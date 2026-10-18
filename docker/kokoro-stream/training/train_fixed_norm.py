import argparse
import copy
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import torchaudio
from huggingface_hub import hf_hub_download

import train_vocoder as tv

STARTED = time.time()
HAR_PER_FRAME = 60
WARMUP_STEPS = int(__import__("os").environ.get("WARMUP_STEPS", "2000"))


class FixedNorm(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.scale = nn.Parameter(torch.ones(channels))
        self.shift = nn.Parameter(torch.zeros(channels))

    def forward(self, x):
        return x * self.scale[None, :, None] + self.shift[None, :, None]


def adain_layers(gen, istftnet) -> list:
    return [m for m in gen.modules() if isinstance(m, istftnet.AdaIN1d)]


def generate(gen, x, s, har):
    for i in range(gen.num_upsamples):
        x = F.leaky_relu(x, negative_slope=0.1)
        x_source = gen.noise_res[i](gen.noise_convs[i](har), s)
        x = gen.ups[i](x)
        if i == gen.num_upsamples - 1:
            x = gen.reflection_pad(x)
        x = x + x_source
        x = sum(gen.resblocks[i * gen.num_kernels + j](x, s) for j in range(gen.num_kernels)) / gen.num_kernels
    x = gen.conv_post(F.leaky_relu(x))
    spec = torch.exp(x[:, : gen.post_n_fft // 2 + 1, :])
    phase = torch.sin(x[:, gen.post_n_fft // 2 + 1 :, :])
    return gen.stft.inverse(spec, phase).squeeze(1)


@torch.no_grad()
def harmonics(gen, f0, seed: int):
    torch.manual_seed(seed)
    har_source, _, _ = gen.m_source(gen.f0_upsamp(f0[:, None]).transpose(1, 2))
    spec, phase = gen.stft.transform(har_source.transpose(1, 2).squeeze(1))
    return torch.cat([spec, phase], dim=1)


def load_teacher(kokoro_src: Path):
    KModel = tv.import_kokoro(kokoro_src)
    from kokoro import istftnet

    model = KModel(repo_id=tv.REPO, config=hf_hub_download(tv.REPO, "config.json", revision=tv.REVISION), model=hf_hub_download(tv.REPO, "kokoro-v1_0.pth", revision=tv.REVISION)).eval()
    return model.decoder.generator.to(tv.DEVICE), istftnet


def with_fixed_norms(teacher, istftnet):
    student = copy.deepcopy(teacher)
    for layer in adain_layers(student, istftnet):
        layer.norm = FixedNorm(layer.norm.num_features).to(tv.DEVICE)
    return student


@torch.no_grad()
def initialise(student, teacher, istftnet, items) -> None:
    sums: dict[int, list] = {}
    teacher_layers = adain_layers(teacher, istftnet)
    seen = []
    hooks = [layer.register_forward_pre_hook(lambda mod, inp: seen.append((mod, inp[0]))) for layer in teacher_layers]
    try:
        for item in items[:300]:
            x, f0, s = item["x"][None].float().to(tv.DEVICE), item["f0"][None].to(tv.DEVICE), item["s"][None].float().to(tv.DEVICE)
            seen.clear()
            generate(teacher, x, s, harmonics(teacher, f0, item["seed"]))
            for mod, inp in seen:
                mean, var = inp.mean(dim=2).flatten(), inp.var(dim=2, unbiased=False).flatten()
                total = sums.setdefault(id(mod), [0, 0, 0])
                total[0], total[1], total[2] = total[0] + mean, total[1] + var, total[2] + 1
    finally:
        for hook in hooks:
            hook.remove()
    for t_layer, s_layer in zip(teacher_layers, adain_layers(student, istftnet)):
        mean_sum, var_sum, count = sums[id(t_layer)]
        mean, var = mean_sum / count, var_sum / count
        scale = t_layer.norm.weight / torch.sqrt(var + t_layer.norm.eps)
        s_layer.norm.scale.copy_(scale)
        s_layer.norm.shift.copy_(t_layer.norm.bias - mean * scale)


def batch(items, teacher, size: int):
    xs, ss, hars, ys = [], [], [], []
    for _ in range(size):
        item = random.choice(items)
        frames = item["x"].shape[1]
        if frames < tv.SEGMENT + 2 * tv.MARGIN:
            continue
        start = random.randint(tv.MARGIN, frames - tv.SEGMENT - tv.MARGIN)
        lo, hi = start - tv.MARGIN, start + tv.SEGMENT + tv.MARGIN
        har = harmonics(teacher, item["f0"][None].to(tv.DEVICE), item["seed"])[0]
        xs.append(item["x"][:, lo:hi].float())
        ss.append(item["s"].float())
        hars.append(har[:, lo * HAR_PER_FRAME : hi * HAR_PER_FRAME + 1])
        ys.append(item["audio"][start * tv.FRAME : (start + tv.SEGMENT) * tv.FRAME].float() / 32767)
    return torch.stack(xs).to(tv.DEVICE), torch.stack(ss).to(tv.DEVICE), torch.stack(hars), torch.stack(ys).to(tv.DEVICE)


def train(kokoro_src: Path, data: Path, out: Path, deadline: float) -> None:
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    items = torch.load(data)
    for seed, item in enumerate(items):
        item["seed"] = seed
    random.Random(0).shuffle(items)
    held, items = items[: min(100, len(items) // 4)], items[min(100, len(items) // 4) :]
    torch.save(held, out / "held.pt")
    teacher, istftnet = load_teacher(kokoro_src)
    for p in teacher.parameters():
        p.requires_grad_(False)
    check = held[0]
    x0, f00, s0 = check["x"][None].float().to(tv.DEVICE), check["f0"][None].to(tv.DEVICE), check["s"][None].float().to(tv.DEVICE)
    with torch.no_grad():
        again = generate(teacher, x0, s0, harmonics(teacher, f00, check["seed"]))[0].cpu()
    stored = check["audio"].float() / 32767
    n = min(len(again), len(stored))
    print(f"teacher reproduces the stored target: SNR {10 * torch.log10(stored[:n].pow(2).sum() / (stored[:n] - again[:n]).pow(2).sum()):.1f} dB", flush=True)
    student = with_fixed_norms(teacher, istftnet)
    for p in student.parameters():
        p.requires_grad_(True)
    initialise(student, teacher, istftnet, items)
    critics = tv.Discriminators().to(tv.DEVICE)
    opt_g = torch.optim.AdamW(student.parameters(), 5e-5, betas=(0.8, 0.99))
    opt_d = torch.optim.AdamW(critics.parameters(), 2e-4, betas=(0.8, 0.99))
    mels = [torchaudio.transforms.MelSpectrogram(24000, n_fft=n, hop_length=n // 4, n_mels=m).to(tv.DEVICE) for n, m in ((512, 64), (1024, 100), (2048, 128))]
    step = 0
    while time.time() < deadline:
        x, s, har, real = batch(items, teacher, 16)
        fake = generate(student, x, s, har)[:, tv.MARGIN * tv.FRAME : (tv.MARGIN + tv.SEGMENT) * tv.FRAME]
        adversarial = step >= WARMUP_STEPS
        if adversarial:
            opt_d.zero_grad()
            d_loss = sum(torch.mean((1 - r[0]) ** 2) + torch.mean(f[0] ** 2) for r, f in zip(critics(real), critics(fake.detach())))
            d_loss.backward()
            opt_d.step()
        opt_g.zero_grad()
        recon = tv.mel_loss(mels, fake, real)
        g_loss = 15 * recon + 5 * F.l1_loss(fake, real)
        if adversarial:
            real_out, fake_out = critics(real), critics(fake)
            g_loss = g_loss + sum(torch.mean((1 - f[0]) ** 2) for f in fake_out) + 2 * sum(F.l1_loss(fm, rm.detach()) for f, r in zip(fake_out, real_out) for fm, rm in zip(f[1], r[1]))
        g_loss.backward()
        nn.utils.clip_grad_norm_(student.parameters(), 1000)
        opt_g.step()
        step += 1
        if step % 500 == 0:
            print(f"step {step} mel {recon.item():.3f} elapsed {(time.time() - STARTED) / 3600:.2f} h", flush=True)
        if step % 5000 == 0:
            torch.save(student.state_dict(), out / "student_gen.pt")
    torch.save(student.state_dict(), out / "student_gen.pt")
    print(f"trained {step} steps", flush=True)
    evaluate(student, teacher, held, out)


@torch.no_grad()
def evaluate(student, teacher, held, out: Path) -> None:
    samples = out / "samples"
    samples.mkdir(exist_ok=True)
    spec = lambda w: torch.stft(w, 1024, 256, window=torch.hann_window(1024), return_complex=True).abs() ** 2 + 1e-10
    distances = []
    for i, item in enumerate(held):
        x, f0, s = item["x"][None].float().to(tv.DEVICE), item["f0"][None].to(tv.DEVICE), item["s"][None].float().to(tv.DEVICE)
        fake = generate(student, x, s, harmonics(teacher, f0, item["seed"]))[0].cpu()
        real = item["audio"].float() / 32767
        n = min(len(real), len(fake))
        distances.append((10 * torch.log10(spec(real[:n])) - 10 * torch.log10(spec(fake[:n]))).pow(2).mean(0).sqrt().mean().item())
        if i < 16:
            tv.save_wav(samples / f"{i:02d}_{item['voice']}_fixednorm.wav", fake)
            tv.save_wav(samples / f"{i:02d}_{item['voice']}_teacher.wav", real)
    print(f"held-out LSD fixed-norm student vs teacher {np.mean(distances):.2f} dB", flush=True)


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("--kokoro-src", type=Path, required=True)
    args.add_argument("--data", type=Path, required=True)
    args.add_argument("--out", type=Path, required=True)
    args.add_argument("--train-until", type=float, required=True)
    opts = args.parse_args()
    opts.out.mkdir(parents=True, exist_ok=True)
    train(opts.kokoro_src, opts.data, opts.out, opts.train_until)


if __name__ == "__main__":
    main()
