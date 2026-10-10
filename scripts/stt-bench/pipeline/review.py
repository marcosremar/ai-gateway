import csv, html, json, random
from pathlib import Path
import metrics as M

HERE = Path(__file__).parent
ROOT = Path('/Volumes/HD 1TB/elevenlabs_agent_history_5kjIT7vyFnfRteQioHdg')
OUT = ROOT / 'stt-review-2026-10-10'

PAGE = """<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>Revisão das transcrições</title>
<style>body{font:15px system-ui;margin:16px;max-width:1100px}tr{vertical-align:top}td{padding:6px;border-bottom:1px solid #ddd}
textarea{width:100%;min-height:3em;font:inherit}.hint{color:#666;font-size:13px}button{font:inherit;padding:6px 12px}</style></head><body>
<h1>Revisão humana: 150 falas de alunos</h1>
<p>Ouça cada trecho e corrija a caixa para o que o aluno <b>disse de fato</b>, com os erros dele (não corrija o português do aluno).
A caixa já vem com a transcrição da ElevenLabs de 2025, que <b>traduz para o português o que o aluno disse em francês</b>; se o aluno falou francês, escreva em francês. Abaixo: a língua detectada, o consenso dos modelos e a saída do scribe-v2 (que mantém o francês), como dicas. Tudo fica só neste computador
(salvo automaticamente no navegador). No fim, clique em «Baixar CSV».</p>
<p><button onclick="dl()">Baixar CSV</button> <span id="n"></span></p><table>__ROWS__</table>
<script>
const K='stt-review-2026-10-10';const saved=JSON.parse(localStorage.getItem(K)||'{}');
document.querySelectorAll('textarea').forEach(t=>{if(saved[t.id]!==undefined)t.value=saved[t.id];
t.addEventListener('input',()=>{saved[t.id]=t.value;localStorage.setItem(K,JSON.stringify(saved));count()})});
function count(){document.getElementById('n').textContent=Object.keys(saved).length+' editadas'}count();
function dl(){const q=s=>'"'+String(s).replace(/"/g,'""')+'"';const rows=[['id','human']];
document.querySelectorAll('textarea').forEach(t=>rows.push([t.id,t.value]));
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([rows.map(r=>r.map(q).join(',')).join('\\n')],{type:'text/csv'}));
a.download='revisao-humana.csv';a.click()}
</script></body></html>"""


def main():
    man = {r['id']: r for r in map(json.loads, open(HERE / 'manifest.jsonl'))}
    cons = json.loads((HERE / 'consensus.json').read_text())
    lang = json.loads((HERE / 'lang.json').read_text())
    scribe = M.load(HERE / 'results' / 'elevenlabs__scribe-v2.jsonl')
    gap = sorted(cons, key=lambda i: -(M.wer([(M.norm(man[i]['silver']), cons[i])]) or 0))
    pick = gap[:100]
    rest = [i for i in cons if i not in pick]
    random.Random(150).shuffle(rest)
    pick = sorted(pick + rest[:50])
    OUT.mkdir(exist_ok=True)
    rows = []
    for i in pick:
        r = man[i]
        src = (ROOT / 'conversations' / r['conv'] / 'audio' / 'full.mp3').as_uri()
        rows.append(f"<tr><td>{i}<br><span class=hint>{r['seconds']} s</span></td><td><audio controls preload=none src=\"{src}#t={r['start']},{r['end']}\"></audio>"
                    f"<textarea id=\"{i}\">{html.escape(r['silver'])}</textarea><div class=hint>língua detectada: {lang[i]} · consenso: {html.escape(cons[i])} · scribe-v2: {html.escape(scribe[i]['hyp'])}</div></td></tr>")
    (OUT / 'revisao.html').write_text(PAGE.replace('__ROWS__', '\n'.join(rows)))
    with open(OUT / 'revisao.csv', 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['id', 'conv', 'start', 'end', 'seconds', 'lang', 'silver_elevenlabs', 'consensus', 'scribe_v2', 'human'])
        for i in pick:
            r = man[i]
            w.writerow([i, r['conv'], r['start'], r['end'], r['seconds'], lang[i], r['silver'], cons[i], scribe[i]['hyp'], ''])
    print(OUT / 'revisao.html', len(pick))


if __name__ == '__main__':
    main()
