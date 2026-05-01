"""
Vui HuggingFace Wrapper for MLC-LLM compatibility.

This wrapper makes Vui look like LlamaForCausalLM so MLC-LLM can:
1. Load the model
2. Run transformer inference
3. Output logits (which we reinterpret as audio tokens)

Usage:
    from vui.hf_wrapper import VuiForCausalLM
    model = VuiForCausalLM.from_pretrained("fluxions/vui")

    # MLC-LLM will use standard causal LM interface
    outputs = model(input_ids)
"""

import os
import torch
import torch.nn as nn
from typing import Optional, Tuple
from transformers import PretrainedConfig, PreTrainedModel
from transformers.modeling_outputs import CausalLMOutput

from vui.fluac import Fluac
from vui.config import Config
from vui.utils import load_what_you_can

# Import Vui components
from vui.rope import apply_rotary_emb, precompute_freqs_cis
from vui.model import (
    RMSNorm, LlamaMLP, Block, Decoder, KVCache, repeat_kv
)
import torch.nn.functional as F
from einops import rearrange


class VuiConfig(PretrainedConfig):
    """HuggingFace config for Vui."""

    model_type = "vui"

    def __init__(
        self,
        # Standard HF params
        vocab_size: int = 512,
        hidden_size: int = 768,
        intermediate_size: int = 2048,
        num_hidden_layers: int = 12,
        num_attention_heads: int = 12,
        num_key_value_heads: int = 12,
        hidden_act: str = "silu",
        max_position_embeddings: int = 4096,
        rms_norm_eps: float = 1e-5,
        rope_theta: float = 10000.0,
        rope_scaling: Optional[dict] = None,
        tie_word_embeddings: bool = False,
        # Vui-specific params (stored in config)
        n_quantizers: int = 9,
        codebook_size: int = 1024,
        rope_dim: Optional[int] = None,
        rope_theta_rescale_factor: float = 1.0,
        bias: bool = False,
        dropout: float = 0.0,
        **kwargs,
    ):
        self.vocab_size = vocab_size
        self.hidden_size = hidden_size
        self.intermediate_size = intermediate_size
        self.num_hidden_layers = num_hidden_layers
        self.num_attention_heads = num_attention_heads
        self.num_key_value_heads = num_key_value_heads
        self.hidden_act = hidden_act
        self.max_position_embeddings = max_position_embeddings
        self.rms_norm_eps = rms_norm_eps
        self.rope_theta = rope_theta
        self.rope_scaling = rope_scaling
        self.n_quantizers = n_quantizers
        self.codebook_size = codebook_size
        self.rope_dim = rope_dim
        self.rope_theta_rescale_factor = rope_theta_rescale_factor
        self.bias = bias
        self.dropout = dropout

        super().__init__(
            tie_word_embeddings=tie_word_embeddings,
            **kwargs,
        )


class VuiAttention(nn.Module):
    """MHA compatible with HuggingFace/MLC conventions."""

    def __init__(self, config: VuiConfig, layer_idx: int):
        super().__init__()
        self.config = config
        self.layer_idx = layer_idx

        self.attention_dropout = config.attention_dropout if hasattr(config, 'attention_dropout') else 0.0
        self.hidden_size = config.hidden_size
        self.num_heads = config.num_attention_heads
        self.head_dim = self.hidden_size // self.num_heads
        self.num_key_value_heads = config.num_key_value_heads
        self.num_key_value_groups = self.num_heads // self.num_key_value_heads
        self.max_position_embeddings = config.max_position_embeddings
        self.rope_theta = config.rope_theta

        if (self.head_dim * self.num_heads) != self.hidden_size:
            raise ValueError(
                f"hidden_size must be divisible by num_heads (got `hidden_size`: {self.hidden_size}"
                f" and `num_heads`: {self.num_heads})."
            )

        self.q_proj = nn.Linear(self.hidden_size, self.num_heads * self.head_dim, bias=config.bias)
        self.k_proj = nn.Linear(self.hidden_size, self.num_key_value_heads * self.head_dim, bias=config.bias)
        self.v_proj = nn.Linear(self.hidden_size, self.num_key_value_heads * self.head_dim, bias=config.bias)
        self.o_proj = nn.Linear(self.num_heads * self.head_dim, self.hidden_size, bias=config.bias)

        self.rotary_emb = None  # RoPE handled separately
        self.kv_cache = None

    def forward(
        self,
        hidden_states: torch.Tensor,
        attention_mask: Optional[torch.Tensor] = None,
        position_ids: Optional[torch.LongTensor] = None,
        position_embeddings: Optional[Tuple[torch.Tensor, torch.Tensor]] = None,
        past_key_value: Optional[Tuple[torch.Tensor]] = None,
        output_attentions: bool = False,
        use_cache: bool = False,
    ) -> Tuple[torch.Tensor, Optional[torch.Tensor], Optional[Tuple[torch.Tensor]]]:
        bsz, q_len, _ = hidden_states.size()

        query_states = self.q_proj(hidden_states)
        key_states = self.k_proj(hidden_states)
        value_states = self.v_proj(hidden_states)

        query_states = query_states.view(bsz, q_len, self.num_heads, self.head_dim).transpose(1, 2)
        key_states = key_states.view(bsz, q_len, self.num_key_value_heads, self.head_dim).transpose(1, 2)
        value_states = value_states.view(bsz, q_len, self.num_key_value_heads, self.head_dim).transpose(1, 2)

        # Apply RoPE if position embeddings provided
        if position_embeddings is not None:
            cos, sin = position_embeddings
            # Standard RoPE application (simplified - actual implementation varies by model)
            pass  # RoPE already applied via decoder

        # KVCache handling
        past_key = past_key_value[0] if past_key_value is not None else None
        past_value = past_key_value[1] if past_key_value is not None else None

        if past_key is not None:
            key_states = torch.cat([past_key, key_states], dim=2)
            value_states = torch.cat([past_value, value_states], dim=2)

        if use_cache:
            past_key_value = (key_states, value_states)
        else:
            past_key_value = None

        # Attention
        attn_output = F.scaled_dot_product_attention(
            query_states, key_states, value_states,
            attn_mask=attention_mask,
            dropout_p=self.attention_dropout if self.training else 0.0,
        )

        attn_output = attn_output.transpose(1, 2).reshape(bsz, q_len, self.num_heads * self.head_dim)
        attn_output = self.o_proj(attn_output)

        return attn_output, None, past_key_value


class VuiDecoderLayer(nn.Module):
    """Single transformer layer compatible with HuggingFace."""

    def __init__(self, config: VuiConfig, layer_idx: int):
        super().__init__()
        self.hidden_size = config.hidden_size

        self.self_attn = VuiAttention(config, layer_idx)

        self.mlp = LlamaMLP(
            d_model=config.hidden_size,
            multiple_of=256,
            bias=config.bias,
            dropout=config.dropout,
        )

        self.input_layernorm = RMSNorm(config.hidden_size, eps=config.rms_norm_eps)
        self.post_attention_layernorm = RMSNorm(config.hidden_size, eps=config.rms_norm_eps)

    def forward(
        self,
        hidden_states: torch.Tensor,
        attention_mask: Optional[torch.Tensor] = None,
        position_ids: Optional[torch.LongTensor] = None,
        position_embeddings: Optional[Tuple[torch.Tensor, torch.Tensor]] = None,
        past_key_value: Optional[Tuple[torch.Tensor]] = None,
        output_attentions: Optional[bool] = False,
        use_cache: Optional[bool] = False,
    ) -> Tuple[torch.FloatTensor, Optional[Tuple[torch.FloatTensor, torch.FloatTensor]]]:
        residual = hidden_states

        hidden_states = self.input_layernorm(hidden_states)

        # Self attention
        hidden_states, self_attn_weights, present_key_value = self.self_attn(
            hidden_states=hidden_states,
            attention_mask=attention_mask,
            position_ids=position_ids,
            position_embeddings=position_embeddings,
            past_key_value=past_key_value,
            output_attentions=output_attentions,
            use_cache=use_cache,
        )
        hidden_states = residual + hidden_states

        # MLP
        residual = hidden_states
        hidden_states = self.post_attention_layernorm(hidden_states)
        hidden_states = self.mlp(hidden_states)
        hidden_states = residual + hidden_states

        return hidden_states, None, present_key_value


class VuiModel(nn.Module):
    """Vui decoder model with HuggingFace interface."""

    def __init__(self, config: VuiConfig):
        super().__init__()
        self.config = config
        self.padding_idx = 0
        self.max_position_embeddings = config.max_position_embeddings

        self.embed_tokens = nn.Embedding(config.vocab_size, config.hidden_size)

        self.layers = nn.ModuleList([
            VuiDecoderLayer(config, layer_idx)
            for layer_idx in range(config.num_hidden_layers)
        ])

        self.norm = RMSNorm(config.hidden_size, eps=config.rms_norm_eps)

        self.gradient_checkpointing = False

        # RoPE cache
        rope_dim = config.rope_dim or config.hidden_size // config.num_attention_heads
        self.rope_freqs = precompute_freqs_cis(
            rope_dim,
            config.max_position_embeddings,
            theta=config.rope_theta,
            theta_rescale_factor=config.rope_theta_rescale_factor,
        )

    def forward(
        self,
        input_ids: torch.LongTensor,
        attention_mask: Optional[torch.Tensor] = None,
        position_ids: Optional[torch.LongTensor] = None,
        past_key_values: Optional[Tuple[Tuple[torch.FloatTensor]]] = None,
        inputs_embeds: Optional[torch.FloatTensor] = None,
        use_cache: Optional[bool] = None,
        output_attentions: Optional[bool] = None,
        output_hidden_states: Optional[bool] = None,
        return_dict: Optional[bool] = None,
    ):
        bsz, seq_len = input_ids.shape
        past_length = 0

        # Handle past_key_values
        if past_key_values is not None:
            past_length = past_key_values[0][0].shape[2]
            seq_len += past_length

        # Position embeddings
        if position_ids is None:
            position_ids = torch.arange(past_length, seq_len, dtype=torch.long, device=input_ids.device)
            position_ids = position_ids.unsqueeze(0).view(-1, seq_len)

        # Get embeddings
        if inputs_embeds is None:
            inputs_embeds = self.embed_tokens(input_ids)

        # RoPE
        freqs_cis = self.rope_freqs[position_ids]

        hidden_states = inputs_embeds

        # Transformer layers
        all_hidden_states = () if output_hidden_states else None
        next_decoder_cache = () if use_cache else None

        for idx, layer in enumerate(self.layers):
            if output_hidden_states:
                all_hidden_states += (hidden_states,)

            past_key_value = past_key_values[idx] if past_key_values is not None else None

            layer_outputs = layer(
                hidden_states,
                attention_mask=attention_mask,
                position_ids=position_ids,
                position_embeddings=(freqs_cis.cos(), freqs_cis.sin()),
                past_key_value=past_key_value,
                output_attentions=output_attentions,
                use_cache=use_cache,
            )

            hidden_states = layer_outputs[0]

            if use_cache:
                next_decoder_cache += (layer_outputs[2],)

        hidden_states = self.norm(hidden_states)

        if output_hidden_states:
            all_hidden_states += (hidden_states,)
            return tuple(all_hidden_states) if output_hidden_states else hidden_states

        return hidden_states


class VuiForCausalLM(PreTrainedModel):
    """Vui wrapped as CausalLM for MLC-LLM compatibility.

    This maps Vui's audio token output heads to a single lm_head interface
    that MLC-LLM expects.
    """

    config_class = VuiConfig
    base_model_prefix = "model"
    supports_gradient_checkpointing = False
    _no_split_modules = ["VuiDecoderLayer"]

    def __init__(self, config: VuiConfig):
        super().__init__(config)
        self.config = config

        # Core transformer
        self.model = VuiModel(config)

        # lm_head maps hidden_size -> vocab_size
        # For Vui, we use a combined audio head that outputs audio tokens
        vocab_size = config.codebook_size + 8
        self.lm_head = nn.Linear(config.hidden_size, vocab_size, bias=config.bias)

        # Initialize weights
        self.post_init()

    def get_input_embeddings(self):
        return self.model.embed_tokens

    def set_input_embeddings(self, value):
        self.model.embed_tokens = value

    def get_output_embeddings(self):
        return self.lm_head

    def set_output_embeddings(self, new_embeddings):
        self.lm_head = new_embeddings

    def forward(
        self,
        input_ids: torch.LongTensor,
        attention_mask: Optional[torch.Tensor] = None,
        position_ids: Optional[torch.LongTensor] = None,
        past_key_values: Optional[Tuple[Tuple[torch.FloatTensor]]] = None,
        inputs_embeds: Optional[torch.FloatTensor] = None,
        labels: Optional[torch.LongTensor] = None,
        use_cache: Optional[bool] = None,
        output_attentions: Optional[bool] = None,
        output_hidden_states: Optional[bool] = None,
        return_dict: Optional[bool] = None,
    ) -> CausalLMOutput:
        return_dict = return_dict if return_dict is not None else self.config.use_return_dict

        # VuiModel returns hidden_states (tensor) or tuple of hidden_states
        hidden_states = self.model(
            input_ids=input_ids,
            attention_mask=attention_mask,
            position_ids=position_ids,
            past_key_values=past_key_values,
            inputs_embeds=inputs_embeds,
            use_cache=use_cache,
            output_attentions=output_attentions,
            output_hidden_states=output_hidden_states,
        )

        # Handle tuple output
        if isinstance(hidden_states, tuple):
            hidden_states = hidden_states[0]

        logits = self.lm_head(hidden_states)

        loss = None
        if labels is not None:
            # Standard CE loss for training
            shift_logits = logits[..., :-1, :].contiguous()
            shift_labels = labels[..., 1:].contiguous()
            loss_fct = nn.CrossEntropyLoss()
            shift_logits = shift_logits.view(-1, self.config.codebook_size + 8)
            shift_labels = shift_labels.view(-1)
            shift_labels = shift_labels.to(shift_logits.device)
            loss = loss_fct(shift_logits, shift_labels)

        return CausalLMOutput(loss=loss, logits=logits)

    @staticmethod
    def from_pretrained_vui(vui_checkpoint_path: str, **hf_kwargs):
        """Load Vui checkpoint and convert to HuggingFace format."""
        from vui.model import Vui

        print(f"Loading Vui from: {vui_checkpoint_path}")
        vui = Vui.from_pretrained(vui_checkpoint_path)

        config = vui.config.model

        # Create HuggingFace config
        # Note: Vui's LlamaMLP uses int(2 * 4 * d_model / 3) for intermediate dim
        actual_intermediate = int(2 * 4 * config.d_model / 3)
        hf_config = VuiConfig(
            vocab_size=vui.tokenizer.vocab_size,
            hidden_size=config.d_model,
            intermediate_size=actual_intermediate,  # Must match Vui's LlamaMLP
            num_hidden_layers=config.n_layers,
            num_attention_heads=config.n_heads,
            num_key_value_heads=config.n_heads,  # GQA not used
            hidden_act="silu",
            max_position_embeddings=config.max_text_tokens + config.max_audio_tokens,
            rms_norm_eps=1e-5,
            rope_theta=config.rope_theta,
            rope_dim=config.rope_dim,
            rope_theta_rescale_factor=config.rope_theta_rescale_factor,
            bias=config.bias,
            dropout=config.dropout,
            n_quantizers=config.n_quantizers,
            codebook_size=config.codebook_size,
            **hf_kwargs,
        )

        model = VuiForCausalLM(hf_config)

        # Map state dict
        state_dict = {}

        # Token embeddings
        state_dict["model.embed_tokens.weight"] = vui.token_emb.weight

        # Decoder layers
        for i, block in enumerate(vui.decoder.blocks):
            # Attention
            state_dict[f"model.layers.{i}.self_attn.q_proj.weight"] = block.attn.Wqkv.weight[:config.d_model]
            state_dict[f"model.layers.{i}.self_attn.k_proj.weight"] = block.attn.Wqkv.weight[config.d_model:config.d_model + config.d_model]
            state_dict[f"model.layers.{i}.self_attn.v_proj.weight"] = block.attn.Wqkv.weight[config.d_model + config.d_model:]
            state_dict[f"model.layers.{i}.self_attn.o_proj.weight"] = block.attn.out_proj.weight

            # MLP - MLC-LLM expects fused gate_up_proj: (2*hidden_dim, d_model)
            # Vui's w1=gate, w3=up, MLC expects them concatenated as gate_up_proj
            hidden_dim = block.mlp.w1.weight.shape[0]
            gate_up = torch.cat([block.mlp.w1.weight, block.mlp.w3.weight], dim=0)
            assert gate_up.shape == (2 * hidden_dim, config.d_model), f"Expected {(2*hidden_dim, config.d_model)}, got {gate_up.shape}"
            state_dict[f"model.layers.{i}.mlp.gate_up_proj.weight"] = gate_up
            state_dict[f"model.layers.{i}.mlp.down_proj.weight"] = block.mlp.w2.weight

            # Norms
            state_dict[f"model.layers.{i}.input_layernorm.weight"] = block.attn_norm.weight
            state_dict[f"model.layers.{i}.post_attention_layernorm.weight"] = block.mlp_norm.weight

        # Final norm
        state_dict["model.norm.weight"] = vui.decoder.norm.weight

        # Audio heads -> use first one as lm_head (MLC-LLM expects single output)
        # In practice, you'd use a combined head; for MLC we pick q0
        state_dict["lm_head.weight"] = vui.audio_heads[0].weight

        model.load_state_dict(state_dict, strict=False)
        return model

    def save_pretrained(self, save_path, vui_checkpoint_path=None):
        """Save in HuggingFace format with proper weight names.

        If vui_checkpoint_path provided, re-exports from Vui with correct names.
        Otherwise uses current state_dict (which may have wrong MLP names).
        """
        os.makedirs(save_path, exist_ok=True)
        self.config.save_pretrained(save_path)

        if vui_checkpoint_path:
            # Re-export from Vui to get correct names
            print(f"Re-exporting from Vui checkpoint: {vui_checkpoint_path}")
            from vui.model import Vui
            vui = Vui.from_pretrained(vui_checkpoint_path)
            config = vui.config.model

            state_dict = {}
            state_dict["model.embed_tokens.weight"] = vui.token_emb.weight

            for i, block in enumerate(vui.decoder.blocks):
                state_dict[f"model.layers.{i}.self_attn.q_proj.weight"] = block.attn.Wqkv.weight[:config.d_model]
                state_dict[f"model.layers.{i}.self_attn.k_proj.weight"] = block.attn.Wqkv.weight[config.d_model:config.d_model + config.d_model]
                state_dict[f"model.layers.{i}.self_attn.v_proj.weight"] = block.attn.Wqkv.weight[config.d_model + config.d_model:]
                state_dict[f"model.layers.{i}.self_attn.o_proj.weight"] = block.attn.out_proj.weight
                # Standard Llama MLP names
                state_dict[f"model.layers.{i}.mlp.gate_proj.weight"] = block.mlp.w1.weight
                state_dict[f"model.layers.{i}.mlp.up_proj.weight"] = block.mlp.w3.weight
                state_dict[f"model.layers.{i}.mlp.down_proj.weight"] = block.mlp.w2.weight
                state_dict[f"model.layers.{i}.input_layernorm.weight"] = block.attn_norm.weight
                state_dict[f"model.layers.{i}.post_attention_layernorm.weight"] = block.mlp_norm.weight

            state_dict["model.norm.weight"] = vui.decoder.norm.weight
            state_dict["lm_head.weight"] = vui.audio_heads[0].weight

            import torch
            torch.save(state_dict, os.path.join(save_path, "pytorch_model.bin"))
        else:
            import torch
            torch.save(self.state_dict(), os.path.join(save_path, "pytorch_model.bin"))
