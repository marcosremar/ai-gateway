import argparse
import random
import sys
import time
import types
import wave
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import torchaudio
from huggingface_hub import hf_hub_download

REPO = "hexgrad/Kokoro-82M"
REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
FRAME = 300
N_FFT = 1200
SEGMENT = 64
WARMUP_STEPS = int(__import__("os").environ.get("WARMUP_STEPS", "5000"))
MARGIN = 16
STARTED = time.time()
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def import_kokoro(source: Path):
    package = types.ModuleType("kokoro")
    package.__path__ = [str(source)]
    sys.modules["kokoro"] = package
    from kokoro.model import KModel

    return KModel


def front(model, ids: list[int], ref_s: torch.Tensor):
    input_ids = torch.LongTensor([[0, *ids, 0]]).to(DEVICE)
    lengths = torch.full((1,), input_ids.shape[-1], dtype=torch.long).to(DEVICE)
    mask = torch.zeros_like(input_ids, dtype=torch.bool)
    d_en = model.bert_encoder(model.bert(input_ids, attention_mask=(~mask).int())).transpose(-1, -2)
    s = ref_s[:, 128:]
    d = model.predictor.text_encoder(d_en, s, lengths, mask)
    x, _ = model.predictor.lstm(d)
    durations = torch.round(torch.sigmoid(model.predictor.duration_proj(x)).sum(axis=-1)).clamp(min=1).long().squeeze()
    indices = torch.repeat_interleave(torch.arange(input_ids.shape[1], device=DEVICE), durations)
    aln = torch.zeros((input_ids.shape[1], indices.shape[0]), device=DEVICE)
    aln[indices, torch.arange(indices.shape[0], device=DEVICE)] = 1
    F0, N = model.predictor.F0Ntrain(d.transpose(-1, -2) @ aln.unsqueeze(0), s)
    asr = model.text_encoder(input_ids, lengths, mask) @ aln.unsqueeze(0)
    dec = model.decoder
    style = ref_s[:, :128]
    F0c = dec.F0_conv(F0.unsqueeze(1))
    Nc = dec.N_conv(N.unsqueeze(1))
    h = dec.encode(torch.cat([asr, F0c, Nc], axis=1), style)
    asr_res = dec.asr_res(asr)
    for i, block in enumerate(dec.decode):
        if i < 4:
            h = torch.cat([h, asr_res, F0c, Nc], axis=1)
        h = block(h, style)
    return h, F0, N, style


@torch.no_grad()
def precompute(kokoro_src: Path, phonemes: Path, out: Path) -> None:
    KModel = import_kokoro(kokoro_src)
    model = KModel(repo_id=REPO, config=hf_hub_download(REPO, "config.json", revision=REVISION), model=hf_hub_download(REPO, "kokoro-v1_0.pth", revision=REVISION)).eval().to(DEVICE)
    packs = {}
    items = []
    for n, line in enumerate(phonemes.read_text(encoding="utf-8").splitlines()):
        voice, ps = line.split("\t")
        if voice not in packs:
            packs[voice] = torch.load(hf_hub_download(REPO, f"voices/{voice}.pt", revision=REVISION), weights_only=True).to(DEVICE)
        ids = [model.vocab[p] for p in ps if p in model.vocab][:500]
        ref_s = packs[voice][len(ids) - 1]
        x, f0, energy, style = front(model, ids, ref_s)
        torch.manual_seed(n)
        audio = model.decoder.generator(x, style, f0).flatten()
        items.append({"x": x[0].half().cpu(), "f0": f0[0].cpu(), "n": energy[0].cpu(), "s": style[0].half().cpu(), "audio": (audio.clamp(-1, 1) * 32767).short().cpu(), "voice": voice})
    torch.save(items, out)
    print(f"precomputed {len(items)} items in {time.time() - STARTED:.0f} s", flush=True)


class AdaLayerNorm(nn.Module):
    def __init__(self, dim: int, style_dim: int = 128):
        super().__init__()
        self.norm = nn.LayerNorm(dim, elementwise_affine=False)
        self.affine = nn.Linear(style_dim, 2 * dim)

    def forward(self, x, s):
        scale, shift = self.affine(s).unsqueeze(1).chunk(2, dim=-1)
        return self.norm(x) * (1 + scale) + shift


class ConvNeXtBlock(nn.Module):
    def __init__(self, dim: int, hidden: int):
        super().__init__()
        self.dwconv = nn.Conv1d(dim, dim, 7, padding=3, groups=dim)
        self.norm = AdaLayerNorm(dim)
        self.pw1 = nn.Linear(dim, hidden)
        self.pw2 = nn.Linear(hidden, dim)
        self.gamma = nn.Parameter(torch.full((dim,), 1e-6))

    def forward(self, x, s):
        h = self.pw2(F.gelu(self.pw1(self.norm(self.dwconv(x).transpose(1, 2), s))))
        return x + (self.gamma * h).transpose(1, 2)


class Student(nn.Module):
    def __init__(self, dim: int = 512, hidden: int = 1536, layers: int = 8):
        super().__init__()
        self.embed = nn.Conv1d(515, dim, 7, padding=3)
        self.blocks = nn.ModuleList(ConvNeXtBlock(dim, hidden) for _ in range(layers))
        self.norm = nn.LayerNorm(dim)
        self.head = nn.Linear(dim, N_FFT + 2)

    def forward(self, x, f0, n, s):
        extra = torch.stack([torch.log1p(f0.clamp(min=0)) / 6, (f0 > 50).float(), n / 10], 1)
        h = self.embed(torch.cat([x, extra], 1))
        for block in self.blocks:
            h = block(h, s)
        h = self.head(self.norm(h.transpose(1, 2))).transpose(1, 2)
        log_mag, phase = h.chunk(2, dim=1)
        return log_mag.clamp(max=6), phase


def to_audio(log_mag, phase, frames: int):
    spec = torch.polar(torch.exp(log_mag.float()), phase.float())
    return torch.istft(spec, N_FFT, FRAME, N_FFT, torch.hann_window(N_FFT, device=spec.device), center=True, length=frames * FRAME)


class PeriodDiscriminator(nn.Module):
    def __init__(self, period: int):
        super().__init__()
        self.period = period
        chans = [1, 32, 128, 512, 1024]
        self.convs = nn.ModuleList(nn.utils.parametrizations.weight_norm(nn.Conv2d(chans[i], chans[i + 1], (5, 1), (3, 1), (2, 0))) for i in range(4))
        self.post = nn.utils.parametrizations.weight_norm(nn.Conv2d(1024, 1, (3, 1), 1, (1, 0)))

    def forward(self, y):
        b, t = y.shape
        y = F.pad(y, (0, (-t) % self.period), "reflect").view(b, 1, -1, self.period)
        features = []
        for conv in self.convs:
            y = F.leaky_relu(conv(y), 0.1)
            features.append(y)
        return self.post(y).flatten(1), features


class ResolutionDiscriminator(nn.Module):
    def __init__(self, n_fft: int):
        super().__init__()
        self.n_fft = n_fft
        self.convs = nn.ModuleList(nn.utils.parametrizations.weight_norm(nn.Conv2d(c_in, 32, (3, 9), (1, 2) if i else (1, 1), (1, 4))) for i, c_in in enumerate([1, 32, 32, 32]))
        self.post = nn.utils.parametrizations.weight_norm(nn.Conv2d(32, 1, (3, 3), 1, (1, 1)))

    def forward(self, y):
        spec = torch.stft(y, self.n_fft, self.n_fft // 4, self.n_fft, torch.hann_window(self.n_fft, device=y.device), return_complex=True).abs().unsqueeze(1)
        features = []
        for conv in self.convs:
            spec = F.leaky_relu(conv(spec), 0.1)
            features.append(spec)
        return self.post(spec).flatten(1), features


class Discriminators(nn.Module):
    def __init__(self):
        super().__init__()
        self.all = nn.ModuleList([*(PeriodDiscriminator(p) for p in (2, 3, 5, 7, 11)), *(ResolutionDiscriminator(n) for n in (512, 1024, 2048))])

    def forward(self, y):
        return [d(y) for d in self.all]


def mel_loss(mels, fake, real):
    return sum(F.l1_loss(torch.log(m(fake) + 1e-5), torch.log(m(real) + 1e-5)) for m in mels)


def batch(items, size: int):
    xs, f0s, ns, ss, ys = [], [], [], [], []
    for _ in range(size):
        item = random.choice(items)
        frames = item["x"].shape[1]
        if frames < SEGMENT + 2 * MARGIN:
            continue
        start = random.randint(MARGIN, frames - SEGMENT - MARGIN)
        lo, hi = start - MARGIN, start + SEGMENT + MARGIN
        xs.append(item["x"][:, lo:hi].float())
        f0s.append(item["f0"][lo:hi])
        ns.append(item["n"][lo:hi])
        ss.append(item["s"].float())
        ys.append(item["audio"][start * FRAME : (start + SEGMENT) * FRAME].float() / 32767)
    return [torch.stack(v).to(DEVICE) for v in (xs, f0s, ns, ss, ys)]


def train(data: Path, out: Path, deadline: float) -> None:
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    items = torch.load(data)
    random.Random(0).shuffle(items)
    held, items = items[: min(100, len(items) // 4)], items[min(100, len(items) // 4) :]
    torch.save(held, out / "held.pt")
    student, critics = Student().to(DEVICE), Discriminators().to(DEVICE)
    print(f"student {sum(p.numel() for p in student.parameters()) / 1e6:.1f}M params", flush=True)
    opt_g = torch.optim.AdamW(student.parameters(), 2e-4, betas=(0.8, 0.99))
    opt_d = torch.optim.AdamW(critics.parameters(), 2e-4, betas=(0.8, 0.99))
    mels = [torchaudio.transforms.MelSpectrogram(24000, n_fft=n, hop_length=n // 4, n_mels=m).to(DEVICE) for n, m in ((512, 64), (1024, 100), (2048, 128))]
    step = 0
    while time.time() < deadline:
        x, f0, n, s, real = batch(items, 32)
        log_mag, phase = student(x, f0, n, s)
        fake = to_audio(log_mag, phase, x.shape[-1])[:, MARGIN * FRAME : (MARGIN + SEGMENT) * FRAME]
        adversarial = step >= WARMUP_STEPS
        if adversarial:
            opt_d.zero_grad()
            d_loss = sum(torch.mean((1 - r[0]) ** 2) + torch.mean(f[0] ** 2) for r, f in zip(critics(real), critics(fake.detach())))
            d_loss.backward()
            opt_d.step()
        opt_g.zero_grad()
        recon = mel_loss(mels, fake, real)
        g_loss = 15 * recon
        if adversarial:
            real_out, fake_out = critics(real), critics(fake)
            g_loss = g_loss + sum(torch.mean((1 - f[0]) ** 2) for f in fake_out) + 2 * sum(F.l1_loss(fm, rm.detach()) for f, r in zip(fake_out, real_out) for fm, rm in zip(f[1], r[1]))
        g_loss.backward()
        nn.utils.clip_grad_norm_(student.parameters(), 1000)
        opt_g.step()
        step += 1
        if step % 500 == 0:
            print(f"step {step} mel {recon.item():.3f} elapsed {(time.time() - STARTED) / 3600:.2f} h", flush=True)
        if step % 10000 == 0:
            torch.save(student.state_dict(), out / "student.pt")
    torch.save(student.state_dict(), out / "student.pt")
    print(f"trained {step} steps", flush=True)


def save_wav(path: Path, samples: torch.Tensor) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes((samples.clamp(-1, 1) * 32767).short().numpy().tobytes())


class Exported(nn.Module):
    def __init__(self, student: Student):
        super().__init__()
        self.student = student

    def forward(self, x, f0, n, style):
        return self.student(x, f0, n, style)


@torch.no_grad()
def evaluate(out: Path) -> None:
    student = Student().to(DEVICE)
    student.load_state_dict(torch.load(out / "student.pt"))
    student.eval()
    held = torch.load(out / "held.pt")
    samples = out / "samples"
    samples.mkdir(exist_ok=True)
    distances = []
    for i, item in enumerate(held):
        x, f0, n, s = item["x"][None].float().to(DEVICE), item["f0"][None].to(DEVICE), item["n"][None].to(DEVICE), item["s"][None].float().to(DEVICE)
        fake = to_audio(*student(x, f0, n, s), x.shape[-1])[0].cpu()
        real = item["audio"].float() / 32767
        spec = lambda w: torch.stft(w, 1024, 256, window=torch.hann_window(1024), return_complex=True).abs() ** 2 + 1e-10
        distances.append((10 * torch.log10(spec(real)) - 10 * torch.log10(spec(fake[: len(real)]))).pow(2).mean(0).sqrt().mean().item())
        if i < 16:
            save_wav(samples / f"{i:02d}_{item['voice']}_student.wav", fake)
            save_wav(samples / f"{i:02d}_{item['voice']}_teacher.wav", real)
    print(f"held-out LSD student vs teacher {np.mean(distances):.2f} dB", flush=True)
    frames = held[0]["x"].shape[1]
    args = (held[0]["x"][None].float().to(DEVICE), held[0]["f0"][None].to(DEVICE), held[0]["n"][None].to(DEVICE), held[0]["s"][None].float().to(DEVICE))
    torch.onnx.export(Exported(student), args, str(out / "student.onnx"), input_names=["x", "f0", "n", "style"], output_names=["log_mag", "phase"], dynamic_axes={"x": {2: "frames"}, "f0": {1: "frames"}, "n": {1: "frames"}, "log_mag": {2: "frames"}, "phase": {2: "frames"}}, opset_version=17, dynamo=False)
    print(f"exported student.onnx ({frames} frames example)", flush=True)


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("stage", choices=["precompute", "train", "evaluate"])
    args.add_argument("--kokoro-src", type=Path)
    args.add_argument("--phonemes", type=Path)
    args.add_argument("--data", type=Path)
    args.add_argument("--out", type=Path)
    args.add_argument("--train-until", type=float, default=0)
    opts = args.parse_args()
    if opts.stage == "precompute":
        precompute(opts.kokoro_src, opts.phonemes, opts.data)
    elif opts.stage == "train":
        opts.out.mkdir(parents=True, exist_ok=True)
        train(opts.data, opts.out, opts.train_until)
    else:
        evaluate(opts.out)


if __name__ == "__main__":
    main()
