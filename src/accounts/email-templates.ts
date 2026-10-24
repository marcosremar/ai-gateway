import type { EmailMessage } from './email';
import type { PageLang } from './page-strings';

type Mail = Omit<EmailMessage, 'to'>;

const INK = '#0b1416';
const INK_2 = '#4a5f63';
const PHOS = '#4cc3cb';
const GROUND = '#0a1012';
const FONT = "Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace";

const escape = (s: string): string => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

interface Block { heading: string; intro: string[]; button?: { label: string; href: string }; code?: string; after?: string[]; steps?: string[] }

interface Footer { why: string; fallback: string; site: string }

const FOOTER: Record<PageLang, Footer> = {
  pt: { why: 'Você recebeu este e-mail porque há uma conta ucast.me com este endereço.', fallback: 'Se o botão não abrir, copie este link no navegador:', site: 'Legendas e dublagem ao vivo' },
  en: { why: 'You are receiving this because there is a ucast.me account with this address.', fallback: 'If the button does not open, paste this link into your browser:', site: 'Live subtitles and dubbing' },
  fr: { why: 'Vous recevez cet e-mail car un compte ucast.me existe avec cette adresse.', fallback: 'Si le bouton ne s’ouvre pas, copiez ce lien dans votre navigateur :', site: 'Sous-titres et doublage en direct' },
};

const paragraph = (s: string): string => `<p style="margin:0 0 16px;font:400 16px/1.55 ${FONT};color:${INK_2}">${escape(s)}</p>`;

function render(lang: PageLang, subject: string, b: Block): Mail {
  const f = FOOTER[lang];
  const button = b.button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="background:${PHOS};border-radius:4px"><a href="${escape(b.button.href)}" style="display:inline-block;padding:14px 26px;font:700 16px/1 ${FONT};color:#04161a;text-decoration:none">${escape(b.button.label)}</a></td></tr></table>` : '';
  const code = b.code ? `<div style="margin:8px 0 24px;padding:16px;background:#eef4f5;border:1px solid #d5e2e4;border-radius:4px;font:500 15px/1.5 ${MONO};color:${INK};word-break:break-all">${escape(b.code)}</div>` : '';
  const steps = b.steps ? `<ol style="margin:0 0 20px;padding-left:22px;font:400 15px/1.6 ${FONT};color:${INK_2}">${b.steps.map(s => `<li style="margin:0 0 6px">${escape(s)}</li>`).join('')}</ol>` : '';
  const fallback = b.button ? `<p style="margin:24px 0 0;font:400 13px/1.5 ${FONT};color:${INK_2}">${escape(f.fallback)}<br><a href="${escape(b.button.href)}" style="color:#1f7f87;word-break:break-all">${escape(b.button.href)}</a></p>` : '';
  const preheader = b.intro[0] ?? '';
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#e8eff0">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e8eff0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="background:${GROUND};border-radius:8px 8px 0 0;padding:22px 32px"><a href="https://ucast.me" style="text-decoration:none;font:700 20px/1 ${FONT};color:#e9f2f3;letter-spacing:-0.02em"><span style="color:${PHOS}">●</span>&nbsp;ucast.me</a></td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 8px 8px;padding:36px 32px 32px">
<h1 style="margin:0 0 16px;font:700 24px/1.25 ${FONT};color:${INK};letter-spacing:-0.02em">${escape(b.heading)}</h1>
${b.intro.map(paragraph).join('')}${button}${code}${steps}${(b.after ?? []).map(paragraph).join('')}${fallback}
</td></tr>
<tr><td style="padding:20px 32px;font:400 12px/1.5 ${FONT};color:#6b8085">${escape(f.why)}<br><a href="https://ucast.me" style="color:#6b8085">ucast.me</a> · ${escape(f.site)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [b.heading, '', ...b.intro, ...(b.button ? ['', `${b.button.label}: ${b.button.href}`] : []), ...(b.code ? ['', b.code] : []),
    ...(b.steps ? ['', ...b.steps.map((s, i) => `${i + 1}. ${s}`)] : []), ...(b.after?.length ? ['', ...b.after] : []), '', '—', f.why, 'https://ucast.me'].join('\n');
  return { subject, html, text };
}

export function verifyEmail(lang: PageLang, link: string, welcome: boolean, downloadUrl: string): Mail {
  const t = {
    pt: { subject: welcome ? 'Bem-vindo ao ucast.me — confirme seu e-mail' : 'Confirme seu e-mail no ucast.me', heading: welcome ? 'Bem-vindo ao ucast.me' : 'Confirme seu e-mail',
      intro: welcome ? ['Sua conta foi criada. Falta só confirmar que este e-mail é seu.'] : ['Confirme que este e-mail é seu para manter a conta segura.'],
      label: 'Confirmar e-mail', steps: [`Baixe o app: ${downloadUrl}`, 'Na sua conta, crie uma chave de ativação e cole no app.', 'Escolha os idiomas e toque em Iniciar.'], after: 'O link vale por 48 horas. Se você não criou esta conta, ignore este e-mail.' },
    en: { subject: welcome ? 'Welcome to ucast.me — confirm your e-mail' : 'Confirm your e-mail on ucast.me', heading: welcome ? 'Welcome to ucast.me' : 'Confirm your e-mail',
      intro: welcome ? ['Your account is ready. Just confirm this e-mail is yours.'] : ['Confirm this e-mail is yours to keep your account secure.'],
      label: 'Confirm e-mail', steps: [`Download the app: ${downloadUrl}`, 'In your account, create an activation key and paste it into the app.', 'Pick your languages and press Start.'], after: 'The link is valid for 48 hours. If you did not create this account, ignore this e-mail.' },
    fr: { subject: welcome ? 'Bienvenue sur ucast.me — confirmez votre e-mail' : 'Confirmez votre e-mail sur ucast.me', heading: welcome ? 'Bienvenue sur ucast.me' : 'Confirmez votre e-mail',
      intro: welcome ? ['Votre compte est créé. Il reste à confirmer que cet e-mail est bien le vôtre.'] : ['Confirmez que cet e-mail est le vôtre pour sécuriser votre compte.'],
      label: 'Confirmer l’e-mail', steps: [`Téléchargez l’app : ${downloadUrl}`, 'Dans votre compte, créez une clé d’activation et collez-la dans l’app.', 'Choisissez les langues et appuyez sur Démarrer.'], after: 'Le lien est valable 48 heures. Si vous n’avez pas créé ce compte, ignorez cet e-mail.' },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: t.intro, button: { label: t.label, href: link }, steps: welcome ? t.steps : undefined, after: [t.after] });
}

export function resetPassword(lang: PageLang, link: string, minutes: number): Mail {
  const t = {
    pt: { subject: 'Redefinir sua senha do ucast.me', heading: 'Redefinir sua senha', intro: 'Recebemos um pedido para criar uma nova senha para a sua conta.', label: 'Criar nova senha',
      after: [`O link vale por ${minutes} minutos e só pode ser usado uma vez.`, 'Se não foi você, ignore este e-mail: sua senha continua a mesma.'] },
    en: { subject: 'Reset your ucast.me password', heading: 'Reset your password', intro: 'We received a request to set a new password for your account.', label: 'Choose a new password',
      after: [`The link is valid for ${minutes} minutes and works once.`, 'If this was not you, ignore this e-mail: your password stays the same.'] },
    fr: { subject: 'Réinitialiser votre mot de passe ucast.me', heading: 'Réinitialiser votre mot de passe', intro: 'Nous avons reçu une demande de nouveau mot de passe pour votre compte.', label: 'Choisir un nouveau mot de passe',
      after: [`Le lien est valable ${minutes} minutes et ne sert qu’une fois.`, 'Si ce n’était pas vous, ignorez cet e-mail : votre mot de passe reste le même.'] },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: [t.intro], button: { label: t.label, href: link }, after: t.after });
}

export function passwordChanged(lang: PageLang, forgotLink: string): Mail {
  const t = {
    pt: { subject: 'Sua senha do ucast.me foi alterada', heading: 'Sua senha foi alterada', intro: ['A senha da sua conta acabou de ser trocada e todas as sessões abertas foram encerradas.', 'Se foi você, não precisa fazer nada.'], label: 'Não fui eu — redefinir a senha' },
    en: { subject: 'Your ucast.me password was changed', heading: 'Your password was changed', intro: ['Your account password was just changed and every open session was signed out.', 'If this was you, there is nothing to do.'], label: 'Not me — reset the password' },
    fr: { subject: 'Votre mot de passe ucast.me a été modifié', heading: 'Votre mot de passe a été modifié', intro: ['Le mot de passe de votre compte vient d’être changé et toutes les sessions ouvertes ont été fermées.', 'Si c’était vous, il n’y a rien à faire.'], label: 'Ce n’était pas moi — réinitialiser' },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: t.intro, button: { label: t.label, href: forgotLink } });
}

export function signupAttempt(lang: PageLang, loginLink: string, forgotLink: string): Mail {
  const t = {
    pt: { subject: 'Tentativa de criar conta no ucast.me', heading: 'Alguém tentou criar uma conta com este e-mail', intro: 'Este e-mail já tem uma conta no ucast.me, então nada foi criado.', label: 'Entrar na conta', after: `Esqueceu a senha? Recupere em ${forgotLink}. Se não foi você, ignore este e-mail.` },
    en: { subject: 'Sign-up attempt on ucast.me', heading: 'Someone tried to sign up with this e-mail', intro: 'This e-mail already has a ucast.me account, so nothing was created.', label: 'Sign in', after: `Forgot your password? Reset it at ${forgotLink}. If this was not you, ignore this e-mail.` },
    fr: { subject: 'Tentative d’inscription sur ucast.me', heading: 'Quelqu’un a essayé de créer un compte avec cet e-mail', intro: 'Cet e-mail a déjà un compte ucast.me, rien n’a donc été créé.', label: 'Se connecter', after: `Mot de passe oublié ? Réinitialisez-le sur ${forgotLink}. Si ce n’était pas vous, ignorez cet e-mail.` },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: [t.intro], button: { label: t.label, href: loginLink }, after: [t.after] });
}

export function accountDeleted(lang: PageLang): Mail {
  const t = {
    pt: { subject: 'Sua conta no ucast.me foi excluída', heading: 'Sua conta foi excluída', intro: ['A conta, as chaves de ativação e o histórico de uso foram apagados. Uma assinatura ativa foi cancelada.', 'Se não foi você, responda pelo site ucast.me.'] },
    en: { subject: 'Your ucast.me account was deleted', heading: 'Your account was deleted', intro: ['The account, its activation keys and usage history were erased. Any active subscription was cancelled.', 'If this was not you, reach us through ucast.me.'] },
    fr: { subject: 'Votre compte ucast.me a été supprimé', heading: 'Votre compte a été supprimé', intro: ['Le compte, ses clés d’activation et l’historique d’utilisation ont été effacés. Tout abonnement actif a été résilié.', 'Si ce n’était pas vous, contactez-nous via ucast.me.'] },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: t.intro });
}

export function accessKey(lang: PageLang, key: string): Mail {
  const t = {
    pt: { subject: 'Sua chave de acesso ao ucast.me', heading: 'Sua chave de ativação', intro: 'Cole esta chave no app, em “Ativar o ucast.me”:', after: ['Ela só foi enviada por este e-mail — guarde-a bem. Se você não esperava esta chave, ignore este e-mail.'] },
    en: { subject: 'Your ucast.me access key', heading: 'Your activation key', intro: 'Paste this key into the app, under “Activate ucast.me”:', after: ['It was sent only in this e-mail — keep it safe. If you did not expect this key, ignore this e-mail.'] },
    fr: { subject: 'Votre clé d’accès ucast.me', heading: 'Votre clé d’activation', intro: 'Collez cette clé dans l’app, dans « Activer ucast.me » :', after: ['Elle n’a été envoyée que dans cet e-mail — conservez-la bien. Si vous n’attendiez pas cette clé, ignorez cet e-mail.'] },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: [t.intro], code: key, after: t.after });
}
