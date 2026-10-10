// ── AI Gateway — Live subtitle rooms: viewer pages ───────────────────────────
// Self-contained HTML (inline CSS/JS under a per-response CSP nonce, no CDN, no build step), mobile first, pt-BR.
//   - roomPage:  live line on top (one line per language, shrink then "…" — never wrapped), full transcript below,
//                language selector, "mostrar original", "Ouvir dublagem" (Web Audio, gapless, live line in sync with
//                the voice), delay indicator, "Copiar texto", per-viewer display settings sheet, reconnect.
//   - entryPage: "Digite o código da sessão".
//   - notFoundPage: unknown / expired code.

import { randomBytes } from 'crypto';

export interface PageOptions {
  /** Where the code input navigates: `/` on the public host, `/live/` elsewhere. */
  basePath: string;
  retentionDays: number;
}

export interface RenderedPage { html: string; nonce: string }

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c] ?? c);
/** JSON for an inline <script>: `<` escaped so no string can close the tag. */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2319c2b4'/%3E%3Crect x='7' y='12' width='18' height='3' rx='1.5' fill='%231b1b1f'/%3E%3Crect x='10' y='18' width='12' height='3' rx='1.5' fill='%231b1b1f'/%3E%3C/svg%3E";

/** Content-Security-Policy of a page rendered with `nonce`. */
export function pageCsp(nonce: string): string {
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`, "connect-src 'self' wss: ws:",
    'media-src blob: data:', 'img-src data:', "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'",
  ].join('; ');
}

const BASE_CSS = `
:root{color-scheme:dark;--bg:#1b1b1f;--surface:#24242a;--line:#34343c;--text:#ececf1;--muted:#9a9aa6;--accent:#19c2b4;--accent-ink:#06211f;--warn:#e0a84a}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent)}
button,select,input{font:inherit;color:inherit}
.brand{font-weight:700;letter-spacing:.02em;color:var(--accent);text-decoration:none}
`;

function shell(title: string, css: string, body: string, script: string, nonce: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1b1b1f">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="${ICON}">
<style nonce="${nonce}">${BASE_CSS}${css}</style>
</head>
<body>
${body}
${script ? `<script nonce="${nonce}">${script}</script>` : ''}
</body>
</html>`;
}

// ── Entry and 404 ───────────────────────────────────────────────────────────

const CARD_CSS = `
main{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px;text-align:center}
h1{font-size:1.4rem;margin:18px 0 8px}
p{color:var(--muted);margin:0 0 20px;line-height:1.5;max-width:28rem}
form{display:flex;gap:8px;width:100%;max-width:22rem}
input{flex:1;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;font-size:1.4rem;letter-spacing:.3em;text-align:center;text-transform:uppercase}
input:focus{outline:2px solid var(--accent);border-color:transparent}
button{background:var(--accent);color:var(--accent-ink);border:0;border-radius:12px;padding:0 18px;font-weight:700;cursor:pointer}
`;

function entryForm(basePath: string): { body: string; script: string } {
  const body = `<form id="f" autocomplete="off">
<input id="c" name="code" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="6" placeholder="K7Q2XM" aria-label="Código da sessão" required>
<button type="submit">Entrar</button>
</form>`;
  const script = `(function(){var f=document.getElementById('f'),c=document.getElementById('c');
f.addEventListener('submit',function(e){e.preventDefault();var v=(c.value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');if(v)location.href=${js(basePath)}+v;});c.focus();})();`;
  return { body, script };
}

export function entryPage(opts: PageOptions): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const form = entryForm(opts.basePath);
  const body = `<main><a class="brand" href="${esc(opts.basePath)}">ucast.me</a>
<h1>Digite o código da sessão</h1>
<p>O código aparece no QR code ou na tela de quem está apresentando.</p>
${form.body}</main>`;
  return { html: shell('Legendas ao vivo · ucast.me', CARD_CSS, body, form.script, nonce), nonce };
}

export function notFoundPage(opts: PageOptions, code: string | null): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const form = entryForm(opts.basePath);
  const which = code ? `A sessão <strong>${esc(code)}</strong> não existe` : 'Esta sessão não existe';
  const body = `<main><a class="brand" href="${esc(opts.basePath)}">ucast.me</a>
<h1>Sessão não encontrada</h1>
<p>${which} ou já expirou — o texto de uma sessão fica disponível por ${opts.retentionDays} dias após a última fala. Confira o código e tente de novo.</p>
${form.body}</main>`;
  return { html: shell('Sessão não encontrada · ucast.me', CARD_CSS, body, form.script, nonce), nonce };
}

// ── Room page ───────────────────────────────────────────────────────────────
// Layout (mobile first): a sticky top block — status bar (brand · title · delay · pill), the live card (the hero: one
// line per language) and one compact toolbar — over a calm transcript column. Spacing scale 4/8/12/16/24 px.
// Every display setting is the viewer's own (settings sheet behind the gear; localStorage, never sent anywhere).

const LIGHT_VARS = '--bg:#f6f6f8;--surface:#ffffff;--line:#dcdce4;--text:#1b1b1f;--muted:#5b5b66;--accent:#0b7d74;--accent-ink:#ffffff;--warn:#8a5a00;--bad:#c4262e;--live-bg:rgba(11,125,116,.12);--shade:rgba(20,20,30,.18);color-scheme:light';

const ROOM_CSS = `
:root{--surface:#25252b;--muted:#a3a3ae;--bad:#ff7d7d;--live-bg:rgba(25,194,180,.16);--shade:rgba(0,0,0,.45);--tx:17px;--pad:max(16px,env(safe-area-inset-left));--pad-r:max(16px,env(safe-area-inset-right))}
html[data-theme="light"]{${LIGHT_VARS}}
@media (prefers-color-scheme:light){html[data-theme="auto"]{${LIGHT_VARS}}}
body{overflow-x:hidden}
.wrap{max-width:60rem;margin:0 auto}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:max(8px,env(safe-area-inset-top)) var(--pad-r) 12px var(--pad)}
.top{display:flex;align-items:center;gap:8px;min-width:0;height:32px}
.top .brand{flex:none;font-size:.95rem}
.top h1{flex:1;min-width:0;margin:0;font-size:.95rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.delay{flex:none;white-space:nowrap;font-size:.75rem;color:var(--muted);font-variant-numeric:tabular-nums}
.delay.warn{color:var(--warn)}
.delay.bad{color:var(--bad)}
.pill{flex:none;white-space:nowrap;font-size:.75rem;font-weight:700;border-radius:999px;padding:4px 10px;background:var(--surface);color:var(--muted);text-transform:lowercase}
.pill.live{background:var(--live-bg);color:var(--accent)}
.pill.live::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-right:6px;vertical-align:1px;animation:pulse 1.6s infinite}
.pill.wait{color:var(--warn)}
@keyframes pulse{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.pill.live::before{animation:none}}
.now{margin-top:8px;background:var(--surface);border-radius:16px;padding:12px 16px;min-height:76px;display:flex;flex-direction:column;justify-content:center;min-width:0}
.mode-full .now{display:none}
.fit{white-space:nowrap;overflow:hidden;line-height:1.3;max-width:100%}
#liveMain{font-weight:700;letter-spacing:-.005em}
#liveOrig{color:var(--muted);margin-top:4px}
.empty{color:var(--muted);font-style:italic;font-weight:400!important}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}
.bar select,.sheet select{flex:1 1 7.5rem;min-width:0;max-width:14rem;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:0 10px;height:40px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:0 12px;cursor:pointer;white-space:nowrap;font-size:.92rem}
.btn:focus-visible,select:focus-visible,.sheet input:focus-visible,.sheet:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:700}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn[hidden]{display:none}
.btn .ic{font-size:1rem;line-height:1}
.end{margin-left:auto}
.sm{display:none}
.ico{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
@media (max-width:479px){.lg{display:none}.sm{display:inline}.end{margin-left:0}.bar .btn{padding:0 10px}.bar select{flex-basis:5.5rem}}
@media (max-width:379px){.bar select{flex-basis:100%;max-width:none}}
.notice{max-width:46rem;margin:12px auto 0;padding:10px 12px;border-radius:10px;background:var(--surface);color:var(--muted);font-size:.9rem}
.notice:empty{display:none}
.notice-wrap{padding:0 var(--pad-r) 0 var(--pad)}
#tx{max-width:46rem;margin:0 auto;padding:8px var(--pad-r) calc(96px + env(safe-area-inset-bottom)) var(--pad)}
#tx p{margin:0;padding:14px 0;border-bottom:1px solid var(--line);line-height:1.6;font-size:var(--tx);overflow-wrap:anywhere}
#tx p:last-child{border-bottom:0}
#tx p .ts{float:right;margin:4px 0 0 12px;font-size:.72rem;color:var(--muted);font-variant-numeric:tabular-nums}
.no-times #tx p .ts{display:none}
#tx p .o{display:block;color:var(--muted);font-size:.86em;line-height:1.5;margin-top:4px}
#tx p.miss .t{color:var(--muted);font-style:italic}
#tx p.cur{box-shadow:inset 3px 0 0 var(--accent);padding-left:15px;margin-left:-15px}
.mode-full #tx p.cur{box-shadow:none;padding-left:0;margin-left:0}
#more{position:fixed;left:50%;bottom:max(16px,env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--accent);color:var(--accent-ink);border:0;border-radius:999px;padding:10px 16px;font-weight:700;box-shadow:0 4px 18px rgba(0,0,0,.4);display:none;cursor:pointer}
.backdrop{position:fixed;inset:0;z-index:20;background:var(--shade)}
.sheet{position:fixed;z-index:21;left:0;right:0;bottom:0;max-height:85vh;max-height:85dvh;overflow-y:auto;overscroll-behavior:contain;background:var(--surface);color:var(--text);border-radius:18px 18px 0 0;border-top:1px solid var(--line);padding:4px var(--pad-r) calc(16px + env(safe-area-inset-bottom)) var(--pad);box-shadow:0 -8px 30px rgba(0,0,0,.35)}
.backdrop[hidden],.sheet[hidden]{display:none}
.sheet-head{display:flex;align-items:center;justify-content:space-between;gap:8px;position:sticky;top:0;background:var(--surface);padding:8px 0;z-index:1}
.sheet h2{margin:0;font-size:1.05rem}
.sheet fieldset{border:0;margin:0;padding:0;min-width:0}
.sheet fieldset.grp{padding:14px 0;border-top:1px solid var(--line)}
.sheet legend{float:left;width:100%}
.sheet legend+*{clear:both}
.sheet legend,.sheet .lbl{display:block;padding:0;margin:0 0 8px;font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.grp{padding:14px 0;border-top:1px solid var(--line)}
.grp select{max-width:none;width:100%}
.opt{display:flex;gap:10px;align-items:flex-start;padding:8px 0;cursor:pointer}
.opt input{margin:3px 0 0;accent-color:var(--accent);width:18px;height:18px;flex:none}
.opt small{display:block;color:var(--muted);font-size:.82rem;margin-top:2px;line-height:1.35}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;cursor:pointer}
.row input[type=checkbox]{accent-color:var(--accent);width:20px;height:20px;flex:none}
.row input[type=range]{flex:1 1 auto;max-width:12rem;accent-color:var(--accent)}
.row.off{opacity:.5}
.seg{display:flex;gap:8px;flex-wrap:wrap}
.seg label{flex:1 1 0;min-width:5.5rem;display:flex;align-items:center;justify-content:center;gap:6px;height:40px;border:1px solid var(--line);border-radius:10px;cursor:pointer;font-size:.9rem}
.seg input{accent-color:var(--accent);margin:0}
.stepper{display:flex;align-items:center;gap:12px}
.stepper output{min-width:3.5rem;text-align:center;font-variant-numeric:tabular-nums}
@media (min-width:768px){.top{height:36px}.top .brand,.top h1{font-size:1rem}.now{padding:16px 20px;min-height:96px}
.backdrop{background:transparent}
.sheet{left:auto;bottom:auto;top:96px;right:16px;width:380px;border:1px solid var(--line);border-radius:16px;padding:4px 20px 16px;box-shadow:0 12px 40px rgba(0,0,0,.45)}}
`;

const ROOM_BODY = `<header><div class="wrap">
<div class="top"><span class="brand">ucast</span><h1 id="title">Legendas ao vivo</h1><span id="delay" class="delay" hidden></span><span id="pill" class="pill wait">conectando…</span></div>
<section class="now" aria-live="polite"><div id="liveMain" class="fit empty">Aguardando a primeira fala…</div><div id="liveOrig" class="fit" hidden></div></section>
<div class="bar" role="toolbar" aria-label="Opções">
<select id="lang" aria-label="Idioma da legenda"></select>
<button id="orig" class="btn" type="button" aria-pressed="false" aria-label="Mostrar original"><span class="lg">Mostrar original</span><span class="sm">Original</span></button>
<button id="dub" class="btn" type="button" aria-pressed="false" aria-label="Ouvir dublagem"><span class="ic" aria-hidden="true">🔈</span>Ouvir<span class="lg"> dublagem</span></button>
<button id="copy" class="btn end" type="button" aria-label="Copiar texto"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span class="lg" id="copyLbl">Copiar texto</span></button>
<button id="gear" class="btn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="sheet" aria-label="Ajustes de exibição"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg><span class="lg">Ajustes</span></button>
</div>
</div></header>
<div class="notice-wrap"><div id="notice" class="notice" role="status"></div></div>
<main id="tx"></main>
<button id="more" type="button">Novas falas ↓</button>
<div id="backdrop" class="backdrop" hidden></div>
<div id="sheet" class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" tabindex="-1" hidden>
<div class="sheet-head"><h2 id="sheetTitle">Ajustes de exibição</h2><button id="sClose" class="btn" type="button" aria-label="Fechar ajustes">✕</button></div>
<div class="grp"><label class="lbl" for="sLang">Idioma da legenda</label><select id="sLang"></select></div>
<fieldset class="grp"><legend>Modo</legend>
<label class="opt"><input type="radio" name="sMode" value="translation"><span>Tradução<small>Tradução em destaque; a fala original embaixo é opcional</small></span></label>
<label class="opt"><input type="radio" name="sMode" value="transcript"><span>Só transcrição<small>Só a fala original, sem tradução</small></span></label>
<label class="opt"><input type="radio" name="sMode" value="bilingual"><span>Bilíngue<small>Tradução e fala original, sempre</small></span></label>
<label class="opt"><input type="radio" name="sMode" value="full"><span>Só texto completo<small>Sem a linha ao vivo, para ler o texto</small></span></label>
<label class="row" id="sOrigRow"><span>Mostrar a fala original embaixo</span><input id="sOrig" type="checkbox" role="switch"></label>
</fieldset>
<fieldset class="grp"><legend>Dublagem</legend>
<label class="row"><span>Ouvir dublagem</span><input id="sDub" type="checkbox" role="switch"></label>
<label class="row"><span>Volume</span><input id="sVol" type="range" min="0" max="100" step="5" aria-label="Volume da dublagem"></label>
<label class="row"><span>Sincronizar legenda com a voz</span><input id="sSync" type="checkbox" role="switch"></label>
</fieldset>
<div class="grp"><span class="lbl" id="sSizeLbl">Tamanho do texto</span><div class="stepper" role="group" aria-labelledby="sSizeLbl">
<button id="sSmaller" class="btn" type="button" aria-label="Diminuir o texto">A−</button><output id="sSize" aria-live="polite">100%</output><button id="sBigger" class="btn" type="button" aria-label="Aumentar o texto">A+</button></div></div>
<fieldset class="grp"><legend>Tema</legend><div class="seg">
<label><input type="radio" name="sTheme" value="dark">Escuro</label><label><input type="radio" name="sTheme" value="light">Claro</label><label><input type="radio" name="sTheme" value="auto">Automático</label>
</div></fieldset>
<fieldset class="grp"><legend>Texto completo</legend>
<label class="row"><span>Rolagem automática do texto completo</span><input id="sScroll" type="checkbox" role="switch"></label>
<label class="row"><span>Mostrar horários</span><input id="sTimes" type="checkbox" role="switch"></label>
<label class="row"><span>Mostrar atraso</span><input id="sDelay" type="checkbox" role="switch"></label>
</fieldset>
</div>`;

/**
 * Pure page logic (plain ES5, no DOM), inlined at the top of the room page script and evaluated as-is by the unit tests.
 *   - pickLang(prefs, languages, saved): the viewer's saved choice if still valid; else the first browser language the
 *     room publishes (exact tag, then primary subtag: "en-US" → "en"); else the room's first target language; "orig"
 *     only when the room has no translations.
 *   - fitLine(text, maxWidth, basePx, measure): one line, never wrapped — shrink the font down to 70 % of basePx, then
 *     keep the END of the sentence behind a leading "…" (words dropped from the start, never the end).
 *     `measure(str, px)` returns the rendered width of `str` at font size `px`. Returns {px, text}.
 *   - pickLive(entries, now, syncOn, waitMs): which line the live card shows. Sync off: the newest line. Sync on
 *     (dubbing on + "sincronizar legenda com a voz"): the line of the most recent event among "its clip started playing"
 *     (startedAt ≤ now) and "no clip came within waitMs of its arrival" (arrivedAt + waitMs ≤ now); a line whose clip
 *     is queued/scheduled waits for it, a line whose clip was dropped (backlog) is skipped. null = nothing eligible
 *     (keep what is shown). entries: [{id, arrivedAt, startedAt|null, pending, skip}] (ms on one clock).
 *   - nextStart(now, prevEnd, lead): start of the next clip on the AudioContext timeline — back to back, never overlapping.
 *   - backlogDrop(ahead, durs, maxSec): how many of the OLDEST pending clips to drop so that the audio still to play
 *     (`ahead` already scheduled + pending durations) is ≤ maxSec; the newest clip is always kept.
 *   - median(values), delayLabel(ms, voice): the delay indicator ("atraso 1,8 s" / "voz 3,2 s"; ok < 3 s ≤ warn ≤ 6 s < bad).
 *   - parseSettings(json, legacyOrig) / normalizeSettings(raw): the viewer's display settings (localStorage
 *     "ucast-settings"), every field validated, defaults for the rest; the older "ucast-orig" = "1" still turns the
 *     original on. textSizes(step, viewportWidth): {live, tx} px for an A−/A+ step (live 20–56, transcript 14–24).
 *   - lineView(mode, showOrig, lang, hasTranslation): what a line shows — {main: 'tr'|'orig', sub, miss}.
 */
export const ROOM_PAGE_LOGIC = String.raw`
function pickLang(prefs,languages,saved){
  languages=languages||[];
  if(saved&&(saved==='orig'||languages.indexOf(saved)>=0))return saved;
  var low=languages.map(function(x){return String(x).toLowerCase()});
  for(var i=0;i<(prefs||[]).length;i++){
    var p=String(prefs[i]||'').toLowerCase();if(!p)continue;
    var k=low.indexOf(p);if(k>=0)return languages[k];
    var pre=p.split('-')[0];
    for(var j=0;j<low.length;j++)if(low[j].split('-')[0]===pre)return languages[j];
  }
  return languages.length?languages[0]:'orig';
}
function fitLine(text,maxWidth,basePx,measure){
  text=String(text==null?'':text).replace(/\s+/g,' ').trim();
  if(!(maxWidth>0)||measure(text,basePx)<=maxWidth)return {px:basePx,text:text};
  var min=Math.max(1,Math.round(basePx*0.7));
  var px=Math.max(min,Math.floor(basePx*maxWidth/measure(text,basePx)));
  while(px>min&&measure(text,px)>maxWidth)px--;
  if(measure(text,px)<=maxWidth)return {px:px,text:text};
  px=min;
  var w=text.split(' ');
  for(var i=1;i<w.length;i++){var c='…'+w.slice(i).join(' ');if(measure(c,px)<=maxWidth)return {px:px,text:c}}
  var s=w[w.length-1];
  while(s.length>1&&measure('…'+s,px)>maxWidth)s=s.slice(1);
  return {px:px,text:'…'+s};
}
function pickLive(entries,now,syncOn,waitMs){
  var best=null,bestAt=-Infinity;
  for(var i=0;i<entries.length;i++){
    var e=entries[i],at;
    if(!syncOn)at=e.id;
    else if(e.skip)continue;
    else if(e.startedAt!=null){if(e.startedAt>now)continue;at=e.startedAt}
    else if(e.pending)continue;
    else{at=e.arrivedAt+waitMs;if(at>now)continue}
    if(best===null||at>bestAt||(at===bestAt&&e.id>best)){best=e.id;bestAt=at}
  }
  return best;
}
function nextStart(now,prevEnd,lead){return Math.max(now+lead,prevEnd)}
function backlogDrop(ahead,durs,maxSec){
  var total=Math.max(0,ahead),n=0;
  for(var i=0;i<durs.length;i++)total+=durs[i];
  while(n<durs.length-1&&total>maxSec){total-=durs[n];n++}
  return n;
}
function median(a){
  if(!a||!a.length)return null;
  var s=a.slice().sort(function(x,y){return x-y}),m=s.length>>1;
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
}
function delayLabel(ms,voice){
  var s=(Math.round(ms/100)/10).toFixed(1).replace('.',',');
  return {text:(voice?'voz ':'atraso ')+s+' s',level:ms<3000?'ok':ms<=6000?'warn':'bad'};
}
var SETTINGS_DEFAULTS={mode:'translation',showOrig:false,volume:0.9,sync:true,size:0,theme:'auto',autoScroll:true,showTimes:true,showDelay:true};
var SIZE_MIN=-3,SIZE_MAX=7,MODES=['translation','transcript','bilingual','full'],THEMES=['dark','light','auto'];
function normalizeSettings(raw){
  var s={},k;for(k in SETTINGS_DEFAULTS)s[k]=SETTINGS_DEFAULTS[k];
  if(!raw||typeof raw!=='object')return s;
  if(MODES.indexOf(raw.mode)>=0)s.mode=raw.mode;
  if(THEMES.indexOf(raw.theme)>=0)s.theme=raw.theme;
  ['showOrig','sync','autoScroll','showTimes','showDelay'].forEach(function(b){if(typeof raw[b]==='boolean')s[b]=raw[b]});
  if(typeof raw.volume==='number'&&raw.volume>=0&&raw.volume<=1)s.volume=raw.volume;
  if(typeof raw.size==='number'&&isFinite(raw.size))s.size=Math.max(SIZE_MIN,Math.min(SIZE_MAX,Math.round(raw.size)));
  return s;
}
function parseSettings(json,legacyOrig){
  var raw=null;try{raw=json?JSON.parse(json):null}catch(e){raw=null}
  var s=normalizeSettings(raw);
  if(!(raw&&typeof raw==='object'&&typeof raw.showOrig==='boolean')&&legacyOrig==='1')s.showOrig=true;
  return s;
}
function textSizes(step,vw){
  var base=Math.max(20,Math.min(36,Math.round(vw/13)));
  return {live:Math.max(20,Math.min(56,Math.round(base*(1+0.1*step)))),tx:Math.max(14,Math.min(24,17+step))};
}
function uaInfo(ua,touch){
  ua=String(ua||'');
  var b=/SamsungBrowser/.test(ua)?'samsung':/Edg\/|EdgiOS|EdgA/.test(ua)?'edge':/OPR\/|Opera/.test(ua)?'opera':/Firefox|FxiOS/.test(ua)?'firefox':/Chrome|CriOS/.test(ua)?'chrome':/Safari/.test(ua)?'safari':'other';
  var ipadOs=/Macintosh/.test(ua)&&touch>1;
  var os=/iPhone|iPad|iPod/.test(ua)||ipadOs?'ios':/Android/.test(ua)?'android':/CrOS/.test(ua)?'chromeos':/Windows/.test(ua)?'windows':/Mac OS X|Macintosh/.test(ua)?'macos':/Linux/.test(ua)?'linux':'other';
  var dev=/iPad|Tablet/.test(ua)||ipadOs||(os==='android'&&!/Mobile/.test(ua))?'tablet':/Mobi|iPhone|iPod|Android/.test(ua)?'mobile':'desktop';
  return {ua:b,os:os,device:dev};
}
function refOf(search,referrer){
  var m=/[?&](?:src|ref)=([^&#]*)/.exec(String(search||''));
  if(m&&decodeURIComponent(m[1]).toLowerCase()==='qr')return 'qr';
  return referrer?'link':'direct';
}
function lineView(mode,showOrig,lang,hasTr){
  if(lang==='orig'||mode==='transcript')return {main:'orig',sub:false,miss:false};
  if(!hasTr)return {main:'orig',sub:false,miss:true};
  return {main:'tr',sub:mode==='bilingual'||!!showOrig,miss:false};
}
`;

/** The page script (plain ES2017, no framework). Placeholders: __CODE__, __DAYS__. */
const ROOM_SCRIPT = String.raw`(function(){
'use strict';
${ROOM_PAGE_LOGIC}
var CODE=__CODE__,DAYS=__DAYS__;
var AUDIO_WAIT_MS=4000,MAX_BACKLOG_S=6,FADE_S=0.01,LEAD_S=0.05;
var $=function(id){return document.getElementById(id)};
var store={get:function(k){try{return localStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
var dn=null;try{dn=new Intl.DisplayNames(['pt-BR'],{type:'language'})}catch(e){}
function langName(c){try{var n=dn&&dn.of(c);if(n)return n.charAt(0).toUpperCase()+n.slice(1)}catch(e){}return c}
var settings=parseSettings(store.get('ucast-settings'),store.get('ucast-orig'));

// ── analytics: anonymous viewerId (localStorage), events batched to POST /v1/rooms/:code/events every 15 s and on
//    pagehide (sendBeacon). No personal data: browser family, device class, viewport, languages, settings, timings. ──
function rid(p){var a=new Uint8Array(12),i,o='';try{crypto.getRandomValues(a)}catch(e){for(i=0;i<12;i++)a[i]=Math.floor(Math.random()*256)}for(i=0;i<12;i++)o+=('0'+a[i].toString(16)).slice(-2);return p+o}
var viewerId=store.get('ucast-viewer'),returning=!!viewerId&&/^v_[A-Za-z0-9_-]{8,40}$/.test(viewerId);
if(!returning){viewerId=rid('v_');store.set('ucast-viewer',viewerId)}
var sessionId=rid('s_'),evq=[],t0=Date.now(),joined=false,left=false,visibleMs=0,visibleSince=document.visibilityState==='hidden'?null:Date.now();
var stat={gaps:0,gapMs:0,drops:0,clips:0,lines:0,drift:[],lag:[]};
function track(type,data){
  var e={t:Date.now(),type:type},k;if(data)for(k in data)e[k]=data[k];
  evq.push(e);if(evq.length>600)evq.splice(0,evq.length-600);
  if(evq.length>=100)flush(false);
}
function flush(beacon){
  while(evq.length&&!gone){
    var body=JSON.stringify({viewerId:viewerId,sessionId:sessionId,events:evq.splice(0,150)}),url='/v1/rooms/'+CODE+'/events',sent=false;
    try{if(beacon&&navigator.sendBeacon)sent=navigator.sendBeacon(url,new Blob([body],{type:'application/json'}))}catch(e){}
    if(!sent){try{fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true}).catch(function(){})}catch(e){}}
  }
}
function snapshot(){return {lang:lang||'orig',mode:settings.mode,showOrig:settings.showOrig,dub:dub,volume:settings.volume,sync:settings.sync,size:settings.size,theme:settings.theme,autoScroll:settings.autoScroll,showTimes:settings.showTimes,showDelay:settings.showDelay}}
function trackJoin(){
  if(joined)return;joined=true;var u=uaInfo(navigator.userAgent,navigator.maxTouchPoints||0);
  track('join',{ua:u.ua,os:u.os,device:u.device,vw:window.innerWidth,vh:window.innerHeight,dpr:window.devicePixelRatio||1,
    lang:String(navigator.language||''),langs:(navigator.languages||[]).slice(0,5),ref:refOf(location.search,document.referrer),returning:returning,settings:snapshot()});
}
function textDelayMedian(){var v=[];for(var i=lines.length-1;i>=0&&v.length<10;i--)if(typeof lines[i].delayMs==='number')v.push(lines[i].delayMs);return median(v)}
function trackSample(){
  if(!joined||ended||gone||!(stat.lines||stat.clips))return;
  var d={lines:stat.lines,clips:stat.clips,gaps:stat.gaps,gapMs:Math.round(stat.gapMs),drops:stat.drops,visible:document.visibilityState!=='hidden'};
  var td=textDelayMedian();if(td!=null)d.textDelayMs=Math.round(td);
  if(dub&&voiceDelays.length)d.voiceDelayMs=Math.round(median(voiceDelays));
  if(stat.drift.length)d.driftMs=Math.round(median(stat.drift));
  if(stat.lag.length)d.lagMs=Math.round(median(stat.lag));
  if(dub&&actx)d.queueMs=Math.max(0,Math.round((qEnd-actx.currentTime)*1000));
  track('sample',d);stat={gaps:0,gapMs:0,drops:0,clips:0,lines:0,drift:[],lag:[]};
}
setInterval(trackSample,30000);
setInterval(function(){flush(false)},15000);
function trackLeave(reason){
  if(left||!joined)return;left=true;trackSample();
  if(visibleSince!=null){visibleMs+=Date.now()-visibleSince;visibleSince=Date.now()}
  track('leave',{durationMs:Date.now()-t0,visibleMs:visibleMs,reason:reason});flush(true);
}
window.addEventListener('pagehide',function(){trackLeave('pagehide')});
window.addEventListener('pageshow',function(e){if(e.persisted)left=false});
document.addEventListener('visibilitychange',function(){
  var hidden=document.visibilityState==='hidden';
  if(hidden&&visibleSince!=null){visibleMs+=Date.now()-visibleSince;visibleSince=null}else if(!hidden&&visibleSince==null)visibleSince=Date.now();
  if(joined)track('visibility',{state:hidden?'hidden':'visible'});
  if(hidden)flush(true);
});
var room=null,lines=[],byId={},lang=null,dub=false,ended=false,expiresAt=null;
var ws=null,attempt=0,timer=null,gone=false;
/** Per line, on the performance.now() clock: arrivedAt (-1e12 for lines of the snapshot), clip startedAt, pending/skip. */
var meta={},liveId=null,voiceDelays=[];
function now(){return performance.now()}
function M(id){return meta[id]||(meta[id]={arrivedAt:-1e12,startedAt:null,pending:false,skip:false})}

/** What line l shows with the current settings: {main, sub|null, miss}. */
function view(l){
  var tr=l.translations&&lang!=='orig'?l.translations[lang]:null,has=tr!=null&&tr!=='';
  var v=lineView(settings.mode,settings.showOrig,lang,has);
  return {main:v.main==='tr'?tr:l.original,sub:v.sub?l.original:null,miss:v.miss};
}
function fmtDate(iso){try{return new Date(iso).toLocaleDateString('pt-BR',{day:'numeric',month:'long',year:'numeric'})}catch(e){return iso}}
function fmtTime(ts){if(!(ts>1e11))return '';try{return new Date(ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}catch(e){return ''}}

// ── settings: the viewer's own, applied instantly, kept in this browser ──
function saveSettings(){store.set('ucast-settings',JSON.stringify(settings))}
var mql=null;try{mql=window.matchMedia('(prefers-color-scheme: light)')}catch(e){}
function applyTheme(){
  document.documentElement.setAttribute('data-theme',settings.theme);
  var light=settings.theme==='light'||(settings.theme==='auto'&&mql&&mql.matches);
  var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',light?'#f6f6f8':'#1b1b1f');
}
if(mql&&mql.addEventListener)mql.addEventListener('change',applyTheme);
function applySettings(rerender){
  applyTheme();
  var b=document.body.classList;b.toggle('mode-full',settings.mode==='full');b.toggle('no-times',!settings.showTimes);
  document.documentElement.style.setProperty('--tx',textSizes(settings.size,window.innerWidth).tx+'px');
  if(outGain)outGain.gain.value=settings.volume;
  var origOk=settings.mode==='translation'||settings.mode==='full';
  var ob=$('orig');ob.setAttribute('aria-pressed',origOk&&settings.showOrig?'true':'false');ob.hidden=!origOk||lang==='orig';
  if(rerender!==false)renderAll();
  if(!sheet.hidden)syncSheet();
}
function setSetting(k,v,from){var before=settings[k];settings[k]=v;settings=normalizeSettings(settings);saveSettings();applySettings();
  if(from&&settings[k]!==before)track('setting',{key:k,value:settings[k],from:from});
  if(k==='volume'&&from){if(settings.volume===0&&before>0)track('audio',{action:'mute'});else if(before===0&&settings.volume>0)track('audio',{action:'unmute'})}}

// ── live line: one line per language, shrink to 70 %, then keep the end with a leading "…" ──
var ctx2d=null;try{ctx2d=document.createElement('canvas').getContext('2d')}catch(e){}
function fit(el,text,px){
  var cs=getComputedStyle(el),fam=cs.fontFamily,wt=cs.fontWeight,st=cs.fontStyle;
  var measure=function(s,p){
    if(ctx2d){ctx2d.font=st+' '+wt+' '+p+'px '+fam;return ctx2d.measureText(s).width}
    el.style.fontSize=p+'px';el.textContent=s;return el.scrollWidth;
  };
  var r=fitLine(text,el.clientWidth-1,px,measure);
  el.style.fontSize=r.px+'px';el.textContent=r.text;el.title=r.text===text?'':text;
}
function syncOn(){return dub&&settings.sync&&lang!=='orig'}
function currentLine(){
  var from=Math.max(0,lines.length-60),entries=[];
  for(var i=from;i<lines.length;i++){var l=lines[i],m=M(l.id);entries.push({id:l.id,arrivedAt:m.arrivedAt,startedAt:m.startedAt,pending:m.pending,skip:m.skip})}
  var id=pickLive(entries,now(),syncOn(),AUDIO_WAIT_MS);
  if(id==null)id=liveId!=null&&byId[liveId]?liveId:(lines.length?lines[lines.length-1].id:null);
  return id==null?null:byId[id];
}
function renderLive(){
  var main=$('liveMain'),orig=$('liveOrig'),l=currentLine();
  var base=textSizes(settings.size,window.innerWidth).live;
  markCurrent(l?l.id:null);
  if(settings.mode==='full')return;
  if(!l){main.className='fit empty';main.style.fontSize='';main.title='';main.textContent=ended?'Nenhuma fala nesta sessão.':'Aguardando a primeira fala…';orig.hidden=true;return}
  var v=view(l);
  main.className='fit'+(v.miss?' empty':'');
  fit(main,v.main,base);
  if(v.sub){orig.hidden=false;fit(orig,v.sub,Math.round(base*0.62))}else orig.hidden=true;
}
function markCurrent(id){
  if(id===liveId)return;
  var tx=$('tx'),old=liveId!=null?tx.querySelector('p[data-id="'+liveId+'"]'):null;if(old)old.classList.remove('cur');
  liveId=id;var el=id!=null?tx.querySelector('p[data-id="'+id+'"]'):null;if(el)el.classList.add('cur');
}

// ── delay indicator: rolling median of the last 10 lines (text) or of the last 10 clips (voice) ──
function updateDelay(){
  var el=$('delay');
  if(ended||gone||!settings.showDelay){el.hidden=true;return}
  var voice=dub&&lang!=='orig'&&voiceDelays.length>0,vals=[];
  if(voice)vals=voiceDelays.slice(-10);
  else for(var i=lines.length-1;i>=0&&vals.length<10;i--)if(typeof lines[i].delayMs==='number')vals.push(lines[i].delayMs);
  var m=median(vals);if(m==null){el.hidden=true;return}
  var d=delayLabel(m,voice);el.hidden=false;el.textContent=d.text;el.className='delay '+d.level;
  el.title=voice?'Atraso da voz em relação à fala (mediana das últimas falas)':'Atraso da legenda em relação à fala (mediana das últimas 10 falas)';
}

// ── transcript ──
function atBottom(){return window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-80}
function para(l){
  var p=document.createElement('p'),v=view(l);
  p.setAttribute('data-id',String(l.id));if(v.miss)p.className='miss';if(l.id===liveId)p.classList.add('cur');
  var tm=fmtTime(l.ts);if(tm){var e=document.createElement('time');e.className='ts';e.textContent=tm;e.dateTime=new Date(l.ts).toISOString();p.appendChild(e)}
  var s=document.createElement('span');s.className='t';s.textContent=v.main;p.appendChild(s);
  if(v.sub){var o=document.createElement('span');o.className='o';o.textContent=v.sub;p.appendChild(o)}
  return p;
}
var firstRender=true;
function renderAll(){
  var tx=$('tx'),stick=firstRender||(settings.autoScroll&&atBottom());tx.textContent='';
  var frag=document.createDocumentFragment();for(var i=0;i<lines.length;i++)frag.appendChild(para(lines[i]));tx.appendChild(frag);
  if(lines.length)firstRender=false;
  renderLive();updateDelay();if(stick)scrollEnd();
}
function scrollEnd(){window.scrollTo(0,document.documentElement.scrollHeight);$('more').style.display='none'}
function upsert(l){
  var stick=settings.autoScroll&&atBottom(),tx=$('tx'),old=byId[l.id];
  if(old){lines[lines.indexOf(old)]=l;byId[l.id]=l;var el=tx.querySelector('p[data-id="'+l.id+'"]');if(el)tx.replaceChild(para(l),el)}
  else{
    byId[l.id]=l;M(l.id).arrivedAt=now();stat.lines++;if(l.ts>1e11)stat.lag.push(Date.now()-l.ts);var i=lines.length;while(i>0&&lines[i-1].id>l.id)i--;lines.splice(i,0,l);
    var next=lines[i+1]?tx.querySelector('p[data-id="'+lines[i+1].id+'"]'):null;tx.insertBefore(para(l),next);
    if(dub)setTimeout(renderLive,AUDIO_WAIT_MS+20);
  }
  renderLive();updateDelay();
  if(stick)scrollEnd();else if(!atBottom())$('more').style.display='block';
}

// ── languages ──
function pickDefault(){
  var prefs=(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||'']);
  var saved=store.get('ucast-lang-'+CODE);
  if(!(saved&&(saved==='orig'||room.languages.indexOf(saved)>=0)))saved=store.get('ucast-lang-last');
  return pickLang(prefs,room.languages,saved);
}
function fillLangSelect(sel){
  sel.textContent='';
  var o=document.createElement('option');o.value='orig';o.textContent=room.originalLang?'Original ('+langName(room.originalLang)+')':'Original';sel.appendChild(o);
  room.languages.forEach(function(c){var x=document.createElement('option');x.value=c;x.textContent=langName(c);sel.appendChild(x)});
  sel.value=lang;
}
function buildSelect(){
  if(!lang)lang=pickDefault();
  fillLangSelect($('lang'));fillLangSelect($('sLang'));
  updateDubButton();applySettings(false);
}
function setLang(v,from){
  if(from&&v!==lang)track('setting',{key:'lang',value:v,from:from});
  lang=v;store.set('ucast-lang-'+CODE,lang);store.set('ucast-lang-last',lang);$('lang').value=v;$('sLang').value=v;
  stopAudio();voiceDelays=[];sendListen();updateDubButton();applySettings();
}
$('lang').addEventListener('change',function(e){setLang(e.target.value,'toolbar')});
$('sLang').addEventListener('change',function(e){setLang(e.target.value,'sheet')});
$('orig').addEventListener('click',function(){if(settings.mode==='full'||settings.mode==='translation')setSetting('showOrig',!settings.showOrig,'toolbar')});
var relayout=null;function onResize(){if(relayout)cancelAnimationFrame(relayout);relayout=requestAnimationFrame(function(){relayout=null;document.documentElement.style.setProperty('--tx',textSizes(settings.size,window.innerWidth).tx+'px');renderLive();if(!sheet.hidden)placeSheet()})}
window.addEventListener('resize',onResize);window.addEventListener('orientationchange',onResize);

// ── dubbing: Web Audio, one AudioContext (created by the tap), clips decoded and scheduled back to back on its
//    timeline with a 10 ms fade in/out (no clicks); the live line switches when a clip STARTS playing ──
var actx=null,outGain=null,qEnd=0,pending=[],playingSrc=[],pumpTimer=null;
function b64Buf(b64){var bin=atob(b64),n=bin.length,u=new Uint8Array(n);for(var i=0;i<n;i++)u[i]=bin.charCodeAt(i);return u.buffer}
function ensureContext(){
  if(!actx){var AC=window.AudioContext||window.webkitAudioContext;if(!AC)return false;
    try{actx=new AC();outGain=actx.createGain();outGain.gain.value=settings.volume;outGain.connect(actx.destination)}catch(e){actx=null;return false}}
  try{if(actx.state!=='running'&&actx.resume)actx.resume()}catch(e){}
  try{var b=actx.createBuffer(1,1,22050),s=actx.createBufferSource();s.buffer=b;s.connect(actx.destination);s.start(0)}catch(e){}
  return true;
}
function stopAudio(){
  pending=[];if(pumpTimer){clearTimeout(pumpTimer);pumpTimer=null}
  playingSrc.forEach(function(s){try{s.stop()}catch(e){}});playingSrc=[];qEnd=0;
  var t=now();for(var k in meta){var m=meta[k];m.pending=false;if(m.startedAt!=null&&m.startedAt>t)m.startedAt=null}
}
function pump(){
  pumpTimer=null;if(!dub||!actx)return;
  var t=actx.currentTime,durs=pending.map(function(c){return c.buf?c.buf.duration:0});
  var n=backlogDrop(qEnd-t,durs,MAX_BACKLOG_S);
  if(n){stat.drops+=n;track('audio',{action:'drop',n:n})}
  for(var i=0;i<n;i++){var d=pending.shift(),m=M(d.lineId);if(m.startedAt==null){m.pending=false;m.skip=true}}
  while(pending.length&&pending[0].buf&&qEnd-actx.currentTime<0.5)schedule(pending.shift());
  if(pending.length)pumpTimer=setTimeout(pump,100);
}
function schedule(c){
  var start=nextStart(actx.currentTime,qEnd,LEAD_S),dur=c.buf.duration;
  if(qEnd>0){var gap=start-qEnd;if(gap>0.02&&gap<3){stat.gaps++;stat.gapMs+=gap*1000}}
  var src=actx.createBufferSource(),g=actx.createGain(),f=Math.min(FADE_S,dur/4);
  src.buffer=c.buf;
  g.gain.setValueAtTime(0,start);g.gain.linearRampToValueAtTime(1,start+f);
  g.gain.setValueAtTime(1,start+dur-f);g.gain.linearRampToValueAtTime(0,start+dur);
  src.connect(g);g.connect(outGain);src.start(start);
  src.onended=function(){var i=playingSrc.indexOf(src);if(i>=0)playingSrc.splice(i,1);try{g.disconnect()}catch(e){}};
  playingSrc.push(src);qEnd=start+dur;
  var m=M(c.lineId),at=now()+(start-actx.currentTime)*1000;
  if(m.startedAt==null){m.startedAt=at;m.pending=false;m.skip=false;setTimeout(function(){onClipStart(c.lineId)},Math.max(0,at-now()))}
}
function onClipStart(id){
  var m=meta[id],l=byId[id];stat.clips++;
  if(m&&m.arrivedAt>0&&m.startedAt!=null)stat.drift.push(syncOn()?now()-m.startedAt:m.startedAt-m.arrivedAt);
  if(m&&l&&m.arrivedAt>0&&m.startedAt!=null){voiceDelays.push((typeof l.delayMs==='number'?l.delayMs:0)+(m.startedAt-m.arrivedAt));if(voiceDelays.length>10)voiceDelays.shift()}
  renderLive();updateDelay();
}
function onAudio(msg){
  if(!dub||!actx||msg.lang!==lang)return;
  var m=M(msg.lineId);if(m.startedAt==null){m.pending=true;m.skip=false}
  var c={lineId:msg.lineId,buf:null};pending.push(c);
  var fail=function(){track('audio',{action:'decode_error'});var i=pending.indexOf(c);if(i>=0)pending.splice(i,1);if(m.startedAt==null)m.pending=false;renderLive();pump()};
  var ab;try{ab=b64Buf(msg.wav)}catch(e){fail();return}
  try{var p=actx.decodeAudioData(ab,function(buf){c.buf=buf;pump()},fail);if(p&&p.catch)p.catch(function(){})}catch(e){fail()}
}
function canDub(){return lang!=='orig'&&!ended}
function updateDubButton(){
  var b=$('dub'),can=canDub();b.disabled=!can;
  b.title=can?'':'Escolha um idioma de tradução para ouvir a dublagem';
  if(!can&&dub)setDub(false,'auto');
}
function setDub(on,from){
  if(on&&!ensureContext()){$('notice').textContent='Este navegador não reproduz a dublagem.';on=false;track('audio',{action:'unsupported'})}
  if(from&&on!==dub){track('setting',{key:'dub',value:on,from:from});track('audio',{action:on?'play':'pause'})}
  dub=on;var b=$('dub');b.setAttribute('aria-pressed',on?'true':'false');b.querySelector('.ic').textContent=on?'🔊':'🔈';
  if(!on){stopAudio();voiceDelays=[]}
  sendListen();renderLive();updateDelay();if(!sheet.hidden)syncSheet();
}
$('dub').addEventListener('click',function(){setDub(!dub,'toolbar')});

// ── settings sheet (bottom sheet on phones, popover from 768 px): focus trap, Esc / backdrop close ──
var sheet=$('sheet'),backdrop=$('backdrop'),opener=null;
function radios(name){return Array.prototype.slice.call(sheet.querySelectorAll('input[name="'+name+'"]'))}
function syncSheet(){
  $('sLang').value=lang||'orig';
  radios('sMode').forEach(function(r){r.checked=r.value===settings.mode});
  radios('sTheme').forEach(function(r){r.checked=r.value===settings.theme});
  var origOk=settings.mode==='translation'||settings.mode==='full';
  $('sOrig').checked=settings.mode==='bilingual'||settings.showOrig;$('sOrig').disabled=!origOk;$('sOrigRow').classList.toggle('off',!origOk);
  $('sDub').checked=dub;$('sDub').disabled=!canDub();
  $('sVol').value=String(Math.round(settings.volume*100));$('sVol').setAttribute('aria-valuetext',Math.round(settings.volume*100)+'%');
  $('sSync').checked=settings.sync;
  $('sSize').textContent=(100+settings.size*10)+'%';$('sSmaller').disabled=settings.size<=SIZE_MIN;$('sBigger').disabled=settings.size>=SIZE_MAX;
  $('sScroll').checked=settings.autoScroll;$('sTimes').checked=settings.showTimes;$('sDelay').checked=settings.showDelay;
}
function placeSheet(){
  if(window.innerWidth>=768){var r=$('gear').getBoundingClientRect(),top=Math.round(r.bottom+8);
    sheet.style.top=top+'px';sheet.style.right=Math.max(16,Math.round(window.innerWidth-r.right))+'px';sheet.style.maxHeight=Math.max(240,window.innerHeight-top-16)+'px'}
  else{sheet.style.top='';sheet.style.right='';sheet.style.maxHeight=''}
}
function focusables(){return Array.prototype.filter.call(sheet.querySelectorAll('button,select,input'),function(e){return !e.disabled&&e.getClientRects().length>0})}
function openSheet(){
  track('ui',{action:'sheet_open'});
  opener=document.activeElement;syncSheet();backdrop.hidden=false;sheet.hidden=false;placeSheet();
  $('gear').setAttribute('aria-expanded','true');$('sLang').focus();
}
function closeSheet(){
  if(sheet.hidden)return;track('ui',{action:'sheet_close'});sheet.hidden=true;backdrop.hidden=true;$('gear').setAttribute('aria-expanded','false');
  var o=opener&&opener.focus?opener:$('gear');try{o.focus()}catch(e){}
}
$('gear').addEventListener('click',function(){if(sheet.hidden)openSheet();else closeSheet()});
$('sClose').addEventListener('click',closeSheet);
backdrop.addEventListener('click',closeSheet);
sheet.addEventListener('keydown',function(e){
  if(e.key==='Escape'||e.key==='Esc'){e.preventDefault();closeSheet();return}
  if(e.key!=='Tab')return;
  var f=focusables();if(!f.length){e.preventDefault();return}
  var a=f[0],z=f[f.length-1];
  if(e.shiftKey&&(document.activeElement===a||document.activeElement===sheet)){e.preventDefault();z.focus()}
  else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}
});
radios('sMode').forEach(function(r){r.addEventListener('change',function(){if(r.checked)setSetting('mode',r.value,'sheet')})});
radios('sTheme').forEach(function(r){r.addEventListener('change',function(){if(r.checked)setSetting('theme',r.value,'sheet')})});
$('sOrig').addEventListener('change',function(e){setSetting('showOrig',e.target.checked,'sheet')});
$('sDub').addEventListener('change',function(e){setDub(e.target.checked,'sheet')});
var volFrom=null;
$('sVol').addEventListener('input',function(e){if(volFrom==null)volFrom=settings.volume;setSetting('volume',Number(e.target.value)/100)});
$('sVol').addEventListener('change',function(e){var b=volFrom==null?settings.volume:volFrom;volFrom=null;settings.volume=b;setSetting('volume',Number(e.target.value)/100,'sheet')});
$('sSync').addEventListener('change',function(e){setSetting('sync',e.target.checked,'sheet')});
$('sSmaller').addEventListener('click',function(){setSetting('size',settings.size-1,'sheet')});
$('sBigger').addEventListener('click',function(){setSetting('size',settings.size+1,'sheet')});
$('sScroll').addEventListener('change',function(e){setSetting('autoScroll',e.target.checked,'sheet')});
$('sTimes').addEventListener('change',function(e){setSetting('showTimes',e.target.checked,'sheet')});
$('sDelay').addEventListener('change',function(e){setSetting('showDelay',e.target.checked,'sheet')});

// ── copy ──
$('copy').addEventListener('click',function(){
  track('ui',{action:'copy'});
  var t=lines.map(function(l){var v=view(l);return v.sub?v.main+'\n'+v.sub:v.main}).join('\n\n');
  var b=$('copyLbl'),label=b.textContent;
  var ok=function(){b.textContent='Copiado!';b.classList.remove('lg');setTimeout(function(){b.textContent=label;b.classList.add('lg')},1600)};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,fallback)}else fallback();
  function fallback(){var a=document.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();try{document.execCommand('copy');ok()}catch(e){}document.body.removeChild(a)}
});
$('more').addEventListener('click',function(){track('ui',{action:'more'});scrollEnd()});
window.addEventListener('scroll',function(){if(atBottom())$('more').style.display='none'},{passive:true});

// ── state ──
function setPill(kind,text){var p=$('pill');p.className='pill '+kind;p.textContent=text}
function showEnded(){
  if(!ended&&joined)track('ui',{action:'ended'});
  ended=true;setPill('','encerrada');setDub(false);updateDubButton();
  var until=expiresAt||new Date(Date.now()+DAYS*864e5).toISOString();
  $('notice').textContent='Sessão encerrada — texto disponível até '+fmtDate(until)+'.';
  renderLive();updateDelay();
}
function applyRoom(r){
  room=r;expiresAt=r.expiresAt||null;lines=[];byId={};
  (r.lines||[]).forEach(function(l){byId[l.id]=l;lines.push(l);M(l.id)});lines.sort(function(a,b){return a.id-b.id});
  var t=r.title||'Legendas ao vivo';$('title').textContent=t;document.title=t+' · ucast.me';
  buildSelect();renderAll();trackJoin();
  if(r.ended)showEnded();
}
function notFound(){gone=true;setPill('','encerrada');updateDelay();$('notice').textContent='Esta sessão não existe mais (o texto fica disponível por '+DAYS+' dias após a última fala).';}

// ── socket, reconnect with backoff ──
function sendListen(){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'listen',lang:dub&&lang!=='orig'?lang:null}))}
function connect(){
  if(ended||gone)return;
  var proto=location.protocol==='https:'?'wss:':'ws:';
  var s;try{s=new WebSocket(proto+'//'+location.host+'/v1/rooms/'+CODE+'/ws')}catch(e){retry();return}
  ws=s;var opened=false,ping=null;
  s.onopen=function(){opened=true;attempt=0;sendListen();ping=setInterval(function(){if(s.readyState===1)s.send('{"type":"ping"}')},20000)};
  s.onmessage=function(ev){var m;try{m=JSON.parse(ev.data)}catch(e){return}
    if(m.type==='snapshot'){applyRoom(m.room);if(!m.room.ended){setPill('live','ao vivo');$('notice').textContent=''}}
    else if(m.type==='line'&&room)upsert(m.line);
    else if(m.type==='audio')onAudio(m);
    else if(m.type==='ended')showEnded();};
  s.onclose=function(){if(ping)clearInterval(ping);if(ws===s)ws=null;if(ended||gone)return;
    setPill('wait','reconectando…');if(joined)track('ui',{action:'reconnect'});
    if(!opened){fetch('/v1/rooms/'+CODE,{cache:'no-store'}).then(function(r){if(r.status===404)notFound();else retry()},retry)}else retry();};
}
function retry(){if(ended||gone||timer)return;var d=Math.min(15000,1000*Math.pow(2,attempt++))*(0.75+Math.random()*0.5);
  timer=setTimeout(function(){timer=null;connect()},d)}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&!ws&&!ended&&!gone){if(timer){clearTimeout(timer);timer=null}attempt=0;connect()}});

applySettings(false);
fetch('/v1/rooms/'+CODE,{cache:'no-store'}).then(function(r){if(r.status===404){notFound();return null}return r.ok?r.json():null})
  .then(function(r){if(r&&!room)applyRoom(r)},function(){}).then(function(){if(!gone)connect()});
})();`;

export function roomPage(code: string, opts: PageOptions): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const script = ROOM_SCRIPT.replace('__CODE__', js(code)).replace('__DAYS__', js(opts.retentionDays));
  return { html: shell('Legendas ao vivo · ucast.me', ROOM_CSS, ROOM_BODY, script, nonce), nonce };
}
