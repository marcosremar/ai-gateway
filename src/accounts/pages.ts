// ── AI Gateway — ucast.me accounts: pages ────────────────────────────────────
// Self-contained HTML like the live page (src/rooms/page.ts): inline CSS/JS under a per-response CSP nonce, no CDN,
// mobile first, pt-BR, same palette. The pages only call the same-origin JSON API (/v1/account/*).

import { randomBytes } from 'crypto';

export interface RenderedPage { html: string; nonce: string }

export interface PageLinks {
  home: string; signup: string; login: string; forgot: string; reset: string; account: string;
  download: string;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c] ?? c);
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2319c2b4'/%3E%3Crect x='7' y='12' width='18' height='3' rx='1.5' fill='%231b1b1f'/%3E%3Crect x='10' y='18' width='12' height='3' rx='1.5' fill='%231b1b1f'/%3E%3C/svg%3E";

export function accountPageCsp(nonce: string): string {
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`, "connect-src 'self'", 'img-src data:',
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}

const CSS = `
:root{color-scheme:dark;--bg:#1b1b1f;--surface:#24242a;--surface2:#2c2c33;--line:#34343c;--text:#ececf1;--muted:#a3a3ae;--accent:#19c2b4;--accent-ink:#06211f;--warn:#e0a84a;--bad:#ff7d7d;--ok:#5fd39a}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f6f8;--surface:#fff;--surface2:#f0f0f4;--line:#dcdce4;--text:#1b1b1f;--muted:#5b5b66;--accent:#0b7d74;--accent-ink:#fff;--warn:#8a5a00;--bad:#c4262e;--ok:#1d7a4b}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%;line-height:1.5}
a{color:var(--accent)}
button,input{font:inherit;color:inherit}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:56rem;margin:0 auto;padding:16px max(16px,env(safe-area-inset-left))}
.brand{font-weight:700;letter-spacing:.02em;color:var(--text);text-decoration:none;font-size:1.15rem}.brand b{color:var(--accent)}
main{max-width:56rem;margin:0 auto;padding:8px 16px 48px}
.narrow{max-width:26rem;margin:4vh auto 0}
h1{font-size:1.5rem;margin:8px 0 6px}h2{font-size:1.1rem;margin:0 0 4px}
p.lead{color:var(--muted);margin:0 0 20px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 16px}
label{display:block;font-weight:600;font-size:.92rem;margin:14px 0 6px}
input[type=email],input[type=password],input[type=text]{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:1rem}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;background:var(--accent);color:var(--accent-ink);border:0;border-radius:10px;padding:0 18px;font-weight:700;cursor:pointer;text-decoration:none}
.btn.full{width:100%;margin-top:18px}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
.btn.danger{background:transparent;color:var(--bad);border:1px solid var(--line);min-height:36px;padding:0 12px;font-weight:600}
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
#kf{margin-top:12px}#dev{flex:1;min-width:12rem;width:auto}#who{margin:0}.btnrow{margin:12px 0 0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:480px){.keybox{flex-direction:column}.top{padding:12px 16px}}
`;

function shell(title: string, body: string, script: string, nonce: string, links: PageLinks, nav = ''): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1b1b1f">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="icon" href="${ICON}">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header class="top"><a class="brand" href="${esc(links.home)}"><b>u</b>cast.me</a><nav class="row">${nav}</nav></header>
<main id="main">
${body}
</main>
${script ? `<script nonce="${nonce}">${COMMON_JS}${script}</script>` : ''}
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
function errText(res){return (res.body&&res.body.error&&res.body.error.message)||'Algo deu errado. Tente de novo.'}
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

const EMAIL_FIELD = `<label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" inputmode="email" required autofocus>`;

export function signupPage(links: PageLinks): RenderedPage {
  return formPage('Criar conta · ucast.me', 'Criar sua conta',
    'Com a conta você recebe a chave de ativação do app ucast.me para Windows e Mac.',
    `${EMAIL_FIELD}<label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required aria-describedby="ph"><p id="ph" class="hint">Pelo menos 8 caracteres.</p>`,
    'Criar conta', `Já tem conta? <a href="${esc(links.login)}">Entrar</a>`,
    `(function(){var f=$('f'),b=$('b'),m=$('m');f.addEventListener('submit',function(e){e.preventDefault();show(m,'');
var email=$('email').value.trim(),pw=$('password').value;
if(!email||email.indexOf('@')<1){show(m,'Informe um e-mail válido.');$('email').focus();return}
if(pw.length<8){show(m,'A senha precisa ter pelo menos 8 caracteres.');$('password').focus();return}
busy(b,true,'Criando…');api('/v1/account/signup','POST',{email:email,password:pw}).then(function(r){
if(r.ok){location.href=${js(links.account)};return}busy(b,false,'Criar conta');show(m,errText(r))},function(){busy(b,false,'Criar conta');show(m,'Sem conexão. Tente de novo.')})})})();`,
    links);
}

export function loginPage(links: PageLinks): RenderedPage {
  return formPage('Entrar · ucast.me', 'Entrar', 'Acesse sua conta para ver a chave de ativação e o uso.',
    `${EMAIL_FIELD}<label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<p class="hint"><a href="${esc(links.forgot)}">Esqueci minha senha</a></p>`,
    'Entrar', `Não tem conta? <a href="${esc(links.signup)}">Criar conta</a>`,
    `(function(){var f=$('f'),b=$('b'),m=$('m');f.addEventListener('submit',function(e){e.preventDefault();show(m,'');
var email=$('email').value.trim(),pw=$('password').value;if(!email||!pw){show(m,'Informe e-mail e senha.');return}
busy(b,true,'Entrando…');api('/v1/account/login','POST',{email:email,password:pw}).then(function(r){
if(r.ok){location.href=${js(links.account)};return}busy(b,false,'Entrar');show(m,errText(r))},function(){busy(b,false,'Entrar');show(m,'Sem conexão. Tente de novo.')})})})();`,
    links);
}

export function forgotPage(links: PageLinks): RenderedPage {
  return formPage('Recuperar senha · ucast.me', 'Recuperar senha', 'Enviaremos um link para você criar uma nova senha.',
    EMAIL_FIELD, 'Enviar link', `<a href="${esc(links.login)}">Voltar para entrar</a>`,
    `(function(){var f=$('f'),b=$('b'),m=$('m');f.addEventListener('submit',function(e){e.preventDefault();show(m,'');
var email=$('email').value.trim();if(!email||email.indexOf('@')<1){show(m,'Informe um e-mail válido.');return}
busy(b,true,'Enviando…');api('/v1/account/password/forgot','POST',{email:email}).then(function(r){busy(b,false,'Enviar link');
if(r.ok){show(m,'Se existir uma conta com este e-mail, você vai receber o link em instantes. Confira também o spam.','ok');return}show(m,errText(r))},
function(){busy(b,false,'Enviar link');show(m,'Sem conexão. Tente de novo.')})})})();`,
    links);
}

export function resetPage(links: PageLinks): RenderedPage {
  return formPage('Nova senha · ucast.me', 'Criar nova senha', 'Escolha a nova senha da sua conta. Você entrará de novo em seguida.',
    `<label for="password">Nova senha</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required autofocus aria-describedby="ph"><p id="ph" class="hint">Pelo menos 8 caracteres.</p>`,
    'Salvar senha', `<a href="${esc(links.login)}">Voltar para entrar</a>`,
    `(function(){var f=$('f'),b=$('b'),m=$('m');var t=(location.hash.match(/token=([A-Za-z0-9_-]+)/)||[])[1]||'';
if(t&&history.replaceState)history.replaceState(null,'',location.pathname);
if(!t){show(m,'Link incompleto. Abra o link do e-mail de novo ou peça outro.');b.disabled=true}
f.addEventListener('submit',function(e){e.preventDefault();show(m,'');var pw=$('password').value;
if(pw.length<8){show(m,'A senha precisa ter pelo menos 8 caracteres.');return}
busy(b,true,'Salvando…');api('/v1/account/password/reset','POST',{token:t,password:pw}).then(function(r){
if(r.ok){show(m,'Senha alterada. Redirecionando para entrar…','ok');setTimeout(function(){location.href=${js(links.login)}},1200);return}
busy(b,false,'Salvar senha');show(m,errText(r))},function(){busy(b,false,'Salvar senha');show(m,'Sem conexão. Tente de novo.')})})})();`,
    links);
}

export function homePage(links: PageLinks): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const body = `<section class="hero"><h1>Legendas e dublagem ao vivo</h1>
<p>O ucast.me traduz o que você fala em tempo real, com legenda na tela, transmissão e dublagem para o público no celular.</p>
<div class="row"><a class="btn" href="${esc(links.signup)}">Criar conta grátis</a><a class="btn ghost" href="${esc(links.login)}">Entrar</a></div>
<p class="hint"><a href="${esc(links.download)}">Baixar o app</a></p></section>`;
  return { html: shell('ucast.me', body, '', nonce, links), nonce };
}

export function dashboardPage(links: PageLinks): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const nav = `<span id="who" class="hint"></span><button id="out" class="btn ghost" type="button">Sair</button>`;
  const body = `<h1>Sua conta</h1><p class="lead" id="lead">Carregando…</p>
<div id="gm" class="msg" role="alert" aria-live="polite"></div>
<section class="card" aria-labelledby="kh"><h2 id="kh">Sua chave de ativação</h2>
<p class="hint">Cole a chave no app ucast.me (em “Ativar o ucast.me”). Use uma chave por computador — se um deles for perdido, revogue só a dele.</p>
<form id="kf" class="row"><label class="sr" for="dev">Nome do computador</label>
<input id="dev" type="text" maxlength="60" placeholder="Nome do computador (ex.: Notebook do escritório)" autocomplete="off">
<button id="kb" class="btn" type="submit">Criar chave</button></form>
<div id="new" hidden><p class="msg ok">Copie a chave agora: por segurança ela não será mostrada de novo.</p>
<div class="keybox"><code id="nk"></code><button id="copy" class="btn" type="button">Copiar</button></div></div>
<div id="km" class="msg" role="alert" aria-live="polite"></div>
<ul id="keys" class="keys" aria-label="Suas chaves"></ul></section>
<section class="card" aria-labelledby="uh"><h2 id="uh">Uso este mês</h2><p class="hint" id="plan"></p>
<div class="grid" id="stats"></div>
<div class="scroll"><table id="days"><caption class="sr">Uso por dia, últimos 30 dias</caption><thead><tr><th scope="col">Dia</th><th scope="col">Transcrição</th><th scope="col">Tradução</th><th scope="col">Dublagem</th><th scope="col">Salas</th><th scope="col">Pedidos</th></tr></thead><tbody></tbody></table></div></section>
<section class="card" aria-labelledby="dh"><h2 id="dh">Baixar o app</h2><p class="hint">Instale o ucast.me, abra “Ativar o ucast.me” e cole a sua chave.</p>
<p class="btnrow"><a class="btn" href="${esc(links.download)}" rel="noopener">Baixar o ucast.me</a></p></section>`;
  const script = `(function(){
var gm=$('gm'),km=$('km');
function fmtMin(s){var m=s/60;return m<10?m.toFixed(1).replace('.',','):String(Math.round(m))}
function n(x){return Math.round(x).toLocaleString('pt-BR')}
function when(s){return s?new Date(s).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'nunca'}
function stat(label,used,limit,fmt,unit){var d=document.createElement('div');d.className='stat';
var v=document.createElement('div');v.className='v';v.textContent=fmt(used)+(unit?' '+unit:'');
var l=document.createElement('div');l.className='l';l.textContent=label+(limit>0?' · limite '+fmt(limit)+(unit?' '+unit:''):' · sem limite');
d.appendChild(v);d.appendChild(l);if(limit>0){var b=document.createElement('div');b.className='bar';var i=document.createElement('i');
i.style.width=Math.min(100,used/limit*100)+'%';b.appendChild(i);d.appendChild(b)}return d}
function renderKeys(list){var ul=$('keys');ul.textContent='';
if(!list.length){var li=document.createElement('li');li.className='meta';li.textContent='Nenhuma chave ainda.';ul.appendChild(li);return}
list.forEach(function(k){var li=document.createElement('li');if(!k.active)li.className='off';
var info=document.createElement('div');var nm=document.createElement('div');nm.className='name';nm.textContent=k.deviceName;
var meta=document.createElement('div');meta.className='meta';meta.textContent=k.prefix+'…  ·  criada '+when(k.createdAt)+'  ·  último uso '+when(k.lastUsedAt)+(k.appVersion?'  ·  app '+k.appVersion:'')+(k.active?'':'  ·  revogada');
info.appendChild(nm);info.appendChild(meta);li.appendChild(info);
if(k.active){var b=document.createElement('button');b.className='btn danger';b.type='button';b.textContent='Revogar';
b.setAttribute('aria-label','Revogar a chave de '+k.deviceName);
b.addEventListener('click',function(){if(!confirm('Revogar a chave de “'+k.deviceName+'”? O app nesse computador para de funcionar até ser ativado de novo.'))return;
busy(b,true);api('/v1/account/keys/'+encodeURIComponent(k.id),'DELETE').then(function(r){if(!r.ok){busy(b,false);show(km,errText(r));return}loadKeys()})});li.appendChild(b)}
ul.appendChild(li)})}
function loadKeys(){return api('/v1/account/keys').then(function(r){if(r.ok)renderKeys(r.body.keys||[])})}
function loadUsage(){return api('/v1/account/usage?days=30').then(function(r){if(!r.ok)return;var u=r.body,q=u.quota,mo=q.month,lim=q.limits;
$('plan').textContent='Plano: '+q.plan+' · o mês renova em '+new Date(q.monthResetsAt).toLocaleDateString('pt-BR');
var s=$('stats');s.textContent='';
s.appendChild(stat('Transcrição',mo.audioSeconds,lim.audioSeconds,fmtMin,'min'));
s.appendChild(stat('Tradução',mo.llmTokens,lim.llmTokens,n,'tokens'));
s.appendChild(stat('Dublagem',mo.ttsChars,lim.ttsChars,n,'caracteres'));
s.appendChild(stat('Salas ao vivo',mo.rooms,lim.rooms,n,''));
var tb=$('days').tBodies[0];tb.textContent='';u.days.slice().reverse().forEach(function(d){if(!d.requests&&!d.rooms)return;var tr=document.createElement('tr');
[d.day.split('-').reverse().join('/'),fmtMin(d.audioSeconds)+' min',n(d.llmTokens),n(d.ttsChars),n(d.rooms),n(d.requests)].forEach(function(t){var td=document.createElement('td');td.textContent=t;tr.appendChild(td)});tb.appendChild(tr)});
if(!tb.rows.length){var tr=document.createElement('tr');var td=document.createElement('td');td.colSpan=6;td.className='meta';td.textContent='Sem uso nos últimos 30 dias.';tr.appendChild(td);tb.appendChild(tr)}})}
api('/v1/account/me').then(function(r){if(r.status===401){location.href=${js(links.login)};return}
if(!r.ok){show(gm,errText(r));return}CSRF=r.body.csrfToken||'';$('who').textContent=r.body.email;
$('lead').textContent='Conectado como '+r.body.email+'.';loadKeys();loadUsage()},function(){show(gm,'Sem conexão. Recarregue a página.')});
$('kf').addEventListener('submit',function(e){e.preventDefault();show(km,'');var b=$('kb');busy(b,true,'Criando…');
api('/v1/account/keys','POST',{deviceName:$('dev').value}).then(function(r){busy(b,false,'Criar chave');if(!r.ok){show(km,errText(r));return}
$('nk').textContent=r.body.key;$('new').hidden=false;$('dev').value='';$('copy').focus();loadKeys()})});
$('copy').addEventListener('click',function(){var t=$('nk').textContent,c=$('copy');
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){c.textContent='Copiada!'},function(){
var r=document.createRange();r.selectNodeContents($('nk'));var sel=getSelection();sel.removeAllRanges();sel.addRange(r);c.textContent='Selecionada — Ctrl+C'})});
$('out').addEventListener('click',function(){api('/v1/account/logout','POST',{}).then(function(){location.href=${js(links.login)}})});
})();`;
  return { html: shell('Sua conta · ucast.me', body, script, nonce, links, nav), nonce };
}

export function notFoundAccountPage(links: PageLinks): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  return { html: shell('Página não encontrada · ucast.me', `<div class="narrow"><h1>Página não encontrada</h1><p class="lead"><a href="${esc(links.home)}">Voltar ao início</a></p></div>`, '', nonce, links), nonce };
}
