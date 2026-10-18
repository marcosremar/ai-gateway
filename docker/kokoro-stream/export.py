import argparse
import hashlib
import json
import os
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
CALIBRATION = {
    "en-us": ["Any questions before we continue?", "Thank you all for your attention.", "Our main concern is still churn.", "Let's look at the details by region, starting with Europe and then Latin America.", "The next meeting is on Tuesday at ten in the morning.", "We hired three new people in the support team."],
    "es": ["¿Alguna pregunta antes de continuar?", "Gracias a todos por su atención.", "Nuestra principal preocupación sigue siendo la rotación de clientes.", "Veamos los detalles por región, empezando por Europa y luego por América Latina.", "La próxima reunión será el martes a las diez de la mañana.", "Hemos contratado a tres personas nuevas en el equipo de soporte."],
    "fr-fr": ["Des questions avant de continuer ?", "Merci à tous pour votre attention.", "Notre principale préoccupation reste le départ des clients.", "Regardons les détails par région, en commençant par l'Europe puis l'Amérique latine.", "La prochaine réunion aura lieu mardi à dix heures.", "Nous avons recruté trois nouvelles personnes dans l'équipe du support."],
    "pt-br": ["Alguma pergunta antes de continuarmos?", "Obrigado a todos pela atenção.", "A nossa principal preocupação continua sendo a rotatividade dos clientes.", "Vamos ver os detalhes por região, começando pela Europa e depois pela América Latina.", "A próxima reunião será na terça-feira às dez da manhã.", "Contratamos três pessoas novas na equipe de suporte."],
    "it": ["Qualche domanda prima di continuare?", "Grazie a tutti per l'attenzione.", "La nostra principale preoccupazione resta l'abbandono dei clienti.", "Vediamo i dettagli per regione, partendo dall'Europa e poi dall'America Latina.", "La prossima riunione sarà martedì alle dieci del mattino.", "Abbiamo assunto tre nuove persone nel team di supporto."],
    "hi": ["आगे बढ़ने से पहले कोई सवाल?", "आप सभी का ध्यान देने के लिए धन्यवाद।", "हमारी मुख्य चिंता अब भी ग्राहकों का छोड़ना है।", "आइए क्षेत्र के अनुसार विवरण देखें, पहले यूरोप और फिर लैटिन अमेरिका।", "अगली बैठक मंगलवार को सुबह दस बजे होगी।", "हमने सहायता टीम में तीन नए लोगों को रखा है।"],
}


def import_kokoro(source: Path):
    package = types.ModuleType("kokoro")
    package.__path__ = [str(source)]
    sys.modules["kokoro"] = package
    from kokoro import istftnet
    from kokoro.model import KModel

    return istftnet, KModel


def adain_forward(self, x, s):
    gamma, beta = torch.chunk(self.fc(s).view(s.size(0), -1, 1), chunks=2, dim=1)
    stats = getattr(self, "external", None)
    normed = self.norm(x) if stats is None else F.batch_norm(x, stats[0], stats[1], self.norm.weight, self.norm.bias, False, 0.0, self.norm.eps)
    return (1 + gamma) * normed + beta


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


class Generator(nn.Module):
    def __init__(self, gen):
        super().__init__()
        self.gen = gen

    def forward(self, x, style, har):
        return generate(self.gen, x, style, har)


class GeneratorWindow(nn.Module):
    def __init__(self, gen, layers):
        super().__init__()
        self.gen = gen
        self.layers = layers

    def forward(self, x, style, har, means, variances):
        at = 0
        for layer in self.layers:
            size = layer.norm.num_features
            layer.external = (means[at : at + size], variances[at : at + size])
            at += size
        try:
            return generate(self.gen, x, style, har)
        finally:
            for layer in self.layers:
                del layer.external


def phonemizer():
    if os.environ.get("ESPEAK_DATA"):
        import espeakng_loader

        espeakng_loader.get_data_path = lambda: os.environ["ESPEAK_DATA"]
        espeakng_loader.get_library_path = lambda: os.environ["ESPEAK_LIBRARY"]
    from misaki import espeak

    cache = {}

    def phonemize(text: str, language: str) -> str:
        if language not in cache:
            cache[language] = espeak.EspeakG2P(language=language)
        return cache[language](text)

    return phonemize


@torch.no_grad()
def priors(model, front, layers, packs, g2p) -> dict[str, np.ndarray]:
    seen = []
    hooks = [layer.register_forward_pre_hook(lambda mod, inp: seen.append((mod, inp[0]))) for layer in layers]
    out = {}
    try:
        for voice, language in VOICES.items():
            total = None
            for text in CALIBRATION[language]:
                ids = [model.vocab[p] for p in g2p(text, language) if p in model.vocab][:510]
                ref_s = packs[voice][len(ids) - 1]
                x, har, _ = front(torch.LongTensor([[0, *ids, 0]]), ref_s, torch.ones(1))
                seen.clear()
                generate(model.decoder.generator, x, ref_s[:, :128], har)
                stats = {id(mod): (inp.mean(dim=2).flatten(), inp.var(dim=2, unbiased=False).flatten()) for mod, inp in seen}
                packed = torch.stack([torch.cat([stats[id(l)][0] for l in layers]), torch.cat([stats[id(l)][1] for l in layers])])
                total = packed if total is None else total + packed
            out[voice] = (total / len(CALIBRATION[language])).numpy()
    finally:
        for hook in hooks:
            hook.remove()
    return out


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("out_dir")
    args.add_argument("--kokoro-src", required=True, help="the kokoro/ folder of a hexgrad/kokoro checkout")
    opts = args.parse_args()
    out = Path(opts.out_dir)
    (out / "voices").mkdir(parents=True, exist_ok=True)
    istftnet, KModel = import_kokoro(Path(opts.kokoro_src))
    istftnet.AdaIN1d.forward = adain_forward
    config = hf_hub_download(REPO, "config.json", revision=REVISION)
    weights = hf_hub_download(REPO, "kokoro-v1_0.pth", revision=REVISION)
    model = KModel(repo_id=REPO, config=config, model=weights, disable_complex=True).eval()
    gen = model.decoder.generator
    layers = [m for m in gen.modules() if isinstance(m, istftnet.AdaIN1d)]
    packs = {v: torch.load(hf_hub_download(REPO, f"voices/{v}.pt", revision=REVISION), weights_only=True) for v in VOICES}
    front = Front(model)
    ids = torch.LongTensor([[0, *torch.randint(1, 100, (48,)).tolist(), 0]])
    ref_s = packs["af_heart"][47]
    with torch.no_grad():
        x, har, _ = front(ids, ref_s, torch.ones(1))
    channels = sum(l.norm.num_features for l in layers)
    exports = [
        ("front.onnx", front, (ids, ref_s, torch.ones(1)), ["input_ids", "ref_s", "speed"], ["x", "har", "durations"], {"input_ids": {1: "tokens"}, "x": {2: "frames"}, "har": {2: "har_frames"}, "durations": {0: "tokens"}}),
        ("generator.onnx", Generator(gen), (x, ref_s[:, :128], har), ["x", "style", "har"], ["audio"], {"x": {2: "frames"}, "har": {2: "har_frames"}, "audio": {0: "samples"}}),
        ("generator_window.onnx", GeneratorWindow(gen, layers), (x, ref_s[:, :128], har, torch.zeros(channels), torch.ones(channels)), ["x", "style", "har", "means", "variances"], ["audio"], {"x": {2: "frames"}, "har": {2: "har_frames"}, "audio": {0: "samples"}}),
    ]
    for name, module, inputs, input_names, output_names, axes in exports:
        torch.onnx.export(module, inputs, str(out / name), input_names=input_names, output_names=output_names, dynamic_axes=axes, opset_version=17, do_constant_folding=True, dynamo=False)
    np.savez(out / "priors.npz", **priors(model, front, layers, packs, phonemizer()))
    for voice, pack in packs.items():
        pack.numpy().astype(np.float32).tofile(out / "voices" / f"{voice}.bin")
    shutil.copy(config, out / "config.json")
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.name != "models.sha256")
    (out / "models.sha256").write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(out)}\n" for p in files))
    print(json.dumps({p.name: round(p.stat().st_size / 1e6, 1) for p in files}))


if __name__ == "__main__":
    main()
