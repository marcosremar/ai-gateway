import argparse
import hashlib
import json
import shutil
import sys
import types
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from huggingface_hub import hf_hub_download

REPO = "hexgrad/Kokoro-82M"
REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
VOICES = {"af_heart": "en-us", "ef_dora": "es", "ff_siwis": "fr-fr", "pf_dora": "pt-br", "if_sara": "it", "hf_alpha": "hi"}
def import_kokoro(source: Path):
    package = types.ModuleType("kokoro")
    package.__path__ = [str(source)]
    sys.modules["kokoro"] = package
    from kokoro import istftnet
    from kokoro.model import KModel

    return istftnet, KModel


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
    return gen.stft.inverse(spec, phase).flatten()


class Front(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, input_ids, ref_s, speed):
        m = self.model
        lengths = torch.full((input_ids.shape[0],), input_ids.shape[-1], dtype=torch.long)
        text_mask = torch.zeros_like(input_ids, dtype=torch.bool)
        d_en = m.bert_encoder(m.bert(input_ids, attention_mask=(~text_mask).int())).transpose(-1, -2)
        s = ref_s[:, 128:]
        d = m.predictor.text_encoder(d_en, s, lengths, text_mask)
        x, _ = m.predictor.lstm(d)
        duration = torch.sigmoid(m.predictor.duration_proj(x)).sum(axis=-1) / speed
        durations = torch.round(duration).clamp(min=1).long().squeeze()
        indices = torch.repeat_interleave(torch.arange(input_ids.shape[1]), durations)
        aln = torch.zeros((input_ids.shape[1], indices.shape[0]))
        aln[indices, torch.arange(indices.shape[0])] = 1
        aln = aln.unsqueeze(0)
        F0_curve, N = m.predictor.F0Ntrain(d.transpose(-1, -2) @ aln, s)
        asr = m.text_encoder(input_ids, lengths, text_mask) @ aln
        dec = m.decoder
        style = ref_s[:, :128]
        F0 = dec.F0_conv(F0_curve.unsqueeze(1))
        Nc = dec.N_conv(N.unsqueeze(1))
        h = dec.encode(torch.cat([asr, F0, Nc], axis=1), style)
        asr_res = dec.asr_res(asr)
        for i, block in enumerate(dec.decode):
            if i < 4:
                h = torch.cat([h, asr_res, F0, Nc], axis=1)
            h = block(h, style)
        gen = dec.generator
        har_source, _, _ = gen.m_source(gen.f0_upsamp(F0_curve[:, None]).transpose(1, 2))
        spec, phase = gen.stft.transform(har_source.transpose(1, 2).squeeze(1))
        return h, torch.cat([spec, phase], dim=1), durations


class FixedNorm(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.scale = nn.Parameter(torch.ones(channels))
        self.shift = nn.Parameter(torch.zeros(channels))

    def forward(self, x):
        return x * self.scale[None, :, None] + self.shift[None, :, None]


class StreamingGenerator(nn.Module):
    def __init__(self, gen, istftnet, weights: Path):
        super().__init__()
        for layer in [m for m in gen.modules() if isinstance(m, istftnet.AdaIN1d)]:
            layer.norm = FixedNorm(layer.norm.num_features)
        gen.load_state_dict(torch.load(weights, map_location="cpu"), strict=False)
        self.gen = gen.eval()

    def forward(self, x, style, har):
        return generate(self.gen, x, style, har)


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("out_dir")
    args.add_argument("--kokoro-src", required=True, help="the kokoro/ folder of a hexgrad/kokoro checkout")
    args.add_argument("--streaming-weights", required=True, help="student_gen.pt from training/train_fixed_norm.py")
    opts = args.parse_args()
    out = Path(opts.out_dir)
    (out / "voices").mkdir(parents=True, exist_ok=True)
    istftnet, KModel = import_kokoro(Path(opts.kokoro_src))
    config = hf_hub_download(REPO, "config.json", revision=REVISION)
    weights = hf_hub_download(REPO, "kokoro-v1_0.pth", revision=REVISION)
    model = KModel(repo_id=REPO, config=config, model=weights, disable_complex=True).eval()
    packs = {v: torch.load(hf_hub_download(REPO, f"voices/{v}.pt", revision=REVISION), weights_only=True) for v in VOICES}
    front = Front(model)
    ids = torch.LongTensor([[0, *torch.randint(1, 100, (48,)).tolist(), 0]])
    ref_s = packs["af_heart"][47]
    with torch.no_grad():
        x, har, _ = front(ids, ref_s, torch.ones(1))
    exports = [
        ("front.onnx", front, (ids, ref_s, torch.ones(1)), ["input_ids", "ref_s", "speed"], ["x", "har", "durations"], {"input_ids": {1: "tokens"}, "x": {2: "frames"}, "har": {2: "har_frames"}, "durations": {0: "tokens"}}),
        ("generator_streaming.onnx", StreamingGenerator(model.decoder.generator, istftnet, Path(opts.streaming_weights)), (x, ref_s[:, :128], har), ["x", "style", "har"], ["audio"], {"x": {2: "frames"}, "har": {2: "har_frames"}, "audio": {0: "samples"}}),
    ]
    for name, module, inputs, input_names, output_names, axes in exports:
        torch.onnx.export(module, inputs, str(out / name), input_names=input_names, output_names=output_names, dynamic_axes=axes, opset_version=17, do_constant_folding=True, dynamo=False)
    for voice, pack in packs.items():
        pack.numpy().astype(np.float32).tofile(out / "voices" / f"{voice}.bin")
    shutil.copy(config, out / "config.json")
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.name != "models.sha256")
    (out / "models.sha256").write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(out)}\n" for p in files))
    print(json.dumps({p.name: round(p.stat().st_size / 1e6, 1) for p in files}))


if __name__ == "__main__":
    main()
