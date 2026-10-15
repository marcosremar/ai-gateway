import json, os, random, subprocess, sys
from pathlib import Path
ROOT = Path('/Volumes/HD 1TB/elevenlabs_agent_history_5kjIT7vyFnfRteQioHdg/conversations')
HERE = Path(__file__).parent
LEAD, TAIL, MIN_S, MAX_S = 0.3, 0.2, 0.8, 30.0
TRIM = ('silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.2,areverse,'
        'silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.2,areverse')
BUCKETS = [(0.8, 2), (2, 4), (4, 8), (8, 15), (15, 30.01)]

def bucket(d):
    return next(i for i, (a, b) in enumerate(BUCKETS) if a <= d < b)

def candidates():
    rows, dropped = [], {}
    for conv in sorted(ROOT.iterdir()):
        mp3 = conv / 'audio' / 'full.mp3'
        if not mp3.exists():
            continue
        turns = json.load(open(conv / 'transcript.json'))
        for i, t in enumerate(turns):
            if t['role'] != 'user':
                continue
            text = (t.get('message') or '').strip()
            why = None
            nxt = turns[i + 1] if i + 1 < len(turns) else None
            prev = turns[i - 1] if i else None
            later_earlier = any(u['time_in_call_secs'] < t['time_in_call_secs'] for u in turns[i + 1:])
            if not text or text.strip('. ') == '':
                why = 'empty'
            elif nxt is None:
                why = 'last'
            elif nxt['time_in_call_secs'] <= t['time_in_call_secs'] or later_earlier or (prev and prev['time_in_call_secs'] > t['time_in_call_secs']):
                why = 'overlap_order'
            elif prev and prev['role'] == 'agent' and prev.get('interrupted'):
                why = 'overlap_interrupt'
            if why is None:
                start = max(0, t['time_in_call_secs'] - LEAD)
                end = nxt['time_in_call_secs'] - TAIL
                dur = end - start
                if dur < MIN_S:
                    why = 'short'
                elif dur > MAX_S:
                    why = 'long'
            if why:
                dropped[why] = dropped.get(why, 0) + 1
                continue
            rows.append({'id': f"{conv.name.split('_')[-1]}-{i:03d}", 'conv': conv.name, 'turn': i, 'start': round(start, 2), 'end': round(end, 2),
                         'seconds': round(dur, 2), 'bucket': bucket(dur), 'silver': text,
                         'prev_agent': (prev or {}).get('message') if prev and prev['role'] == 'agent' else '',
                         'next_agent': nxt.get('message') if nxt['role'] == 'agent' else ''})
    return rows, dropped

def stratified(rows, n, seed=20261010):
    rng = random.Random(seed)
    by_b = {}
    for r in rows:
        by_b.setdefault(r['bucket'], []).append(r)
    alloc = {b: max(n // 7, round(n * len(rs) / len(rows))) for b, rs in by_b.items()}
    while sum(alloc.values()) > n:
        alloc[max(alloc, key=alloc.get)] -= 1
    pick = []
    for b, rs in sorted(by_b.items()):
        per = min(alloc[b], len(rs))
        by_conv = {}
        for r in rs:
            by_conv.setdefault(r['conv'], []).append(r)
        for v in by_conv.values():
            rng.shuffle(v)
        convs = sorted(by_conv); rng.shuffle(convs)
        chosen = []
        while len(chosen) < per:
            for c in convs:
                if by_conv[c] and len(chosen) < per:
                    chosen.append(by_conv[c].pop())
        pick += chosen
    return sorted(pick, key=lambda r: r['id'])

def cut(rows, out):
    out.mkdir(exist_ok=True)
    for r in rows:
        dst = out / f"{r['id']}.wav"
        if dst.exists():
            continue
        subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(r['start']), '-t', str(r['seconds']), '-i', str(ROOT / r['conv'] / 'audio' / 'full.mp3'),
                        '-af', TRIM, '-ac', '1', '-ar', '16000', '-y', str(dst)], check=True)

if __name__ == '__main__':
    n = int(sys.argv[1])
    rows, dropped = candidates()
    print('candidates', len(rows), 'seconds', round(sum(r['seconds'] for r in rows)), 'dropped', dropped)
    print('by bucket', {b: sum(1 for r in rows if r['bucket'] == b) for b in range(len(BUCKETS))}, 'convs', len({r['conv'] for r in rows}))
    pick = stratified(rows, n)
    print('sample', len(pick), 'seconds', round(sum(r['seconds'] for r in pick)), 'convs', len({r['conv'] for r in pick}),
          {b: sum(1 for r in pick if r['bucket'] == b) for b in range(len(BUCKETS))})
    core = set(r['id'] for r in stratified(pick, 200, seed=7))
    for r in pick:
        r['core'] = r['id'] in core
    with open(HERE / 'manifest.jsonl', 'w') as f:
        for r in pick:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    if '--cut' in sys.argv:
        cut(pick, HERE / 'clips')
