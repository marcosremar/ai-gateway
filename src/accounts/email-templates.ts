import type { EmailMessage } from './email';
import type { PageLang } from './page-strings';

type Mail = Omit<EmailMessage, 'to'>;

const GLASS = '#0a1012';
const PANEL = '#0d1517';
const SCREEN = '#080d0f';
const HAIRLINE = '#1f2b2e';
const INK = '#e9f2f3';
const INK_2 = '#a3b8bb';
const INK_3 = '#8ba5a8';
const PHOS = '#4cc3cb';
const FONT = "Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const SITE = 'https://ucast.me';

const escape = (s: string): string => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

interface Block {
  tag: string;
  heading: string;
  intro: string[];
  button?: { label: string; href: string };
  readout?: Array<[label: string, value: string]>;
  steps?: string[];
  code?: { label: string; value: string };
  after?: string[];
}

interface Chrome { why: string; fallback: string; tagline: string }

const CHROME: Record<PageLang, Chrome> = {
  pt: { why: 'Você recebeu este e-mail porque há uma conta ucast.me com este endereço.', fallback: 'Se o botão não abrir, copie o link', tagline: 'Legendas e dublagem ao vivo' },
  en: { why: 'You are receiving this because there is a ucast.me account with this address.', fallback: 'If the button does not open, copy the link', tagline: 'Live subtitles and dubbing' },
  fr: { why: 'Vous recevez cet e-mail car un compte ucast.me existe avec cette adresse.', fallback: 'Si le bouton ne s’ouvre pas, copiez le lien', tagline: 'Sous-titres et doublage en direct' },
};

const label = (s: string, color = INK_3): string =>
  `<span style="font:500 11px/1.4 ${MONO};letter-spacing:0.16em;text-transform:uppercase;color:${color}">${escape(s)}</span>`;

const paragraph = (s: string): string => `<p style="margin:0 0 16px;font:400 16px/1.6 ${FONT};color:${INK_2}">${escape(s)}</p>`;

const lamp = `<span style="display:inline-block;width:7px;height:7px;border-radius:7px;background:${PHOS};vertical-align:1px"></span>`;

function button(b: NonNullable<Block['button']>): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 28px"><tr><td bgcolor="${PHOS}" style="background:${PHOS};border-radius:3px">`
    + `<a href="${escape(b.href)}" style="display:inline-block;padding:15px 28px;font:700 16px/1 ${FONT};letter-spacing:-0.01em;color:#04161a;text-decoration:none;border-radius:3px">${escape(b.label)}</a></td></tr></table>`;
}

function readout(rows: NonNullable<Block['readout']>): string {
  const cells = rows.map(([l, v], i) => `<td style="padding:14px ${i < rows.length - 1 ? '28px' : '0'} 14px 0;vertical-align:top;white-space:nowrap">${label(l)}<br><span style="font:600 15px/1.6 ${MONO};font-variant-numeric:tabular-nums;color:${PHOS}">${escape(v)}</span></td>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;border-top:1px solid ${HAIRLINE};border-bottom:1px solid ${HAIRLINE}"><tr>${cells}<td width="100%"></td></tr></table>`;
}

function strips(steps: string[]): string {
  const rows = steps.map((s, i) => {
    const rule = i ? `border-top:1px solid ${HAIRLINE};` : '';
    return `<tr><td style="padding:14px 16px 14px 0;${rule}white-space:nowrap;vertical-align:top">${label(`CH${i + 1}`, PHOS)}</td>`
      + `<td style="padding:14px 0;${rule}font:500 15px/1.5 ${FONT};color:${INK}">${escape(s)}</td></tr>`;
  }).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;border-bottom:1px solid ${HAIRLINE}">${rows}</table>`;
}

function code(c: NonNullable<Block['code']>): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 24px"><tr><td bgcolor="${SCREEN}" style="background:${SCREEN};border:1px solid ${HAIRLINE};border-radius:3px;padding:16px 18px">`
    + `${label(c.label)}<div style="margin-top:8px;font:600 15px/1.55 ${MONO};color:${PHOS};word-break:break-all">${escape(c.value)}</div></td></tr></table>`;
}

function render(lang: PageLang, subject: string, b: Block): Mail {
  const c = CHROME[lang];
  const fallback = b.button ? `<p style="margin:28px 0 0;padding-top:18px;border-top:1px solid ${HAIRLINE}">${label(c.fallback)}<br><a href="${escape(b.button.href)}" style="font:400 12px/1.7 ${MONO};color:${PHOS};word-break:break-all;text-decoration:none">${escape(b.button.href)}</a></p>` : '';
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${escape(subject)}</title>
<style>@font-face{font-family:Archivo;font-weight:100 900;src:url(${SITE}/fonts/archivo-latin.woff2) format('woff2')}@font-face{font-family:'JetBrains Mono';font-weight:100 800;src:url(${SITE}/fonts/jetbrains-mono-latin.woff2) format('woff2')}a{color:${PHOS}}</style></head>
<body bgcolor="${GLASS}" style="margin:0;padding:0;background:${GLASS};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${GLASS}">${escape(b.intro[0] ?? '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${GLASS}" style="background:${GLASS}"><tr><td align="center" style="padding:40px 16px 48px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
<tr><td style="padding:0 4px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle"><a href="${SITE}" style="text-decoration:none;font:800 21px/1 ${FONT};letter-spacing:-0.03em;color:${INK}"><img src="${SITE}/email/mark.png" width="22" height="22" alt="" style="display:inline-block;vertical-align:-4px;border:0;margin-right:8px">ucast<span style="font-weight:600;color:${PHOS}">.me</span></a></td>
<td align="right" style="vertical-align:middle;white-space:nowrap">${lamp}&nbsp;&nbsp;${label(b.tag)}</td>
</tr></table></td></tr>
<tr><td bgcolor="${PANEL}" style="background:${PANEL};border:1px solid ${HAIRLINE};border-radius:6px;padding:40px 36px 34px">
<h1 style="margin:0 0 18px;font:700 28px/1.2 ${FONT};letter-spacing:-0.025em;color:${INK}">${escape(b.heading)}</h1>
${b.intro.map(paragraph).join('')}${b.button ? button(b.button) : ''}${b.readout ? readout(b.readout) : ''}${b.steps ? strips(b.steps) : ''}${b.code ? code(b.code) : ''}${(b.after ?? []).map(paragraph).join('')}${fallback}
</td></tr>
<tr><td style="padding:24px 4px 0">${label('SN 2025-UC-001 · CAL OK')}<p style="margin:10px 0 0;font:400 12px/1.6 ${FONT};color:${INK_3}">${escape(c.why)}<br><a href="${SITE}" style="color:${INK_2};text-decoration:none">ucast.me</a> · ${escape(c.tagline)}</p></td></tr>
</table></td></tr></table></body></html>`;
  const text = [b.heading, '', ...b.intro, ...(b.button ? ['', `${b.button.label}: ${b.button.href}`] : []),
    ...(b.readout ? ['', b.readout.map(([l, v]) => `${l}: ${v}`).join(' · ')] : []), ...(b.steps ? ['', ...b.steps.map((s, i) => `${i + 1}. ${s}`)] : []),
    ...(b.code ? ['', b.code.value] : []), ...(b.after?.length ? ['', ...b.after] : []), '', '—', c.why, SITE].join('\n');
  return { subject, html, text };
}

export function verifyEmail(lang: PageLang, link: string, welcome: boolean, downloadUrl: string): Mail {
  const t = {
    pt: { subject: welcome ? 'Bem-vindo ao ucast.me — confirme seu e-mail' : 'Confirme seu e-mail no ucast.me', tag: welcome ? 'Conta nova' : 'Confirmação', heading: welcome ? 'Bem-vindo ao ucast.me' : 'Confirme seu e-mail',
      intro: welcome ? ['Sua conta foi criada. Falta só confirmar que este e-mail é seu.'] : ['Confirme que este e-mail é seu para manter a conta segura.'],
      label: 'Confirmar e-mail', valid: 'Validade', steps: [`Baixe o app em ${downloadUrl}`, 'Na sua conta, crie uma chave de ativação e cole no app.', 'Escolha os idiomas e toque em Iniciar.'], after: 'Se você não criou esta conta, ignore este e-mail.' },
    en: { subject: welcome ? 'Welcome to ucast.me — confirm your e-mail' : 'Confirm your e-mail on ucast.me', tag: welcome ? 'New account' : 'Confirmation', heading: welcome ? 'Welcome to ucast.me' : 'Confirm your e-mail',
      intro: welcome ? ['Your account is ready. Just confirm this e-mail is yours.'] : ['Confirm this e-mail is yours to keep your account secure.'],
      label: 'Confirm e-mail', valid: 'Valid for', steps: [`Download the app at ${downloadUrl}`, 'In your account, create an activation key and paste it into the app.', 'Pick your languages and press Start.'], after: 'If you did not create this account, ignore this e-mail.' },
    fr: { subject: welcome ? 'Bienvenue sur ucast.me — confirmez votre e-mail' : 'Confirmez votre e-mail sur ucast.me', tag: welcome ? 'Nouveau compte' : 'Confirmation', heading: welcome ? 'Bienvenue sur ucast.me' : 'Confirmez votre e-mail',
      intro: welcome ? ['Votre compte est créé. Il reste à confirmer que cet e-mail est bien le vôtre.'] : ['Confirmez que cet e-mail est le vôtre pour sécuriser votre compte.'],
      label: 'Confirmer l’e-mail', valid: 'Validité', steps: [`Téléchargez l’app sur ${downloadUrl}`, 'Dans votre compte, créez une clé d’activation et collez-la dans l’app.', 'Choisissez les langues et appuyez sur Démarrer.'], after: 'Si vous n’avez pas créé ce compte, ignorez cet e-mail.' },
  }[lang];
  return render(lang, t.subject, { tag: t.tag, heading: t.heading, intro: t.intro, button: { label: t.label, href: link }, readout: [[t.valid, '48 H']], steps: welcome ? t.steps : undefined, after: [t.after] });
}

export function resetPassword(lang: PageLang, link: string, minutes: number): Mail {
  const t = {
    pt: { subject: 'Redefinir sua senha do ucast.me', tag: 'Senha', heading: 'Redefinir sua senha', intro: 'Recebemos um pedido para criar uma nova senha para a sua conta.', label: 'Criar nova senha',
      valid: 'Validade', uses: 'Uso', once: '1 vez', after: 'Se não foi você, ignore este e-mail: sua senha continua a mesma.' },
    en: { subject: 'Reset your ucast.me password', tag: 'Password', heading: 'Reset your password', intro: 'We received a request to set a new password for your account.', label: 'Choose a new password',
      valid: 'Valid for', uses: 'Uses', once: '1×', after: 'If this was not you, ignore this e-mail: your password stays the same.' },
    fr: { subject: 'Réinitialiser votre mot de passe ucast.me', tag: 'Mot de passe', heading: 'Réinitialiser votre mot de passe', intro: 'Nous avons reçu une demande de nouveau mot de passe pour votre compte.', label: 'Choisir un nouveau mot de passe',
      valid: 'Validité', uses: 'Usage', once: '1 fois', after: 'Si ce n’était pas vous, ignorez cet e-mail : votre mot de passe reste le même.' },
  }[lang];
  return render(lang, t.subject, { tag: t.tag, heading: t.heading, intro: [t.intro], button: { label: t.label, href: link }, readout: [[t.valid, `${minutes} MIN`], [t.uses, t.once]], after: [t.after] });
}

export function passwordChanged(lang: PageLang, forgotLink: string): Mail {
  const t = {
    pt: { subject: 'Sua senha do ucast.me foi alterada', tag: 'Segurança', heading: 'Sua senha foi alterada', intro: ['A senha da sua conta acabou de ser trocada e todas as sessões abertas foram encerradas.'], sessions: 'Sessões abertas', after: 'Se foi você, não precisa fazer nada. Se não foi, crie uma senha nova agora:', label: 'Redefinir a senha' },
    en: { subject: 'Your ucast.me password was changed', tag: 'Security', heading: 'Your password was changed', intro: ['Your account password was just changed and every open session was signed out.'], sessions: 'Open sessions', after: 'If this was you, there is nothing to do. If not, set a new password now:', label: 'Reset the password' },
    fr: { subject: 'Votre mot de passe ucast.me a été modifié', tag: 'Sécurité', heading: 'Votre mot de passe a été modifié', intro: ['Le mot de passe de votre compte vient d’être changé et toutes les sessions ouvertes ont été fermées.'], sessions: 'Sessions ouvertes', after: 'Si c’était vous, il n’y a rien à faire. Sinon, choisissez un nouveau mot de passe maintenant :', label: 'Réinitialiser le mot de passe' },
  }[lang];
  return render(lang, t.subject, { tag: t.tag, heading: t.heading, intro: [...t.intro, t.after], button: { label: t.label, href: forgotLink }, readout: [[t.sessions, '0']] });
}

export function signupAttempt(lang: PageLang, loginLink: string, forgotLink: string): Mail {
  const t = {
    pt: { subject: 'Tentativa de criar conta no ucast.me', tag: 'Segurança', heading: 'Alguém tentou criar uma conta com este e-mail', intro: 'Este e-mail já tem uma conta no ucast.me, então nada foi criado.', label: 'Entrar na conta', after: `Esqueceu a senha? Recupere em ${forgotLink}. Se não foi você, ignore este e-mail.` },
    en: { subject: 'Sign-up attempt on ucast.me', tag: 'Security', heading: 'Someone tried to sign up with this e-mail', intro: 'This e-mail already has a ucast.me account, so nothing was created.', label: 'Sign in', after: `Forgot your password? Reset it at ${forgotLink}. If this was not you, ignore this e-mail.` },
    fr: { subject: 'Tentative d’inscription sur ucast.me', tag: 'Sécurité', heading: 'Quelqu’un a essayé de créer un compte avec cet e-mail', intro: 'Cet e-mail a déjà un compte ucast.me, rien n’a donc été créé.', label: 'Se connecter', after: `Mot de passe oublié ? Réinitialisez-le sur ${forgotLink}. Si ce n’était pas vous, ignorez cet e-mail.` },
  }[lang];
  return render(lang, t.subject, { tag: t.tag, heading: t.heading, intro: [t.intro], button: { label: t.label, href: loginLink }, after: [t.after] });
}

export function accountDeleted(lang: PageLang): Mail {
  const t = {
    pt: { subject: 'Sua conta no ucast.me foi excluída', tag: 'Conta', heading: 'Sua conta foi excluída', intro: ['A conta, as chaves de ativação e o histórico de uso foram apagados. Uma assinatura ativa foi cancelada.', 'Se não foi você, fale com a gente pelo site ucast.me.'] },
    en: { subject: 'Your ucast.me account was deleted', tag: 'Account', heading: 'Your account was deleted', intro: ['The account, its activation keys and usage history were erased. Any active subscription was cancelled.', 'If this was not you, reach us through ucast.me.'] },
    fr: { subject: 'Votre compte ucast.me a été supprimé', tag: 'Compte', heading: 'Votre compte a été supprimé', intro: ['Le compte, ses clés d’activation et l’historique d’utilisation ont été effacés. Tout abonnement actif a été résilié.', 'Si ce n’était pas vous, contactez-nous via ucast.me.'] },
  }[lang];
  return render(lang, t.subject, { tag: t.tag, heading: t.heading, intro: t.intro });
}

export function accessKey(lang: PageLang, key: string): Mail {
  const t = {
    pt: { subject: 'Sua chave de acesso ao ucast.me', tag: 'Ativação', heading: 'Sua chave de ativação', intro: 'Cole esta chave no app, em “Ativar o ucast.me”.', label: 'Chave', after: 'Ela só foi enviada por este e-mail — guarde-a bem. Se você não esperava esta chave, ignore este e-mail.' },
    en: { subject: 'Your ucast.me access key', tag: 'Activation', heading: 'Your activation key', intro: 'Paste this key into the app, under “Activate ucast.me”.', label: 'Key', after: 'It was sent only in this e-mail — keep it safe. If you did not expect this key, ignore this e-mail.' },
    fr: { subject: 'Votre clé d’accès ucast.me', tag: 'Activation', heading: 'Votre clé d’activation', intro: 'Collez cette clé dans l’app, dans « Activer ucast.me ».', label: 'Clé', after: 'Elle n’a été envoyée que dans cet e-mail — conservez-la bien. Si vous n’attendiez pas cette clé, ignorez cet e-mail.' },
  }[lang];
  return render(lang, t.subject, { tag: t.tag, heading: t.heading, intro: [t.intro], code: { label: t.label, value: key }, after: [t.after] });
}
