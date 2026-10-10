import json, re, sys
from pathlib import Path
import jiwer
sys.path.insert(0, '/Users/marcos/Documents/qwen35-audio-bridge')
from bridge.data import normalize_pt

RULER = 'pt-norm-bridge+tags+fillers-v1'
TAGS = re.compile(r'<\|[^|]*\|>|\[[^\]]*\]')
FILLER = re.compile(r'^(e+h+|e{3,}|é{2,}|h+u+m+|h+m+|u+m{2,}|u+h+|h+[ãa]{2,}|hã+|euh+|m+h*m+|ahn+|hein)$')


def norm(text):
    return ' '.join(w for w in normalize_pt(TAGS.sub(' ', text or '')).split() if not FILLER.match(w))


def wer(pairs):
    pairs = [(r, h) for r, h in pairs if r]
    if not pairs:
        return None
    o = jiwer.process_words([r for r, _ in pairs], [h if h else '' for _, h in pairs])
    return (o.substitutions + o.deletions + o.insertions) / sum(len(r.split()) for r, _ in pairs)


def edges(ref, hyp):
    if not ref or not hyp:
        return 0, 0
    a = jiwer.process_words(ref, hyp).alignments[0]
    lead = a[0].hyp_end_idx - a[0].hyp_start_idx if a[0].type == 'insert' else 0
    tail = a[-1].hyp_end_idx - a[-1].hyp_start_idx if a[-1].type == 'insert' else 0
    return lead, tail


def load(path):
    rows = {}
    for line in Path(path).open():
        r = json.loads(line)
        rows[r['id']] = r
    return rows


FR = set('je j ai suis est ce c cest le la les des du une un pas et avec pour moi oui alors parce il elle nous vous très aussi faire mon ma mes ton qu quoi comment bonjour merci voilà ça sais veux peux dans sur aller vais'.split())
PT = set('eu não você é um uma o os as da do das dos com para muito sim estou tudo bem isso meu minha está são tem quero gosto obrigado obrigada também porque ele ela nós vou fazer onde como aqui então'.split())


def text_lang(text):
    words = norm(text).split()
    if not words:
        return 'empty'
    fr = sum(w in FR for w in words)
    pt = sum(w in PT for w in words)
    if fr >= 2 and fr > pt:
        return 'fr'
    if pt >= 1 and pt >= fr:
        return 'pt'
    return 'other'
