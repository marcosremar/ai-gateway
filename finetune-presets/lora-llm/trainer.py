"""
LoRA/QLoRA fine-tune for causal LLMs (LLaMA, Mistral, Qwen — 7B to 32B).

Usage:
    python trainer.py \
        --model /workspace/model \
        --data /workspace/data/train.jsonl \
        --output /workspace/checkpoints \
        --epochs 3 --lr 2e-4 \
        --lora-r 16 --lora-alpha 32 \
        [--load-in-4bit]

JSONL format (one per line):
    {"instruction": "...", "input": "...", "output": "..."}
    {"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
"""

import argparse, json, math, os, sys
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig, TaskType, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForSeq2Seq,
    TrainingArguments,
)
from trl import SFTTrainer


def load_jsonl(path: str) -> list[dict]:
    records = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def to_messages(record: dict) -> list[dict]:
    """Normalize instruction/input/output or messages format → chat messages."""
    if "messages" in record:
        return record["messages"]
    parts = []
    instruction = record.get("instruction", "")
    inp = record.get("input", "")
    prompt = f"{instruction}\n\n{inp}".strip() if inp else instruction
    if prompt:
        parts.append({"role": "user", "content": prompt})
    output = record.get("output") or record.get("response") or record.get("text", "")
    if output:
        parts.append({"role": "assistant", "content": output})
    return parts


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True, help="Base model path or HF repo")
    p.add_argument("--data", required=True, help="Train JSONL path")
    p.add_argument("--output", default="/workspace/checkpoints")
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--batch", type=int, default=2)
    p.add_argument("--grad-accum", type=int, default=4)
    p.add_argument("--max-len", type=int, default=2048)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--lora-dropout", type=float, default=0.05)
    p.add_argument("--load-in-4bit", action="store_true", default=True)
    p.add_argument("--load-in-8bit", action="store_true", default=False)
    p.add_argument("--save-steps", type=int, default=200)
    p.add_argument("--warmup-ratio", type=float, default=0.03)
    args = p.parse_args()

    print(f"Model: {args.model}")
    print(f"Data:  {args.data}")
    print(f"Output: {args.output}")

    # ── Quantization ──────────────────────────────────────────────────────────
    bnb_config = None
    if args.load_in_4bit and not args.load_in_8bit:
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
            bnb_4bit_quant_type="nf4",
        )
        print("QLoRA: 4-bit NF4")
    elif args.load_in_8bit:
        bnb_config = BitsAndBytesConfig(load_in_8bit=True)
        print("LoRA: 8-bit")
    else:
        print("LoRA: full precision")

    # ── Tokenizer ────────────────────────────────────────────────────────────
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    tokenizer.padding_side = "right"
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # ── Model ────────────────────────────────────────────────────────────────
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
        torch_dtype=torch.bfloat16 if not bnb_config else None,
    )
    model.config.use_cache = False

    if bnb_config:
        model = prepare_model_for_kbit_training(model)

    # ── LoRA ─────────────────────────────────────────────────────────────────
    # Target all linear layers (works for LLaMA, Mistral, Qwen)
    target_modules = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        target_modules=target_modules,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type=TaskType.CAUSAL_LM,
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    # ── Dataset ───────────────────────────────────────────────────────────────
    records = load_jsonl(args.data)
    print(f"Loaded {len(records)} samples")

    def format_sample(record):
        messages = to_messages(record)
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
        return {"text": text}

    ds = Dataset.from_list([format_sample(r) for r in records])

    # ── Training ──────────────────────────────────────────────────────────────
    total_steps = math.ceil(len(ds) / (args.batch * args.grad_accum)) * args.epochs
    print(f"Total steps: {total_steps}")

    training_args = TrainingArguments(
        output_dir=args.output,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=args.warmup_ratio,
        fp16=not torch.cuda.is_bf16_supported(),
        bf16=torch.cuda.is_bf16_supported(),
        logging_steps=10,
        save_steps=args.save_steps,
        save_total_limit=3,
        optim="paged_adamw_32bit" if bnb_config else "adamw_torch",
        report_to="none",
        dataloader_num_workers=2,
        remove_unused_columns=True,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        args=training_args,
        train_dataset=ds,
        dataset_text_field="text",
        max_seq_length=args.max_len,
        packing=True,
    )

    trainer.train()
    trainer.save_model(args.output)
    tokenizer.save_pretrained(args.output)
    print(f"Done. Saved to {args.output}")


if __name__ == "__main__":
    main()
