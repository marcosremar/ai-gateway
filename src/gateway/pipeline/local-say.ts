// ── BabelCast Gateway — Local TTS fallback (macOS `say`) ─────────────────────
// Último recurso de TTS quando nenhuma nuvem/GPU/local Kokoro está disponível.
// Usa o `say` do macOS (sempre presente) e converte para WAV com `afconvert`.
// Qualidade inferior à nuvem, mas garante que a dublagem nunca falha por
// falta de provider — mesma filosofia do whisper local no STT.

import { createLogger } from '../../logger';

const log = createLogger('tts-local-say');

export interface LocalSayResult {
  audio: Buffer;
  contentType: string;
}

/** Mapeia um nome de voz do app para uma voz do macOS, quando possível. */
function mapVoice(speaker: string): string | null {
  const s = speaker.trim();
  if (!s) return null;
  return s;
}

/**
 * Sintetiza com `say` (macOS) → AIFF → `afconvert` → WAV PCM 16-bit.
 * Retorna null se o `say`/`afconvert` não existirem ou falharem.
 */
export async function localSay(
  input: string,
  speaker: string,
  language: string,
): Promise<LocalSayResult | null> {
  const text = input.trim();
  if (!text) return null;

  // Só macOS tem `say`; em Linux/Windows este fallback não existe.
  if (process.platform !== 'darwin') return null;

  const tmp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const aiff = `/tmp/bc-say-${tmp}.aiff`;
  const wav = `/tmp/bc-say-${tmp}.wav`;
  const voice = mapVoice(speaker);

  try {
    const args: string[] = [];
    if (voice) args.push('-v', voice);
    args.push('-o', aiff, text);
    const sayRes = await Bun.spawn(['say', ...args], { stdout: 'ignore', stderr: 'pipe' });
    const sayExit = await sayRes.exited;
    if (sayExit !== 0) {
      log.warn(`say failed (exit ${sayExit}) for voice=${voice || '(default)'} — retrying sem voz`);
      // Voz inexistente: tenta com a voz padrão do sistema.
      const retry = await Bun.spawn(['say', '-o', aiff, text], {
        stdout: 'ignore', stderr: 'pipe',
      });
      if ((await retry.exited) !== 0) return null;
    }

    const conv = await Bun.spawn(
      ['afconvert', '-f', 'WAVE', '-d', 'LEI16@44100', '-c', '2', aiff, wav],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    if ((await conv.exited) !== 0) return null;

    const audio = Bun.file(wav);
    if (!(await audio.exists())) return null;
    const buf = Buffer.from(await audio.arrayBuffer());
    if (buf.length < 44) return null; // header WAV mínimo
    log.log(`local-say: ${buf.length}B wav (voice=${voice || 'default'})`);
    return { audio: buf, contentType: 'audio/wav' };
  } catch (e) {
    log.warn(`local-say error: ${e instanceof Error ? e.message : e}`);
    return null;
  } finally {
    try { await Bun.file(aiff).delete(); } catch { /* ignore */ }
    try { await Bun.file(wav).delete(); } catch { /* ignore */ }
  }
}
