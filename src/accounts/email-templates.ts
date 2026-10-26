import type { EmailMessage } from './email';
import type { PageLang } from './page-strings';

type Mail = Omit<EmailMessage, 'to'>;

const INK = '#0b1416';
const INK_2 = '#3d5357';
const MUTED = '#6b8085';
const ACCENT = '#1f7f87';
const BUTTON = '#4cc3cb';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const SITE = 'https://ucast.me';

const escape = (s: string): string => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

interface Block {
  heading: string;
  intro: string[];
  button?: { label: string; href: string };
  steps?: string[];
  code?: string;
  after?: string[];
}

interface Chrome { help: string; why: string; fallback: string }

const CHROME: Record<PageLang, Chrome> = {
  pt: { help: 'Dúvidas? Responda a este e-mail.', why: 'Você recebeu este e-mail porque há uma conta ucast.me com este endereço.', fallback: 'Se o botão não funcionar, copie este link no navegador:' },
  en: { help: 'Questions? Just reply to this e-mail.', why: 'You are receiving this because there is a ucast.me account with this address.', fallback: 'If the button does not work, paste this link into your browser:' },
  fr: { help: 'Une question ? Répondez simplement à cet e-mail.', why: 'Vous recevez cet e-mail car un compte ucast.me existe avec cette adresse.', fallback: 'Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :' },
};

const paragraph = (s: string): string => `<p style="margin:0 0 16px;font:400 16px/1.6 ${FONT};color:${INK_2}">${escape(s)}</p>`;

function button(b: NonNullable<Block['button']>): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td bgcolor="${BUTTON}" style="background:${BUTTON};border-radius:4px">`
    + `<a href="${escape(b.href)}" style="display:inline-block;padding:13px 24px;font:600 16px/1 ${FONT};color:#04161a;text-decoration:none">${escape(b.label)}</a></td></tr></table>`;
}

function render(lang: PageLang, subject: string, b: Block): Mail {
  const c = CHROME[lang];
  const steps = b.steps ? `<ol style="margin:0 0 16px;padding-left:20px;font:400 16px/1.6 ${FONT};color:${INK_2}">${b.steps.map(s => `<li style="margin:0 0 4px">${escape(s)}</li>`).join('')}</ol>` : '';
  const code = b.code ? `<p style="margin:0 0 20px;padding:14px 16px;background:#f2f6f7;border:1px solid #dfe8ea;border-radius:4px;font:500 15px/1.5 ${MONO};color:${INK};word-break:break-all">${escape(b.code)}</p>` : '';
  const fallback = b.button ? `<p style="margin:24px 0 0;font:400 13px/1.5 ${FONT};color:${MUTED}">${escape(c.fallback)}<br><a href="${escape(b.button.href)}" style="color:${ACCENT};word-break:break-all">${escape(b.button.href)}</a></p>` : '';
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:32px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
<tr><td style="padding:0 0 28px;font:700 20px/1 ${FONT};color:${INK}">ucast<span style="color:${ACCENT}">.me</span></td></tr>
<tr><td>
<h1 style="margin:0 0 16px;font:700 22px/1.3 ${FONT};color:${INK}">${escape(b.heading)}</h1>
${b.intro.map(paragraph).join('')}${b.button ? button(b.button) : ''}${steps}${code}${(b.after ?? []).map(paragraph).join('')}${fallback}
</td></tr>
<tr><td style="padding:28px 0 0;border-bottom:1px solid #e6eced"></td></tr>
<tr><td style="padding:16px 0 0;font:400 12px/1.5 ${FONT};color:${MUTED}">${escape(c.help)}<br>${escape(c.why)}<br><a href="${SITE}" style="color:${MUTED}">ucast.me</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [b.heading, '', ...b.intro, ...(b.button ? ['', `${b.button.label}: ${b.button.href}`] : []),
    ...(b.steps ? ['', ...b.steps.map((s, i) => `${i + 1}. ${s}`)] : []), ...(b.code ? ['', b.code] : []), ...(b.after?.length ? ['', ...b.after] : []), '', '—', c.help, c.why, SITE].join('\n');
  return { subject, html, text };
}

export function verifyEmail(lang: PageLang, link: string, welcome: boolean, downloadUrl: string): Mail {
  const t = {
    pt: { subject: welcome ? 'Bem-vindo ao ucast.me — confirme seu e-mail' : 'Confirme seu e-mail no ucast.me', heading: welcome ? 'Bem-vindo ao ucast.me' : 'Confirme seu e-mail',
      intro: welcome ? ['Sua conta foi criada. Falta só confirmar que este e-mail é seu.'] : ['Confirme que este e-mail é seu para manter a conta segura.'],
      label: 'Confirmar e-mail', valid: 'O link vale por 48 horas.', steps: [`Baixe o app em ${downloadUrl}`, 'Na sua conta, crie uma chave de ativação e cole no app.', 'Escolha os idiomas e toque em Iniciar.'], after: 'Se você não criou esta conta, ignore este e-mail.' },
    en: { subject: welcome ? 'Welcome to ucast.me — confirm your e-mail' : 'Confirm your e-mail on ucast.me', heading: welcome ? 'Welcome to ucast.me' : 'Confirm your e-mail',
      intro: welcome ? ['Your account is ready. Just confirm this e-mail is yours.'] : ['Confirm this e-mail is yours to keep your account secure.'],
      label: 'Confirm e-mail', valid: 'The link is valid for 48 hours.', steps: [`Download the app at ${downloadUrl}`, 'In your account, create an activation key and paste it into the app.', 'Pick your languages and press Start.'], after: 'If you did not create this account, ignore this e-mail.' },
    fr: { subject: welcome ? 'Bienvenue sur ucast.me — confirmez votre e-mail' : 'Confirmez votre e-mail sur ucast.me', heading: welcome ? 'Bienvenue sur ucast.me' : 'Confirmez votre e-mail',
      intro: welcome ? ['Votre compte est créé. Il reste à confirmer que cet e-mail est bien le vôtre.'] : ['Confirmez que cet e-mail est le vôtre pour sécuriser votre compte.'],
      label: 'Confirmer l’e-mail', valid: 'Le lien est valable 48 heures.', steps: [`Téléchargez l’app sur ${downloadUrl}`, 'Dans votre compte, créez une clé d’activation et collez-la dans l’app.', 'Choisissez les langues et appuyez sur Démarrer.'], after: 'Si vous n’avez pas créé ce compte, ignorez cet e-mail.' },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: t.intro, button: { label: t.label, href: link }, steps: welcome ? t.steps : undefined, after: [`${t.valid} ${t.after}`] });
}

export function resetPassword(lang: PageLang, link: string, minutes: number): Mail {
  const t = {
    pt: { subject: 'Redefinir sua senha do ucast.me', heading: 'Redefinir sua senha', intro: 'Recebemos um pedido para criar uma nova senha para a sua conta.', label: 'Criar nova senha',
      valid: `O link vale por ${minutes} minutos e só pode ser usado uma vez.`, after: 'Se não foi você, ignore este e-mail: sua senha continua a mesma.' },
    en: { subject: 'Reset your ucast.me password', heading: 'Reset your password', intro: 'We received a request to set a new password for your account.', label: 'Choose a new password',
      valid: `The link is valid for ${minutes} minutes and works once.`, after: 'If this was not you, ignore this e-mail: your password stays the same.' },
    fr: { subject: 'Réinitialiser votre mot de passe ucast.me', heading: 'Réinitialiser votre mot de passe', intro: 'Nous avons reçu une demande de nouveau mot de passe pour votre compte.', label: 'Choisir un nouveau mot de passe',
      valid: `Le lien est valable ${minutes} minutes et ne sert qu’une fois.`, after: 'Si ce n’était pas vous, ignorez cet e-mail : votre mot de passe reste le même.' },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: [t.intro], button: { label: t.label, href: link }, after: [t.valid, t.after] });
}

export function passwordChanged(lang: PageLang, forgotLink: string): Mail {
  const t = {
    pt: { subject: 'Sua senha do ucast.me foi alterada', heading: 'Sua senha foi alterada', intro: ['A senha da sua conta acabou de ser trocada e todas as sessões abertas foram encerradas.'], after: 'Se foi você, não precisa fazer nada. Se não foi, crie uma senha nova agora:', label: 'Redefinir a senha' },
    en: { subject: 'Your ucast.me password was changed', heading: 'Your password was changed', intro: ['Your account password was just changed and every open session was signed out.'], after: 'If this was you, there is nothing to do. If not, set a new password now:', label: 'Reset the password' },
    fr: { subject: 'Votre mot de passe ucast.me a été modifié', heading: 'Votre mot de passe a été modifié', intro: ['Le mot de passe de votre compte vient d’être changé et toutes les sessions ouvertes ont été fermées.'], after: 'Si c’était vous, il n’y a rien à faire. Sinon, choisissez un nouveau mot de passe maintenant :', label: 'Réinitialiser le mot de passe' },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: [...t.intro, t.after], button: { label: t.label, href: forgotLink } });
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
    pt: { subject: 'Sua conta no ucast.me foi excluída', heading: 'Sua conta foi excluída', intro: ['A conta, as chaves de ativação e o histórico de uso foram apagados. Uma assinatura ativa foi cancelada.', 'Se não foi você, responda a este e-mail.'] },
    en: { subject: 'Your ucast.me account was deleted', heading: 'Your account was deleted', intro: ['The account, its activation keys and usage history were erased. Any active subscription was cancelled.', 'If this was not you, reply to this e-mail.'] },
    fr: { subject: 'Votre compte ucast.me a été supprimé', heading: 'Votre compte a été supprimé', intro: ['Le compte, ses clés d’activation et l’historique d’utilisation ont été effacés. Tout abonnement actif a été résilié.', 'Si ce n’était pas vous, répondez à cet e-mail.'] },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: t.intro });
}

export function coupon(lang: PageLang, code: string, months: number): Mail {
  const t = {
    pt: { subject: 'Seu código do ucast.me', heading: 'Seu código promocional', intro: `Este código libera ${months} ${months === 1 ? 'mês' : 'meses'} de uso do plano Pro, sem cartão.`, button: 'Criar a conta grátis', after: 'Depois de criar a conta, abra “Código promocional” na página da conta e digite o código.' },
    en: { subject: 'Your ucast.me code', heading: 'Your promo code', intro: `This code unlocks ${months} ${months === 1 ? 'month' : 'months'} of the Pro plan, no card needed.`, button: 'Create your free account', after: 'After creating the account, open “Promo code” on the account page and enter the code.' },
    fr: { subject: 'Votre code ucast.me', heading: 'Votre code promo', intro: `Ce code débloque ${months} mois d’utilisation du forfait Pro, sans carte.`, button: 'Créer votre compte gratuit', after: 'Après avoir créé le compte, ouvrez « Code promo » sur la page du compte et saisissez le code.' },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: [t.intro], code, button: { label: t.button, href: `${SITE}/signup` }, after: [t.after] });
}

export function accessKey(lang: PageLang, key: string): Mail {
  const t = {
    pt: { subject: 'Sua chave de acesso ao ucast.me', heading: 'Sua chave de ativação', intro: 'Cole esta chave no app, em “Ativar o ucast.me”.', after: 'Ela só foi enviada por este e-mail — guarde-a bem. Se você não esperava esta chave, ignore este e-mail.' },
    en: { subject: 'Your ucast.me access key', heading: 'Your activation key', intro: 'Paste this key into the app, under “Activate ucast.me”.', after: 'It was sent only in this e-mail — keep it safe. If you did not expect this key, ignore this e-mail.' },
    fr: { subject: 'Votre clé d’accès ucast.me', heading: 'Votre clé d’activation', intro: 'Collez cette clé dans l’app, dans « Activer ucast.me ».', after: 'Elle n’a été envoyée que dans cet e-mail — conservez-la bien. Si vous n’attendiez pas cette clé, ignorez cet e-mail.' },
  }[lang];
  return render(lang, t.subject, { heading: t.heading, intro: [t.intro], code: key, after: [t.after] });
}
