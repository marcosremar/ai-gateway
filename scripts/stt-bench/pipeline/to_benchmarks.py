import json, sys, time
from pathlib import Path

HERE = Path(__file__).parent
DATASET = 'elevenlabs-pt-l2-v1'
RULER = 'pt-norm-bridge+tags+fillers-v1/lid-whisper-v1/fid-mean-probe-fr-v1'


def record(s, consensus):
    local = s['model'].startswith('meso/')
    fr = s['french']
    notes = [f"WER on Portuguese turns of the core-200 sample; all-turn silver WER {s['werSilverAllTurns']:.3f}",
             f"planted-error probe preserved {s['probeFidelity']}", f"French turns kept French {fr['fr']}, translated to Portuguese {fr['pt']}, other {fr['other']}",
             f"hallucination {s['hallucinationRate']:.3f}"]
    if s['model'] in consensus:
        notes.append('member of the consensus reference (favoured on werConsensus)')
    if s['model'] == 'elevenlabs/scribe-v2':
        notes.append('same vendor as the silver reference (favoured on werSilver)')
    if local:
        notes.append('local reference on a Tesla P40 (Mesocentre); latency is GPU compute, not comparable to the network calls')
    return {
        'model': s['model'].split('/', 1)[1] if local else s['model'],
        'provider': 'meso' if local else 'openrouter',
        'task': 'stt',
        'dataset': DATASET + ('-local' if local else ''),
        'measuredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'n': s['n'],
        'werSilver': round(min(1, s['werSilver']), 4),
        'werConsensus': None if s['werConsensus'] is None else round(min(1, s['werConsensus']), 4),
        'fidelity': None if s['fidelity'] is None else round(s['fidelity'], 4),
        'ttftP50Ms': round(s['ttftP50Ms'] or 0),
        'ttftP95Ms': round(s['ttftP95Ms'] or 0),
        'ttftStreaming': bool(s['ttftStreaming']),
        'latencyP50Ms': round(s['latencyP50Ms'] or 0),
        'latencyP95Ms': round(s['latencyP95Ms'] or 0),
        'costPer1kUsd': round(s['costPer1kUsd'], 4),
        'emptyRate': round(s['emptyRate'], 4),
        'rulerVersion': RULER,
        'notes': '; '.join(notes),
    }


summary = json.loads((HERE / 'summary.json').read_text())
rows = [record(s, summary['consensusSystems']) for s in summary['core'] if s['n'] >= 70]
Path(sys.argv[1]).write_text(json.dumps(rows, indent=2, ensure_ascii=False) + '\n')
print(len(rows), 'records ->', sys.argv[1])
