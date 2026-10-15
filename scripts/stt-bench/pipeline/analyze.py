import json, statistics, sys
from collections import Counter
from pathlib import Path
import jiwer
import metrics as M

sys.path.insert(0, '/Users/marcos/Documents/qwen35-audio-bridge')
from bridge.fidelity import outcome, read_items

HERE = Path(__file__).parent
DATASET = 'elevenlabs-pt-l2-v1'
CIRCULAR = {'elevenlabs/scribe-v2'}
HALLU = ('legendas pela comunidade', 'obrigado por assistir', 'inscreva se', 'amara org', 'legenda adriana')
MESO = {'meso/whisper-large-v3': 'whisper-el', 'meso/qwen3-asr-1.7b': 'qwen3asr-el'}
MESO_PROBE = {'meso/whisper-large-v3': 'whisper-probe', 'meso/qwen3-asr-1.7b': 'qwen3asr-probe'}


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))] if xs else None


def load_runs():
    runs = {}
    for f in sorted((HERE / 'results').glob('*.jsonl')):
        rows = M.load(f)
        runs[next(iter(rows.values()))['model']] = rows
    for name, sub in MESO.items():
        f = HERE / 'meso_results' / sub / 'hypotheses.jsonl'
        if f.exists():
            runs[name] = {r['id']: {'id': r['id'], 'status': 200, 'hyp': r['hyp'], 'total': r.get('total_s'), 'ttft': r.get('total_s'), 'streaming': False, 'cost': 0.0}
                          for r in map(json.loads, f.open())}
    return runs


def consensus(texts):
    pivot, others = texts[0].split(), [t.split() for t in texts[1:]]
    slots = [[w] for w in pivot]
    gaps = [[] for _ in range(len(pivot) + 1)]
    for hyp in others:
        got = ['' for _ in pivot]
        ins = [[] for _ in range(len(pivot) + 1)]
        if pivot and hyp:
            for a in jiwer.process_words(' '.join(pivot), ' '.join(hyp)).alignments[0]:
                if a.type in ('equal', 'substitute'):
                    for d in range(a.ref_end_idx - a.ref_start_idx):
                        got[a.ref_start_idx + d] = hyp[a.hyp_start_idx + d]
                elif a.type == 'insert':
                    ins[a.ref_start_idx] += hyp[a.hyp_start_idx:a.hyp_end_idx]
        elif hyp:
            ins[0] = hyp
        for k in range(len(pivot)):
            slots[k].append(got[k])
        for k in range(len(pivot) + 1):
            gaps[k].append(' '.join(ins[k]))
    out = []
    for k in range(len(pivot) + 1):
        g = [x for x in gaps[k] if x]
        if len(g) == len(others) and len(set(g)) == 1:
            out.append(g[0])
        if k < len(pivot):
            word, votes = Counter(slots[k]).most_common(1)[0]
            out.append(word if votes >= 2 else slots[k][0])
    return ' '.join(w for w in out if w)


def model_stats(model, rows, ids, man, cons):
    got = [rows[i] for i in ids if i in rows and rows[i]['status'] == 200]
    errors = sum(1 for i in ids if i in rows and rows[i]['status'] != 200)
    hyp = {r['id']: M.norm(r['hyp']) for r in got}
    silver = [(M.norm(man[i]['silver']), hyp[i]) for i in hyp]
    by_bucket = {}
    for b in range(len(__import__('build_set').BUCKETS)):
        p = [(M.norm(man[i]['silver']), hyp[i]) for i in hyp if man[i]['bucket'] == b]
        by_bucket[b] = M.wer(p)
    empty = sum(1 for i in hyp if not hyp[i] and M.norm(man[i]['silver'])) / max(1, len(hyp))
    hallu = sum(1 for i in hyp if any(h in hyp[i] for h in HALLU) or len(hyp[i].split()) >= 2 * len(M.norm(man[i]['silver']).split()) + 6) / max(1, len(hyp))
    ttft = [r['ttft'] * 1000 for r in got if r.get('ttft')]
    total = [r['total'] * 1000 for r in got if r.get('total')]
    cost = [r.get('cost') or 0 for r in got]
    return {'model': model, 'n': len(got), 'errors': errors, 'werSilver': M.wer(silver),
            'werConsensus': M.wer([(cons[i], hyp[i]) for i in hyp]) if cons else None, 'werByBucket': by_bucket,
            'emptyRate': empty, 'hallucinationRate': hallu, 'ttftP50Ms': pct(ttft, .5), 'ttftP95Ms': pct(ttft, .95),
            'ttftStreaming': any(r.get('streaming') for r in got), 'latencyP50Ms': pct(total, .5), 'latencyP95Ms': pct(total, .95),
            'costPer1kUsd': 1000 * statistics.mean(cost) if cost else 0}


def fidelity(model):
    items = read_items()
    if model in MESO_PROBE:
        f = HERE / 'meso_results' / MESO_PROBE[model] / 'hypotheses.jsonl'
        rows = {r['id']: r for r in map(json.loads, f.open())} if f.exists() else {}
    else:
        f = HERE / 'results_probe' / (model.replace('/', '__') + '.jsonl')
        rows = {k: v for k, v in M.load(f).items() if v['status'] == 200} if f.exists() else {}
    said = [(items[int(i[1:3])], r) for i, r in rows.items() if '-said-' in i]
    if len(said) < 100:
        return None, len(said)
    labels = [outcome(it, M.TAGS.sub(' ', r['hyp'])) for it, r in said]
    return labels.count('preserved') / len(labels), len(said)


def turn_language():
    out = {}
    for r in map(json.loads, open(HERE / 'langid.jsonl')):
        top, prob = max(r['whole'].items(), key=lambda kv: kv[1])
        fr_window = any(w[0] == 'fr' and w[1] >= 0.5 for w in r['windows'])
        pt_window = any(w[0] == 'pt' and w[1] >= 0.5 for w in r['windows'])
        if top == 'pt' and not fr_window:
            out[r['id']] = 'pt'
        elif top == 'fr' and prob >= 0.7 and not pt_window:
            out[r['id']] = 'fr'
        else:
            out[r['id']] = 'mixed'
    return out


def french_fidelity(rows, ids):
    labels = Counter(M.text_lang(rows[i]['hyp']) for i in ids if i in rows and rows[i]['status'] == 200)
    total = sum(labels.values())
    return {'fr': labels['fr'], 'pt': labels['pt'], 'other': labels['other'] + labels['empty'], 'faithful': labels['fr'] / total if total else None}


def main():
    man = {r['id']: r for r in map(json.loads, open(HERE / 'manifest.jsonl'))}
    lang = turn_language()
    runs = load_runs()
    core = sorted(i for i, r in man.items() if r['core'])
    full = sorted(man)
    core_pt = [i for i in core if lang[i] == 'pt']
    core_fr = [i for i in core if lang[i] == 'fr']
    base = {m: model_stats(m, rows, core_pt, man, None) for m, rows in runs.items()}
    eligible = [m for m in base if m not in CIRCULAR and not m.startswith('meso/') and base[m]['n'] >= 0.98 * len(core_pt)]
    top3, families = [], set()
    for m in sorted(eligible, key=lambda m: base[m]['werSilver']):
        fam = 'google/' + m.split('/')[1].split('-')[0] if m.startswith('google/') else m.split('/')[0]
        if fam not in families and len(top3) < 3:
            top3.append(m)
            families.add(fam)
    cons = {}
    for i in core:
        texts = [M.norm(runs[m][i]['hyp']) for m in top3 if i in runs[m] and runs[m][i]['status'] == 200]
        if len(texts) == 3:
            cons[i] = consensus(texts)
    counts = {k: sum(1 for i in ids if lang[i] == k) for k, ids in (('pt', full), ('fr', full), ('mixed', full))}
    out = {'dataset': DATASET, 'ruler': M.RULER, 'consensusSystems': top3, 'languages': {'full': counts,
           'core': {k: sum(1 for i in core if lang[i] == k) for k in ('pt', 'fr', 'mixed')}},
           'silverOnFrench': dict(Counter(M.text_lang(man[i]['silver']) for i in full if lang[i] == 'fr')), 'core': [], 'full': []}
    for m, rows in runs.items():
        s = model_stats(m, rows, [i for i in core_pt if i in cons], man, cons)
        s['werSilverAllTurns'] = model_stats(m, rows, core, man, None)['werSilver']
        s['probeFidelity'], s['fidelityClips'] = fidelity(m)
        s['french'] = french_fidelity(rows, core_fr)
        parts = [x for x in (s['probeFidelity'], s['french']['faithful']) if x is not None]
        s['fidelity'] = sum(parts) / len(parts) if len(parts) == 2 else None
        out['core'].append(s)
        if sum(1 for i in full if i in rows) >= 0.98 * len(full):
            f = model_stats(m, rows, [i for i in full if lang[i] == 'pt'], man, None)
            f['french'] = french_fidelity(rows, [i for i in full if lang[i] == 'fr'])
            out['full'].append(f)
    sc = [(M.norm(man[i]['silver']), cons[i]) for i in core_pt if i in cons]
    out['silverVsConsensus'] = {'turns': len(sc), 'wer': M.wer(sc), 'identical': sum(1 for a, b in sc if a == b) / len(sc),
                                'byBucket': {b: M.wer([(M.norm(man[i]['silver']), cons[i]) for i in core_pt if i in cons and man[i]['bucket'] == b]) for b in range(5)},
                                'allTurnsWer': M.wer([(M.norm(man[i]['silver']), cons[i]) for i in cons])}
    diffs = sorted(cons, key=lambda i: -(M.wer([(M.norm(man[i]['silver']), cons[i])]) or 0))
    out['divergenceExamples'] = [{'id': i, 'lang': lang[i], 'seconds': man[i]['seconds'], 'silver': man[i]['silver'], 'consensus': cons[i]} for i in diffs[:40]]
    (HERE / 'summary.json').write_text(json.dumps(out, indent=2, ensure_ascii=False))
    (HERE / 'consensus.json').write_text(json.dumps(cons, ensure_ascii=False))
    (HERE / 'lang.json').write_text(json.dumps(lang))
    print('languages', out['languages'], 'silver text on fr turns', out['silverOnFrench'])
    print('consensus from', top3, 'silver vs consensus', out['silverVsConsensus'])
    for s in sorted(out['core'], key=lambda s: s['werConsensus'] or 9):
        fr = s['french']
        print(f"{s['model'][:44]:44} n={s['n']:3} silver={s['werSilver']:.3f} cons={s['werConsensus'] or 0:.3f} all={s['werSilverAllTurns']:.3f} "
              f"probe={s['probeFidelity'] if s['probeFidelity'] is None else round(s['probeFidelity'], 3)} fr={fr['fr']}/{fr['pt']}/{fr['other']} "
              f"fid={s['fidelity'] if s['fidelity'] is None else round(s['fidelity'], 3)} empty={s['emptyRate']:.3f} hal={s['hallucinationRate']:.3f} "
              f"ttft={s['ttftP50Ms'] or 0:.0f}/{s['ttftP95Ms'] or 0:.0f} lat={s['latencyP50Ms'] or 0:.0f}/{s['latencyP95Ms'] or 0:.0f} "
              f"stream={s['ttftStreaming']} $1k={s['costPer1kUsd']:.3f}")
    for s in sorted(out['full'], key=lambda s: s['werSilver']):
        print('FULL', f"{s['model'][:44]:44} n={s['n']} silverPT={s['werSilver']:.3f} fr={s['french']} buckets={ {b: round(v, 3) if v is not None else None for b, v in s['werByBucket'].items()} }")


if __name__ == '__main__':
    main()
