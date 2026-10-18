import { createServer } from 'http';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createRooms } from '../src/rooms';

const PORT = Number(process.env.ROOM_DEMO_PORT ?? 4610);
const DIR = join(homedir(), '.ai-gateway', 'room-page-demo');
const EVERY_MS = 5_000;

const TALK: Array<{ fr: string; en: string; de: string; es: string; pt: string }> = [
  { fr: 'Bonjour à tous et merci d’être venus aussi nombreux ce matin.', en: 'Good morning everyone, and thank you for coming in such numbers this morning.', de: 'Guten Morgen zusammen, und danke, dass Sie heute Morgen so zahlreich gekommen sind.', es: 'Buenos días a todos y gracias por venir tantos esta mañana.', pt: 'Bom dia a todos e obrigado por virem em tão grande número esta manhã.' },
  { fr: 'Aujourd’hui, nous allons parler de ce que l’intelligence artificielle change vraiment en classe.', en: 'Today we are going to talk about what artificial intelligence really changes in the classroom.', de: 'Heute sprechen wir darüber, was künstliche Intelligenz im Unterricht wirklich verändert.', es: 'Hoy vamos a hablar de lo que la inteligencia artificial cambia de verdad en el aula.', pt: 'Hoje vamos falar do que a inteligência artificial realmente muda na sala de aula.' },
  { fr: 'Commençons par un chiffre : deux élèves sur trois l’utilisent déjà pour leurs devoirs.', en: 'Let’s start with a number: two students out of three already use it for their homework.', de: 'Beginnen wir mit einer Zahl: Zwei von drei Schülern nutzen sie bereits für ihre Hausaufgaben.', es: 'Empecemos con una cifra: dos de cada tres alumnos ya la usan para sus deberes.', pt: 'Comecemos com um número: dois em cada três alunos já a usam para os trabalhos de casa.' },
  { fr: 'La question n’est donc plus de savoir si on l’autorise, mais comment on l’enseigne.', en: 'So the question is no longer whether we allow it, but how we teach it.', de: 'Die Frage ist also nicht mehr, ob wir sie erlauben, sondern wie wir sie unterrichten.', es: 'La pregunta ya no es si la permitimos, sino cómo la enseñamos.', pt: 'A questão já não é se a permitimos, mas como a ensinamos.' },
  { fr: 'Dans notre lycée, nous avons testé trois approches pendant un semestre complet.', en: 'In our high school, we tested three approaches over a full semester.', de: 'An unserem Gymnasium haben wir drei Ansätze ein ganzes Semester lang getestet.', es: 'En nuestro instituto probamos tres enfoques durante un semestre completo.', pt: 'Na nossa escola secundária, testámos três abordagens durante um semestre inteiro.' },
  { fr: 'La première : interdire complètement. Résultat, les élèves l’utilisaient en cachette.', en: 'The first: ban it completely. Result: the students used it in secret.', de: 'Erstens: ein komplettes Verbot. Ergebnis: Die Schüler nutzten sie heimlich.', es: 'La primera: prohibirla del todo. Resultado: los alumnos la usaban a escondidas.', pt: 'A primeira: proibir completamente. Resultado: os alunos usavam-na às escondidas.' },
  { fr: 'La deuxième : la laisser libre. Les copies se ressemblaient toutes un peu trop.', en: 'The second: leave it open. The essays all looked a little too alike.', de: 'Zweitens: sie freigeben. Die Aufsätze ähnelten sich alle ein bisschen zu sehr.', es: 'La segunda: dejarla libre. Los trabajos se parecían todos un poco demasiado.', pt: 'A segunda: deixá-la livre. Os trabalhos ficaram todos um pouco parecidos demais.' },
  { fr: 'La troisième, celle qui a marché : l’utiliser ensemble, en classe, à voix haute.', en: 'The third, the one that worked: using it together, in class, out loud.', de: 'Drittens, und das hat funktioniert: sie gemeinsam im Unterricht nutzen, laut und offen.', es: 'La tercera, la que funcionó: usarla juntos, en clase, en voz alta.', pt: 'A terceira, a que funcionou: usá-la juntos, na aula, em voz alta.' },
  { fr: 'Quand une réponse est fausse, toute la classe cherche pourquoi. C’est là qu’ils apprennent.', en: 'When an answer is wrong, the whole class looks for why. That is where they learn.', de: 'Wenn eine Antwort falsch ist, sucht die ganze Klasse nach dem Grund. Genau da lernen sie.', es: 'Cuando una respuesta es falsa, toda la clase busca por qué. Ahí es donde aprenden.', pt: 'Quando uma resposta está errada, a turma toda procura porquê. É aí que aprendem.' },
  { fr: 'Je vous propose maintenant de regarder trois exemples concrets, tirés de vraies copies.', en: 'I now suggest we look at three concrete examples, taken from real essays.', de: 'Ich schlage vor, dass wir uns jetzt drei konkrete Beispiele aus echten Arbeiten ansehen.', es: 'Les propongo ahora ver tres ejemplos concretos, sacados de trabajos reales.', pt: 'Proponho agora vermos três exemplos concretos, tirados de trabalhos reais.' },
];

const silentWav = (): Buffer => {
  const rate = 16_000, samples = rate;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(samples * 2, 40);
  return b;
};

mkdirSync(DIR, { recursive: true });
const rooms = createRooms({
  env: {},
  config: { dir: DIR, publicHost: '', publicBaseUrl: `http://localhost:${PORT}/live` },
  keyUser: () => ({ userId: 'demo', admin: true }),
  userOf: () => 'demo',
  sweepIntervalMs: 0,
  synthesize: async () => ({ audio: silentWav(), format: 'wav' }),
  synthesizeAvailable: () => true,
});
const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
rooms.mount(server);
server.listen(PORT);

const savedPath = join(DIR, 'room.json');
const savedCode = ((): string | null => { try { return JSON.parse(readFileSync(savedPath, 'utf8')).code; } catch { return null; } })();
const existing = savedCode ? await rooms.service.get(savedCode) : null;
const code = existing?.meta.code ?? (await rooms.service.create({
  title: 'L’IA en classe : ce qui change pour les élèves', originalLang: 'fr', languages: ['en', 'de', 'es', 'pt'],
  serverDub: true, youtubeUrl: 'https://www.youtube.com/channel/UCdemo/live',
}, 'demo')).code;
writeFileSync(savedPath, JSON.stringify({ code }));
console.log(`room page: http://localhost:${PORT}/live/${code}`);

const room = (await rooms.service.get(code))!;
let next = (room.lines.at(-1)?.id ?? 0) + 1;
const publish = async (id: number, s: (typeof TALK)[number], cut: number | null) => {
  const part = (t: string) => (cut === null ? t : t.split(' ').slice(0, cut).join(' '));
  await rooms.service.publishLine(room, {
    id, original: part(s.fr), originalLang: 'fr', ts: Date.now(), delayMs: 900 + Math.round(Math.random() * 900),
    translations: { en: part(s.en), de: part(s.de), es: part(s.es), pt: part(s.pt) }, ...(cut === null ? {} : { draft: true }),
  });
};
setInterval(() => {
  const id = next++;
  const s = TALK[id % TALK.length]!;
  void publish(id, s, Math.ceil(s.fr.split(' ').length / 2));
  setTimeout(() => void publish(id, s, null), 1_600);
}, EVERY_MS);
