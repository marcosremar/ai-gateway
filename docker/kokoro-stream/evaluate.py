import argparse
import concurrent.futures
import json
import os
import re
import statistics
import subprocess
import time
import unicodedata
import wave
from pathlib import Path

import numpy as np

import server

SENTENCES = {
    "pt": ["Bom dia a todos, vamos começar a reunião de hoje.", "A reunião é às 14h30 do dia 18/10/2026 e o ingresso custa R$ 10,50.", "O Dr. Silva falou com a Microsoft e com o Sr. João sobre o projeto.", "Você acredita que conseguimos? Foi incrível, de verdade!", "A nossa principal preocupação continua sendo a rotatividade dos clientes, principalmente na Europa e na América Latina."],
    "es": ["Buenos días a todos, empecemos la reunión de hoy.", "La reunión es a las 14:30 del 18/10/2026 y la entrada cuesta 10,50 €.", "El Dr. García habló con Microsoft y con el Sr. López sobre el proyecto.", "¿Te puedes creer que lo logramos? ¡Fue increíble, de verdad!", "Nuestra principal preocupación sigue siendo la rotación de clientes, sobre todo en Europa y en América Latina."],
    "fr": ["Bonjour à tous, commençons la réunion d'aujourd'hui.", "La réunion est à 14h30 le 18/10/2026 et l'entrée coûte 10,50 €.", "M. Dupont a parlé avec Microsoft et avec le Dr Martin du projet.", "Tu te rends compte qu'on a réussi ? C'était incroyable, vraiment !", "Notre principale préoccupation reste le départ des clients, surtout en Europe et en Amérique latine."],
    "it": ["Buongiorno a tutti, iniziamo la riunione di oggi.", "La riunione è alle 14:30 del 18/10/2026 e l'ingresso costa 10,50 €.", "Il Dott. Rossi ha parlato con Microsoft e con il Sig. Bianchi del progetto.", "Ci credi che ce l'abbiamo fatta? È stato incredibile, davvero!", "La nostra principale preoccupazione resta l'abbandono dei clienti, soprattutto in Europa e in America Latina."],
    "en": ["Good morning everyone, let's start today's meeting.", "The meeting is at 2:30 pm on 10/18/2026 and the ticket costs $10.50.", "Dr. Smith talked to Microsoft and to Mr. Johnson about the project.", "Can you believe we made it? It was amazing, honestly!", "Our main concern is still customer churn, especially in Europe and Latin America."],
}
VOICES = {"pt": "pf_dora", "es": "ef_dora", "fr": "ff_siwis", "it": "if_sara", "en": "af_heart"}
EMPHASIS = {"pt": ("incrível", "principal"), "es": ("increíble", "principal"), "fr": ("incroyable", "principale"), "it": ("incredibile", "principale"), "en": ("amazing", "main")}
VARIANTS = {
    "numbers": ("Números por extenso (servidor)", dict(phrase_end=False, question=False)),
    "phrase_end": ("+ fim de frase mais longo", dict(phrase_end=True, question=False)),
    "question": ("+ subida na pergunta", dict(phrase_end=True, question=True)),
    "emphasis": ("+ ênfase numa palavra", dict(phrase_end=True, question=True, emphasis=True)),
    "pause": ("+ pausa copiada de quem fala", dict(phrase_end=True, question=True, pause=True)),
    "faster": ("+ ritmo de quem fala (15% mais rápido)", dict(phrase_end=True, question=True, speed=1.15)),
    "slower": ("+ ritmo de quem fala (10% mais lento)", dict(phrase_end=True, question=True, speed=0.9)),
}


def prepared(text: str, lang: str, i: int, options: dict) -> str:
    if options.get("emphasis") and i in (3, 4):
        word = EMPHASIS[lang][i - 3]
        text = text.replace(word, f"*{word}*", 1)
    if options.get("pause") and i == 4:
        text = text.replace(", ", ", [pause:350] ", 1)
    return text


def synthesize(engine, text: str, voice: str, options: dict) -> tuple[np.ndarray, float]:
    server.PHRASE_END_RATE = 1.25 if options.get("phrase_end") else 1.0
    server.QUESTION_RISE_SEMITONES = 3.0 if options.get("question") else 0.0
    started = time.perf_counter()
    first = None
    pcm = b""
    for chunk in server.speak(engine, server.spoken_segments(text, voice), voice, options.get("speed", 1.0)):
        first = first or time.perf_counter() - started
        pcm += chunk
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32767, first * 1000


def save(path: Path, audio: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(server.RATE)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())


def words(text: str, lang: str) -> list[str]:
    text = unicodedata.normalize("NFC", server.normalize(text.replace("*", ""), lang).lower()).replace("-", " ")
    return re.sub(r"[^\w\s']", " ", text).replace("'", " ").split()


def edits(ref: list[str], hyp: list[str]) -> int:
    row = list(range(len(hyp) + 1))
    for i, x in enumerate(ref, 1):
        prev, row[0] = row[0], i
        for j, y in enumerate(hyp, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (x != y))
    return row[-1]


def transcribe(path: Path, lang: str) -> str:
    out = subprocess.run(["curl", "-s", "-m", "90", "-H", f"Authorization: Bearer {os.environ['GATEWAY_API_KEY']}", "-F", f"file=@{path}", "-F", "model=whisper-large-v3", "-F", f"language={lang}", f"{os.environ.get('GATEWAY_URL', 'https://live.ucast.me')}/v1/audio/transcriptions"], capture_output=True, text=True).stdout
    return json.loads(out).get("text", "")


def pauses(audio: np.ndarray) -> tuple[int, float]:
    level = np.sqrt(np.convolve(audio**2, np.ones(240) / 240, "same")) > server.VOICE_LEVEL * 10
    voiced = np.flatnonzero(level)
    if len(voiced) < 2:
        return 0, 0.0
    gaps = np.diff(voiced) / server.RATE
    long = gaps[gaps >= 0.15]
    return len(long), float(long.mean() * 1000) if len(long) else 0.0


def pitch_spread(audio: np.ndarray) -> float:
    import librosa

    f0, voiced, _ = librosa.pyin(audio, fmin=60, fmax=500, sr=server.RATE, frame_length=2048)
    f0 = f0[voiced & ~np.isnan(f0)]
    return float(np.std(12 * np.log2(f0 / np.median(f0)))) if len(f0) > 10 else 0.0


def quality(audio: np.ndarray) -> float:
    import torch
    import torchaudio
    from speechmos import dnsmos

    wav16 = torchaudio.functional.resample(torch.from_numpy(audio).float(), server.RATE, 16000).numpy()
    return float(dnsmos.run(wav16, 16000)["ovrl_mos"])


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("out_dir")
    args.add_argument("--variants", nargs="*", default=list(VARIANTS))
    opts = args.parse_args()
    out = Path(opts.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    engine = server.load(server.MODEL_DIR)
    rows = []
    for key in opts.variants:
        label, options = VARIANTS[key]
        for lang, texts in SENTENCES.items():
            for i, text in enumerate(texts):
                audio, first_ms = synthesize(engine, prepared(text, lang, i, options), VOICES[lang], options)
                path = out / f"server_{key}_{lang}{i}.wav"
                save(path, audio)
                gaps, gap_ms = pauses(audio)
                rows.append({"variant": key, "label": label, "lang": lang, "i": i, "text": text, "path": str(path), "first_ms": first_ms, "seconds": len(audio) / server.RATE, "words": len(words(text, lang)), "pauses": gaps, "pause_ms": gap_ms, "pitch": pitch_spread(audio), "quality": quality(audio)})
        print(key, "synthesized", flush=True)

    def errors(row: dict) -> int:
        ref = words(row["text"], row["lang"])
        return int(statistics.median(edits(ref, words(transcribe(Path(row["path"]), row["lang"]), row["lang"])) for _ in range(3)))

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        for row, e in zip(rows, pool.map(errors, rows)):
            row["errors"] = e
    (out / "evaluation.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    for key in opts.variants:
        rs = [r for r in rows if r["variant"] == key]
        print(f"{VARIANTS[key][0]:42s} WER {100 * sum(r['errors'] for r in rs) / sum(r['words'] for r in rs):4.1f}%  quality {np.mean([r['quality'] for r in rs]):.2f}  pitch {np.mean([r['pitch'] for r in rs]):.2f} st  words/s {sum(r['words'] for r in rs) / sum(r['seconds'] for r in rs):.2f}  pauses {np.mean([r['pauses'] for r in rs]):.1f}  first sound {np.median([r['first_ms'] for r in rs]):.0f} ms")


if __name__ == "__main__":
    main()
