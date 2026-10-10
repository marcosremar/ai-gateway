import difflib, json, sys
from pathlib import Path
import build_set as B
import metrics as M

HERE = Path(__file__).parent
WORDS = HERE / 'words'
PAD, EDGE_SHARE = 0.1, 0.34


def turn_spans(turns, words):
    ref, owner = [], []
    for k, t in enumerate(turns):
        toks = M.norm(t.get('message') or '').split()
        ref += toks
        owner += [(k, j, len(toks)) for j in range(len(toks))]
    asr = [M.norm(w[2]) for w in words]
    hit = {}
    for a, b, size in difflib.SequenceMatcher(None, ref, asr, autojunk=False).get_matching_blocks():
        for d in range(size):
            hit[a + d] = b + d
    spans = {}
    for r, w in hit.items():
        k, j, n = owner[r]
        spans.setdefault(k, []).append((j, n, words[w][0], words[w][1]))
    return spans


def agent_end(spans, k):
    hits = spans.get(k) or []
    tail = [h for h in hits if h[0] >= h[1] * (1 - EDGE_SHARE)]
    return max(h[3] for h in tail) if tail else None


def agent_start(spans, k):
    hits = spans.get(k) or []
    head = [h for h in hits if h[0] < max(1, h[1] * EDGE_SHARE)]
    return min(h[2] for h in head) if head else None


def candidates():
    rows, dropped = [], {}
    for conv in sorted(B.ROOT.iterdir()):
        wf = WORDS / f'{conv.name}.json'
        if not wf.exists():
            continue
        turns = json.load(open(conv / 'transcript.json'))
        spans = turn_spans(turns, json.load(open(wf)))
        for i, t in enumerate(turns):
            if t['role'] != 'user':
                continue
            text = (t.get('message') or '').strip()
            prev = turns[i - 1] if i else None
            nxt = turns[i + 1] if i + 1 < len(turns) else None
            why = None
            if not M.norm(text):
                why = 'empty'
            elif nxt is None or prev is None:
                why = 'edge_of_call'
            elif prev['role'] != 'agent' or nxt['role'] != 'agent':
                why = 'not_between_agent_turns'
            elif any(u['time_in_call_secs'] < t['time_in_call_secs'] for u in turns[i + 1:]) or nxt['time_in_call_secs'] < t['time_in_call_secs']:
                why = 'overlap_order'
            elif prev.get('interrupted'):
                why = 'overlap_interrupt'
            start = end = None
            if why is None:
                pe, ns = agent_end(spans, i - 1), agent_start(spans, i + 1)
                if pe is None:
                    why = 'no_align'
                else:
                    start = pe + PAD
                    end = ns - PAD if ns is not None else nxt['time_in_call_secs'] - B.TAIL
                    if not (t['time_in_call_secs'] - 3 <= start <= nxt['time_in_call_secs'] + 1):
                        why = 'align_out_of_window'
                    elif end - start < B.MIN_S:
                        why = 'short'
                    elif end - start > B.MAX_S:
                        why = 'long'
            if why:
                dropped[why] = dropped.get(why, 0) + 1
                continue
            dur = end - start
            rows.append({'id': f"{conv.name.split('_')[-1]}-{i:03d}", 'conv': conv.name, 'turn': i, 'start': round(start, 2), 'end': round(end, 2),
                         'seconds': round(dur, 2), 'bucket': B.bucket(dur), 'silver': text, 'prev_agent': prev.get('message') or '',
                         'next_agent': nxt.get('message') or ''})
    return rows, dropped


if __name__ == '__main__':
    n = int(sys.argv[1])
    rows, dropped = candidates()
    print('candidates', len(rows), 'seconds', round(sum(r['seconds'] for r in rows)), 'dropped', dropped)
    print('by bucket', {b: sum(1 for r in rows if r['bucket'] == b) for b in range(len(B.BUCKETS))}, 'convs', len({r['conv'] for r in rows}))
    B.cut(rows, HERE / 'clips')
    import soundfile as sf
    for r in rows:
        r['window'] = r['seconds']
        r['seconds'] = round(sf.info(str(HERE / 'clips' / f"{r['id']}.wav")).duration, 2)
        r['bucket'] = B.bucket(r['seconds']) if r['seconds'] >= B.MIN_S else -1
    short = [r for r in rows if r['bucket'] < 0]
    rows = [r for r in rows if r['bucket'] >= 0]
    print('trimmed below', B.MIN_S, 's:', len(short), '| kept', len(rows), 'seconds', round(sum(r['seconds'] for r in rows)))
    pick = B.stratified(rows, n)
    core = {r['id'] for r in B.stratified(pick, 200, seed=7)}
    for r in pick:
        r['core'] = r['id'] in core
    print('sample', len(pick), 'seconds', round(sum(r['seconds'] for r in pick)), 'convs', len({r['conv'] for r in pick}),
          {b: sum(1 for r in pick if r['bucket'] == b) for b in range(len(B.BUCKETS))}, 'core seconds', round(sum(r['seconds'] for r in pick if r['core'])))
    with open(HERE / 'manifest.jsonl', 'w') as f:
        for r in pick:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    keep = {r['id'] for r in pick}
    for f in (HERE / 'clips').glob('*.wav'):
        if f.stem not in keep:
            f.unlink()
