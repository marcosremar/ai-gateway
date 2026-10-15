"""
What packet loss on the WebRTC uplink does to the learner's speech, per recovery strategy, without a network:

    loss_bench.py clips <speech-16k.wav> <out-dir> [seeds]   (the edge's venv) Opus 20 ms packets, mono 32 kbit/s with
                                                             in-band FEC as a browser sends them; packets dropped at
                                                             0 / 2 / 5 / 10 %; one WAV per strategy, loss and seed
    loss_bench.py wer <out-dir> [whisper-model]              (a Python with openai-whisper) transcript identical to the
                                                             loss-free one, and word error rate against it

Strategies: silence (a lost packet is 20 ms of zeros: the edge before), fec (rebuilt from the next packet's FEC, zeros
when that is lost too), fec+plc (audio.LossDecoder: the edge now), red+fec+plc (the same decoder when every packet also
carries a copy of the one before it, RFC 2198 at distance 1 as Chrome sends it).
"""

import json
import random
import sys
import wave
from pathlib import Path

LOSSES = (0, 2, 5, 10)
STRATEGIES = ("silence", "fec", "fec+plc", "red+fec+plc")


def clips(source: str, out_dir: str, seeds: int) -> None:
    import ctypes  # noqa: PLC0415

    import av  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    from aiortc.jitterbuffer import JitterFrame  # noqa: PLC0415

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from aigw_edge import audio  # noqa: PLC0415

    lib = audio.LIBOPUS
    with wave.open(source) as w:
        speech = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    voice = np.interp(np.arange(len(speech) * 3) / 3, np.arange(len(speech)), speech).astype(np.int16)

    def encode(loss: int) -> list[bytes]:
        enc = av.CodecContext.create("libopus", "w")
        enc.bit_rate, enc.format, enc.layout, enc.sample_rate = 32000, "s16", "mono", 48000
        enc.options = {"application": "voip", "fec": "1", "packet_loss": str(loss)}
        packets = []
        for i in range(0, len(voice) - 959, 960):
            frame = av.AudioFrame.from_ndarray(voice[i:i + 960].reshape(1, -1), format="s16", layout="mono")
            frame.sample_rate, frame.pts = 48000, i
            packets += [bytes(p) for p in enc.encode(frame)]
        return packets

    def plain(packets: list[bytes], got: list[bool], fec: bool) -> np.ndarray:
        dec = lib.opus_decoder_create(48000, 1, ctypes.byref(ctypes.c_int()))
        pcm, out = (ctypes.c_int16 * 5760)(), []
        for n, data in enumerate(packets):
            if got[n]:
                lib.opus_decode(dec, data, len(data), pcm, 960, 0)
            elif fec and n + 1 < len(packets) and got[n + 1] and lib.opus_packet_has_lbrr(packets[n + 1], len(packets[n + 1])) > 0:
                lib.opus_decode(dec, packets[n + 1], len(packets[n + 1]), pcm, 960, 1)
            else:
                ctypes.memset(pcm, 0, 1920)
            out.append(np.frombuffer(pcm, dtype=np.int16, count=960).copy())
        lib.opus_decoder_destroy(dec)
        return np.concatenate(out)

    def edge(packets: list[bytes], got: list[bool]) -> tuple[np.ndarray, int]:
        decoder, out, fec = audio.LossDecoder(), np.zeros(len(packets) * 960, dtype=np.int16), 0
        for n, data in enumerate(packets):
            if got[n]:
                for frame in decoder.decode(JitterFrame(data=data, timestamp=n * 960)):
                    out[frame.pts:frame.pts + frame.samples] = frame.to_ndarray()[0][:len(out) - frame.pts]
                    fec += frame.opaque[1]
        return out, fec

    def save(name: str, pcm48: np.ndarray) -> None:
        with wave.open(str(Path(out_dir, name + ".wav")), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(audio.Downsampler48to16().push(pcm48, 1))

    def snr(reference: np.ndarray, x: np.ndarray) -> float:
        noise = float(np.sum((reference.astype(np.float64) - x) ** 2))
        return 99.0 if noise == 0 else round(10 * np.log10(float(np.sum(reference.astype(np.float64) ** 2)) / noise), 1)

    Path(out_dir).mkdir(parents=True, exist_ok=True)
    table = {}
    for loss in LOSSES:
        packets = encode(loss)
        whole = [True] * len(packets)
        reference = plain(packets, whole, False)
        rows = {s: {"snr_db": [], "rebuilt_pct": []} for s in STRATEGIES}
        for seed in range(1 if loss == 0 else seeds):
            rng = random.Random(seed)
            got = [rng.random() >= loss / 100 for _ in packets]
            got[0] = True
            lost = max(1, got.count(False))
            carried = [got[n] or (n + 1 < len(got) and got[n + 1]) for n in range(len(got))]
            with_fec, fec_samples = edge(packets, got)
            with_red, red_fec = edge(packets, carried)
            outputs = {"silence": (plain(packets, got, False), 0), "fec": (plain(packets, got, True), fec_samples // 960),
                       "fec+plc": (with_fec, fec_samples // 960),
                       "red+fec+plc": (with_red, carried.count(True) - got.count(True) + red_fec // 960)}
            for strategy, (pcm, rebuilt) in outputs.items():
                save(f"{strategy}_{loss}_{seed}", pcm)
                rows[strategy]["snr_db"].append(snr(reference, pcm))
                rows[strategy]["rebuilt_pct"].append(round(100 * rebuilt / lost) if loss else 100)
        table[loss] = {s: {k: round(sum(v) / len(v), 1) for k, v in r.items()} for s, r in rows.items()}
    print(json.dumps(table, indent=1))


def wer(out_dir: str, model_name: str) -> None:
    import re  # noqa: PLC0415

    import whisper  # noqa: PLC0415

    model = whisper.load_model(model_name)
    words = lambda text: re.sub(r"[^\w\s]", "", text.lower()).split()  # noqa: E731

    def distance(a: list[str], b: list[str]) -> int:
        row = list(range(len(b) + 1))
        for i, x in enumerate(a, 1):
            previous, row[0] = row[0], i
            for j, y in enumerate(b, 1):
                previous, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, previous + (x != y))
        return row[-1]

    heard = lambda path: words(model.transcribe(str(path), language="pt", fp16=False, temperature=0)["text"])  # noqa: E731
    reference = heard(Path(out_dir, "silence_0_0.wav"))
    print("reference:", " ".join(reference))
    table = {}
    for loss in LOSSES:
        for strategy in STRATEGIES:
            texts = [heard(path) for path in sorted(Path(out_dir).glob(f"{strategy}_{loss}_*.wav"))]
            table[f"{loss} % {strategy}"] = {
                "intact": f"{sum(t == reference for t in texts)}/{len(texts)}",
                "wer_pct": round(100 * sum(distance(reference, t) for t in texts) / (len(reference) * len(texts)), 1)}
            print(f"{loss} % {strategy}", table[f"{loss} % {strategy}"], flush=True)
    print(json.dumps(table, indent=1))


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "clips":
        clips(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 10)
    elif len(sys.argv) >= 3 and sys.argv[1] == "wer":
        wer(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "small")
    else:
        sys.exit(__doc__)
