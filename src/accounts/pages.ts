// ── AI Gateway — ucast.me accounts: pages ────────────────────────────────────
// Self-contained HTML like the live page (src/rooms/page.ts): inline CSS/JS under a per-response CSP nonce, no CDN,
// mobile first, pt-BR, same palette. The pages only call the same-origin JSON API (/v1/account/*).

import { randomBytes } from 'crypto';
import { PAGE_STRINGS, type PageLang } from './page-strings';

export interface RenderedPage { html: string; nonce: string }

export interface PageLinks {
  home: string; signup: string; login: string; forgot: string; reset: string; account: string;
  download: string; lang: PageLang;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c] ?? c);
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%234cc3cb'/%3E%3Crect x='7' y='12' width='18' height='3' rx='1.5' fill='%2304161a'/%3E%3Crect x='10' y='18' width='12' height='3' rx='1.5' fill='%2304161a'/%3E%3C/svg%3E";

/** The logo always goes to the public landing page, even on the account hosts. */
const LANDING_URL = 'https://ucast.me/';

export function accountPageCsp(nonce: string): string {
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`, "connect-src 'self'", 'img-src data:',
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}

const CSS = `
:root{color-scheme:dark;--bg:#0a1012;--surface:#0f181b;--surface2:#122025;--line:rgba(233,244,245,.1);--line-strong:rgba(233,244,245,.18);--text:#e9f2f3;--muted:#8ba5a8;--accent:#4cc3cb;--accent-ink:#04161a;--accent-dim:rgba(76,195,203,.38);--warn:#e0a458;--bad:#ff7d7d;--ok:#5fd39a}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f7f7;--surface:#fff;--surface2:#eef3f4;--line:rgba(10,35,38,.12);--line-strong:rgba(10,35,38,.22);--text:#0e1e21;--muted:#5b7377;--accent:#0b6b72;--accent-ink:#fff;--accent-dim:rgba(11,107,114,.35);--warn:#8a5a00;--bad:#c4262e;--ok:#1d7a4b}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%;line-height:1.5}
::selection{background:var(--accent);color:var(--accent-ink)}
a{color:var(--accent)}
button,input{font:inherit;color:inherit}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:56rem;margin:0 auto;padding:16px max(16px,env(safe-area-inset-left));border-bottom:1px solid var(--line)}
.brand{font-family:ui-monospace,"SF Mono","Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;font-weight:700;letter-spacing:-.02em;color:var(--text);text-decoration:none;font-size:1.15rem}.brand b{color:var(--accent)}
main{max-width:56rem;margin:0 auto;padding:8px 16px 48px}
.narrow{max-width:26rem;margin:4vh auto 0}
h1{font-size:1.5rem;margin:8px 0 6px;letter-spacing:-.02em}h2{font-size:1.1rem;margin:0 0 4px;letter-spacing:-.01em}
p.lead{color:var(--muted);margin:0 0 20px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 16px}
label{display:block;font-weight:600;font-size:.92rem;margin:14px 0 6px}
input[type=email],input[type=password],input[type=text]{width:100%;background:var(--bg);border:1px solid var(--line-strong);border-radius:10px;padding:12px 14px;font-size:1rem}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;background:var(--accent);color:var(--accent-ink);border:0;border-radius:10px;padding:0 18px;font-weight:700;cursor:pointer;text-decoration:none;transition:transform .12s cubic-bezier(.16,1,.3,1)}
.btn:hover{filter:brightness(1.08)}
.btn:active{transform:translateY(1px)}
.btn.full{width:100%;margin-top:18px}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line-strong)}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent);filter:none}
.btn.danger{background:transparent;color:var(--bad);border:1px solid var(--line);min-height:36px;padding:0 12px;font-weight:600}
.btn.danger:hover{border-color:var(--bad);filter:none}
.btn[disabled]{opacity:.6;cursor:wait}
.hint{color:var(--muted);font-size:.88rem;margin:6px 0 0}
.alt{color:var(--muted);text-align:center;margin:18px 0 0;font-size:.95rem}
.msg{border-radius:10px;padding:10px 12px;margin:14px 0 0;font-size:.95rem}
.msg:empty{display:none}
.msg.err{background:rgba(255,125,125,.12);color:var(--bad)}
.msg.ok{background:rgba(95,211,154,.12);color:var(--ok)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.keybox{display:flex;gap:8px;align-items:stretch;margin:10px 0 6px}
.keybox code{flex:1;min-width:0;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--accent);border-radius:10px;padding:12px;font-size:.95rem}
.keys{list-style:none;margin:12px 0 0;padding:0}
.keys li{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding:12px 0}
.keys .name{font-weight:600}.keys .meta{color:var(--muted);font-size:.85rem}
.keys .off{opacity:.55}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:12px;margin-top:12px}
.stat{background:var(--surface2);border-radius:12px;padding:14px}
.stat .v{font-size:1.35rem;font-weight:700}.stat .l{color:var(--muted);font-size:.85rem}
.bar{height:6px;border-radius:3px;background:var(--line);margin-top:8px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:.9rem}
th,td{text-align:right;padding:6px 8px;border-top:1px solid var(--line);white-space:nowrap}th:first-child,td:first-child{text-align:left}
th{color:var(--muted);font-weight:600}
.scroll{overflow-x:auto}
.hero{text-align:center;padding:8vh 0 4vh}.hero h1{font-size:2rem}.hero p{color:var(--muted);max-width:32rem;margin:0 auto 24px}
.hero .row{justify-content:center}.hero .hint{margin-top:18px}
.users{list-style:none;margin:12px 0 0;padding:0}
.users li{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding:12px 0}
.users .name{font-weight:600}.users .meta{color:var(--muted);font-size:.85rem}
#uq{margin:12px 0 4px}
#kf{margin-top:12px}#dev{flex:1;min-width:12rem;width:auto}#who{margin:0}.btnrow{margin:12px 0 0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:480px){.keybox{flex-direction:column}.top{padding:12px 16px}}
`;

const stringsOf = (links: PageLinks) => PAGE_STRINGS[links.lang];

function shell(title: string, body: string, script: string, nonce: string, links: PageLinks, nav = ''): string {
  const t = stringsOf(links);
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a1012">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="icon" href="${ICON}">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header class="top"><a class="brand" href="${LANDING_URL}" title="${esc(t.home)}">ucast<b>.me</b></a><nav class="row">${nav}</nav></header>
<main id="main">
${body}
</main>
${script ? `<script nonce="${nonce}">var L=${js({ ...t.client, locale: t.locale })};${COMMON_JS}${script}</script>` : ''}
</body>
</html>`;
}

/** Shared helpers: `api()` (JSON, same-origin cookie, CSRF header) and form wiring. */
const COMMON_JS = `
var CSRF='';
function $(id){return document.getElementById(id)}
function api(path,method,body){
  var h={'Accept':'application/json'};
  if(body!==undefined)h['Content-Type']='application/json';
  if(CSRF)h['X-CSRF-Token']=CSRF;
  return fetch(path,{method:method||'GET',headers:h,credentials:'same-origin',body:body===undefined?undefined:JSON.stringify(body)})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(j){return {status:r.status,ok:r.ok,body:j}})});
}
function errText(res){var e=(res.body&&res.body.error)||{};return L.errors[e.code]||(L.locale==='pt-BR'&&e.message)||L.generic}
function fill(text,vars){return text.replace(/\\{(\\w+)\\}/g,function(_,k){return vars[k]})}
function show(el,text,kind){el.className='msg '+(kind||'err');el.textContent=text||''}
function busy(btn,on,label){btn.disabled=on;if(label)btn.textContent=label}
`;

function formPage(title: string, heading: string, lead: string, fields: string, button: string, alt: string, script: string, links: PageLinks): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const body = `<div class="narrow"><h1>${heading}</h1><p class="lead">${lead}</p>
<form id="f" class="card" novalidate>${fields}
<div id="m" class="msg" role="alert" aria-live="polite"></div>
<button id="b" class="btn full" type="submit">${button}</button></form>
<p class="alt">${alt}</p></div>`;
  return { html: shell(title, body, script, nonce, links), nonce };
}

const emailField = (links: PageLinks) => `<label for="email">${esc(stringsOf(links).email)}</label><input id="email" name="email" type="email" autocomplete="email" inputmode="email" required autofocus>`;

export function signupPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  return formPage(t.signupTitle, t.signupHeading, t.signupLead,
    `${emailField(links)}<label for="password">${t.password}</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required aria-describedby="ph"><p id="ph" class="hint">${t.minLength}</p>`,
    t.signupButton, `${t.haveAccount} <a href="${esc(links.login)}">${t.signIn}</a>`,
    `(function(){var f=$('f'),b=$('b'),m=$('m');f.addEventListener('submit',function(e){e.preventDefault();show(m,'');
var email=$('email').value.trim(),pw=$('password').value;
if(!email||email.indexOf('@')<1){show(m,L.invalidEmail);$('email').focus();return}
if(pw.length<8){show(m,L.shortPassword);$('password').focus();return}
busy(b,true,L.creating);api('/v1/account/signup','POST',{email:email,password:pw}).then(function(r){
if(r.ok){location.href=${js(links.account)};return}busy(b,false,L.signupButton);show(m,errText(r))},function(){busy(b,false,L.signupButton);show(m,L.offline)})})})();`,
    links);
}

export function loginPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  return formPage(t.loginTitle, t.signIn, t.loginLead,
    `${emailField(links)}<label for="password">${t.password}</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<p class="hint"><a href="${esc(links.forgot)}">${t.forgotLink}</a></p>`,
    t.signIn, `${t.noAccount} <a href="${esc(links.signup)}">${t.signupButton}</a>`,
    `(function(){var f=$('f'),b=$('b'),m=$('m');f.addEventListener('submit',function(e){e.preventDefault();show(m,'');
var email=$('email').value.trim(),pw=$('password').value;if(!email||!pw){show(m,L.emailAndPassword);return}
busy(b,true,L.signingIn);api('/v1/account/login','POST',{email:email,password:pw}).then(function(r){
if(r.ok){location.href=${js(links.account)};return}busy(b,false,L.signIn);show(m,errText(r))},function(){busy(b,false,L.signIn);show(m,L.offline)})})})();`,
    links);
}

export function forgotPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  return formPage(t.forgotTitle, t.forgotHeading, t.forgotLead,
    emailField(links), t.forgotButton, `<a href="${esc(links.login)}">${t.backToLogin}</a>`,
    `(function(){var f=$('f'),b=$('b'),m=$('m');f.addEventListener('submit',function(e){e.preventDefault();show(m,'');
var email=$('email').value.trim();if(!email||email.indexOf('@')<1){show(m,L.invalidEmail);return}
busy(b,true,L.sending);api('/v1/account/password/forgot','POST',{email:email}).then(function(r){busy(b,false,L.forgotButton);
if(r.ok){show(m,L.forgotSent,'ok');return}show(m,errText(r))},
function(){busy(b,false,L.forgotButton);show(m,L.offline)})})})();`,
    links);
}

export function resetPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  return formPage(t.resetTitle, t.resetHeading, t.resetLead,
    `<label for="password">${t.newPassword}</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required autofocus aria-describedby="ph"><p id="ph" class="hint">${t.minLength}</p>`,
    t.resetButton, `<a href="${esc(links.login)}">${t.backToLogin}</a>`,
    `(function(){var f=$('f'),b=$('b'),m=$('m');var t=(location.hash.match(/token=([A-Za-z0-9_-]+)/)||[])[1]||'';
if(t&&history.replaceState)history.replaceState(null,'',location.pathname);
if(!t){show(m,L.resetIncomplete);b.disabled=true}
f.addEventListener('submit',function(e){e.preventDefault();show(m,'');var pw=$('password').value;
if(pw.length<8){show(m,L.shortPassword);return}
busy(b,true,L.saving);api('/v1/account/password/reset','POST',{token:t,password:pw}).then(function(r){
if(r.ok){show(m,L.resetDone,'ok');setTimeout(function(){location.href=${js(links.login)}},1200);return}
busy(b,false,L.resetButton);show(m,errText(r))},function(){busy(b,false,L.resetButton);show(m,L.offline)})})})();`,
    links);
}

export function homePage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  const nonce = randomBytes(16).toString('base64');
  const body = `<section class="hero"><h1>${t.heroTitle}</h1>
<p>${t.heroLead}</p>
<div class="row"><a class="btn" href="${esc(links.signup)}">${t.heroSignup}</a><a class="btn ghost" href="${esc(links.login)}">${t.signIn}</a></div>
<p class="hint"><a href="${esc(links.download)}">${t.downloadApp}</a></p></section>`;
  return { html: shell('ucast.me', body, '', nonce, links), nonce };
}

export function dashboardPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  const nonce = randomBytes(16).toString('base64');
  const nav = `<span id="who" class="hint"></span><button id="out" class="btn ghost" type="button">${t.signOut}</button>`;
  const body = `<h1>${t.dashHeading}</h1><p class="lead" id="lead">${t.loading}</p>
<div id="gm" class="msg" role="alert" aria-live="polite"></div>
<section class="card" aria-labelledby="kh"><h2 id="kh">${t.keyHeading}</h2>
<p class="hint">${t.keyHint}</p>
<form id="kf" class="row"><label class="sr" for="dev">${t.deviceLabel}</label>
<input id="dev" type="text" maxlength="60" placeholder="${esc(t.devicePlaceholder)}" autocomplete="off">
<button id="kb" class="btn" type="submit">${t.createKey}</button></form>
<div id="new" hidden><p class="msg ok">${t.copyNow}</p>
<div class="keybox"><code id="nk"></code><button id="copy" class="btn" type="button">${t.copy}</button></div></div>
<div id="km" class="msg" role="alert" aria-live="polite"></div>
<ul id="keys" class="keys" aria-label="${esc(t.yourKeys)}"></ul></section>
<section class="card" aria-labelledby="uh"><h2 id="uh">${t.usageHeading}</h2><p class="hint" id="plan"></p>
<div class="grid" id="stats"></div>
<div class="scroll"><table id="days"><caption class="sr">${t.usageCaption}</caption><thead><tr><th scope="col">${t.day}</th><th scope="col">${t.transcription}</th><th scope="col">${t.translation}</th><th scope="col">${t.dubbing}</th><th scope="col">${t.rooms}</th><th scope="col">${t.requests}</th></tr></thead><tbody></tbody></table></div></section>
<section class="card" aria-labelledby="dh"><h2 id="dh">${t.downloadApp}</h2><p class="hint">${t.downloadHint}</p>
<p class="btnrow"><a class="btn" href="${esc(links.download)}" rel="noopener">${t.downloadButton}</a></p></section>
<section class="card" id="admin" aria-labelledby="ah" hidden><h2 id="ah">${t.usersHeading}</h2>
<p class="hint">${t.usersHint}</p>
<label class="sr" for="uq">${t.searchUser}</label><input id="uq" type="text" placeholder="${esc(t.searchPlaceholder)}" autocomplete="off">
<div id="um" class="msg" role="alert" aria-live="polite"></div>
<ul id="users" class="users" aria-label="${esc(t.usersHeading)}"></ul></section>`;
  const script = `(function(){
var gm=$('gm'),km=$('km');
function fmtMin(s){return (s/60).toLocaleString(L.locale,{maximumFractionDigits:s<600?1:0})}
function n(x){return Math.round(x).toLocaleString(L.locale)}
function when(s){return s?new Date(s).toLocaleString(L.locale,{dateStyle:'short',timeStyle:'short'}):L.never}
function stat(label,used,limit,fmt,unit){var d=document.createElement('div');d.className='stat';
var v=document.createElement('div');v.className='v';v.textContent=fmt(used)+(unit?' '+unit:'');
var l=document.createElement('div');l.className='l';l.textContent=label+(limit>0?' · '+L.limit+' '+fmt(limit)+(unit?' '+unit:''):' · '+L.noLimit);
d.appendChild(v);d.appendChild(l);if(limit>0){var b=document.createElement('div');b.className='bar';var i=document.createElement('i');
i.style.width=Math.min(100,used/limit*100)+'%';b.appendChild(i);d.appendChild(b)}return d}
function renderKeys(list){var ul=$('keys');ul.textContent='';
if(!list.length){var li=document.createElement('li');li.className='meta';li.textContent=L.noKeys;ul.appendChild(li);return}
list.forEach(function(k){var li=document.createElement('li');if(!k.active)li.className='off';
var info=document.createElement('div');var nm=document.createElement('div');nm.className='name';nm.textContent=k.deviceName;
var meta=document.createElement('div');meta.className='meta';meta.textContent=k.prefix+'…  ·  '+L.created+' '+when(k.createdAt)+'  ·  '+L.lastUse+' '+when(k.lastUsedAt)+(k.appVersion?'  ·  '+L.app+' '+k.appVersion:'')+(k.active?'':'  ·  '+L.revoked);
info.appendChild(nm);info.appendChild(meta);li.appendChild(info);
if(k.active){var b=document.createElement('button');b.className='btn danger';b.type='button';b.textContent=L.revoke;
b.setAttribute('aria-label',L.revokeKeyOf+k.deviceName);
b.addEventListener('click',function(){if(!confirm(fill(L.revokeConfirm,{name:k.deviceName})))return;
busy(b,true);api('/v1/account/keys/'+encodeURIComponent(k.id),'DELETE').then(function(r){if(!r.ok){busy(b,false);show(km,errText(r));return}loadKeys()})});li.appendChild(b)}
ul.appendChild(li)})}
function loadKeys(){return api('/v1/account/keys').then(function(r){if(r.ok)renderKeys(r.body.keys||[])})}
function loadUsage(){return api('/v1/account/usage?days=30').then(function(r){if(!r.ok)return;var u=r.body,q=u.quota,mo=q.month,lim=q.limits;
$('plan').textContent=L.plan+': '+q.plan+' · '+L.monthRenews+' '+new Date(q.monthResetsAt).toLocaleDateString(L.locale);
var s=$('stats');s.textContent='';
s.appendChild(stat(L.transcription,mo.audioSeconds,lim.audioSeconds,fmtMin,'min'));
s.appendChild(stat(L.translation,mo.llmTokens,lim.llmTokens,n,'tokens'));
s.appendChild(stat(L.dubbing,mo.ttsChars,lim.ttsChars,n,L.characters));
s.appendChild(stat(L.liveRooms,mo.rooms,lim.rooms,n,''));
var tb=$('days').tBodies[0];tb.textContent='';u.days.slice().reverse().forEach(function(d){if(!d.requests&&!d.rooms)return;var tr=document.createElement('tr');
[new Date(d.day+'T12:00:00Z').toLocaleDateString(L.locale),fmtMin(d.audioSeconds)+' min',n(d.llmTokens),n(d.ttsChars),n(d.rooms),n(d.requests)].forEach(function(t){var td=document.createElement('td');td.textContent=t;tr.appendChild(td)});tb.appendChild(tr)});
if(!tb.rows.length){var tr=document.createElement('tr');var td=document.createElement('td');td.colSpan=6;td.className='meta';td.textContent=L.noUsage;tr.appendChild(td);tb.appendChild(tr)}})}
var USERS=[],um=$('um');
function drawUsers(){var ul=$('users');ul.textContent='';var q=($('uq').value||'').trim().toLowerCase();
var list=USERS.filter(function(u){return !q||(u.email||'').toLowerCase().indexOf(q)>=0});
if(!list.length){var li=document.createElement('li');li.className='meta';li.textContent=q?L.noUserFound:L.noUsers;ul.appendChild(li);return}
list.forEach(function(u){var li=document.createElement('li');
var info=document.createElement('div');var nm=document.createElement('div');nm.className='name';nm.textContent=u.email;
var meta=document.createElement('div');meta.className='meta';meta.textContent=L.since+' '+when(u.createdAt)+(u.lastSeenAt?'  ·  '+L.active+' '+when(u.lastSeenAt):'');
info.appendChild(nm);info.appendChild(meta);li.appendChild(info);
var b=document.createElement('button');b.className='btn ghost';b.type='button';b.textContent=L.sendKey;
b.setAttribute('aria-label',L.sendKeyTo+u.email);
b.addEventListener('click',function(){if(!confirm(fill(L.sendKeyConfirm,{email:u.email})))return;
busy(b,true,L.sending);api('/v1/account/users/'+encodeURIComponent(u.id)+'/access-key','POST',{}).then(function(r){busy(b,false,L.sendKey);
if(r.ok){show(um,fill(L.keySent,{email:u.email}),'ok')}else{show(um,errText(r))}},function(){busy(b,false,L.sendKey);show(um,L.offline)})});
li.appendChild(b);ul.appendChild(li)})}
$('uq').addEventListener('input',drawUsers);
function loadUsers(){return api('/v1/account/users').then(function(r){if(!r.ok)return;USERS=r.body.users||[];$('admin').hidden=false;drawUsers()})}
api('/v1/account/me').then(function(r){if(r.status===401){location.href=${js(links.login)};return}
if(!r.ok){show(gm,errText(r));return}CSRF=r.body.csrfToken||'';$('who').textContent=r.body.email;
$('lead').textContent=fill(L.signedInAs,{email:r.body.email});loadKeys();loadUsage();loadUsers()},function(){show(gm,L.offlineReload)});
$('kf').addEventListener('submit',function(e){e.preventDefault();show(km,'');var b=$('kb');busy(b,true,L.creating);
api('/v1/account/keys','POST',{deviceName:$('dev').value}).then(function(r){busy(b,false,L.createKey);if(!r.ok){show(km,errText(r));return}
$('nk').textContent=r.body.key;$('new').hidden=false;$('dev').value='';$('copy').focus();loadKeys()})});
$('copy').addEventListener('click',function(){var t=$('nk').textContent,c=$('copy');
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){c.textContent=L.copied},function(){
var r=document.createRange();r.selectNodeContents($('nk'));var sel=getSelection();sel.removeAllRanges();sel.addRange(r);c.textContent=L.selected})});
$('out').addEventListener('click',function(){api('/v1/account/logout','POST',{}).then(function(){location.href=${js(links.login)}})});
})();`;
  return { html: shell(t.dashTitle, body, script, nonce, links, nav), nonce };
}

export function notFoundAccountPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  const nonce = randomBytes(16).toString('base64');
  return { html: shell(t.notFoundTitle, `<div class="narrow"><h1>${t.notFoundHeading}</h1><p class="lead"><a href="${esc(links.home)}">${t.backHome}</a></p></div>`, '', nonce, links), nonce };
}
