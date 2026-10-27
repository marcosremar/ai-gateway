// ── AI Gateway — ucast.me accounts: pages ────────────────────────────────────
// Self-contained HTML like the live page (src/rooms/page.ts): inline CSS/JS under a per-response CSP nonce, no CDN,
// mobile first, pt-BR, same palette. The pages only call the same-origin JSON API (/v1/account/*).

import { randomBytes } from 'crypto';
import { PAGE_STRINGS, type PageLang } from './page-strings';
import { PLANS } from './plans';

export interface RenderedPage { html: string; nonce: string; formAction?: string }

export interface PageLinks {
  home: string; signup: string; login: string; forgot: string; reset: string; verify: string; account: string;
  download: string; lang: PageLang;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c] ?? c);
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%234cc3cb'/%3E%3Ccircle cx='16' cy='16' r='9.33' fill='none' stroke='%230a1012' stroke-width='4'/%3E%3C/svg%3E";
const LOGO_MARK = '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="16" fill="#4cc3cb"/><circle cx="16" cy="16" r="9.33" fill="none" stroke="#0a1012" stroke-width="4"/></svg>';

/** The logo always goes to the public landing page, even on the account hosts. */
const LANDING_URL = 'https://ucast.me/';

export const DESKTOP_RETURN_ORIGIN = 'http://127.0.0.1:*';

export function accountPageCsp(nonce: string, formAction?: string): string {
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`, "connect-src 'self'", 'img-src data:', "font-src 'self'",
    "base-uri 'none'", `form-action 'self'${formAction ? ` ${formAction}` : ''}`, "frame-ancestors 'none'",
  ].join('; ');
}

const CSS = `
@font-face{font-family:Archivo;src:url(/fonts/archivo-latin.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"JetBrains Mono";src:url(/fonts/jetbrains-mono-latin.woff2) format("woff2");font-weight:100 800;font-display:swap}
:root{color-scheme:dark;--glass:#0a1012;--glass-2:#0d1517;--panel:#0f181b;--screen:#080d0f;--ink:#e9f2f3;--ink-2:#a3b8bb;--ink-3:#8ba5a8;--phos:#4cc3cb;--phos-ink:#04161a;--amber:#e0a458;--ok:#5fd39a;--hairline:rgba(233,241,234,.1);--hairline-2:rgba(233,241,234,.18);--sans:Archivo,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;--ease:cubic-bezier(.16,1,.3,1)}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;background:var(--glass);color:var(--ink);font-family:var(--sans);-webkit-text-size-adjust:100%;line-height:1.5;-webkit-font-smoothing:antialiased}
html{scrollbar-color:var(--hairline-2) var(--glass)}
::selection{background:var(--phos);color:var(--phos-ink)}
a{color:var(--phos);text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
button,input{font:inherit;color:inherit}
input{caret-color:var(--phos)}
:focus-visible{outline:2px solid var(--phos);outline-offset:3px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:68rem;margin:0 auto;padding:18px max(20px,env(safe-area-inset-left));border-bottom:1px solid var(--hairline)}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-weight:800;font-size:1.15rem;letter-spacing:-.02em}
.brand svg{width:26px;height:26px;flex:none}
.brand b{color:var(--phos);font-weight:600}
main{max-width:68rem;margin:0 auto;padding:8px 20px 64px}
.narrow{max-width:27rem;margin:7vh auto 0}
.bench{display:grid;grid-template-columns:minmax(0,27rem) minmax(0,1fr);gap:clamp(40px,7vw,104px);align-items:start;margin-top:7vh}
.bench .narrow{margin:0}
main>h1{margin-top:clamp(32px,6vh,56px)}
h1{font-size:clamp(1.75rem,3.4vw,2.35rem);font-weight:700;line-height:1.08;margin:0 0 12px;letter-spacing:-.03em;text-wrap:balance}
h2{font-size:1.1rem;margin:0 0 4px;letter-spacing:-.015em}
p.lead{color:var(--ink-2);margin:0 0 28px;max-width:38ch;text-wrap:pretty}
.card{background:var(--panel);border:1px solid var(--hairline);border-radius:4px;padding:22px;margin:0 0 16px}
form.card{padding:24px 24px 26px}
label{display:block;font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin:18px 0 8px}
form label:first-child{margin-top:0}
input[type=email],input[type=password],input[type=text]{width:100%;height:48px;background:var(--screen);border:1px solid var(--hairline-2);border-radius:3px;padding:0 14px;font-size:1rem;transition:border-color .2s var(--ease)}
input:hover{border-color:rgba(233,241,234,.28)}
input:focus{outline:none;border-color:var(--phos)}
input:focus-visible{outline:2px solid var(--phos);outline-offset:2px}
input::placeholder{color:var(--ink-3);opacity:1}
input:-webkit-autofill{-webkit-box-shadow:0 0 0 40px var(--screen) inset;-webkit-text-fill-color:var(--ink);caret-color:var(--phos)}
.field{position:relative}
.field input{padding-right:92px}
.reveal{position:absolute;right:4px;top:4px;height:40px;padding:0 10px;background:transparent;border:0;border-radius:2px;font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);cursor:pointer}
.reveal:hover{color:var(--ink)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:46px;background:var(--phos);color:var(--phos-ink);border:0;border-radius:3px;padding:0 20px;font-weight:700;letter-spacing:-.005em;cursor:pointer;text-decoration:none;box-shadow:0 1px 0 rgba(255,255,255,.18) inset,0 2px 0 #2a7f86;transition:transform .12s var(--ease),box-shadow .12s var(--ease),filter .2s}
.btn:hover{filter:brightness(1.06)}
.btn:active{transform:translateY(1px);box-shadow:0 1px 0 rgba(255,255,255,.12) inset,0 1px 0 #2a7f86}
.btn.full{width:100%;margin-top:24px;min-height:50px;font-size:1.02rem}
.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--hairline-2);box-shadow:none}
.btn.ghost:hover{border-color:var(--phos);color:var(--phos);filter:none}
.btn.danger{background:transparent;color:var(--amber);border:1px solid var(--hairline);box-shadow:none;min-height:36px;padding:0 12px;font-weight:600}
.btn.danger:hover{border-color:var(--amber);filter:none}
.btn[disabled]{opacity:.55;cursor:progress;transform:none}
.hint{color:var(--ink-3);font-size:.86rem;margin:8px 0 0}
.alt{color:var(--ink-2);margin:22px 0 0;font-size:.95rem}
.msg{display:flex;gap:10px;align-items:baseline;border:1px solid var(--hairline);border-radius:3px;padding:11px 13px;margin:18px 0 0;font-size:.93rem;background:var(--screen)}
.msg::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;transform:translateY(-1px);background:currentColor}
.msg:empty{display:none}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:12px;margin-top:14px}
.plan{display:flex;flex-direction:column;gap:6px;background:var(--screen);border:1px solid var(--hairline);border-radius:4px;padding:18px}
.plan.current,.plan.wanted{border-color:var(--phos)}
.plan h3{margin:0;font-size:1rem}
.plan .price{margin:0;font-family:var(--mono);font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums}
.plan .price span{font-size:.8rem;color:var(--ink-3);margin-left:4px}
.plan ul{list-style:none;margin:6px 0 10px;padding:0;color:var(--ink-2);font-size:.9rem;flex:1}
.plan li{padding:3px 0}
.plan .btn{width:100%}
#cpf input[type=number]{width:5.5rem;flex:none}
textarea{width:100%;background:var(--screen);border:1px solid var(--hairline-2);border-radius:3px;padding:12px;font:inherit;color:inherit;resize:vertical}
#cpi{margin:12px 0}
.mailtext{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--screen);border:1px solid var(--hairline);border-radius:3px;padding:12px;margin:8px 0 0;font-size:.85rem;color:var(--ink-2)}
.mailtext a{color:var(--phos)}
.mini{display:flex;flex-direction:column;gap:2px;font-size:.8rem;color:var(--ink-3)}
#cpf{align-items:flex-end}
.linkish{background:none;border:0;padding:0;color:var(--ink-3);font-size:.86rem;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.linkish:hover{color:var(--ink)}
.quiet{margin-top:28px}
.quiet summary{cursor:pointer;color:var(--ink-3);font-size:.86rem;padding:6px 0;list-style:none}
.quiet summary::-webkit-details-marker{display:none}
.quiet summary::before{content:"›";display:inline-block;margin-right:8px;transition:transform .2s var(--ease)}
.quiet[open] summary::before{transform:rotate(90deg)}
.quiet[open] summary{margin-bottom:12px}
.notice{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:center;justify-content:space-between;border-color:rgba(224,164,88,.35)}
.notice p{margin:0;color:var(--amber)}
.notice .msg{flex-basis:100%;margin:0}
#xpw{flex:1;min-width:12rem;width:auto}
input:disabled{opacity:.5;cursor:not-allowed}
.msg.err{color:var(--amber);border-color:rgba(224,164,88,.35)}
.msg.ok{color:var(--phos);border-color:rgba(76,195,203,.35)}
.chain{list-style:none;margin:0;padding:0;border-top:1px solid var(--hairline)}
.chain>li{display:grid;grid-template-columns:auto 1fr auto;gap:4px 16px;align-items:baseline;padding:18px 0;border-bottom:1px solid var(--hairline)}
.chain .ch{font-family:var(--mono);font-size:11px;letter-spacing:.14em;color:var(--phos)}
.chain>li>.name{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:-.01em}
.chain>li>.name::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--hairline-2)}
.chain>li.done>.name::before{background:var(--phos);box-shadow:0 0 6px rgba(76,195,203,.6)}
.chain>li.done>.read{color:var(--phos)}
.chain .act{grid-column:2/4;min-width:0}
.chain .act .claim{margin:0 0 4px}
.steps{margin-top:14px}
.steps #kf{margin-top:12px}
h3{font-size:1rem;margin:26px 0 4px;letter-spacing:-.01em}
caption{text-align:left;padding:0 0 6px}
.chain .read{font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--ink-3);text-align:right;font-variant-numeric:tabular-nums}
.chain .claim{grid-column:2/4;color:var(--ink-2);font-size:.93rem;margin:0}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.keybox{display:flex;gap:8px;align-items:stretch;margin:10px 0 6px}
.keybox code{flex:1;min-width:0;overflow-wrap:anywhere;background:var(--screen);border:1px solid var(--phos);border-radius:3px;padding:12px;font-family:var(--mono);font-size:.92rem}
.keys{list-style:none;margin:12px 0 0;padding:0}
.keys li{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;border-top:1px solid var(--hairline);padding:12px 0}
.keys .name{font-weight:600}.keys .meta{color:var(--ink-3);font-size:.85rem;font-family:var(--mono);font-variant-numeric:tabular-nums}
.keys .off{opacity:.55}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:12px;margin-top:12px}
.stat{background:var(--screen);border:1px solid var(--hairline);border-radius:3px;padding:14px}
.stat .v{font-family:var(--mono);font-size:1.3rem;font-weight:600;font-variant-numeric:tabular-nums}.stat .l{color:var(--ink-3);font-size:.85rem}
.bar{height:4px;border-radius:2px;background:var(--hairline);margin-top:10px;overflow:hidden}.bar i{display:block;height:100%;background:var(--phos)}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:.9rem;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:7px 8px;border-top:1px solid var(--hairline);white-space:nowrap}th:first-child,td:first-child{text-align:left}
th{color:var(--ink-3);font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.12em;text-transform:uppercase}
.scroll{overflow-x:auto}
.hero{text-align:center;padding:8vh 0 4vh}.hero h1{font-size:2.2rem}.hero p{color:var(--ink-2);max-width:32rem;margin:0 auto 24px}
.hero .row{justify-content:center}.hero .hint{margin-top:18px}
.users{list-style:none;margin:12px 0 0;padding:0}
.users li{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;border-top:1px solid var(--hairline);padding:12px 0}
.users .name{font-weight:600}.users .meta{color:var(--ink-3);font-size:.85rem}
#uq{margin:12px 0 4px}
#kf{margin-top:12px}#dev{flex:1;min-width:12rem;width:auto}#who{margin:0;font-family:var(--mono);font-size:12px}.btnrow{margin:12px 0 0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:860px){.bench{grid-template-columns:1fr;gap:44px;margin-top:5vh}.narrow{margin-top:5vh}}
@media (max-width:480px){#who{display:none}.keybox{flex-direction:column}.top{padding:14px 18px}main{padding:4px 18px 48px}form.card{padding:20px 18px 22px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
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
<header class="top"><a class="brand" href="${LANDING_URL}" title="${esc(t.home)}">${LOGO_MARK}<span>ucast<b>.me</b></span></a><nav class="row">${nav}</nav></header>
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
function toAccountIfSignedIn(url){api('/v1/account/me').then(function(r){if(r.ok)location.replace(url+location.search)})}
document.querySelectorAll('.reveal').forEach(function(b){var i=$(b.getAttribute('aria-controls'));b.addEventListener('click',function(){var hidden=i.type==='password';i.type=hidden?'text':'password';b.textContent=hidden?L.hide:L.show;b.setAttribute('aria-pressed',String(hidden));i.focus()})});
`;

function formPage(title: string, heading: string, lead: string, fields: string, button: string, alt: string, script: string, links: PageLinks, aside = ''): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const form = `<div class="narrow"><h1>${heading}</h1><p class="lead">${lead}</p>
<form id="f" class="card" novalidate>${fields}
<div id="m" class="msg" role="alert" aria-live="polite"></div>
<button id="b" class="btn full" type="submit">${button}</button></form>
<p class="alt">${alt}</p></div>`;
  const body = aside ? `<div class="bench">${form}${aside}</div>` : form;
  return { html: shell(title, body, script, nonce, links), nonce };
}

function passwordField(links: PageLinks, label: string, autocomplete: string, extra: string): string {
  const t = stringsOf(links);
  return `<label for="password">${label}</label><div class="field"><input id="password" name="password" type="password" autocomplete="${autocomplete}" ${extra}><button class="reveal" type="button" aria-controls="password" aria-pressed="false">${t.client.show}</button></div>`;
}

function setupChain(links: PageLinks): string {
  const t = stringsOf(links);
  const steps = t.steps.map((step, i) => `<li${i ? '' : ' class="done"'}><span class="ch">CH${i + 1}</span><span class="name">${step.name}</span><span class="read">${step.read}</span><p class="claim">${step.claim}</p></li>`).join('');
  return `<aside aria-label="${esc(t.stepsLabel)}"><ol class="chain">${steps}</ol></aside>`;
}

const emailField = (links: PageLinks) => `<label for="email">${esc(stringsOf(links).email)}</label><input id="email" name="email" type="email" autocomplete="email" inputmode="email" required autofocus>`;

export function signupPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  const after = `function afterAuth(){var n=new URLSearchParams(location.search).get('next');
if(n&&n.charAt(0)==='/'&&n.indexOf('//')<0&&(n==='/account'||n.indexOf('/account/')===0||n==='/desktop'||n.indexOf('/desktop?')===0||n.indexOf('/account/desktop')===0))return n;
return ${js(links.account)}+location.search}`;
  return formPage(t.signupTitle, t.signupHeading, t.signupLead,
    `<div id="inv" class="msg" role="status" aria-live="polite"></div>${emailField(links)}${passwordField(links, t.password, 'new-password', 'minlength="8" required aria-describedby="ph"')}<p id="ph" class="hint">${t.minLength}</p>`,
    t.signupButton, `${t.haveAccount} <a href="${esc(links.login)}">${t.signIn}</a>`,
    `(function(){${after};var f=$('f'),b=$('b'),m=$('m'),INVITE=new URLSearchParams(location.search).get('invite');toAccountIfSignedIn(afterAuth());
if(INVITE)api('/v1/account/invite?code='+encodeURIComponent(INVITE),'GET').then(function(r){if(!r.ok){INVITE=null;show($('inv'),errText(r));return}
show($('inv'),fill(L.inviteBanner,{n:r.body.months}),'ok');document.querySelector('h1').textContent=L.inviteHeading;
if(r.body.email){$('email').value=r.body.email;$('email').readOnly=true;$('password').focus()}});f.addEventListener('submit',function(e){e.preventDefault();show(m,'');
var email=$('email').value.trim(),pw=$('password').value;
if(!email||email.indexOf('@')<1){show(m,L.invalidEmail);$('email').focus();return}
if(pw.length<8){show(m,L.shortPassword);$('password').focus();return}
busy(b,true,L.creating);api('/v1/account/signup','POST',INVITE?{email:email,password:pw,invite:INVITE}:{email:email,password:pw}).then(function(r){
if(r.ok){location.href=afterAuth();return}busy(b,false,L.signupButton);show(m,errText(r))},function(){busy(b,false,L.signupButton);show(m,L.offline)})})})();`,
    links, setupChain(links));
}

export function loginPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  const after = `function afterAuth(){var n=new URLSearchParams(location.search).get('next');
if(n&&n.charAt(0)==='/'&&n.indexOf('//')<0&&(n==='/account'||n.indexOf('/account/')===0||n==='/desktop'||n.indexOf('/desktop?')===0||n.indexOf('/account/desktop')===0))return n;
return ${js(links.account)}+location.search}`;
  return formPage(t.loginTitle, t.signIn, t.loginLead,
    `${emailField(links)}${passwordField(links, t.password, 'current-password', 'required')}
<p class="hint"><a href="${esc(links.forgot)}">${t.forgotLink}</a></p>`,
    t.signIn, `${t.noAccount} <a href="${esc(links.signup)}">${t.signupButton}</a>`,
    `(function(){${after};var f=$('f'),b=$('b'),m=$('m');toAccountIfSignedIn(afterAuth());f.addEventListener('submit',function(e){e.preventDefault();show(m,'');
var email=$('email').value.trim(),pw=$('password').value;if(!email||!pw){show(m,L.emailAndPassword);return}
busy(b,true,L.signingIn);api('/v1/account/login','POST',{email:email,password:pw}).then(function(r){
if(r.ok){location.href=afterAuth();return}busy(b,false,L.signIn);show(m,errText(r))},function(){busy(b,false,L.signIn);show(m,L.offline)})})})();`,
    links);
}

export function forgotPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  return formPage(t.forgotTitle, t.forgotHeading, t.forgotLead,
    emailField(links), t.forgotButton, `<a href="${esc(links.login)}">${t.backToLogin}</a>`,
    `(function(){var f=$('f'),b=$('b'),m=$('m');f.addEventListener('submit',function(e){e.preventDefault();show(m,'');
var email=$('email').value.trim();if(!email||email.indexOf('@')<1){show(m,L.invalidEmail);return}
busy(b,true,L.sending);api('/v1/account/password/forgot','POST',{email:email}).then(function(r){busy(b,false,L.forgotButton);
if(r.ok){f.replaceWith(m);show(m,L.forgotSent,'ok');return}show(m,errText(r))},
function(){busy(b,false,L.forgotButton);show(m,L.offline)})})})();`,
    links);
}

export function resetPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  return formPage(t.resetTitle, t.resetHeading, t.resetLead,
    `${passwordField(links, t.newPassword, 'new-password', 'minlength="8" required autofocus aria-describedby="ph"')}<p id="ph" class="hint">${t.minLength}</p>`,
    t.resetButton, `<a href="${esc(links.login)}">${t.backToLogin}</a>`,
    `(function(){var f=$('f'),b=$('b'),m=$('m');var t=(location.hash.match(/token=([A-Za-z0-9_-]+)/)||[])[1]||'';
if(t&&history.replaceState)history.replaceState(null,'',location.pathname);
if(!t){f.replaceWith(m);show(m,L.resetIncomplete)}
f.addEventListener('submit',function(e){e.preventDefault();show(m,'');var pw=$('password').value;
if(pw.length<8){show(m,L.shortPassword);return}
busy(b,true,L.saving);api('/v1/account/password/reset','POST',{token:t,password:pw}).then(function(r){
if(r.ok){show(m,L.resetDone,'ok');setTimeout(function(){location.href=${js(links.login)}},1200);return}
busy(b,false,L.resetButton);show(m,errText(r))},function(){busy(b,false,L.resetButton);show(m,L.offline)})})})();`,
    links);
}

export function verifyPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  const nonce = randomBytes(16).toString('base64');
  const body = `<div class="narrow"><h1>${t.verifyHeading}</h1><p class="lead" id="vl">${t.verifyLead}</p>
<div id="m" class="msg" role="alert" aria-live="polite"></div>
<p class="btnrow"><a id="go" class="btn" href="${esc(links.account)}" hidden>${t.goAccount}</a></p></div>`;
  const script = `(function(){var m=$('m'),go=$('go');var t=(location.hash.match(/token=([A-Za-z0-9_-]+)/)||[])[1]||'';
if(t&&history.replaceState)history.replaceState(null,'',location.pathname);
function done(text,kind){$('vl').hidden=true;show(m,text,kind);go.hidden=false}
if(!t){done(L.verifyMissing);return}
api('/v1/account/verify','POST',{token:t}).then(function(r){if(r.ok){done(L.verified,'ok');return}done(errText(r))},function(){done(L.offline)})})();`;
  return { html: shell(t.verifyTitle, body, script, nonce, links), nonce };
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
<div id="vb" class="card notice" hidden><p>${t.verifyNotice}</p><button id="vr" class="btn ghost" type="button">${t.resendVerify}</button><div id="vm" class="msg" role="status" aria-live="polite"></div></div>
<section class="card" aria-labelledby="sh"><h2 id="sh">${t.setupHeading}</h2>
<ol class="chain steps">
<li id="s1"><span class="ch">CH1</span><span class="name">${t.stepDownload}</span><span class="read">WIN · MAC</span>
<div class="act"><p class="claim">${t.stepDownloadClaim}</p><p class="btnrow"><a id="dl" class="btn" href="${esc(links.download)}" rel="noopener">${t.downloadButton}</a></p></div></li>
<li id="s2"><span class="ch">CH2</span><span class="name">${t.stepKey}</span><span class="read" id="kc"></span>
<div class="act"><p class="claim">${t.stepKeyClaim}</p>
<form id="kf" class="row"><label class="sr" for="dev">${t.deviceLabel}</label>
<input id="dev" type="text" maxlength="60" placeholder="${esc(t.deviceHint)}" autocomplete="off" required>
<button id="kb" class="btn" type="submit">${t.createKey}</button></form>
<div id="new" hidden><p class="msg ok">${t.copyNow}</p>
<div class="keybox"><code id="nk"></code><button id="copy" class="btn" type="button">${t.copy}</button></div></div>
<div id="km" class="msg" role="alert" aria-live="polite"></div>
<ul id="keys" class="keys" aria-label="${esc(t.keysHeading)}"></ul></div></li>
<li id="s3"><span class="ch">CH3</span><span class="name">${t.stepApp}</span><span class="read" id="ac"></span>
<div class="act"><p class="claim">${t.stepAppClaim}</p></div></li>
</ol></section>
<section class="card" aria-labelledby="uh"><h2 id="uh">${t.usageHeading}</h2><p class="hint" id="plan"></p>
<div class="grid" id="stats"></div></section>
<section class="card" aria-labelledby="ch"><h2 id="ch">${t.couponHeading}</h2><p class="hint">${t.couponHint}</p>
<form id="cf" class="row"><input id="cc" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="UCAST-XXXX-XXXX" aria-label="${esc(t.couponHeading)}"><button id="cb" class="btn" type="submit">${t.client.couponButton}</button></form>
<div id="cm" class="msg" role="status" aria-live="polite"></div></section>
<section class="card" id="billing" aria-labelledby="bh" hidden><h2 id="bh">${t.client.planHeading}</h2><p class="hint" id="bp"></p>
<div id="bm" class="msg" role="status" aria-live="polite"></div>
<div class="plans" id="plans"></div>
<p class="hint"><button id="manage" class="linkish" type="button" hidden>${t.client.manage}</button></p></section>
<section class="card" id="admin" aria-labelledby="ah" hidden><h2 id="ah">${t.adminHeading}</h2>
<div class="scroll"><table id="days"><caption class="hint">${t.usageCaption}</caption><thead><tr><th scope="col">${t.day}</th><th scope="col">${t.transcription}</th><th scope="col">${t.translation}</th><th scope="col">${t.dubbing}</th><th scope="col">${t.rooms}</th><th scope="col">${t.requests}</th></tr></thead><tbody></tbody></table></div>
<h3>${t.usersHeading}</h3><p class="hint">${t.usersHint}</p>
<label class="sr" for="uq">${t.searchUser}</label><input id="uq" type="text" placeholder="${esc(t.searchPlaceholder)}" autocomplete="off">
<div id="um" class="msg" role="alert" aria-live="polite"></div>
<ul id="users" class="users" aria-label="${esc(t.usersHeading)}"></ul>
<h3>${t.couponsHeading}</h3><p class="hint">${t.couponsHint}</p>
<div class="row"><label class="mini"><span>${t.couponDuration}</span><select id="cpm">${[3, 6, 12].map(n => `<option value="${n}">${t.client.couponMonthsOf.replace('{n}', String(n))}</option>`).join('')}</select></label>
<label class="mini"><span>${t.couponLang}</span><select id="cpl">${(['pt', 'en', 'fr'] as const).map(l => `<option value="${l}"${links.lang === l ? ' selected' : ''}>${{ pt: 'Português', en: 'English', fr: 'Français' }[l]}</option>`).join('')}</select></label></div>
<form id="cpi" class="stack"><label class="sr" for="cpe">${t.couponInviteLabel}</label><textarea id="cpe" rows="3" placeholder="${esc(t.couponInvitePlaceholder)}" autocomplete="off" spellcheck="false"></textarea>
<button id="cpb" class="btn" type="submit">${t.client.couponInvite}</button></form>
<div id="cam" class="msg" role="status" aria-live="polite"></div>
<details class="quiet"><summary>${t.couponMore}</summary>
<form id="cpf" class="row"><label class="mini"><span>${t.couponCount}</span><input id="cpn" type="number" min="1" max="500" value="1"></label>
<label class="mini"><span>${t.couponMaxUses}</span><input id="cpu" type="number" min="1" max="100000" value="1"></label>
<input id="cpt" type="text" maxlength="80" placeholder="${esc(t.couponNote)}" aria-label="${esc(t.couponNote)}">
<button id="cpg" class="btn ghost" type="submit">${t.client.couponCreate}</button></form></details>
<ul id="coupons" class="users" aria-label="${esc(t.couponsHeading)}"></ul>
<h3>${t.emailsHeading}</h3><p class="hint">${t.emailsHint}</p>
<ul id="mails" class="users" aria-label="${esc(t.emailsHeading)}"></ul></section>
<details class="quiet"><summary>${t.accountSettings}</summary>
<section class="card" aria-labelledby="xh"><h2 id="xh">${t.deleteHeading}</h2><p class="hint">${t.deleteHint}</p>
<form id="xf" class="row"><label class="sr" for="xpw">${t.deletePassword}</label>
<input id="xpw" type="password" autocomplete="current-password" placeholder="${esc(t.deletePassword)}" required>
<button id="xb" class="btn danger" type="submit">${t.deleteButton}</button></form>
<div id="xm" class="msg" role="alert" aria-live="polite"></div></section></details>`;
  const plans = Object.values(PLANS).map(p => ({ id: p.id, price: p.priceCents / 100, hours: p.quota.audioSeconds / 3600, dubMinutes: Math.round(p.quota.ttsSeconds / 60), rooms: p.quota.rooms }));
  const script = `(function(){
var gm=$('gm'),km=$('km'),ADMIN=false,BILLING=false,PLAN='free',PLANS=${js(plans)},WANT=new URLSearchParams(location.search).get('plan');
function minutes(s){return (s/60).toLocaleString(L.locale,{maximumFractionDigits:s<600?1:0})}
function n(x){return Math.round(x).toLocaleString(L.locale)}
function day(s){return new Date(s).toLocaleDateString(L.locale,{day:'numeric',month:'short',year:'numeric'})}
function when(s){return s?new Date(s).toLocaleString(L.locale,{dateStyle:'short',timeStyle:'short'}):L.never}
function mark(id,done,read){$(id).classList.toggle('done',done);if(read!==undefined)$(id).querySelector('.read').textContent=read}
var platform=(navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||'';
$('dev').value=/mac/i.test(platform)?L.defaultMac:/win/i.test(platform)?L.defaultWin:L.defaultPc;
$('dl').addEventListener('click',function(){mark('s1',true)});
function stat(label,value,unit,limit){var d=document.createElement('div');d.className='stat';
var v=document.createElement('div');v.className='v';v.textContent=value+(unit?' '+unit:'')+(limit?' '+fill(L.ofLimit,{x:limit}):'');
var l=document.createElement('div');l.className='l';l.textContent=label;d.appendChild(v);d.appendChild(l);return d}
function renderKeys(list){var ul=$('keys');ul.textContent='';var active=list.filter(function(k){return k.active});
var used=active.filter(function(k){return k.lastActivatedAt||k.lastUsedAt}).map(function(k){return k.lastActivatedAt||k.lastUsedAt}).sort();
mark('s2',active.length>0,active.length?fill(L.keyCount,{n:active.length}):'');
mark('s3',used.length>0,used.length?fill(L.activatedOn,{date:day(used[0])}):L.waitingApp);
if(used.length)mark('s1',true);
list.forEach(function(k){var li=document.createElement('li');if(!k.active)li.className='off';
var info=document.createElement('div');var nm=document.createElement('div');nm.className='name';nm.textContent=k.deviceName;
var meta=document.createElement('div');meta.className='meta';var last=k.lastUsedAt||k.lastActivatedAt;
meta.textContent=L.createdOn+' '+day(k.createdAt)+' · '+(last?L.usedOn+' '+when(last):L.notUsedYet)+(k.active?'':' · '+L.revoked);
info.appendChild(nm);info.appendChild(meta);li.appendChild(info);
if(k.active){var b=document.createElement('button');b.className='btn danger';b.type='button';b.textContent=L.revoke;
b.setAttribute('aria-label',L.revokeKeyOf+k.deviceName);
b.addEventListener('click',function(){if(!confirm(fill(L.revokeConfirm,{name:k.deviceName})))return;
busy(b,true);api('/v1/account/keys/'+encodeURIComponent(k.id),'DELETE').then(function(r){if(!r.ok){busy(b,false);show(km,errText(r));return}loadKeys()})});li.appendChild(b)}
ul.appendChild(li)})}
function loadKeys(){return api('/v1/account/keys').then(function(r){if(r.ok)renderKeys(r.body.keys||[])})}
function loadUsage(){return api('/v1/account/usage?days=30').then(function(r){if(!r.ok)return;var u=r.body,q=u.quota,mo=q.month;
var lim=q.limits;PLAN=q.plan;
$('plan').textContent=(BILLING?(L.planNames[q.plan]||q.plan):(q.plan==='free'?L.freePlan:q.plan))+' · '+L.renewsOn+' '+day(q.monthResetsAt)+(q.viaCoupon?' · '+L.couponUntil+' '+day(q.grantEndsAt):'');
var s=$('stats');s.textContent='';
s.appendChild(stat(L.minutesSubtitled,minutes(mo.audioSeconds),'min',lim.audioSeconds>0?hours(lim.audioSeconds/3600):''));
s.appendChild(stat(L.minutesDubbed,minutes(mo.ttsSeconds||0),'min',lim.ttsSeconds>0?dubbing(Math.round(lim.ttsSeconds/60)):''));
s.appendChild(stat(L.liveRooms,n(mo.rooms),'',lim.rooms>0?n(lim.rooms):''));
var used=Math.max(lim.audioSeconds>0?mo.audioSeconds/lim.audioSeconds:0,lim.ttsSeconds>0?(mo.ttsSeconds||0)/lim.ttsSeconds:0,lim.rooms>0?mo.rooms/lim.rooms:0);
if(BILLING&&used>=0.8){var order=['free','pro','events'];WANT=WANT||order[order.indexOf(q.plan)+1]||null}
if(BILLING)renderPlans(q);
if(BILLING&&used>=1)show($('bm'),L.limitReached);else if(BILLING&&used>=0.8)show($('bm'),fill(L.limitNear,{p:Math.floor(used*100)}));
if(!ADMIN)return;var tb=$('days').tBodies[0];tb.textContent='';u.days.slice().reverse().forEach(function(d){if(!d.requests&&!d.rooms)return;var tr=document.createElement('tr');
[new Date(d.day+'T12:00:00Z').toLocaleDateString(L.locale),minutes(d.audioSeconds)+' min',n(d.llmTokens),minutes(d.ttsSeconds||0)+' min',n(d.rooms),n(d.requests)].forEach(function(t){var td=document.createElement('td');td.textContent=t;tr.appendChild(td)});tb.appendChild(tr)});
if(!tb.rows.length){var tr=document.createElement('tr');var td=document.createElement('td');td.colSpan=6;td.className='meta';td.textContent=L.noUsage;tr.appendChild(td);tb.appendChild(tr)}})}
function hours(h){return n(h)+' h'}
function dubbing(m){return m>=60?n(m/60)+' h':n(m)+' min'}
function money(v){return v.toLocaleString(L.locale,{style:'currency',currency:'EUR',maximumFractionDigits:v%1?2:0})}
function renderPlans(q){$('billing').hidden=false;var box=$('plans');box.textContent='';var paid=q.plan!=='free'&&!q.viaCoupon;
$('bp').textContent=q.planRenewsAt?fill(q.planCancelsAtPeriodEnd?L.endsOn:L.subscriptionRenewsOn,{date:day(q.planRenewsAt)}):'';
$('manage').hidden=!paid;
PLANS.forEach(function(p){var card=document.createElement('div');card.className='plan'+(p.id===q.plan?' current':p.id===WANT?' wanted':'');
var h=document.createElement('h3');h.textContent=L.planNames[p.id];card.appendChild(h);
var price=document.createElement('p');price.className='price';price.textContent=money(p.price);
if(p.price){var per=document.createElement('span');per.textContent=L.perMonth;price.appendChild(per)}card.appendChild(price);
var ul=document.createElement('ul');[fill(L.subtitleHours,{h:n(p.hours)}),fill(L.dubbingAmount,{d:dubbing(p.dubMinutes)}),p.rooms?fill(L.roomsLimit,{n:p.rooms}):L.roomsUnlimited,L.localUnlimited].forEach(function(t){var li=document.createElement('li');li.textContent=t;ul.appendChild(li)});card.appendChild(ul);
var b=document.createElement('button');b.type='button';b.className='btn'+(p.id===q.plan?' ghost':'');
if(p.id===q.plan){b.textContent=L.currentPlan;b.disabled=true}
else if(p.id==='free'){b.hidden=true}
else if(paid){b.textContent=L.changePlan;b.className='btn ghost';b.addEventListener('click',openPortal)}
else{b.textContent=L.subscribe;b.addEventListener('click',function(){busy(b,true,L.redirecting);api('/v1/account/billing/checkout','POST',{plan:p.id}).then(function(r){if(r.ok){location.href=r.body.url;return}busy(b,false,L.subscribe);show($('bm'),errText(r))},function(){busy(b,false,L.subscribe);show($('bm'),L.offline)})})}
card.appendChild(b);box.appendChild(card)})}
function openPortal(){var b=$('manage');busy(b,true);api('/v1/account/billing/portal','POST',{}).then(function(r){busy(b,false);if(r.ok){location.href=r.body.url;return}show($('bm'),errText(r))},function(){busy(b,false);show($('bm'),L.offline)})}
$('manage').addEventListener('click',openPortal);
var USERS=[],um=$('um');
function drawUsers(){var ul=$('users');ul.textContent='';var q=($('uq').value||'').trim().toLowerCase();
var list=USERS.filter(function(u){return !q||(u.email||'').toLowerCase().indexOf(q)>=0});
if(!list.length){var li=document.createElement('li');li.className='meta';li.textContent=q?L.noUserFound:L.noUsers;ul.appendChild(li);return}
list.forEach(function(u){var li=document.createElement('li');
var info=document.createElement('div');var nm=document.createElement('div');nm.className='name';nm.textContent=u.email;
var meta=document.createElement('div');meta.className='meta';meta.textContent=L.since+' '+day(u.createdAt)+(u.lastSeenAt?' · '+L.active+' '+when(u.lastSeenAt):'');
info.appendChild(nm);info.appendChild(meta);li.appendChild(info);
var b=document.createElement('button');b.className='btn ghost';b.type='button';b.textContent=L.sendNewKey;
b.setAttribute('aria-label',L.sendKeyTo+u.email);
b.addEventListener('click',function(){if(!confirm(fill(L.sendKeyConfirm,{email:u.email})))return;
busy(b,true,L.sending);api('/v1/account/users/'+encodeURIComponent(u.id)+'/access-key','POST',{}).then(function(r){busy(b,false,L.sendNewKey);
if(r.ok){show(um,fill(L.keySent,{email:u.email}),'ok')}else{show(um,errText(r))}},function(){busy(b,false,L.sendNewKey);show(um,L.offline)})});
li.appendChild(b);ul.appendChild(li)})}
$('uq').addEventListener('input',drawUsers);
$('cf').addEventListener('submit',function(e){e.preventDefault();var code=$('cc').value.trim();if(!code)return;var b=$('cb');show($('cm'),'');busy(b,true,L.sending);
api('/v1/account/coupon/redeem','POST',{code:code}).then(function(r){busy(b,false,L.couponButton);if(!r.ok){show($('cm'),errText(r));return}
$('cc').value='';show($('cm'),fill(L.couponApplied,{date:day(r.body.quota.grantEndsAt)}),'ok');loadUsage()})});
var pre=new URLSearchParams(location.search).get('code')||new URLSearchParams(location.search).get('invite');if(pre)$('cc').value=pre.slice(0,40);
function loadUsers(){return api('/v1/account/users').then(function(r){if(!r.ok)return;USERS=r.body.users||[];drawUsers()})}
var COUPONS=[];
function mailOpts(){return {months:Number($('cpm').value),lang:$('cpl').value}}
function note(text,ok){show($('cam'),text,ok?'ok':'err')}
function drawCoupons(){var ul=$('coupons');ul.textContent='';
if(!COUPONS.length){var li=document.createElement('li');li.className='meta';li.textContent=L.couponNone;ul.appendChild(li);return}
COUPONS.slice().reverse().forEach(function(c){var li=document.createElement('li');var info=document.createElement('div');
var nm=document.createElement('div');nm.className='name';nm.textContent=c.code;
var meta=document.createElement('div');meta.className='meta';meta.textContent=(L.planNames[c.plan]||c.plan)+' · '+fill(L.couponMonthsOf,{n:c.months})+' · '+fill(L.couponUses,{used:c.uses,max:c.maxUses})+(c.note?' · '+c.note:'');
var form=document.createElement('form');form.className='row';form.hidden=true;
var email=document.createElement('input');email.type='text';email.placeholder=L.couponEmailPlaceholder;email.setAttribute('aria-label',L.couponEmailPlaceholder);
var go=document.createElement('button');go.className='btn';go.type='submit';go.textContent=L.couponSend;form.appendChild(email);form.appendChild(go);
form.addEventListener('submit',function(e){e.preventDefault();var to=email.value.trim();if(!to)return;busy(go,true,L.sending);
api('/v1/account/coupons/send','POST',Object.assign({code:c.code,email:to},mailOpts())).then(function(r){busy(go,false,L.couponSend);
if(r.ok){note(fill(L.couponSentTo,{email:r.body.email}),true);email.value='';form.hidden=true;loadMails()}else{note(errText(r))}},function(){busy(go,false,L.couponSend);note(L.offline)})});
info.appendChild(nm);info.appendChild(meta);info.appendChild(form);li.appendChild(info);
var actions=document.createElement('div');actions.className='row';
var copy=document.createElement('button');copy.className='btn ghost';copy.type='button';copy.textContent=L.couponCopy;
copy.addEventListener('click',function(){(navigator.clipboard?navigator.clipboard.writeText(c.code):Promise.reject()).then(function(){copy.textContent=L.couponCopied;setTimeout(function(){copy.textContent=L.couponCopy},1500)},function(){})});
var send=document.createElement('button');send.className='btn ghost';send.type='button';send.textContent=L.couponSend;
send.addEventListener('click',function(){form.hidden=!form.hidden;if(!form.hidden)email.focus()});
actions.appendChild(copy);actions.appendChild(send);li.appendChild(actions);ul.appendChild(li)})}
function loadCoupons(){return api('/v1/account/coupons').then(function(r){if(!r.ok)return;COUPONS=r.body.coupons||[];drawCoupons()})}
function linkify(box,text){box.textContent='';text.split(/(https?:\\/\\/[^\\s<>"]+)/).forEach(function(part,i){if(i%2){var a=document.createElement('a');a.href=part;a.textContent=part;a.target='_blank';a.rel='noopener';box.appendChild(a)}else box.appendChild(document.createTextNode(part))})}
function drawMails(list){var ul=$('mails');ul.textContent='';
if(!list.length){var li=document.createElement('li');li.className='meta';li.textContent=L.mailNone;ul.appendChild(li);return}
list.forEach(function(m){var li=document.createElement('li');var info=document.createElement('div');
var nm=document.createElement('div');nm.className='name';nm.textContent=m.subject;
var meta=document.createElement('div');meta.className='meta';meta.textContent=L.mailTo+' '+m.to+' · '+when(m.at)+' · '+(m.ok?L.mailSent:L.mailFailed);
var body=document.createElement('pre');body.className='mailtext';body.hidden=true;linkify(body,m.text+(m.error?'\\n\\n'+m.error:''));
info.appendChild(nm);info.appendChild(meta);info.appendChild(body);li.appendChild(info);
var b=document.createElement('button');b.className='btn ghost';b.type='button';b.textContent=L.mailView;
b.addEventListener('click',function(){body.hidden=!body.hidden;b.textContent=body.hidden?L.mailView:L.mailHide});
li.appendChild(b);ul.appendChild(li)})}
function loadMails(){return api('/v1/account/emails?limit=50').then(function(r){if(r.ok)drawMails(r.body.emails||[])})}
$('cpi').addEventListener('submit',function(e){e.preventDefault();var emails=$('cpe').value.split(/[\\s,;]+/).filter(Boolean);
if(!emails.length){note(L.couponNeedEmail);$('cpe').focus();return}var b=$('cpb');note('');busy(b,true,L.sending);
api('/v1/account/coupons','POST',Object.assign({emails:emails},mailOpts())).then(function(r){busy(b,false,L.couponInvite);
if(!r.ok){note(errText(r));return}var skipped=r.body.skipped||[];
note(fill(L.couponInvited,{n:r.body.coupons.length})+(skipped.length?' '+fill(L.couponSkipped,{emails:skipped.join(', ')}):''),true);
$('cpe').value=skipped.join('\\n');loadCoupons();loadMails()},function(){busy(b,false,L.couponInvite);note(L.offline)})});
$('cpf').addEventListener('submit',function(e){e.preventDefault();var b=$('cpg');note('');busy(b,true,L.sending);
api('/v1/account/coupons','POST',{count:Number($('cpn').value),maxUses:Number($('cpu').value),note:$('cpt').value.trim(),months:Number($('cpm').value)}).then(function(r){busy(b,false,L.couponCreate);
if(!r.ok){note(errText(r));return}note(fill(L.couponCreated,{n:r.body.coupons.length}),true);loadCoupons()},function(){busy(b,false,L.couponCreate);note(L.offline)})});
api('/v1/account/me').then(function(r){if(r.status===401){location.href=${js(links.login)};return}
if(!r.ok){show(gm,errText(r));return}CSRF=r.body.csrfToken||'';ADMIN=!!r.body.admin;BILLING=!!r.body.billing;$('who').textContent=r.body.email;
$('lead').textContent=fill(L.signedInAs,{email:r.body.email});$('admin').hidden=!ADMIN;
if(!r.body.emailVerified){$('vb').hidden=false;$('dev').disabled=true;$('kb').disabled=true}loadKeys();var back=new URLSearchParams(location.search).get('billing');
if(back&&history.replaceState)history.replaceState(null,'',location.pathname);
if(back==='cancel')show($('bm'),L.billingCancelled);
((back==='success'||back==='portal')&&BILLING?api('/v1/account/billing/sync','POST',{}).then(function(s){if(s.ok&&back==='success')show($('bm'),L.billingDone,'ok')}):Promise.resolve()).then(loadUsage).then(function(){if(back||(WANT&&BILLING))$('billing').scrollIntoView({block:'start'})});if(ADMIN){loadUsers();loadCoupons();loadMails()}},function(){show(gm,L.offlineReload)});
$('kf').addEventListener('submit',function(e){e.preventDefault();show(km,'');var dev=$('dev').value.trim();if(!dev){$('dev').focus();return}var b=$('kb');busy(b,true,L.creating);
api('/v1/account/keys','POST',{deviceName:dev}).then(function(r){busy(b,false,L.createKey);if(!r.ok){show(km,errText(r));return}
$('nk').textContent=r.body.key;$('new').hidden=false;$('copy').focus();loadKeys()})});
$('copy').addEventListener('click',function(){var t=$('nk').textContent,c=$('copy');
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){c.textContent=L.copied},function(){
var r=document.createRange();r.selectNodeContents($('nk'));var sel=getSelection();sel.removeAllRanges();sel.addRange(r);c.textContent=L.selected})});
$('vr').addEventListener('click',function(){var b=$('vr');busy(b,true);api('/v1/account/verify/resend','POST',{}).then(function(r){busy(b,false);show($('vm'),r.ok?L.verifySent:errText(r),r.ok?'ok':'err')},function(){busy(b,false);show($('vm'),L.offline)})});
$('xf').addEventListener('submit',function(e){e.preventDefault();var xm=$('xm'),b=$('xb'),pw=$('xpw').value;show(xm,'');if(!pw){$('xpw').focus();return}
if(!confirm(L.deleteConfirm))return;busy(b,true,L.deleting);
api('/v1/account/me','DELETE',{password:pw}).then(function(r){if(r.ok){location.href=${js(links.home)};return}busy(b,false,${js(t.deleteButton)});show(xm,errText(r))},function(){busy(b,false,${js(t.deleteButton)});show(xm,L.offline)})});
$('out').addEventListener('click',function(){api('/v1/account/logout','POST',{}).then(function(){location.href=${js(links.login)}})});
})();`;
  return { html: shell(t.dashTitle, body, script, nonce, links, nav), nonce };
}

/**
 * Handoff do app desktop: o ucast.me abre esta página com `?port=&state=&device=`.
 * Se ainda não estiver logado, manda para /login?next=…; senão cria a chave deste
 * computador e redireciona para `http://127.0.0.1:<port>/?key=…&state=…`.
 */
export function desktopPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  const nonce = randomBytes(16).toString('base64');
  const body = `<div class="narrow"><h1>${esc(t.desktopHeading)}</h1>
<p class="lead" id="lead">${esc(t.desktopLead)}</p>
<div id="m" class="msg" role="alert" aria-live="polite"></div>
<p class="btnrow"><button id="ok" class="btn" type="button" hidden></button><a id="go" class="btn" href="${esc(links.account)}" hidden>${esc(t.goAccount)}</a></p></div>`;
  const script = `(function(){
var m=$('m'),lead=$('lead'),go=$('go'),ok=$('ok');
var q=new URLSearchParams(location.search);
var port=q.get('port')||'', state=q.get('state')||'', device=(q.get('device')||'').trim().slice(0,60)||L.defaultPc, post=q.get('post')==='1';
var p=parseInt(port,10);
function fail(text){lead.hidden=true;show(m,text);go.hidden=false}
if(!state||!/^[A-Za-z0-9_-]{8,128}$/.test(state)){fail(L.desktopBadLink);return}
if(!(p>=1024&&p<=65535)){fail(L.desktopBadLink);return}
var loginNext=${js(links.login)}+'?next='+encodeURIComponent(location.pathname+location.search);
api('/v1/account/me').then(function(r){
if(r.status===401){location.replace(loginNext);return}
if(!r.ok){fail(errText(r));return}
CSRF=r.body.csrfToken||'';
if(r.body.emailVerified===false){fail(L.desktopNeedVerify);return}
lead.textContent=fill(L.desktopConfirm,{device:device});
ok.textContent=L.desktopAuthorize;ok.hidden=false;
ok.addEventListener('click',function(){
ok.hidden=true;lead.textContent=L.desktopCreating;
api('/v1/account/keys','POST',{deviceName:device}).then(function(r2){
if(!r2.ok){fail(errText(r2));return}
var key=r2.body.key;
if(!key||String(key).indexOf('ucast_live_')!==0){fail(L.generic);return}
lead.textContent=L.desktopSending;
if(post){var f=document.createElement('form');f.method='POST';f.action='http://127.0.0.1:'+p+'/';
[['key',key],['state',state]].forEach(function(kv){var i=document.createElement('input');i.type='hidden';i.name=kv[0];i.value=kv[1];f.appendChild(i)});
document.body.appendChild(f);f.submit();return}
location.replace('http://127.0.0.1:'+p+'/?key='+encodeURIComponent(key)+'&state='+encodeURIComponent(state));
},function(){fail(L.offline)});
});
},function(){fail(L.offline)});
})();`;
  return { html: shell(t.desktopTitle, body, script, nonce, links), nonce, formAction: DESKTOP_RETURN_ORIGIN };
}

export function notFoundAccountPage(links: PageLinks): RenderedPage {
  const t = stringsOf(links);
  const nonce = randomBytes(16).toString('base64');
  return { html: shell(t.notFoundTitle, `<div class="narrow"><h1>${t.notFoundHeading}</h1><p class="lead"><a href="${esc(links.home)}">${t.backHome}</a></p></div>`, '', nonce, links), nonce };
}
