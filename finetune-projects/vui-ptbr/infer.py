"""
Quick inference + quality check for vui-ptbr finetuned checkpoint.

Usage:
    python infer.py --ckpt ../../output/checkpoints/erinome_step5000.pt
    python infer.py --ckpt ../../output/checkpoints/erinome_step5000.pt --compare
"""

import argparse, os, sys, contextlib
from pathlib import Path

import torch
import soundfile as sf

# Add preset dir to path so vui package is importable
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "finetune-presets" / "codec-tts"))

from vui.model import Vui
from vui.inference import generate


PTBR_TEXTS = [
    "Olá, como vai você hoje?",
    "O Brasil é um país de dimensões continentais com grande diversidade cultural.",
    "A inteligência artificial está transformando a forma como trabalhamos e vivemos.",
    "Bom dia! Espero que você tenha um ótimo dia pela frente.",
    "O Rio de Janeiro é uma cidade maravilhosa, famosa pelas suas praias e pelo carnaval.",
]


def load_model(ckpt_path: str | None, device: torch.device) -> Vui:
    """Load VUI base model, optionally with finetuned weights on top."""
    print(f"  Loading base model (fluxions/vui)...")
    from huggingface_hub import hf_hub_download
    base_path = hf_hub_download("fluxions/vui", "vui-100m-base.pt")
    base_ckpt = torch.load(base_path, map_location="cpu", weights_only=False)

    from vui.config import VuiConfig, Config
    raw_cfg = base_ckpt["config"]
    model_cfg = raw_cfg["model"] if "model" in raw_cfg else raw_cfg
    cfg = Config(model=VuiConfig(**model_cfg))
    model = Vui(cfg).eval()

    def _strip_module(sd: dict) -> dict:
        if any(k.startswith("module.") for k in sd):
            return {k.removeprefix("module."): v for k, v in sd.items()}
        return sd

    base_sd = _strip_module(base_ckpt["model"])
    model.load_state_dict(base_sd, strict=False)  # base may exclude codec (loaded in __init__)

    if ckpt_path:
        print(f"  Loading finetuned weights: {ckpt_path}")
        ft_ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
        sd = _strip_module(ft_ckpt["model"])
        # Finetuned checkpoint excludes codec (frozen) — load only what's present
        missing, unexpected = model.load_state_dict(sd, strict=False)
        codec_missing = [k for k in missing if k.startswith("codec.")]
        other_missing = [k for k in missing if not k.startswith("codec.")]
        if other_missing:
            print(f"  ⚠ missing non-codec keys: {other_missing[:5]}")
        print(f"  Loaded ({len(sd)} keys, {len(codec_missing)} codec keys kept from base)")
        step = ft_ckpt.get("step", "?")
        loss = ft_ckpt.get("loss", "?")
        print(f"  Checkpoint: step={step}, loss={loss:.4f}" if isinstance(loss, float) else f"  step={step}")

    model = model.to(device=device)

    if device.type != "cuda":
        # On MPS/CPU, VUI allocates KV cache in bfloat16 but model weights are float32.
        # Patch allocate_inference_cache to use float32 so dtypes match throughout.
        _orig_alloc = model.decoder.allocate_inference_cache
        def _alloc_f32(batch_size, dev, dtype):
            return _orig_alloc(batch_size, dev, torch.float32)
        model.decoder.allocate_inference_cache = _alloc_f32

    return model


@contextlib.contextmanager
def device_autocast(device: torch.device):
    """MPS doesn't support bfloat16 autocast well — use float32 on MPS/CPU."""
    if device.type == "cuda":
        with torch.autocast("cuda", torch.bfloat16, True):
            yield
    else:
        yield


def synthesize(model: Vui, text: str, device: torch.device) -> torch.Tensor:
    """Generate audio codes then decode to waveform."""
    with device_autocast(device):
        codes = generate(model, text, use_cuda_graph=False, temperature=0.7, top_k=100)
    # codes shape: [Q, T] or [B, Q, T]
    if codes.dim() == 3:
        codes = codes[0]
    wav = model.codec.from_indices(codes.unsqueeze(0))  # [1, 1, T]
    return wav.squeeze().cpu()


def measure_wer(wav: torch.Tensor, text: str, sr: int = 22050) -> float | None:
    """ASR roundtrip WER using openai-whisper (optional)."""
    try:
        import whisper, tempfile, os
        wm = whisper.load_model("base")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            sf.write(f.name, wav.numpy(), sr)
            result = wm.transcribe(f.name, language="pt")
            os.unlink(f.name)
        hyp = result["text"].strip().lower()
        ref = text.strip().lower()
        # simple word error rate
        ref_words = ref.split()
        hyp_words = hyp.split()
        import difflib
        matcher = difflib.SequenceMatcher(None, ref_words, hyp_words)
        matches = sum(t.size for t in matcher.get_matching_blocks())
        wer = 1.0 - (matches / max(len(ref_words), 1))
        return wer, hyp
    except ImportError:
        return None, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ckpt", required=True, help="Finetuned checkpoint path")
    parser.add_argument("--compare", action="store_true", help="Also synthesize with base model for comparison")
    parser.add_argument("--out-dir", default="./infer_out", help="Output directory for wav files")
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    if args.device == "auto":
        device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    else:
        device = torch.device(args.device)
    print(f"Device: {device}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    models = {"finetuned": args.ckpt}
    if args.compare:
        models["base"] = None

    results = {}
    for model_name, ckpt in models.items():
        print(f"\n{'='*50}")
        print(f"Model: {model_name}")
        print(f"{'='*50}")
        model = load_model(ckpt, device)

        wers = []
        for i, text in enumerate(PTBR_TEXTS):
            print(f"\n  [{i+1}/{len(PTBR_TEXTS)}] \"{text[:60]}\"")
            try:
                wav = synthesize(model, text, device)
                duration = len(wav) / 22050
                out_path = out_dir / f"{model_name}_{i+1}.wav"
                sf.write(str(out_path), wav.numpy(), 22050)
                print(f"  → {out_path} ({duration:.1f}s)")

                wer, hyp = measure_wer(wav, text)
                if wer is not None:
                    print(f"  WER: {wer:.1%}  ASR: \"{hyp}\"")
                    wers.append(wer)
            except Exception as e:
                print(f"  ERROR: {e}")

        if wers:
            avg_wer = sum(wers) / len(wers)
            results[model_name] = avg_wer
            print(f"\n  Avg WER ({model_name}): {avg_wer:.1%}")

        del model
        if device.type == "mps":
            torch.mps.empty_cache()

    if len(results) == 2:
        base_wer = results.get("base", 1.0)
        ft_wer = results.get("finetuned", 1.0)
        improvement = (base_wer - ft_wer) / max(base_wer, 1e-6) * 100
        print(f"\n{'='*50}")
        print(f"COMPARISON")
        print(f"  Base model WER:      {base_wer:.1%}")
        print(f"  Finetuned WER:       {ft_wer:.1%}")
        print(f"  Improvement:         {improvement:+.1f}%")
        print(f"{'='*50}")
    elif results:
        print(f"\nFinal WER: {list(results.values())[0]:.1%}")
    else:
        print("\nNo WER computed (whisper not installed). Check wav files in", out_dir)


if __name__ == "__main__":
    main()
