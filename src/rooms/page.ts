// ── AI Gateway — Live subtitle rooms: viewer pages ───────────────────────────
// Self-contained HTML (inline CSS/JS under a per-response CSP nonce, no CDN, no build step), mobile first, French by default (interface language per app).
//   - roomPage:  live line on top (one line per language, shrink then "…" — never wrapped), full transcript below,
//                language selector, dubbing toggle (Web Audio, gapless, live line in sync with the voice), quick display
//                modes, karaoke highlight, delay indicator, copy text, per-viewer display settings sheet, reconnect.
//   - entryPage: "Saisissez le code de la session".
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

/** Interface languages of the room page; French is the default (the pilot runs in France). */
export const UI_LANGS = ['fr', 'pt', 'en'] as const;
type UiLang = typeof UI_LANGS[number];

/** Every interface string of the room page, per interface language. `{d}` / `{n}` / `{f}` are filled by the script. */
export const UI_TEXT: Record<UiLang, Record<string, string>> = {
  fr: {
    locale: 'fr-FR', dec: ',', name: 'Français', title: 'Sous-titres en direct', connecting: 'connexion…', live: 'en direct',
    reconnecting: 'reconnexion…', ended: 'terminée', waiting: 'En attente de la première prise de parole…',
    noLines: 'Aucune prise de parole dans cette session.', options: 'Options', langLabel: 'Langue des sous-titres', original: 'Original',
    modesLabel: "Mode d'affichage", qTranslation: 'Sous-titres traduits',
    qBilingual: 'Sous-titres doubles (original + traduction)', qTranscript: 'Transcription (langue originale)', qFull: 'Texte complet',
    copy: 'Copier le texte', copied: 'Copié !', settings: 'Réglages', settingsTitle: "Réglages d'affichage", close: 'Fermer les réglages',
    backToTop: 'Revenir en haut', uiLang: "Langue de l'interface", mode: 'Mode',
    mTranslation: 'Traduction', mTranslationD: 'Traduction en avant ; la phrase originale en dessous est facultative',
    mTranscript: 'Transcription seule', mTranscriptD: 'Seulement la phrase originale, sans traduction',
    mBilingual: 'Bilingue', mBilingualD: 'Traduction et phrase originale, toujours',
    mFull: 'Texte complet seul', mFullD: 'Sans la ligne en direct, pour lire le texte',
    showOrig: 'Afficher la phrase originale en dessous', dubbing: 'Doublage', listenDub: 'Écouter le doublage', volume: 'Volume',
    volumeAria: 'Volume du doublage', sync: 'Synchroniser les sous-titres avec la voix', size: 'Taille du texte', smaller: 'Réduire le texte',
    bigger: 'Agrandir le texte', theme: 'Thème', dark: 'Sombre', light: 'Clair', auto: 'Automatique', fullText: 'Texte complet',
    autoScroll: 'Défilement automatique du texte complet', showTimes: 'Afficher les heures',
    endedNotice: 'Session terminée — texte disponible jusqu’au {d}.',
    gone: 'Cette session n’existe plus (le texte reste disponible {n} jours après la dernière prise de parole).',
    noDub: 'Ce navigateur ne lit pas le doublage.', current: 'Sous-titre en cours', langCap: 'Langue',
    withVoice: 'Avec la voix', textOnly: 'Texte seulement', dubPick: 'choisissez une langue de traduction', dubNa: 'indisponible dans cette langue', dubOff: 'désactivé · touchez pour écouter',
    dubLocked: 'touchez ici pour activer le son', dubError: 'erreur de lecture de la voix ({f})', dubPlaying: 'lecture en cours',
    dubLoading: 'chargement de la voix…', dubIdle: 'activé · en attente de la parole',
    dubTipPick: 'Choisissez une langue de traduction pour écouter le doublage', dubTipNa: 'Doublage indisponible dans cette langue',
  },
  pt: {
    locale: 'pt-BR', dec: ',', name: 'Português', title: 'Legendas ao vivo', connecting: 'conectando…', live: 'ao vivo',
    reconnecting: 'reconectando…', ended: 'encerrada', waiting: 'Aguardando a primeira fala…', noLines: 'Nenhuma fala nesta sessão.',
    options: 'Opções', langLabel: 'Idioma da legenda', original: 'Original', modesLabel: 'Modo de exibição',
    qTranslation: 'Legenda traduzida', qBilingual: 'Legenda dupla (original + tradução)',
    qTranscript: 'Transcrição (fala original)', qFull: 'Texto completo', copy: 'Copiar texto', copied: 'Copiado!', settings: 'Ajustes',
    settingsTitle: 'Ajustes de exibição', close: 'Fechar ajustes', backToTop: 'Voltar ao topo', uiLang: 'Idioma da interface', mode: 'Modo',
    mTranslation: 'Tradução', mTranslationD: 'Tradução em destaque; a fala original embaixo é opcional',
    mTranscript: 'Só transcrição', mTranscriptD: 'Só a fala original, sem tradução',
    mBilingual: 'Bilíngue', mBilingualD: 'Tradução e fala original, sempre',
    mFull: 'Só texto completo', mFullD: 'Sem a linha ao vivo, para ler o texto',
    showOrig: 'Mostrar a fala original embaixo', dubbing: 'Dublagem', listenDub: 'Ouvir dublagem', volume: 'Volume',
    volumeAria: 'Volume da dublagem', sync: 'Sincronizar legenda com a voz', size: 'Tamanho do texto', smaller: 'Diminuir o texto',
    bigger: 'Aumentar o texto', theme: 'Tema', dark: 'Escuro', light: 'Claro', auto: 'Automático', fullText: 'Texto completo',
    autoScroll: 'Rolagem automática do texto completo', showTimes: 'Mostrar horários',
    endedNotice: 'Sessão encerrada — texto disponível até {d}.',
    gone: 'Esta sessão não existe mais (o texto fica disponível por {n} dias após a última fala).',
    noDub: 'Este navegador não reproduz a dublagem.', current: 'Legenda atual', langCap: 'Idioma',
    withVoice: 'Com voz', textOnly: 'Só texto', dubPick: 'escolha um idioma de tradução', dubNa: 'indisponível neste idioma', dubOff: 'desligada · toque para ouvir',
    dubLocked: 'toque aqui para ativar o som', dubError: 'erro ao tocar a voz ({f})', dubPlaying: 'tocando',
    dubLoading: 'carregando voz…', dubIdle: 'ligada · aguardando a fala',
    dubTipPick: 'Escolha um idioma de tradução para ouvir a dublagem', dubTipNa: 'Dublagem indisponível neste idioma',
  },
  en: {
    locale: 'en', dec: '.', name: 'English', title: 'Live subtitles', connecting: 'connecting…', live: 'live',
    reconnecting: 'reconnecting…', ended: 'ended', waiting: 'Waiting for the first words…', noLines: 'No speech in this session.',
    options: 'Options', langLabel: 'Subtitle language', original: 'Original', modesLabel: 'Display mode',
    qTranslation: 'Translated subtitles', qBilingual: 'Dual subtitles (original + translation)',
    qTranscript: 'Transcript (original speech)', qFull: 'Full text', copy: 'Copy text', copied: 'Copied!', settings: 'Settings',
    settingsTitle: 'Display settings', close: 'Close settings', backToTop: 'Back to top', uiLang: 'Interface language', mode: 'Mode',
    mTranslation: 'Translation', mTranslationD: 'Translation first; the original underneath is optional',
    mTranscript: 'Transcript only', mTranscriptD: 'Only the original speech, no translation',
    mBilingual: 'Bilingual', mBilingualD: 'Translation and original, always',
    mFull: 'Full text only', mFullD: 'No live line, for reading the text',
    showOrig: 'Show the original underneath', dubbing: 'Dubbing', listenDub: 'Listen to dubbing', volume: 'Volume',
    volumeAria: 'Dubbing volume', sync: 'Sync subtitles with the voice', size: 'Text size', smaller: 'Smaller text',
    bigger: 'Bigger text', theme: 'Theme', dark: 'Dark', light: 'Light', auto: 'Automatic', fullText: 'Full text',
    autoScroll: 'Auto-scroll the full text', showTimes: 'Show times',
    endedNotice: 'Session ended — text available until {d}.',
    gone: 'This session no longer exists (the text stays available {n} days after the last words).',
    noDub: 'This browser cannot play the dubbing.', current: 'Current subtitle', langCap: 'Language',
    withVoice: 'With voice', textOnly: 'Text only', dubPick: 'choose a translation language', dubNa: 'not available in this language', dubOff: 'off · tap to listen',
    dubLocked: 'tap here to turn the sound on', dubError: 'could not play the voice ({f})', dubPlaying: 'playing',
    dubLoading: 'loading the voice…', dubIdle: 'on · waiting for speech',
    dubTipPick: 'Choose a translation language to hear the dubbing', dubTipNa: 'Dubbing not available in this language',
  },
};
const T = UI_TEXT.fr;

const LOGO_MARK = '<span class="mark"><svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle class="disc" cx="16" cy="16" r="16"/><circle class="ring" cx="16" cy="16" r="9.33"/></svg></span>';
const logo = (href?: string) => {
  const inner = `${LOGO_MARK}<span class="word">ucast<b>.me</b></span>`;
  return href ? `<a class="logo" href="${esc(href)}" aria-label="ucast.me">${inner}</a>` : `<span class="logo" aria-label="ucast.me">${inner}</span>`;
};
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%232F6A80'/%3E%3Ccircle cx='16' cy='16' r='9.33' fill='none' stroke='%232D2D31' stroke-width='4'/%3E%3C/svg%3E";

/** Content-Security-Policy of a page rendered with `nonce`. */
export function pageCsp(nonce: string): string {
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`, "connect-src 'self' wss: ws:",
    'media-src blob: data:', 'img-src data:', "font-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'",
  ].join('; ');
}

const BASE_CSS = `
@font-face{font-family:"Bricolage";font-style:normal;font-weight:200 800;font-display:swap;src:url(/live/fonts/bricolage-5.3-latin.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Bricolage";font-style:normal;font-weight:200 800;font-display:swap;src:url(/live/fonts/bricolage-5.3-latin-ext.woff2) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
:root{color-scheme:dark;--bg:#0A1220;--surface:#111C30;--raised:#17253F;--line:#22324F;--text:#EEF3F9;--muted:#93A6BC;--accent:#7FB8CC;--brand:#2F6A80;--brand-hi:#3A8099;--brand-ink:#F4FAFC;--warn:#F5B14C;--spot:rgba(127,184,204,.13)}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:"Bricolage",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-optical-sizing:auto;-webkit-text-size-adjust:100%;-webkit-font-smoothing:antialiased}
::selection{background:var(--brand);color:var(--brand-ink)}
a{color:var(--accent);text-underline-offset:.2em}
button,select,input{font:inherit;color:inherit}
.logo{display:inline-flex;align-items:center;gap:.45em;color:var(--text);text-decoration:none;font-weight:800;letter-spacing:-.025em;line-height:1}
.logo .mark{position:relative;display:inline-flex;width:1.3em;height:1.3em;flex:none}
.logo svg{width:100%;height:100%}
.logo .disc{fill:var(--brand)}
.logo .ring{fill:none;stroke:var(--bg);stroke-width:4}
.logo .word b{font-weight:600;color:var(--accent)}
`;

function shell(title: string, css: string, body: string, script: string, nonce: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0A1220">
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
main{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px;text-align:center;background:radial-gradient(70% 55% at 50% 0%,var(--spot),transparent 70%)}
.logo{font-size:1.6rem}
h1{font-size:clamp(1.6rem,6vw,2.2rem);font-weight:800;letter-spacing:-.03em;line-height:1.1;margin:28px 0 10px;text-wrap:balance}
p{color:var(--muted);margin:0 0 28px;line-height:1.55;max-width:28rem;text-wrap:pretty}
form{display:flex;gap:8px;width:100%;max-width:22rem}
input{flex:1;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:14px;font-size:1.5rem;font-weight:700;letter-spacing:.28em;text-align:center;text-transform:uppercase;caret-color:var(--accent)}
input::placeholder{color:var(--muted);opacity:.55}
input:focus{outline:2px solid var(--accent);outline-offset:2px;border-color:transparent}
button{background:var(--brand);color:var(--brand-ink);border:0;border-radius:16px;padding:0 20px;font-weight:800;cursor:pointer}
button:hover{background:var(--brand-hi)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;

function entryForm(basePath: string): { body: string; script: string } {
  const body = `<form id="f" autocomplete="off">
<input id="c" name="code" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="6" placeholder="K7Q2XM" aria-label="Code de la session" required>
<button type="submit">Entrer</button>
</form>`;
  const script = `(function(){var f=document.getElementById('f'),c=document.getElementById('c');
f.addEventListener('submit',function(e){e.preventDefault();var v=(c.value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');if(v)location.href=${js(basePath)}+v;});c.focus();})();`;
  return { body, script };
}

export function entryPage(opts: PageOptions): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const form = entryForm(opts.basePath);
  const body = `<main>${logo(opts.basePath)}
<h1>Saisissez le code de la session</h1>
<p>Le code figure sur le QR code ou sur l’écran de la personne qui présente.</p>
${form.body}</main>`;
  return { html: shell('Sous-titres en direct · ucast.me', CARD_CSS, body, form.script, nonce), nonce };
}

export function notFoundPage(opts: PageOptions, code: string | null): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const form = entryForm(opts.basePath);
  const which = code ? `La session <strong>${esc(code)}</strong> n’existe pas` : 'Cette session n’existe pas';
  const body = `<main>${logo(opts.basePath)}
<h1>Session introuvable</h1>
<p>${which} ou a expiré — le texte d’une session reste disponible ${opts.retentionDays} jours après la dernière prise de parole. Vérifiez le code et réessayez.</p>
${form.body}</main>`;
  return { html: shell('Session introuvable · ucast.me', CARD_CSS, body, form.script, nonce), nonce };
}

// ── Room page ───────────────────────────────────────────────────────────────
// Layout (mobile first): a sticky top block — status bar (brand · title · delay · pill), the live card (the hero: one
// line per language) and one compact toolbar — over a calm transcript column. Spacing scale 4/8/12/16/24 px.
// Every display setting is the viewer's own (settings sheet behind the gear; localStorage, never sent anywhere).

const LIGHT_VARS = '--bg:#F2F5F9;--surface:#FFFFFF;--raised:#E8EEF5;--line:#D3DCE7;--text:#0F1A2E;--muted:#4D5D73;--accent:#2F6A80;--brand:#2F6A80;--brand-hi:#26586B;--brand-ink:#FFFFFF;--warn:#8a5a00;--bad:#c4262e;--live-bg:rgba(47,106,128,.12);--shade:rgba(15,26,46,.28);--spot:rgba(47,106,128,.09);color-scheme:light';

const ROOM_CSS = `
:root{--bad:#FF7A70;--live-bg:rgba(127,184,204,.14);--shade:rgba(4,8,16,.6);--tx:17px;--pad:max(16px,env(safe-area-inset-left));--pad-r:max(16px,env(safe-area-inset-right));--rail:3.4rem}
html[data-theme="light"]{${LIGHT_VARS}}
@media (prefers-color-scheme:light){html[data-theme="auto"]{${LIGHT_VARS}}}
html{overflow-x:hidden;scrollbar-color:var(--line) transparent}
.wrap{max-width:48rem;margin:0 auto;min-width:0}
header{position:sticky;top:0;z-index:5;background:linear-gradient(var(--bg) 82%,transparent);padding:max(10px,env(safe-area-inset-top)) var(--pad-r) 14px var(--pad)}
.top{display:flex;align-items:center;gap:10px;min-width:0;height:34px}
.top .logo{flex:none;font-size:1.06rem}
.top h1{flex:1;min-width:0;margin:0;font-size:.9rem;font-weight:500;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{flex:none;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;font-size:.75rem;font-weight:700;border-radius:999px;padding:5px 11px;background:var(--surface);color:var(--muted);text-transform:lowercase;letter-spacing:.01em}
.pill.live{background:var(--live-bg);color:var(--accent)}
.pill.live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent)}
.pill.wait{color:var(--warn)}
header:has(.pill.live) .logo .mark::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--accent);animation:onair 2.4s cubic-bezier(.16,1,.3,1) infinite}
@keyframes onair{0%{transform:scale(1);opacity:.7}100%{transform:scale(2.3);opacity:0}}
.btn.yt{flex:none;border:1px solid var(--line);color:var(--text);text-decoration:none;font-weight:700}
.btn.yt[hidden]{display:none}
.btn.yt:hover{border-color:var(--brand-hi);background:var(--live-bg)}
.yt .ytic{width:20px;height:14px;flex:none}
@keyframes pulse{50%{opacity:.35}}
.now{position:relative;margin-top:10px;border-radius:24px;padding:20px;min-height:112px;display:flex;flex-direction:column;justify-content:center;min-width:0;background:radial-gradient(110% 120% at 50% -30%,var(--spot),transparent 62%),var(--surface);border:1px solid var(--line);box-shadow:0 22px 44px -28px rgba(0,0,0,.7)}
.mode-full .now{display:none}
.fit{white-space:nowrap;overflow:hidden;line-height:1.22;max-width:100%}
#liveMain{font-weight:760;letter-spacing:-.022em}
#liveOrig{color:var(--muted);font-weight:500;margin-top:8px}
.empty{color:var(--muted);font-weight:500!important;letter-spacing:0!important}
.ctl{display:flex;gap:8px;margin-top:10px;align-items:stretch;min-width:0}
.lang{flex:0 0 6.75rem;min-width:0;position:relative;display:block}
.lang select{display:block;width:100%;height:60px;-webkit-appearance:none;appearance:none;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:20px 28px 0 14px;font-size:1rem;font-weight:700;cursor:pointer}
.lang select:hover{border-color:var(--brand-hi)}
.lang .cap{position:absolute;left:14px;top:10px;font-size:.68rem;font-weight:600;letter-spacing:.04em;color:var(--muted);pointer-events:none}
.lang::after{content:"";position:absolute;right:14px;top:50%;width:7px;height:7px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:translateY(-70%) rotate(45deg);pointer-events:none}
.dub{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:10px;height:60px;padding:0 14px 0 8px;border-radius:999px;border:1px solid var(--brand);background:var(--live-bg);color:var(--text);cursor:pointer;text-align:left;-webkit-tap-highlight-color:transparent;transition:background-color .2s,border-color .2s}
.dub:hover{background:rgba(127,184,204,.2)}
.dub .ic{position:relative;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:var(--brand);color:var(--brand-ink);flex:none}
.dub .ic svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.dub .dl{display:flex;flex-direction:column;min-width:0;line-height:1.2}
.dub .dt{font-weight:800;font-size:1rem;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dub .ds{font-size:.8rem;line-height:1.15;color:var(--muted);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.dub[aria-pressed="true"]{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
.dub[aria-pressed="true"] .ic{background:var(--brand-ink);color:var(--brand)}
.dub[aria-pressed="true"] .ds{color:var(--brand-ink);font-weight:600}
.dub[data-state="playing"] .ic::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--brand-ink);animation:onair 1.8s cubic-bezier(.16,1,.3,1) infinite}
.dub[data-state="loading"] .ic{animation:pulse 1.2s infinite}
.dub[data-state="locked"],.dub[data-state="error"]{background:var(--surface);color:var(--text);border-color:var(--warn)}
.dub[data-state="locked"] .ic,.dub[data-state="error"] .ic{background:var(--warn);color:var(--bg)}
.dub[data-state="locked"] .ds,.dub[data-state="error"] .ds{color:var(--warn);font-weight:700}
.dub:disabled{cursor:not-allowed;background:var(--surface);border-color:var(--line)}
.dub:disabled .ic{background:var(--raised);color:var(--muted)}
.dub:disabled .dt{color:var(--muted)}
.dub:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media (prefers-reduced-motion:reduce){header:has(.pill.live) .logo .mark::after,.dub .ic,.dub .ic::after{animation:none!important;display:none}}
.tools{display:flex;gap:8px;margin-top:10px;align-items:center;min-width:0}
.sheet select{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:0 10px;height:44px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;background:transparent;border:1px solid var(--line);border-radius:12px;padding:0 12px;cursor:pointer;white-space:nowrap;font-size:.9rem;font-weight:600;color:var(--text)}
.btn:hover{border-color:var(--brand-hi);background:var(--live-bg)}
.btn:focus-visible,select:focus-visible,.sheet input:focus-visible,.sheet:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn[aria-pressed="true"]{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn[hidden]{display:none}
.end{margin-left:auto}
.sm{display:none}
.ico{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.modes{display:flex;gap:2px;padding:3px;border-radius:14px;background:var(--surface);border:1px solid var(--line)}
.modes .mb{border:0;border-radius:10px;height:36px}
.modes .mb:hover{background:var(--raised)}
.modes .mb[aria-pressed="true"]{background:var(--brand)}
.mb{position:relative;width:44px;padding:0}
.mb::after{display:none;content:attr(data-tip);position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);z-index:30;white-space:nowrap;background:var(--text);color:var(--bg);font-size:.78rem;font-weight:600;padding:5px 8px;border-radius:8px;pointer-events:none}
.mb:focus-visible::after,.mb.tip::after{display:block}
@media (hover:hover){.mb:hover::after{display:block}}
.modes .mb:first-child::after{left:0;transform:none}
.modes .mb:last-child::after{left:auto;right:0;transform:none}
.k{color:var(--accent);transition:color .12s linear}
@media (prefers-reduced-motion:reduce){.k{transition:none}}
@media (max-width:767px){.tools{flex-wrap:wrap}.modes{order:5;flex-basis:100%;justify-content:space-between}.modes .mb{flex:1 1 0;padding:0}}
@media (max-width:479px){.lg{display:none}.sm{display:inline}.tools .btn{padding:0 10px;height:44px;min-width:44px}.modes .mb{height:38px}.dub .dt{font-size:.94rem}.top{flex-wrap:wrap;height:auto;row-gap:6px}.top .pill{margin-left:auto}.top h1{order:5;flex-basis:100%;font-size:.85rem}}
@media (max-width:339px){.ctl{flex-wrap:wrap}.lang{flex-basis:100%}}
.notice{max-width:48rem;margin:12px auto 0;padding:12px 14px;border-radius:14px;background:var(--surface);border:1px solid var(--line);color:var(--muted);font-size:.9rem}
.notice:empty{display:none}
.notice-wrap{padding:0 var(--pad-r) 0 var(--pad)}
.txh{max-width:48rem;margin:14px auto 0;padding:0 var(--pad-r) 4px calc(var(--pad) + var(--rail) + 18px);font-size:.8rem;font-weight:700;letter-spacing:.01em;color:var(--muted)}
#tx{position:relative;max-width:48rem;margin:0 auto;padding:0 var(--pad-r) calc(96px + env(safe-area-inset-bottom)) var(--pad)}
#tx::before{content:"";position:absolute;top:0;bottom:96px;left:calc(var(--pad) + var(--rail) + 8px);width:1px;background:var(--line)}
#tx p{position:relative;display:grid;grid-template-columns:var(--rail) minmax(0,1fr);column-gap:18px;margin:0;padding:10px 0;line-height:1.55;font-size:var(--tx);overflow-wrap:anywhere;text-wrap:pretty}
#tx p .ts{grid-column:1;grid-row:1/span 2;justify-self:end;padding-top:.32em;font-size:.72rem;font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums;line-height:1.4}
#tx p .t,#tx p .o{grid-column:2}
#tx p .o{display:block;color:var(--muted);font-size:.86em;line-height:1.5;margin-top:4px}
#tx p.miss .t{color:var(--muted);font-style:italic}
#tx p.cur::before{content:"";position:absolute;left:calc(var(--rail) + 4px);top:calc(10px + .55em);width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--bg)}
#tx p.cur .ts{color:var(--accent)}
.no-times #tx::before,.no-times #tx p.cur::before{display:none}
.no-times #tx p{display:block}
.no-times .txh{padding-left:var(--pad)}
.mode-full #tx p.cur::before{display:none}
#more{position:fixed;right:var(--pad-r);bottom:max(18px,env(safe-area-inset-bottom));z-index:6;width:52px;height:52px;border-radius:50%;border:0;background:var(--brand);color:var(--brand-ink);box-shadow:0 12px 28px -8px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transform:translateY(12px) scale(.9);pointer-events:none;transition:opacity .2s,transform .25s cubic-bezier(.16,1,.3,1)}
#more.show{opacity:1;transform:none;pointer-events:auto}
#more .ico{width:22px;height:22px;stroke-width:2.4}
#more:hover{background:var(--brand-hi)}
#more:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.condensed .ctl,.condensed .tools{display:none}
.condensed .now{min-height:0;padding-top:12px;padding-bottom:12px}
@media (prefers-reduced-motion:reduce){#more{transition:none}}
.backdrop{position:fixed;inset:0;z-index:20;background:var(--shade)}
.sheet{position:fixed;z-index:21;left:0;right:0;bottom:0;max-height:85vh;max-height:85dvh;overflow-y:auto;overscroll-behavior:contain;background:var(--surface);color:var(--text);border-radius:24px 24px 0 0;border-top:1px solid var(--line);padding:4px var(--pad-r) calc(16px + env(safe-area-inset-bottom)) var(--pad);box-shadow:0 -12px 36px rgba(0,0,0,.4)}
.backdrop[hidden],.sheet[hidden]{display:none}
.sheet-head{display:flex;align-items:center;justify-content:space-between;gap:8px;position:sticky;top:0;background:var(--surface);padding:10px 0;z-index:1}
.sheet h2{margin:0;font-size:1.15rem;font-weight:800;letter-spacing:-.02em}
.sheet fieldset{border:0;margin:0;padding:0;min-width:0}
.sheet fieldset.grp{padding:14px 0;border-top:1px solid var(--line)}
.sheet legend{float:left;width:100%}
.sheet legend+*{clear:both}
.sheet legend,.sheet .lbl{display:block;padding:0;margin:0 0 10px;font-size:1rem;font-weight:800;letter-spacing:-.01em;color:var(--text)}
.mpick{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px}
.mcard{position:relative;display:flex;flex-direction:column;gap:4px;padding:8px 8px 10px;border:1px solid var(--line);border-radius:16px;cursor:pointer;background:var(--surface);transition:border-color .15s,background-color .15s}
.mcard:hover{border-color:var(--brand-hi)}
.mcard input{position:absolute;opacity:0;pointer-events:none}
.mcard:has(input:checked){border-color:var(--brand);background:var(--live-bg);box-shadow:inset 0 0 0 1px var(--brand)}
.mcard:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.mcard svg{display:block;width:100%;height:auto;margin-bottom:4px}
.mcard .bg{fill:var(--bg)}
.mcard .st{fill:var(--raised);stroke:var(--line)}
.mcard .tr{fill:var(--accent)}
.mcard .or{fill:var(--muted)}
.mcard .s{opacity:.55}
.mcard b{font-size:.92rem;font-weight:800;letter-spacing:-.01em}
.mcard small{color:var(--muted);font-size:.76rem;line-height:1.3}
.grp{padding:14px 0;border-top:1px solid var(--line)}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;cursor:pointer;font-size:.95rem}
.row input[type=checkbox]{-webkit-appearance:none;appearance:none;position:relative;flex:none;width:44px;height:26px;margin:0;border-radius:999px;background:var(--raised);border:1px solid var(--line);cursor:pointer;transition:background-color .2s,border-color .2s}
.row input[type=checkbox]::before{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--muted);transition:transform .2s cubic-bezier(.16,1,.3,1),background-color .2s}
.row input[type=checkbox]:checked{background:var(--brand);border-color:var(--brand)}
.row input[type=checkbox]:checked::before{transform:translateX(18px);background:var(--brand-ink)}
.row input[type=checkbox]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.row input[type=range]{flex:1 1 auto;min-width:0;max-width:12rem;accent-color:var(--brand-hi)}
.row.off{opacity:.5}
.seg{display:flex;gap:8px;flex-wrap:wrap}
.seg label{flex:1 1 0;min-width:5.5rem;display:flex;align-items:center;justify-content:center;gap:6px;height:42px;border:1px solid var(--line);border-radius:12px;cursor:pointer;font-size:.9rem;font-weight:600}
.seg label:has(input:checked){border-color:var(--brand-hi);background:var(--live-bg)}
.seg input{accent-color:var(--brand-hi);margin:0}
.stepper{display:flex;align-items:center;gap:12px}
.stepper output{min-width:3.5rem;text-align:center;font-weight:700;font-variant-numeric:tabular-nums}
@media (min-width:768px){.top{height:38px}.now{padding:28px 32px;min-height:168px;border-radius:28px}.lang{flex-basis:12rem}:root{--rail:3.8rem}
.backdrop{background:transparent}
.sheet{left:auto;bottom:auto;top:100px;right:16px;width:380px;border:1px solid var(--line);border-radius:20px;padding:4px 20px 16px;box-shadow:0 18px 48px -12px rgba(0,0,0,.55)}}
`;

const ico = (paths: string) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';
/** Quick display modes on the toolbar: [mode, label key, icon]. The dubbed voice is the "Écouter le doublage" toggle. */
const QUICK_MODES: Array<[string, string, string]> = [
  ['translation', 'qTranslation', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h10"/>'],
  ['bilingual', 'qBilingual', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 11.5h10M7 15h6"/>'],
  ['transcript', 'qTranscript', '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'],
  ['full', 'qFull', '<path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h4"/>'],
];
const txt = (k: string) => `data-i="${k}">${esc(T[k])}`;
const bar = (cls: string, x: number, y: number, w: number, h: number) => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`;
const stage = (lines: string) => `<rect class="st" x="8" y="8" width="104" height="28" rx="7"/>${lines}`;
const MODE_ART: Record<string, string> = {
  translation: stage(bar('tr', 18, 19, 72, 6)) + bar('tr s', 14, 46, 88, 3.5) + bar('tr s', 14, 54, 70, 3.5) + bar('tr s', 14, 62, 80, 3.5),
  transcript: stage(bar('or', 18, 19, 62, 6)) + bar('or s', 14, 46, 84, 3.5) + bar('or s', 14, 54, 66, 3.5) + bar('or s', 14, 62, 78, 3.5),
  bilingual: stage(bar('tr', 18, 15, 72, 6) + bar('or', 18, 25, 54, 4)) + bar('tr s', 14, 44, 84, 3.5) + bar('or s', 14, 50, 64, 3) + bar('tr s', 14, 60, 76, 3.5) + bar('or s', 14, 66, 58, 3),
  full: bar('tr s', 14, 12, 90, 3.5) + bar('tr s', 14, 20, 74, 3.5) + bar('tr s', 14, 32, 86, 3.5) + bar('tr s', 14, 40, 60, 3.5) + bar('tr s', 14, 52, 88, 3.5) + bar('tr s', 14, 60, 70, 3.5),
};
const opt = (mode: string, k: string) =>
  `<label class="mcard"><input type="radio" name="sMode" value="${mode}"><svg viewBox="0 0 120 76" aria-hidden="true" focusable="false"><rect class="bg" width="120" height="76" rx="9"/>${MODE_ART[mode]}</svg><b ${txt(k)}</b><small ${txt(k + 'D')}</small></label>`;
const uiOptions = UI_LANGS.map(l => `<option value="${l}">${esc(UI_TEXT[l].name)}</option>`).join('');

const ROOM_BODY = `<header><div class="wrap">
<div class="top">${logo()}<h1 id="title" ${txt('title')}</h1><span id="pill" class="pill wait" ${txt('connecting')}</span></div>
<section class="now" aria-live="polite" data-ia="current" aria-label="${esc(T.current)}"><div id="liveMain" class="fit empty">${esc(T.waiting)}</div><div id="liveOrig" class="fit" hidden></div></section>
<div class="ctl">
<label class="lang"><span class="cap" ${txt('langCap')}</span><select id="lang" data-ia="langLabel" aria-label="${esc(T.langLabel)}"></select></label>
<button id="dub" class="dub" type="button" aria-pressed="false" aria-describedby="dubState" data-state="off"><span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="2"/><rect x="16" y="14" width="5" height="7" rx="2"/></svg></span><span class="dl"><span class="dt" ${txt('listenDub')}</span><span id="dubState" class="ds" aria-live="polite" ${txt('dubOff')}</span></span></button>
</div>
<div class="tools" role="toolbar" data-ia="options" aria-label="${esc(T.options)}">
<div class="modes" role="group" data-ia="modesLabel" aria-label="${esc(T.modesLabel)}">
${QUICK_MODES.map(([m, k, p]) => `<button class="btn mb" type="button" data-m="${m}" aria-pressed="false" data-ia="${k}" data-tip="${esc(T[k])}" aria-label="${esc(T[k])}">${ico(p)}</button>`).join('\n')}
</div>
<a id="yt" class="btn yt" target="_blank" rel="noopener noreferrer" aria-label="Regarder sur YouTube" hidden><svg class="ytic" viewBox="0 0 20 14" aria-hidden="true" focusable="false"><rect width="20" height="14" rx="4" fill="#ff0000"/><path d="M8 4l5.2 3L8 10z" fill="#ffffff"/></svg><span class="lg" id="ytLbl">Regarder sur YouTube</span><span class="sm">YouTube</span></a>
<button id="copy" class="btn end" type="button" data-ia="copy" aria-label="${esc(T.copy)}">${ico('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>')}<span class="lg" id="copyLbl" ${txt('copy')}</span></button>
<button id="gear" class="btn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="sheet" data-ia="settingsTitle" aria-label="${esc(T.settingsTitle)}">${ico(GEAR)}<span class="lg" ${txt('settings')}</span></button>
</div>
</div></header>
<div class="notice-wrap"><div id="notice" class="notice" role="status"></div></div>
<div class="txh" aria-hidden="true" ${txt('fullText')}</div>
<main id="tx" data-ia="fullText" aria-label="${esc(T.fullText)}"></main>
<button id="more" type="button" data-ia="backToTop" aria-label="${esc(T.backToTop)}">${ico('<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>')}</button>
<div id="backdrop" class="backdrop" hidden></div>
<div id="sheet" class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" tabindex="-1" hidden>
<div class="sheet-head"><h2 id="sheetTitle" ${txt('settingsTitle')}</h2><button id="sClose" class="btn" type="button" data-ia="close" aria-label="${esc(T.close)}">✕</button></div>
<div class="grp"><label class="lbl" for="sUi" ${txt('uiLang')}</label><select id="sUi">${uiOptions}</select></div>
<div class="grp"><label class="lbl" for="sLang" ${txt('langLabel')}</label><select id="sLang"></select></div>
<fieldset class="grp"><legend ${txt('mode')}</legend>
<div class="mpick">
${opt('translation', 'mTranslation')}
${opt('bilingual', 'mBilingual')}
${opt('transcript', 'mTranscript')}
${opt('full', 'mFull')}
</div>
<label class="row" id="sOrigRow"><span ${txt('showOrig')}</span><input id="sOrig" type="checkbox" role="switch"></label>
</fieldset>
<fieldset class="grp"><legend ${txt('dubbing')}</legend>
<label class="row"><span ${txt('listenDub')}</span><input id="sDub" type="checkbox" role="switch"></label>
<label class="row"><span ${txt('volume')}</span><input id="sVol" type="range" min="0" max="100" step="5" data-ia="volumeAria" aria-label="${esc(T.volumeAria)}"></label>
<label class="row"><span ${txt('sync')}</span><input id="sSync" type="checkbox" role="switch"></label>
</fieldset>
<div class="grp"><span class="lbl" id="sSizeLbl" ${txt('size')}</span><div class="stepper" role="group" aria-labelledby="sSizeLbl">
<button id="sSmaller" class="btn" type="button" data-ia="smaller" aria-label="${esc(T.smaller)}">A−</button><output id="sSize" aria-live="polite">100%</output><button id="sBigger" class="btn" type="button" data-ia="bigger" aria-label="${esc(T.bigger)}">A+</button></div></div>
<fieldset class="grp"><legend ${txt('theme')}</legend><div class="seg">
<label><input type="radio" name="sTheme" value="dark"><span ${txt('dark')}</span></label><label><input type="radio" name="sTheme" value="light"><span ${txt('light')}</span></label><label><input type="radio" name="sTheme" value="auto"><span ${txt('auto')}</span></label>
</div></fieldset>
<fieldset class="grp"><legend ${txt('fullText')}</legend>
<label class="row"><span ${txt('autoScroll')}</span><input id="sScroll" type="checkbox" role="switch"></label>
<label class="row"><span ${txt('showTimes')}</span><input id="sTimes" type="checkbox" role="switch"></label>
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
 *   - median(values): the delay median sent with the analytics samples (the page does not show it).
 *   - karaoke: speechMs(text) estimates how long `text` took to say (CHARS_PER_S, ~150 words/min); wordStarts(text, start,
 *     dur) spreads the words of `text` over [start, start+dur] by character length; spokenCount(starts, t) is how many
 *     words are already said at t (those are coloured). The publisher sends no word timestamps, so the times are an
 *     estimate: from the dubbed clip (start + real duration) when the voice is on, else from the line's arrival.
 *   - parseSettings(json, legacyOrig) / normalizeSettings(raw): the display settings (localStorage "ucast-settings-<app>",
 *     one per app that opened the live; interface language `ui` fr by default), every field validated, defaults for the rest; the older "ucast-orig" = "1" still turns the
 *     original on. textSizes(step, viewportWidth): {live, tx} px for an A−/A+ step (live 20–56, transcript 14–24).
 *   - lineView(mode, showOrig, lang, hasTranslation): what a line shows — {main: 'tr'|'orig', sub, miss}.
 *   - safeYoutubeUrl(u): the room's YouTube link when it is an https URL on youtube.com / www. / m. / youtu.be (the
 *     server already validates it; checked again before it becomes an href), else null (the link stays hidden).
 *   - youtubeLabel(prefs): "Assistir no YouTube" in the first of `prefs` it knows (pt / en / fr / es; default pt); the page
 *     passes the interface language.
 *   - listenMsg(dubOn, lang): the `listen` message (sent on every (re)connect and on every dub/language change).
 *   - dubStatus({can, lang, on, ctx, error, playing, loading}, L): the dub toggle's visible state in the interface language
 *     L — {kind, text}: na | off | locked (AudioContext not running: the next tap resumes it) | error (`error` = the clip
 *     format) | playing | loading | idle.
 *   - silentWav(rate, samples): a silent 16-bit mono WAV as a binary string — played by an <audio> element inside the
 *     tap so iOS puts the page's audio session in "playback" (otherwise the ringer switch mutes Web Audio).
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
var CHARS_PER_S=15;
function speechMs(text){return Math.max(800,String(text==null?'':text).length*1000/CHARS_PER_S)}
function wordStarts(text,start,dur){
  var w=String(text==null?'':text).split(/\s+/).filter(Boolean),total=0,acc=0,out=[],i;
  for(i=0;i<w.length;i++)total+=w[i].length+1;
  for(i=0;i<w.length;i++){out.push(start+dur*acc/total);acc+=w[i].length+1}
  return out;
}
function spokenCount(starts,t){var n=0;while(n<starts.length&&starts[n]<=t)n++;return n}
var UIS=['fr','pt','en'];
var SETTINGS_DEFAULTS={ui:'fr',mode:'translation',showOrig:false,volume:0.9,sync:true,size:0,theme:'auto',autoScroll:true,showTimes:true};
var SIZE_MIN=-3,SIZE_MAX=7,MODES=['translation','transcript','bilingual','full'],THEMES=['dark','light','auto'];
function normalizeSettings(raw){
  var s={},k;for(k in SETTINGS_DEFAULTS)s[k]=SETTINGS_DEFAULTS[k];
  if(!raw||typeof raw!=='object')return s;
  if(MODES.indexOf(raw.mode)>=0)s.mode=raw.mode;
  if(THEMES.indexOf(raw.theme)>=0)s.theme=raw.theme;
  if(UIS.indexOf(raw.ui)>=0)s.ui=raw.ui;
  ['showOrig','sync','autoScroll','showTimes'].forEach(function(b){if(typeof raw[b]==='boolean')s[b]=raw[b]});
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
var YT_HOSTS=['youtube.com','www.youtube.com','m.youtube.com','youtu.be'];
function safeYoutubeUrl(u){
  if(typeof u!=='string'||!u||u.length>200)return null;
  var m=/^https:\/\/([^\/?#@:]+)(?:[\/?#]|$)/i.exec(u);
  if(!m||YT_HOSTS.indexOf(m[1].toLowerCase())<0||/[\s"'<>\\]/.test(u))return null;
  return u;
}
var YT_LABELS={pt:'Assistir no YouTube',en:'Watch on YouTube',fr:'Regarder sur YouTube',es:'Ver en YouTube'};
function youtubeLabel(prefs){
  prefs=prefs||[];
  for(var i=0;i<prefs.length;i++){
    var p=String(prefs[i]||'').toLowerCase().split('-')[0];
    if(Object.prototype.hasOwnProperty.call(YT_LABELS,p))return YT_LABELS[p];
  }
  return YT_LABELS.pt;
}
function lineView(mode,showOrig,lang,hasTr){
  if(lang==='orig'||mode==='transcript')return {main:'orig',sub:false,miss:false};
  if(!hasTr)return {main:'orig',sub:false,miss:true};
  return {main:'tr',sub:mode==='bilingual'||!!showOrig,miss:false};
}
function dubbable(lang,dubLangs){
  if(!lang||lang==='orig')return false;
  return !Array.isArray(dubLangs)||dubLangs.indexOf(lang)>=0;
}
function listenMsg(on,lang){var l=lang&&lang!=='orig'?lang:null;return JSON.stringify({type:'listen',lang:on?l:null,view:l,chunks:true})}
function s16ToFloat(bin){var n=bin.length>>1,out=new Float32Array(n);for(var i=0;i<n;i++){var v=bin.charCodeAt(2*i)|(bin.charCodeAt(2*i+1)<<8);out[i]=(v>=32768?v-65536:v)/32768}return out}
function dubStatus(s,L){
  if(!s.can)return {kind:'na',text:s.lang==='orig'?L.dubPick:L.dubNa};
  if(!s.on)return {kind:'off',text:L.dubOff};
  if(!s.ctx||s.ctx!=='running')return {kind:'locked',text:L.dubLocked};
  if(s.error)return {kind:'error',text:L.dubError.replace('{f}',s.error)};
  if(s.playing)return {kind:'playing',text:L.dubPlaying};
  if(s.loading)return {kind:'loading',text:L.dubLoading};
  return {kind:'idle',text:L.dubIdle};
}
function silentWav(rate,samples){
  var n=samples*2,h=[];
  function s(t){for(var i=0;i<t.length;i++)h.push(t.charCodeAt(i))}
  function u32(v){h.push(v&255,(v>>8)&255,(v>>16)&255,(v>>>24)&255)}
  function u16(v){h.push(v&255,(v>>8)&255)}
  s('RIFF');u32(36+n);s('WAVE');s('fmt ');u32(16);u16(1);u16(1);u32(rate);u32(rate*2);u16(2);u16(16);s('data');u32(n);
  for(var i=0;i<n;i++)h.push(0);
  var o='';for(var j=0;j<h.length;j++)o+=String.fromCharCode(h[j]);
  return o;
}
`;

/** The page script (plain ES2017, no framework). Placeholders: __CODE__, __DAYS__, __APP__, __UI__. */
const ROOM_SCRIPT = String.raw`(function(){
'use strict';
${ROOM_PAGE_LOGIC}
var CODE=__CODE__,DAYS=__DAYS__,APP=__APP__,UI=__UI__;
var AUDIO_WAIT_MS=4000,MAX_BACKLOG_S=25,FADE_S=0.01,LEAD_S=0.05;
var $=function(id){return document.getElementById(id)};
var store={get:function(k){try{return localStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
var SETTINGS_KEY='ucast-settings-'+APP;
var settings=parseSettings(store.get(SETTINGS_KEY)||store.get('ucast-settings'),store.get('ucast-orig'));
var L=UI[settings.ui],dn=null;
function langName(c){try{var n=dn&&dn.of(c);if(n)return n.charAt(0).toUpperCase()+n.slice(1)}catch(e){}return c}
var pillKey='connecting',notice=null;
function fill(k,v){var t=L[k];for(var x in v)t=t.replace('{'+x+'}',v[x]);return t}
function setNotice(k,v){notice=k?{k:k,v:v||{}}:null;$('notice').textContent=k?fill(k,notice.v):''}
function applyUi(){
  L=UI[settings.ui];dn=null;try{dn=new Intl.DisplayNames([L.locale],{type:'language'})}catch(e){}
  document.documentElement.lang=settings.ui;
  Array.prototype.forEach.call(document.querySelectorAll('[data-i]'),function(e){e.textContent=L[e.getAttribute('data-i')]});
  Array.prototype.forEach.call(document.querySelectorAll('[data-ia]'),function(e){var t=L[e.getAttribute('data-ia')];e.setAttribute('aria-label',t);if(e.hasAttribute('data-tip'))e.setAttribute('data-tip',t)});
  var yt=youtubeLabel([settings.ui]);$('ytLbl').textContent=yt;$('yt').setAttribute('aria-label',yt);
  if(room){$('title').textContent=room.title||L.title;document.title=(room.title||L.title)+' · ucast.me';fillLangSelect($('lang'));fillLangSelect($('sLang'));updateDubButton()}
  setPill($('pill').className.replace('pill','').trim(),pillKey);
  if(notice)setNotice(notice.k,notice.v);
}

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
function snapshot(){return {ui:settings.ui,lang:lang||'orig',mode:settings.mode,showOrig:settings.showOrig,dub:dub,volume:settings.volume,sync:settings.sync,size:settings.size,theme:settings.theme,autoScroll:settings.autoScroll,showTimes:settings.showTimes}}
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
function fmtDate(iso){try{return new Date(iso).toLocaleDateString(L.locale,{day:'numeric',month:'long',year:'numeric'})}catch(e){return iso}}
function fmtTime(ts){if(!(ts>1e11))return '';try{return new Date(ts).toLocaleTimeString(L.locale,{hour:'2-digit',minute:'2-digit'})}catch(e){return ''}}

// ── settings: the viewer's own, applied instantly, kept in this browser ──
function saveSettings(){store.set(SETTINGS_KEY,JSON.stringify(settings))}
var mql=null;try{mql=window.matchMedia('(prefers-color-scheme: light)')}catch(e){}
function applyTheme(){
  document.documentElement.setAttribute('data-theme',settings.theme);
  var light=settings.theme==='light'||(settings.theme==='auto'&&mql&&mql.matches);
  var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',light?'#F5F5F7':'#252528');
}
if(mql&&mql.addEventListener)mql.addEventListener('change',applyTheme);
function applySettings(rerender){
  applyTheme();
  var b=document.body.classList;b.toggle('mode-full',settings.mode==='full');b.toggle('no-times',!settings.showTimes);
  document.documentElement.style.setProperty('--tx',textSizes(settings.size,window.innerWidth).tx+'px');
  if(outGain)outGain.gain.value=settings.volume;
  updateModes();
  if(rerender!==false)renderAll();
  if(!sheet.hidden)syncSheet();
}
function setSetting(k,v,from){var before=settings[k];settings[k]=v;settings=normalizeSettings(settings);saveSettings();if(k==='ui')applyUi();applySettings();
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
  el.style.fontSize=r.px+'px';el.title=r.text===text?'':text;
  el._full=text;el._shown=r.text;el._k=-1;paintKaraoke();
}

// ── karaoke: the words already said are coloured, one by one, on the live line and the current transcript line ──
var kRaf=null;
function wordsOf(t){return String(t||'').split(/\s+/).filter(Boolean)}
function karaokeAt(l,text){
  var m=M(l.id),start=m.arrivedAt,dur=speechMs(l.original);
  if(syncOn()&&m.startedAt!=null&&m.durMs){start=m.startedAt;dur=m.durMs}
  return spokenCount(wordStarts(text,start,dur),now());
}
function paintWords(el,k){
  var w=wordsOf(el._shown),drop=wordsOf(el._full).length-w.length,said=Math.max(0,k-drop);
  el.textContent='';
  for(var i=0;i<w.length;i++){
    if(i)el.appendChild(document.createTextNode(' '));
    if(i<said){var sp=document.createElement('span');sp.className='k';sp.textContent=w[i];el.appendChild(sp)}
    else el.appendChild(document.createTextNode(w[i]));
  }
}
function karaokeEls(){
  var els=[],cur=liveId!=null?$('tx').querySelector('p[data-id="'+liveId+'"]'):null;
  if(settings.mode!=='full'&&!$('liveMain').classList.contains('empty')){els.push($('liveMain'));if(!$('liveOrig').hidden)els.push($('liveOrig'))}
  if(cur)Array.prototype.forEach.call(cur.querySelectorAll('.t,.o'),function(e){if(e._full==null){e._full=e._shown=e.textContent;e._k=-1}els.push(e)});
  return els;
}
function paintKaraoke(){
  var l=liveId!=null?byId[liveId]:null,busy=false;if(!l)return;
  karaokeEls().forEach(function(el){
    var k=karaokeAt(l,el._full),n=wordsOf(el._full).length;
    if(k!==el._k){el._k=k;paintWords(el,k)}
    if(k<n)busy=true;
  });
  if(busy&&!kRaf)kRaf=requestAnimationFrame(function(){kRaf=null;paintKaraoke()});
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
  if(settings.mode==='full'){paintKaraoke();return}
  if(!l){main.className='fit empty';main.style.fontSize='';main.title='';main.textContent=ended?L.noLines:L.waiting;orig.hidden=true;return}
  var v=view(l);
  main.className='fit'+(v.miss?' empty':'');
  fit(main,v.main,base);
  if(v.sub){orig.hidden=false;fit(orig,v.sub,Math.round(base*0.62))}else orig.hidden=true;
}
function markCurrent(id){
  if(id===liveId)return;
  var tx=$('tx'),prev=liveId,old=prev!=null?tx.querySelector('p[data-id="'+prev+'"]'):null;
  liveId=id;if(old&&byId[prev])tx.replaceChild(para(byId[prev]),old);
  var el=id!=null?tx.querySelector('p[data-id="'+id+'"]'):null;if(el)el.classList.add('cur');
}

// ── delay indicator: rolling median of the last 10 lines (text) or of the last 10 clips (voice) ──

// ── transcript ──
function atTop(){return window.scrollY<=40}
function para(l){
  var p=document.createElement('p'),v=view(l);
  p.setAttribute('data-id',String(l.id));if(v.miss)p.className='miss';if(l.id===liveId)p.classList.add('cur');
  var tm=fmtTime(l.ts);if(tm){var e=document.createElement('time');e.className='ts';e.textContent=tm;e.dateTime=new Date(l.ts).toISOString();p.appendChild(e)}
  var s=document.createElement('span');s.className='t';s.textContent=v.main;p.appendChild(s);
  if(v.sub){var o=document.createElement('span');o.className='o';o.textContent=v.sub;p.appendChild(o)}
  return p;
}
function renderAll(){
  var tx=$('tx');tx.textContent='';
  var frag=document.createDocumentFragment();for(var i=lines.length-1;i>=0;i--)frag.appendChild(para(lines[i]));tx.appendChild(frag);
  renderLive();
}
function upsert(l){
  var stick=settings.autoScroll&&atTop(),tx=$('tx'),old=byId[l.id];
  if(old){lines[lines.indexOf(old)]=l;byId[l.id]=l;var el=tx.querySelector('p[data-id="'+l.id+'"]');if(el)tx.replaceChild(para(l),el)}
  else{
    byId[l.id]=l;M(l.id).arrivedAt=now();stat.lines++;if(l.ts>1e11)stat.lag.push(Date.now()-l.ts);var i=lines.length;while(i>0&&lines[i-1].id>l.id)i--;lines.splice(i,0,l);
    var newer=lines[i+1]?tx.querySelector('p[data-id="'+lines[i+1].id+'"]'):null;tx.insertBefore(para(l),newer?newer.nextSibling:tx.firstChild);
    if(dub){setTimeout(renderLive,AUDIO_WAIT_MS+20);expectVoice(l)}
  }
  renderLive();
  if(stick)window.scrollTo(0,0);
}

// ── languages ──
function pickDefault(){
  var prefs=(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||'']);
  var saved=store.get('ucast-lang-'+CODE);
  if(!(saved&&(saved==='orig'||allLangs().indexOf(saved)>=0)))saved=store.get('ucast-lang-last');
  return saved&&saved!=='orig'&&allLangs().indexOf(saved)>=0?saved:pickLang(prefs,room.languages,saved);
}
function allLangs(){return room.languages.concat(room.listenLangs||[])}
function fillLangSelect(sel){
  sel.textContent='';
  var o=document.createElement('option');o.value='orig';o.textContent=room.originalLang?L.original+' ('+langName(room.originalLang)+')':L.original;sel.appendChild(o);
  var opt=function(c){var x=document.createElement('option');x.value=c;x.textContent=langName(c);return x};
  var voiced=allLangs().filter(function(c){return dubbable(c,room.dubLangs)}),mute=allLangs().filter(function(c){return !dubbable(c,room.dubLangs)});
  if(!voiced.length||!mute.length)allLangs().forEach(function(c){sel.appendChild(opt(c))});
  else[[L.withVoice,voiced],[L.textOnly,mute]].forEach(function(g){var og=document.createElement('optgroup');og.label=g[0];g[1].forEach(function(c){og.appendChild(opt(c))});sel.appendChild(og)});
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
$('sUi').addEventListener('change',function(e){setSetting('ui',e.target.value,'sheet')});
var relayout=null;function onResize(){if(relayout)cancelAnimationFrame(relayout);relayout=requestAnimationFrame(function(){relayout=null;document.documentElement.style.setProperty('--tx',textSizes(settings.size,window.innerWidth).tx+'px');renderLive();if(!sheet.hidden)placeSheet()})}
window.addEventListener('resize',onResize);window.addEventListener('orientationchange',onResize);

// ── dubbing: Web Audio, one AudioContext (created/resumed synchronously inside the tap), clips decoded and scheduled
//    back to back on its timeline with a 10 ms fade in/out (no clicks); the live line switches when a clip STARTS
//    playing. Mobile unlock (unlockAudio, always inside a user gesture): iOS audio session → "playback" (else the ringer
//    switch mutes Web Audio), a silent <audio> element played (same effect on older iOS), the context resumed and a
//    1-sample buffer started. A context the OS suspends (screen lock, call, app switch) is resumed by the next tap; the
//    toggle says so ("toque aqui para ativar o som"), and shows carregando voz… / tocando / decode errors. ──
var VOICE_WAIT_MS=20000;
var actx=null,outGain=null,qEnd=0,pending=[],playingSrc=[],pumpTimer=null,unlockEl=null,dubErr=null,decoding=0,awaitId=null,awaitAt=0,dubTick=null,dubKind='';
function b64Buf(b64){var bin=atob(b64),n=bin.length,u=new Uint8Array(n);for(var i=0;i<n;i++)u[i]=bin.charCodeAt(i);return u.buffer}
function unlockAudio(){
  try{var as=navigator.audioSession;if(as&&as.type!=='playback')as.type='playback'}catch(e){}
  try{
    if(!unlockEl){unlockEl=document.createElement('audio');unlockEl.setAttribute('playsinline','');unlockEl.setAttribute('webkit-playsinline','');unlockEl.preload='auto';unlockEl.src='data:audio/wav;base64,'+btoa(silentWav(8000,1600))}
    var pp=unlockEl.play();if(pp&&pp.catch)pp.catch(function(){});
  }catch(e){}
  if(!actx){var AC=window.AudioContext||window.webkitAudioContext;if(!AC)return false;
    try{actx=new AC()}catch(e){actx=null;return false}
    try{outGain=actx.createGain();outGain.gain.value=settings.volume;outGain.connect(actx.destination)}catch(e){actx=null;return false}
    try{actx.onstatechange=function(){if(actx.state==='running'&&pending.length)pump();updateDubUi()}}catch(e){}
  }
  try{if(actx.state!=='running'&&actx.resume){var r=actx.resume();if(r&&r.then)r.then(function(){pump();updateDubUi()},function(){updateDubUi()})}}catch(e){}
  try{var b=actx.createBuffer(1,1,22050),s=actx.createBufferSource();s.buffer=b;s.connect(actx.destination);s.start(0)}catch(e){}
  return true;
}
function locked(){return !!(dub&&actx&&actx.state!=='running')}
/** Any tap anywhere while the OS has suspended the context resumes it (it must happen inside a gesture on iOS). */
function wake(){if(locked())unlockAudio()}
['touchend','click','keydown'].forEach(function(t){document.addEventListener(t,wake,true)});
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&locked()){try{actx.resume().then(updateDubUi,updateDubUi)}catch(e){}updateDubUi()}});
function updateDubUi(){
  var b=$('dub');if(!b)return;
  var playing=!!(actx&&playingSrc.length&&actx.currentTime<qEnd);
  var awaiting=awaitId!=null&&now()-awaitAt<VOICE_WAIT_MS;
  var st=dubStatus({can:canDub(),lang:lang,on:dub,ctx:actx?actx.state:null,error:dubErr,playing:playing,loading:decoding>0||pending.length>0||awaiting},L);
  if(st.kind!==dubKind){dubKind=st.kind;b.setAttribute('data-state',st.kind)}
  var ds=$('dubState');if(ds.textContent!==st.text)ds.textContent=st.text;
  if(dub&&!dubTick)dubTick=setInterval(updateDubUi,400);else if(!dub&&dubTick){clearInterval(dubTick);dubTick=null}
}
function stopAudio(){
  pending=[];if(pumpTimer){clearTimeout(pumpTimer);pumpTimer=null}
  playingSrc.forEach(function(s){try{s.stop()}catch(e){}});playingSrc=[];qEnd=0;awaitId=null;dubErr=null;
  var t=now();for(var k in meta){var m=meta[k];m.pending=false;if(m.startedAt!=null&&m.startedAt>t)m.startedAt=null}
}
function pump(){
  pumpTimer=null;if(!dub||!actx)return;
  var t=actx.currentTime,durs=pending.map(function(c){return c.buf?c.buf.duration:0});
  var n=backlogDrop(qEnd-t,durs,MAX_BACKLOG_S),gone={},dropped=0;
  for(var i=0;i<n;i++){var id=pending[i].lineId;if(M(id).startedAt==null&&!gone[id]){gone[id]=1;dropped++}}
  if(dropped){stat.drops+=dropped;track('audio',{action:'drop',n:dropped});
    pending=pending.filter(function(c){return !gone[c.lineId]});for(var k in gone){var dm=M(k);dm.pending=false;dm.skip=true}}
  while(pending.length&&pending[0].buf&&qEnd-actx.currentTime<0.5)schedule(pending.shift());
  if(pending.length)pumpTimer=setTimeout(pump,100);
  updateDubUi();
}
function schedule(c){
  var start=nextStart(actx.currentTime,qEnd,LEAD_S),dur=c.buf.duration;
  if(qEnd>0){var gap=start-qEnd;if(gap>0.02&&gap<3){stat.gaps++;stat.gapMs+=gap*1000}}
  var src=actx.createBufferSource(),g=actx.createGain(),f=Math.min(FADE_S,dur/4);
  var fadeIn=!c.part||M(c.lineId).startedAt==null||start>qEnd+0.001;
  src.buffer=c.buf;
  if(fadeIn){g.gain.setValueAtTime(0,start);g.gain.linearRampToValueAtTime(1,start+f)}else g.gain.setValueAtTime(1,start);
  if(!c.part){g.gain.setValueAtTime(1,start+dur-f);g.gain.linearRampToValueAtTime(0,start+dur)}
  src.connect(g);g.connect(outGain);src.start(start);
  src.onended=function(){var i=playingSrc.indexOf(src);if(i>=0)playingSrc.splice(i,1);try{g.disconnect()}catch(e){}updateDubUi()};
  playingSrc.push(src);qEnd=start+dur;
  var m=M(c.lineId),at=now()+(start-actx.currentTime)*1000;
  if(m.startedAt==null){m.startedAt=at;m.durMs=dur*1000;m.pending=false;m.skip=false;setTimeout(function(){onClipStart(c.lineId)},Math.max(0,at-now()))}
  else if(c.part)m.durMs+=dur*1000;
}
function onClipStart(id){
  var m=meta[id],l=byId[id];stat.clips++;
  if(m&&m.arrivedAt>0&&m.startedAt!=null)stat.drift.push(syncOn()?now()-m.startedAt:m.startedAt-m.arrivedAt);
  if(m&&l&&m.arrivedAt>0&&m.startedAt!=null){voiceDelays.push((typeof l.delayMs==='number'?l.delayMs:0)+(m.startedAt-m.arrivedAt));if(voiceDelays.length>10)voiceDelays.shift()}
  renderLive();updateDubUi();
}
/** A line arrived while listening: its voice is on the way (the toggle says "carregando voz…" for a while). */
function expectVoice(l){if(dub&&lang!=='orig'&&l.translations&&l.translations[lang]){awaitId=l.id;awaitAt=now();updateDubUi()}}
function onAudio(msg){
  if(!dub||!actx||msg.lang!==lang||typeof msg.wav!=='string')return;
  if(awaitId!=null&&msg.lineId>=awaitId)awaitId=null;
  var m=M(msg.lineId);if(m.pending||m.startedAt!=null)return;m.pending=true;m.skip=false;
  var c={lineId:msg.lineId,buf:null},done=false,fmt=String(msg.format||'wav');pending.push(c);decoding++;
  var fail=function(){if(done)return;done=true;decoding--;
    track('audio',{action:'decode_error',format:fmt});dubErr=fmt;
    var i=pending.indexOf(c);if(i>=0)pending.splice(i,1);if(m.startedAt==null)m.pending=false;renderLive();pump();updateDubUi()};
  var ok=function(buf){if(done)return;if(!buf){fail();return}done=true;decoding--;dubErr=null;c.buf=buf;pump()};
  var ab;try{ab=b64Buf(msg.wav)}catch(e){fail();return}
  try{var p=actx.decodeAudioData(ab,ok,fail);if(p&&p.then)p.then(ok,fail)}catch(e){fail()}
  updateDubUi();
}
function onAudioChunk(msg){
  if(!dub||!actx||msg.lang!==lang||typeof msg.pcm!=='string')return;
  if(awaitId!=null&&msg.lineId>=awaitId)awaitId=null;
  var samples;try{samples=s16ToFloat(atob(msg.pcm))}catch(e){return}
  if(!samples.length)return;
  var m=M(msg.lineId);if(m.startedAt==null){m.pending=true;m.skip=false}
  var buf=actx.createBuffer(1,samples.length,msg.rate||24000);buf.getChannelData(0).set(samples);
  pending.push({lineId:msg.lineId,buf:buf,part:true});pump();
}
function canDub(){return !ended&&dubbable(lang,room&&room.dubLangs)}
function updateDubButton(){
  var b=$('dub'),can=canDub();b.disabled=!can;
  b.title=can?'':(lang==='orig'?L.dubTipPick:L.dubTipNa);
  if(!can&&dub)setDub(false,'auto');
  updateDubUi();
}
function setDub(on,from){
  if(on&&!unlockAudio()){setNotice('noDub');on=false;track('audio',{action:'unsupported'})}
  if(from&&on!==dub){track('setting',{key:'dub',value:on,from:from});track('audio',{action:on?'play':'pause'})}
  dub=on;var b=$('dub');b.setAttribute('aria-pressed',on?'true':'false');
  if(!on){stopAudio();voiceDelays=[];if(unlockEl){try{unlockEl.pause()}catch(e){}}}
  sendListen();renderLive();updateDubUi();if(!sheet.hidden)syncSheet();
}
/** The toggle: while the OS holds the sound (context suspended), a tap re-activates it instead of switching it off. */
$('dub').addEventListener('click',function(){if(locked()){unlockAudio();updateDubUi();track('audio',{action:'resume'});return}setDub(!dub,'toolbar')});

// ── quick modes on the toolbar: one tap switches the display mode, the current one is pressed; tooltip on hover/focus/tap ──
var modeBtns=Array.prototype.slice.call(document.querySelectorAll('.mb'));
function updateModes(){modeBtns.forEach(function(b){b.setAttribute('aria-pressed',b.getAttribute('data-m')===settings.mode?'true':'false')})}
function quickMode(m){
  if((m==='translation'||m==='bilingual')&&lang==='orig'&&room&&room.languages.length)setLang(room.languages[0],'toolbar');
  setSetting('mode',m,'toolbar');
}
modeBtns.forEach(function(b){b.addEventListener('click',function(){
  quickMode(b.getAttribute('data-m'));
  modeBtns.forEach(function(x){x.classList.remove('tip')});b.classList.add('tip');clearTimeout(b._tip);b._tip=setTimeout(function(){b.classList.remove('tip')},1400);
})});

// ── settings sheet (bottom sheet on phones, popover from 768 px): focus trap, Esc / backdrop close ──
var sheet=$('sheet'),backdrop=$('backdrop'),opener=null;
function radios(name){return Array.prototype.slice.call(sheet.querySelectorAll('input[name="'+name+'"]'))}
function syncSheet(){
  $('sLang').value=lang||'orig';$('sUi').value=settings.ui;
  radios('sMode').forEach(function(r){r.checked=r.value===settings.mode});
  radios('sTheme').forEach(function(r){r.checked=r.value===settings.theme});
  var origOk=settings.mode==='translation'||settings.mode==='full';
  $('sOrig').checked=settings.mode==='bilingual'||settings.showOrig;$('sOrig').disabled=!origOk;$('sOrigRow').classList.toggle('off',!origOk);
  $('sDub').checked=dub;$('sDub').disabled=!canDub();
  $('sVol').value=String(Math.round(settings.volume*100));$('sVol').setAttribute('aria-valuetext',Math.round(settings.volume*100)+'%');
  $('sSync').checked=settings.sync;
  $('sSize').textContent=(100+settings.size*10)+'%';$('sSmaller').disabled=settings.size<=SIZE_MIN;$('sBigger').disabled=settings.size>=SIZE_MAX;
  $('sScroll').checked=settings.autoScroll;$('sTimes').checked=settings.showTimes;
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

// ── copy ──
$('copy').addEventListener('click',function(){
  track('ui',{action:'copy'});
  var t=lines.map(function(l){var v=view(l);return v.sub?v.main+'\n'+v.sub:v.main}).join('\n\n');
  var b=$('copyLbl');
  var ok=function(){b.textContent=L.copied;b.classList.remove('lg');setTimeout(function(){b.textContent=L.copy;b.classList.add('lg')},1600)};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,fallback)}else fallback();
  function fallback(){var a=document.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();try{document.execCommand('copy');ok()}catch(e){}document.body.removeChild(a)}
});
$('more').addEventListener('click',function(){track('ui',{action:'top'});window.scrollTo({top:0,behavior:'smooth'})});
window.addEventListener('scroll',function(){
  var y=window.scrollY,b=document.body.classList;
  if(y>160)b.add('condensed');else if(y<40)b.remove('condensed');
  $('more').classList.toggle('show',y>400);
},{passive:true});

// ── state ──
function setPill(kind,k){pillKey=k;var p=$('pill');p.className='pill '+kind;p.textContent=L[k]}
function showEnded(){
  if(!ended&&joined)track('ui',{action:'ended'});
  ended=true;setPill('','ended');setDub(false);updateDubButton();
  var until=expiresAt||new Date(Date.now()+DAYS*864e5).toISOString();
  setNotice('endedNotice',{d:fmtDate(until)});
  renderLive();
}
function applyRoom(r){
  room=r;expiresAt=r.expiresAt||null;lines=[];byId={};
  (r.lines||[]).forEach(function(l){byId[l.id]=l;lines.push(l);M(l.id)});lines.sort(function(a,b){return a.id-b.id});
  var t=r.title||L.title;$('title').textContent=t;document.title=t+' · ucast.me';
  applyYoutube(r.youtubeUrl);
  buildSelect();renderAll();trackJoin();updateDubButton();
  if(r.ended)showEnded();
}
// ── "Regarder sur YouTube": the presenter's live on YouTube, when the app sent its link (snapshot or "update") ──
function applyYoutube(u){
  var a=$('yt'),ok=safeYoutubeUrl(u);
  if(ok){a.href=ok;a.hidden=false}else{a.hidden=true;a.removeAttribute('href')}
}
$('yt').addEventListener('click',function(){track('ui',{action:'youtube'})});
function notFound(){gone=true;setPill('','ended');setNotice('gone',{n:DAYS})}

// ── socket, reconnect with backoff ──
/** Tells the server which language this viewer listens to — on every (re)connect, dub toggle and language change. */
function sendListen(){if(ws&&ws.readyState===1)ws.send(listenMsg(dub,lang))}
function connect(){
  if(ended||gone)return;
  var proto=location.protocol==='https:'?'wss:':'ws:';
  var s;try{s=new WebSocket(proto+'//'+location.host+'/v1/rooms/'+CODE+'/ws')}catch(e){retry();return}
  ws=s;var opened=false,ping=null;
  s.onopen=function(){opened=true;attempt=0;sendListen();ping=setInterval(function(){if(s.readyState===1)s.send('{"type":"ping"}')},20000)};
  s.onmessage=function(ev){var m;try{m=JSON.parse(ev.data)}catch(e){return}
    if(m.type==='snapshot'){applyRoom(m.room);if(!m.room.ended){setPill('live','live');setNotice(null)}}
    else if(m.type==='line'&&room)upsert(m.line);
    else if(m.type==='audio')onAudio(m);
    else if(m.type==='audio-chunk')onAudioChunk(m);
    else if(m.type==='update'){if(room)room.youtubeUrl=m.youtubeUrl;applyYoutube(m.youtubeUrl);
      if(room&&m.dubLangs){room.dubLangs=m.dubLangs;room.listenLangs=m.listenLangs;buildSelect();updateDubButton()}}
    else if(m.type==='ended')showEnded();};
  s.onclose=function(){if(ping)clearInterval(ping);if(ws===s)ws=null;if(ended||gone)return;
    setPill('wait','reconnecting');if(joined)track('ui',{action:'reconnect'});
    if(!opened){fetch('/v1/rooms/'+CODE,{cache:'no-store'}).then(function(r){if(r.status===404)notFound();else retry()},retry)}else retry();};
}
function retry(){if(ended||gone||timer)return;var d=Math.min(15000,1000*Math.pow(2,attempt++))*(0.75+Math.random()*0.5);
  timer=setTimeout(function(){timer=null;connect()},d)}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&!ws&&!ended&&!gone){if(timer){clearTimeout(timer);timer=null}attempt=0;connect()}});

applyUi();applySettings(false);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){if(room)renderLive()});
fetch('/v1/rooms/'+CODE,{cache:'no-store'}).then(function(r){if(r.status===404){notFound();return null}return r.ok?r.json():null})
  .then(function(r){if(r&&!room)applyRoom(r)},function(){}).then(function(){if(!gone)connect()});
})();`;

/** `app`: the id of the app that opened the live (appIdOf the room owner); display settings are kept per app. */
export function roomPage(code: string, opts: PageOptions, app = 'default'): RenderedPage {
  const nonce = randomBytes(16).toString('base64');
  const script = ROOM_SCRIPT.replace('__CODE__', js(code)).replace('__DAYS__', js(opts.retentionDays))
    .replace('__APP__', () => js(app)).replace('__UI__', () => js(UI_TEXT));
  return { html: shell(`${T.title} · ucast.me`, ROOM_CSS, ROOM_BODY, script, nonce), nonce };
}
