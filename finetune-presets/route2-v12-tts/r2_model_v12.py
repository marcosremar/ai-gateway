"""Route-2 v12 PHONEME-conditioned Matcha OT-CFM TTS (self-contained).
Deps: torch, einops, numba. No diffusers / conformer / matcha package.
v12 change vs v11: input is PHONEME IDs [B, L] (Long) via nn.Embedding, NOT Tucano
hiddens [B,L,2048] via Conv1d. synthesise() also returns w_ceil (mel-frames/phoneme)
for lip-sync timing @ 93.75 Hz. in_dim arg now = phoneme vocab size.
"""
import math
import types
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from einops import pack, rearrange, repeat

try:
    from numba import njit, prange
    HAVE_NUMBA = True
except Exception:  # pragma: no cover
    HAVE_NUMBA = False


# ============================== utils ==============================
def sequence_mask(length, max_length=None):
    if max_length is None:
        max_length = int(length.max())
    x = torch.arange(max_length, dtype=length.dtype, device=length.device)
    return x.unsqueeze(0) < length.unsqueeze(1)  # [B, max_length] bool


def fix_len(x, factor=2):
    return int(factor * math.ceil(int(x) / factor))


def generate_path(duration, mask):
    """duration [B, t_x], mask [B, t_x, t_y] -> path [B, t_x, t_y]."""
    b, t_x, t_y = mask.shape
    cum = torch.cumsum(duration, 1)
    path = sequence_mask(cum.view(b * t_x), t_y).view(b, t_x, t_y).to(mask.dtype)
    path = path - F.pad(path, (0, 0, 1, 0, 0, 0))[:, :-1]
    return path * mask


# ============================== MAS (numba) ==============================
if HAVE_NUMBA:
    @njit
    def _mas_each(path, value, t_x, t_y, max_neg=-1e9):
        index = t_x - 1
        for y in range(t_y):
            for x in range(max(0, t_x + y - t_y), min(t_x, y + 1)):
                if x == y:
                    v_cur = max_neg
                else:
                    v_cur = value[x, y - 1]
                if x == 0:
                    v_prev = 0.0 if y == 0 else max_neg
                else:
                    v_prev = value[x - 1, y - 1]
                value[x, y] += max(v_prev, v_cur)
        for y in range(t_y - 1, -1, -1):
            path[index, y] = 1
            if index != 0 and (index == y or value[index, y - 1] < value[index - 1, y - 1]):
                index -= 1

    @njit(parallel=True)
    def _mas_c(paths, values, t_xs, t_ys):
        for i in prange(paths.shape[0]):
            _mas_each(paths[i], values[i], t_xs[i], t_ys[i])
else:  # pure-python fallback (slow; correctness-equivalent)
    def _mas_each(path, value, t_x, t_y, max_neg=-1e9):
        index = t_x - 1
        for y in range(t_y):
            for x in range(max(0, t_x + y - t_y), min(t_x, y + 1)):
                v_cur = max_neg if x == y else value[x, y - 1]
                if x == 0:
                    v_prev = 0.0 if y == 0 else max_neg
                else:
                    v_prev = value[x - 1, y - 1]
                value[x, y] += max(v_prev, v_cur)
        for y in range(t_y - 1, -1, -1):
            path[index, y] = 1
            if index != 0 and (index == y or value[index, y - 1] < value[index - 1, y - 1]):
                index -= 1

    def _mas_c(paths, values, t_xs, t_ys):
        for i in range(paths.shape[0]):
            _mas_each(paths[i], values[i], int(t_xs[i]), int(t_ys[i]))


def maximum_path(value, mask):
    """value,mask: [B, t_x, t_y] (torch). Returns hard monotonic alignment [B,t_x,t_y]."""
    device, dtype = value.device, value.dtype
    v = (value * mask).detach().cpu().numpy().astype(np.float32)
    path = np.zeros_like(v).astype(np.int32)
    m = mask.detach().cpu().numpy()
    t_x = m.sum(1)[:, 0].astype(np.int32)  # valid text len
    t_y = m.sum(2)[:, 0].astype(np.int32)  # valid mel len
    _mas_c(path, v, t_x, t_y)
    return torch.from_numpy(path).to(device=device, dtype=dtype)


# ============================== glow-tts encoder pieces (verbatim) ==============================
class LayerNorm(nn.Module):
    def __init__(self, channels, eps=1e-4):
        super().__init__()
        self.channels = channels
        self.eps = eps
        self.gamma = nn.Parameter(torch.ones(channels))
        self.beta = nn.Parameter(torch.zeros(channels))

    def forward(self, x):
        n_dims = len(x.shape)
        mean = torch.mean(x, 1, keepdim=True)
        variance = torch.mean((x - mean) ** 2, 1, keepdim=True)
        x = (x - mean) * torch.rsqrt(variance + self.eps)
        shape = [1, -1] + [1] * (n_dims - 2)
        return x * self.gamma.view(*shape) + self.beta.view(*shape)


class ConvReluNorm(nn.Module):
    def __init__(self, in_channels, hidden_channels, out_channels, kernel_size, n_layers, p_dropout):
        super().__init__()
        self.n_layers = n_layers
        self.conv_layers = nn.ModuleList()
        self.norm_layers = nn.ModuleList()
        self.conv_layers.append(nn.Conv1d(in_channels, hidden_channels, kernel_size, padding=kernel_size // 2))
        self.norm_layers.append(LayerNorm(hidden_channels))
        self.relu_drop = nn.Sequential(nn.ReLU(), nn.Dropout(p_dropout))
        for _ in range(n_layers - 1):
            self.conv_layers.append(nn.Conv1d(hidden_channels, hidden_channels, kernel_size, padding=kernel_size // 2))
            self.norm_layers.append(LayerNorm(hidden_channels))
        self.proj = nn.Conv1d(hidden_channels, out_channels, 1)
        self.proj.weight.data.zero_()
        self.proj.bias.data.zero_()

    def forward(self, x, x_mask):
        x_org = x
        for i in range(self.n_layers):
            x = self.conv_layers[i](x * x_mask)
            x = self.norm_layers[i](x)
            x = self.relu_drop(x)
        x = x_org + self.proj(x)
        return x * x_mask


class DurationPredictor(nn.Module):
    def __init__(self, in_channels, filter_channels, kernel_size, p_dropout):
        super().__init__()
        self.drop = nn.Dropout(p_dropout)
        self.conv_1 = nn.Conv1d(in_channels, filter_channels, kernel_size, padding=kernel_size // 2)
        self.norm_1 = LayerNorm(filter_channels)
        self.conv_2 = nn.Conv1d(filter_channels, filter_channels, kernel_size, padding=kernel_size // 2)
        self.norm_2 = LayerNorm(filter_channels)
        self.proj = nn.Conv1d(filter_channels, 1, 1)

    def forward(self, x, x_mask):
        x = self.conv_1(x * x_mask)
        x = torch.relu(x)
        x = self.norm_1(x)
        x = self.drop(x)
        x = self.conv_2(x * x_mask)
        x = torch.relu(x)
        x = self.norm_2(x)
        x = self.drop(x)
        x = self.proj(x * x_mask)
        return x * x_mask


class RotaryPositionalEmbeddings(nn.Module):
    def __init__(self, d, base=10_000):
        super().__init__()
        self.base = base
        self.d = int(d)
        self.cos_cached = None
        self.sin_cached = None

    def _build_cache(self, x):
        if self.cos_cached is not None and x.shape[0] <= self.cos_cached.shape[0]:
            return
        seq_len = x.shape[0]
        theta = 1.0 / (self.base ** (torch.arange(0, self.d, 2).float() / self.d)).to(x.device)
        seq_idx = torch.arange(seq_len, device=x.device).float()
        idx_theta = torch.einsum("n,d->nd", seq_idx, theta)
        idx_theta2 = torch.cat([idx_theta, idx_theta], dim=1)
        self.cos_cached = idx_theta2.cos()[:, None, None, :]
        self.sin_cached = idx_theta2.sin()[:, None, None, :]

    def _neg_half(self, x):
        d_2 = self.d // 2
        return torch.cat([-x[:, :, :, d_2:], x[:, :, :, :d_2]], dim=-1)

    def forward(self, x):
        x = rearrange(x, "b h t d -> t b h d")
        self._build_cache(x)
        x_rope, x_pass = x[..., : self.d], x[..., self.d:]
        neg = self._neg_half(x_rope)
        x_rope = (x_rope * self.cos_cached[: x.shape[0]]) + (neg * self.sin_cached[: x.shape[0]])
        return rearrange(torch.cat((x_rope, x_pass), dim=-1), "t b h d -> b h t d")


class MultiHeadAttention(nn.Module):
    def __init__(self, channels, out_channels, n_heads, p_dropout=0.0):
        super().__init__()
        assert channels % n_heads == 0
        self.channels = channels
        self.n_heads = n_heads
        self.k_channels = channels // n_heads
        self.conv_q = nn.Conv1d(channels, channels, 1)
        self.conv_k = nn.Conv1d(channels, channels, 1)
        self.conv_v = nn.Conv1d(channels, channels, 1)
        self.query_rotary_pe = RotaryPositionalEmbeddings(self.k_channels * 0.5)
        self.key_rotary_pe = RotaryPositionalEmbeddings(self.k_channels * 0.5)
        self.conv_o = nn.Conv1d(channels, out_channels, 1)
        self.drop = nn.Dropout(p_dropout)
        nn.init.xavier_uniform_(self.conv_q.weight)
        nn.init.xavier_uniform_(self.conv_k.weight)
        nn.init.xavier_uniform_(self.conv_v.weight)

    def forward(self, x, c, attn_mask=None):
        q = self.conv_q(x)
        k = self.conv_k(c)
        v = self.conv_v(c)
        x, _ = self._attn(q, k, v, mask=attn_mask)
        return self.conv_o(x)

    def _attn(self, query, key, value, mask=None):
        b, d, t_s, t_t = (*key.size(), query.size(2))
        query = rearrange(query, "b (h c) t-> b h t c", h=self.n_heads)
        key = rearrange(key, "b (h c) t-> b h t c", h=self.n_heads)
        value = rearrange(value, "b (h c) t-> b h t c", h=self.n_heads)
        query = self.query_rotary_pe(query)
        key = self.key_rotary_pe(key)
        scores = torch.matmul(query, key.transpose(-2, -1)) / math.sqrt(self.k_channels)
        if mask is not None:
            scores = scores.masked_fill(mask == 0, -1e4)
        p_attn = F.softmax(scores, dim=-1)
        p_attn = self.drop(p_attn)
        output = torch.matmul(p_attn, value)
        output = output.transpose(2, 3).contiguous().view(b, d, t_t)
        return output, p_attn


class FFN(nn.Module):
    def __init__(self, in_channels, out_channels, filter_channels, kernel_size, p_dropout=0.0):
        super().__init__()
        self.conv_1 = nn.Conv1d(in_channels, filter_channels, kernel_size, padding=kernel_size // 2)
        self.conv_2 = nn.Conv1d(filter_channels, out_channels, kernel_size, padding=kernel_size // 2)
        self.drop = nn.Dropout(p_dropout)

    def forward(self, x, x_mask):
        x = self.conv_1(x * x_mask)
        x = torch.relu(x)
        x = self.drop(x)
        x = self.conv_2(x * x_mask)
        return x * x_mask


class Encoder(nn.Module):
    def __init__(self, hidden_channels, filter_channels, n_heads, n_layers, kernel_size=1, p_dropout=0.0):
        super().__init__()
        self.n_layers = n_layers
        self.drop = nn.Dropout(p_dropout)
        self.attn_layers = nn.ModuleList()
        self.norm_layers_1 = nn.ModuleList()
        self.ffn_layers = nn.ModuleList()
        self.norm_layers_2 = nn.ModuleList()
        for _ in range(n_layers):
            self.attn_layers.append(MultiHeadAttention(hidden_channels, hidden_channels, n_heads, p_dropout=p_dropout))
            self.norm_layers_1.append(LayerNorm(hidden_channels))
            self.ffn_layers.append(FFN(hidden_channels, hidden_channels, filter_channels, kernel_size, p_dropout=p_dropout))
            self.norm_layers_2.append(LayerNorm(hidden_channels))

    def forward(self, x, x_mask):
        attn_mask = x_mask.unsqueeze(2) * x_mask.unsqueeze(-1)
        for i in range(self.n_layers):
            x = x * x_mask
            y = self.attn_layers[i](x, x, attn_mask)
            y = self.drop(y)
            x = self.norm_layers_1[i](x + y)
            y = self.ffn_layers[i](x, x_mask)
            y = self.drop(y)
            x = self.norm_layers_2[i](x + y)
        return x * x_mask


# ============================== Tucano text encoder ==============================
class TucanoTextEncoder(nn.Module):
    def __init__(self, in_dim=2048, n_channels=192, filter_channels=768, n_heads=2, n_layers=6,
                 kernel_size=3, p_dropout=0.1, n_feats=100, dp_filter=256, dp_kernel=3, dp_dropout=0.1, prenet=True):
        super().__init__()
        self.n_feats = n_feats
        self.n_channels = n_channels
        # v12: in_dim is now the PHONEME VOCAB SIZE (n_phonemes incl pad=0); input = Long IDs [B,L]
        self.in_proj = nn.Embedding(in_dim, n_channels, padding_idx=0)
        self.prenet = ConvReluNorm(n_channels, n_channels, n_channels, 5, 3, 0.5) if prenet else None
        self.encoder = Encoder(n_channels, filter_channels, n_heads, n_layers, kernel_size, p_dropout)
        self.proj_m = nn.Conv1d(n_channels, n_feats, 1)
        self.proj_w = DurationPredictor(n_channels, dp_filter, dp_kernel, dp_dropout)

    def forward(self, x, x_lengths):
        # v12: x is [B, L] LongTensor of phoneme IDs; x_lengths: [B]
        x_mask = sequence_mask(x_lengths, x.size(1)).unsqueeze(1).to(torch.float32)  # [B,1,L]
        x = self.in_proj(x).transpose(1, 2)  # [B,L] -> [B,L,C] -> [B,C,L]
        x = x * x_mask
        if self.prenet is not None:
            x = self.prenet(x, x_mask)
        x = self.encoder(x, x_mask)
        mu = self.proj_m(x) * x_mask
        logw = self.proj_w(torch.detach(x), x_mask)
        return mu, logw, x_mask


# ============================== CFM estimator U-Net ==============================
class SinusoidalPosEmb(nn.Module):
    def __init__(self, dim):
        super().__init__()
        assert dim % 2 == 0
        self.dim = dim

    def forward(self, x, scale=1000):
        if x.ndim < 1:
            x = x.unsqueeze(0)
        half = self.dim // 2
        emb = math.log(10000) / (half - 1)
        emb = torch.exp(torch.arange(half, device=x.device).float() * -emb)
        emb = scale * x.unsqueeze(1) * emb.unsqueeze(0)
        return torch.cat((emb.sin(), emb.cos()), dim=-1)


class Block1D(nn.Module):
    def __init__(self, dim, dim_out, groups=8):
        super().__init__()
        self.block = nn.Sequential(nn.Conv1d(dim, dim_out, 3, padding=1), nn.GroupNorm(groups, dim_out), nn.Mish())

    def forward(self, x, mask):
        return self.block(x * mask) * mask


class ResnetBlock1D(nn.Module):
    def __init__(self, dim, dim_out, time_emb_dim, groups=8):
        super().__init__()
        self.mlp = nn.Sequential(nn.Mish(), nn.Linear(time_emb_dim, dim_out))
        self.block1 = Block1D(dim, dim_out, groups=groups)
        self.block2 = Block1D(dim_out, dim_out, groups=groups)
        self.res_conv = nn.Conv1d(dim, dim_out, 1)

    def forward(self, x, mask, time_emb):
        h = self.block1(x, mask)
        h = h + self.mlp(time_emb).unsqueeze(-1)
        h = self.block2(h, mask)
        return h + self.res_conv(x * mask)


class Downsample1D(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.conv = nn.Conv1d(dim, dim, 3, 2, 1)

    def forward(self, x):
        return self.conv(x)


class Upsample1D(nn.Module):
    def __init__(self, channels, out_channels=None):
        super().__init__()
        self.channels = channels
        self.conv = nn.ConvTranspose1d(channels, out_channels or channels, 4, 2, 1)

    def forward(self, x):
        return self.conv(x)


class TimestepEmbedding(nn.Module):
    def __init__(self, in_channels, time_embed_dim, out_dim=None):
        super().__init__()
        self.linear_1 = nn.Linear(in_channels, time_embed_dim)
        self.act = nn.SiLU()
        self.linear_2 = nn.Linear(time_embed_dim, out_dim or time_embed_dim)

    def forward(self, sample):
        return self.linear_2(self.act(self.linear_1(sample)))


class SelfAttnBlock(nn.Module):
    """Pre-LN transformer self-attn over time. Operates on [B,T,C]; mask [B,T] (1=valid)."""
    def __init__(self, dim, num_heads, head_dim, dropout=0.0):
        super().__init__()
        assert dim % num_heads == 0, (dim, num_heads)
        self.norm1 = nn.LayerNorm(dim)
        self.attn = nn.MultiheadAttention(dim, num_heads, dropout=dropout, batch_first=True)
        self.norm2 = nn.LayerNorm(dim)
        self.ff = nn.Sequential(nn.Linear(dim, dim * 4), nn.GELU(), nn.Dropout(dropout), nn.Linear(dim * 4, dim))

    def forward(self, hidden_states, attention_mask=None, timestep=None):  # timestep unused (layer_norm)
        kpm = None
        if attention_mask is not None:
            kpm = ~attention_mask.bool()  # True => ignore
        h = self.norm1(hidden_states)
        a, _ = self.attn(h, h, h, key_padding_mask=kpm, need_weights=False)
        hidden_states = hidden_states + a
        hidden_states = hidden_states + self.ff(self.norm2(hidden_states))
        return hidden_states


class Decoder(nn.Module):
    def __init__(self, in_channels, out_channels, channels=(256, 256), dropout=0.05,
                 attention_head_dim=64, n_blocks=1, num_mid_blocks=2, num_heads=4):
        super().__init__()
        channels = tuple(channels)
        self.in_channels = in_channels
        self.out_channels = out_channels
        self.time_embeddings = SinusoidalPosEmb(in_channels)
        time_embed_dim = channels[0] * 4
        self.time_mlp = TimestepEmbedding(in_channels, time_embed_dim)

        self.down_blocks = nn.ModuleList([])
        self.mid_blocks = nn.ModuleList([])
        self.up_blocks = nn.ModuleList([])

        output_channel = in_channels
        for i in range(len(channels)):
            input_channel = output_channel
            output_channel = channels[i]
            is_last = i == len(channels) - 1
            resnet = ResnetBlock1D(input_channel, output_channel, time_embed_dim)
            tb = nn.ModuleList([self._block(output_channel, attention_head_dim, num_heads, dropout) for _ in range(n_blocks)])
            ds = Downsample1D(output_channel) if not is_last else nn.Conv1d(output_channel, output_channel, 3, padding=1)
            self.down_blocks.append(nn.ModuleList([resnet, tb, ds]))

        for _ in range(num_mid_blocks):
            input_channel = channels[-1]
            resnet = ResnetBlock1D(input_channel, output_channel, time_embed_dim)
            tb = nn.ModuleList([self._block(output_channel, attention_head_dim, num_heads, dropout) for _ in range(n_blocks)])
            self.mid_blocks.append(nn.ModuleList([resnet, tb]))

        channels = channels[::-1] + (channels[0],)
        for i in range(len(channels) - 1):
            input_channel = channels[i]
            output_channel = channels[i + 1]
            is_last = i == len(channels) - 2
            resnet = ResnetBlock1D(2 * input_channel, output_channel, time_embed_dim)
            tb = nn.ModuleList([self._block(output_channel, attention_head_dim, num_heads, dropout) for _ in range(n_blocks)])
            up = Upsample1D(output_channel) if not is_last else nn.Conv1d(output_channel, output_channel, 3, padding=1)
            self.up_blocks.append(nn.ModuleList([resnet, tb, up]))

        self.final_block = Block1D(channels[-1], channels[-1])
        self.final_proj = nn.Conv1d(channels[-1], out_channels, 1)
        self._init()

    @staticmethod
    def _block(dim, head_dim, num_heads, dropout):
        return SelfAttnBlock(dim, num_heads, head_dim, dropout)

    def _init(self):
        for m in self.modules():
            if isinstance(m, nn.Conv1d):
                nn.init.kaiming_normal_(m.weight, nonlinearity="relu")
                if m.bias is not None:
                    nn.init.constant_(m.bias, 0)
            elif isinstance(m, nn.GroupNorm):
                nn.init.constant_(m.weight, 1)
                nn.init.constant_(m.bias, 0)

    def forward(self, x, mask, mu, t, spks=None, cond=None):
        t = self.time_embeddings(t)
        t = self.time_mlp(t)
        x = pack([x, mu], "b * t")[0]

        hiddens = []
        masks = [mask]
        for resnet, tb, downsample in self.down_blocks:
            mask_down = masks[-1]
            x = resnet(x, mask_down, t)
            x = rearrange(x, "b c t -> b t c")
            md = rearrange(mask_down, "b 1 t -> b t")
            for blk in tb:
                x = blk(hidden_states=x, attention_mask=md, timestep=t)
            x = rearrange(x, "b t c -> b c t")
            hiddens.append(x)
            x = downsample(x * mask_down)
            masks.append(mask_down[:, :, ::2])

        masks = masks[:-1]
        mask_mid = masks[-1]
        for resnet, tb in self.mid_blocks:
            x = resnet(x, mask_mid, t)
            x = rearrange(x, "b c t -> b t c")
            md = rearrange(mask_mid, "b 1 t -> b t")
            for blk in tb:
                x = blk(hidden_states=x, attention_mask=md, timestep=t)
            x = rearrange(x, "b t c -> b c t")

        for resnet, tb, upsample in self.up_blocks:
            mask_up = masks.pop()
            x = resnet(pack([x, hiddens.pop()], "b * t")[0], mask_up, t)
            x = rearrange(x, "b c t -> b t c")
            md = rearrange(mask_up, "b 1 t -> b t")
            for blk in tb:
                x = blk(hidden_states=x, attention_mask=md, timestep=t)
            x = rearrange(x, "b t c -> b c t")
            x = upsample(x * mask_up)

        x = self.final_block(x, mask_up)
        out = self.final_proj(x * mask_up)
        return out * mask


# ============================== CFM (OT-CFM, verbatim flow_matching.py) ==============================
class CFM(nn.Module):
    def __init__(self, in_channels, out_channel, cfm_params, decoder_params):
        super().__init__()
        self.n_feats = in_channels
        self.solver = cfm_params.solver
        self.sigma_min = getattr(cfm_params, "sigma_min", 1e-4)
        self.estimator = Decoder(in_channels=in_channels, out_channels=out_channel, **decoder_params)

    @torch.inference_mode()
    def forward(self, mu, mask, n_timesteps, temperature=1.0, spks=None, cond=None):
        z = torch.randn_like(mu) * temperature
        t_span = torch.linspace(0, 1, n_timesteps + 1, device=mu.device)
        return self.solve_euler(z, t_span=t_span, mu=mu, mask=mask, spks=spks, cond=cond)

    def solve_euler(self, x, t_span, mu, mask, spks, cond):
        t, _, dt = t_span[0], t_span[-1], t_span[1] - t_span[0]
        sol = []
        for step in range(1, len(t_span)):
            dphi_dt = self.estimator(x, mask, mu, t, spks, cond)
            x = x + dt * dphi_dt
            t = t + dt
            sol.append(x)
            if step < len(t_span) - 1:
                dt = t_span[step + 1] - t
        return sol[-1]

    def compute_loss(self, x1, mask, mu, spks=None, cond=None):
        b, _, t = mu.shape
        t = torch.rand([b, 1, 1], device=mu.device, dtype=mu.dtype)
        z = torch.randn_like(x1)
        y = (1 - (1 - self.sigma_min) * t) * z + t * x1
        u = x1 - (1 - self.sigma_min) * z
        loss = F.mse_loss(self.estimator(y, mask, mu, t.squeeze(), spks), u, reduction="sum") / (
            torch.sum(mask) * u.shape[1]
        )
        return loss, y


# ============================== top-level TTS ==============================
class TucanoMatchaTTS(nn.Module):
    def __init__(self, in_dim=2048, n_feats=100, enc=None, dec=None, cfm=None):
        super().__init__()
        enc = enc or {}
        dec = dec or dict(channels=(256, 256), dropout=0.05, attention_head_dim=64,
                          n_blocks=1, num_mid_blocks=2, num_heads=4)
        cfm = cfm or types.SimpleNamespace(solver="euler", sigma_min=1e-4)
        self.n_feats = n_feats
        self.encoder = TucanoTextEncoder(in_dim=in_dim, n_feats=n_feats, **enc)
        self.decoder = CFM(in_channels=2 * n_feats, out_channel=n_feats, cfm_params=cfm, decoder_params=dec)

    def forward(self, x, x_lengths, y, y_lengths):
        # v12: x: [B, L] Long phoneme IDs; y: [B, n_feats, T] (T even)
        mu_x, logw, x_mask = self.encoder(x, x_lengths)
        y_mask = sequence_mask(y_lengths, y.size(2)).unsqueeze(1).to(y.dtype)  # [B,1,T]
        attn_mask = x_mask.unsqueeze(-1) * y_mask.unsqueeze(2)  # [B,1,L,T]

        with torch.no_grad():
            const = -0.5 * math.log(2 * math.pi) * self.n_feats
            factor = -0.5 * torch.ones_like(mu_x)  # 1/var, var=1
            y_square = torch.matmul(factor.transpose(1, 2), y ** 2)           # [B,L,T]
            y_mu = torch.matmul((2.0 * (factor * mu_x)).transpose(1, 2), y)   # [B,L,T]
            mu_sq = torch.sum(factor * (mu_x ** 2), 1).unsqueeze(-1)          # [B,L,1]
            log_prior = y_square - y_mu + mu_sq + const                       # [B,L,T]
            attn = maximum_path(log_prior, attn_mask.squeeze(1))              # [B,L,T]

        dur = attn.sum(2)                                                     # [B,L]
        logw_ = torch.log(1e-8 + dur).unsqueeze(1) * x_mask                   # [B,1,L]
        dur_loss = F.mse_loss(logw, logw_, reduction="sum") / torch.sum(x_lengths)

        mu_y = torch.matmul(attn.transpose(1, 2), mu_x.transpose(1, 2)).transpose(1, 2)  # [B,F,T]
        prior_loss = torch.sum(0.5 * ((y - mu_y) ** 2 + math.log(2 * math.pi)) * y_mask) / (
            torch.sum(y_mask) * self.n_feats
        )
        diff_loss, _ = self.decoder.compute_loss(x1=y, mask=y_mask, mu=mu_y)
        return dur_loss, prior_loss, diff_loss, attn

    @torch.inference_mode()
    def synthesise(self, x, x_lengths, n_timesteps=10, temperature=1.0, length_scale=1.0):
        mu_x, logw, x_mask = self.encoder(x, x_lengths)
        w = torch.exp(logw) * x_mask
        w_ceil = torch.ceil(w) * length_scale
        y_lengths = torch.clamp_min(torch.sum(w_ceil, (1, 2)), 1).long()
        y_max = fix_len(int(y_lengths.max()), 2)
        y_mask = sequence_mask(y_lengths, y_max).unsqueeze(1).to(torch.float32)
        attn_mask = x_mask.unsqueeze(-1) * y_mask.unsqueeze(2)
        attn = generate_path(w_ceil.squeeze(1), attn_mask.squeeze(1))  # [B,L,T]
        mu_y = torch.matmul(attn.transpose(1, 2), mu_x.transpose(1, 2)).transpose(1, 2)  # [B,F,T]
        out = self.decoder(mu_y, y_mask, n_timesteps, temperature)
        # v12: also return w_ceil [B,L] = #mel-frames per phoneme -> lip-sync timing @ 93.75 Hz
        return out * y_mask, y_lengths, w_ceil.squeeze(1)


if __name__ == "__main__":
    torch.manual_seed(0)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print("numba:", HAVE_NUMBA, "device:", dev)
    N_PHON = 80  # smoke phoneme vocab size (real run: from espeak-ng pt-br coverage)
    m = TucanoMatchaTTS(in_dim=N_PHON).to(dev)
    n_params = sum(p.numel() for p in m.parameters())
    print(f"params={n_params/1e6:.2f}M  (in_proj=Embedding({N_PHON}))")
    B, L = 4, 20
    xl = torch.tensor([20, 17, 12, 8], device=dev)
    Tl = torch.tensor([150, 130, 90, 60], device=dev)
    Tmax = fix_len(int(Tl.max()), 2)
    x = torch.randint(1, N_PHON, (B, L), device=dev)  # Long phoneme IDs, 0=pad
    for b in range(B):
        x[b, xl[b]:] = 0  # pad tail
    y = torch.randn(B, 100, Tmax, device=dev)
    dl, pl, fl, attn = m(x, xl, y, Tl)
    print(f"FWD dur={dl.item():.4f} prior={pl.item():.4f} diff={fl.item():.4f} attn={tuple(attn.shape)}")
    assert all(torch.isfinite(t) for t in (dl, pl, fl)), "non-finite loss"
    (dl + pl + fl).backward()
    print("BWD ok grad_norm=", sum(p.grad.norm().item() for p in m.parameters() if p.grad is not None))
    m.eval()
    out, yl, w_ceil = m.synthesise(x, xl, n_timesteps=4)
    print(f"SYNTH out={tuple(out.shape)} y_lengths={yl.tolist()}")
    print(f"w_ceil[0] (mel-frames per phoneme)={w_ceil[0].tolist()}")
    assert int(w_ceil[0].sum()) == int(yl[0]), "w_ceil sum must equal y_length (lip-sync invariant)"
    print("SMOKE_OK")
