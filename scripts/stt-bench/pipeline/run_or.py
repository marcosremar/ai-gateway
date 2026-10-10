import argparse, asyncio, base64, json, time
from pathlib import Path
import httpx
import devenv as S

HERE = Path(__file__).parent
BASE = 'https://openrouter.ai/api/v1'
PROMPT = ('Transcreva exatamente o que a pessoa diz neste áudio em português, palavra por palavra, sem corrigir erros de gramática, '
          'pronúncia ou vocabulário, sem traduzir e sem comentar. Se não houver fala, responda com nada. Responda só com a transcrição.')
CHAT = {'google/gemini-3.8-flash', 'google/gemini-3.1-flash-lite', 'google/gemini-3.5-flash-lite', 'mistralai/voxtral-small-24b-2507'}
SPENT = {'usd': 0.0}
OUT = {'dir': 'results', 'clips': 'clips'}


def slug(model):
    return model.replace('/', '__')


async def stt_call(c, key, model, wav):
    t0 = time.perf_counter()
    async with c.stream('POST', f'{BASE}/audio/transcriptions', headers={'Authorization': 'Bearer ' + key},
                        data={'model': model, 'language': 'pt', 'stream': 'true'},
                        files={'file': ('a.wav', wav, 'audio/wav')}) as r:
        ctype = r.headers.get('content-type', '')
        if 'event-stream' not in ctype:
            body = await r.aread()
            total = time.perf_counter() - t0
            if r.status_code != 200:
                return {'status': r.status_code, 'error': body.decode()[:300], 'total': total}
            j = json.loads(body)
            return {'status': 200, 'hyp': j.get('text', ''), 'ttft': total, 'total': total, 'streaming': False,
                    'cost': (j.get('usage') or {}).get('cost')}
        text, ttft, cost = '', None, None
        async for line in r.aiter_lines():
            if not line.startswith('data:') or line.strip() == 'data: [DONE]':
                continue
            ev = json.loads(line[5:])
            delta = ev.get('delta') or ev.get('text') or ''
            if delta and ttft is None:
                ttft = time.perf_counter() - t0
            if ev.get('type', '').endswith('done'):
                text = ev.get('text', text + delta)
            else:
                text += delta
            cost = (ev.get('usage') or {}).get('cost', cost)
        total = time.perf_counter() - t0
        return {'status': r.status_code, 'hyp': text, 'ttft': ttft or total, 'total': total, 'streaming': ttft is not None, 'cost': cost}


async def chat_call(c, key, model, wav):
    body = {'model': model, 'stream': True, 'temperature': 0, 'max_tokens': 400, 'usage': {'include': True},
            'provider': {'zdr': True}, 'reasoning': {'effort': 'minimal', 'exclude': True},
            'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': PROMPT},
                                                      {'type': 'input_audio', 'input_audio': {'data': base64.b64encode(wav).decode(), 'format': 'wav'}}]}]}
    t0 = time.perf_counter()
    async with c.stream('POST', f'{BASE}/chat/completions', headers={'Authorization': 'Bearer ' + key}, json=body) as r:
        if r.status_code != 200:
            return {'status': r.status_code, 'error': (await r.aread()).decode()[:300], 'total': time.perf_counter() - t0}
        text, ttft, cost = '', None, None
        async for line in r.aiter_lines():
            if not line.startswith('data:') or line.strip() == 'data: [DONE]':
                continue
            ev = json.loads(line[5:])
            if ev.get('error'):
                return {'status': 502, 'error': json.dumps(ev['error'])[:300], 'total': time.perf_counter() - t0}
            for ch in ev.get('choices') or []:
                d = (ch.get('delta') or {}).get('content') or ''
                if d and ttft is None:
                    ttft = time.perf_counter() - t0
                text += d
            if ev.get('usage'):
                cost = ev['usage'].get('cost', cost)
        total = time.perf_counter() - t0
        return {'status': 200, 'hyp': text, 'ttft': ttft or total, 'total': total, 'streaming': True, 'cost': cost}


async def run_model(c, key, model, rows, conc, budget):
    out = HERE / OUT['dir'] / f'{slug(model)}.jsonl'
    out.parent.mkdir(exist_ok=True)
    done = {json.loads(l)['id'] for l in out.open()} if out.exists() else set()
    sem = asyncio.Semaphore(conc)
    call = chat_call if model in CHAT else stt_call
    fails = {'n': 0}

    async def one(row):
        async with sem:
            if SPENT['usd'] >= budget or fails['n'] >= 8:
                return
            wav = (HERE / OUT['clips'] / f"{row['id']}.wav").read_bytes()
            res = None
            for attempt in range(3):
                try:
                    res = await call(c, key, model, wav)
                except (httpx.HTTPError, json.JSONDecodeError) as e:
                    res = {'status': 0, 'error': repr(e)[:300]}
                if res['status'] == 200 or res['status'] in (400, 401, 402, 403, 404):
                    break
                await asyncio.sleep(2 * (attempt + 1))
            res.update({'id': row['id'], 'model': model, 'attempts': attempt + 1, 'at': time.strftime('%Y-%m-%dT%H:%M:%S')})
            if res['status'] != 200:
                fails['n'] += 1
            SPENT['usd'] += res.get('cost') or 0
            with out.open('a') as f:
                f.write(json.dumps(res, ensure_ascii=False) + '\n')

    await asyncio.gather(*(one(r) for r in rows if r['id'] not in done))
    print(model, 'fails', fails['n'], 'spent so far', round(SPENT['usd'], 4), flush=True)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('models', nargs='+')
    ap.add_argument('--subset', choices=['all', 'core'], default='all')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--conc', type=int, default=4)
    ap.add_argument('--budget', type=float, default=3.0)
    ap.add_argument('--out', default='results')
    ap.add_argument('--manifest', default='manifest.jsonl')
    ap.add_argument('--clips', default='clips')
    ap.add_argument('--only', default='')
    a = ap.parse_args()
    OUT['dir'] = a.out
    OUT['clips'] = a.clips
    key = S.env()['OPENROUTER_API_KEY']
    rows = [r for r in map(json.loads, open(HERE / a.manifest)) if a.only in r['id']]
    if a.subset == 'core':
        rows = [r for r in rows if r.get('core')]
    rows = rows[: a.limit] if a.limit else rows
    async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=20), limits=httpx.Limits(max_connections=200)) as c:
        cr = (await c.get(f'{BASE}/credits', headers={'Authorization': 'Bearer ' + key})).json()['data']
        print('credits before', round(cr['total_credits'] - cr['total_usage'], 4), flush=True)
        await asyncio.gather(*(run_model(c, key, m, rows, a.conc, a.budget) for m in a.models))
        cr = (await c.get(f'{BASE}/credits', headers={'Authorization': 'Bearer ' + key})).json()['data']
        print('credits after', round(cr['total_credits'] - cr['total_usage'], 4), flush=True)


asyncio.run(main())
