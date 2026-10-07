"""
Session tokens (shared contract with the gateway's src/realtime): JWT HS256 signed with
HMAC-SHA256(key=replicaToken, msg="aigw-rt-v1"), claims {sid, app, dep, rep, cfg, exp, iat}.

`cfg` is base64url JSON of the session config — the `/v1/s2s` config (system, messages, voice, fallback_voice, language,
max_tokens, temperature, stt_prompt, response_format, speak_field, user_template…).

Reasons follow the gateway's test vectors (tests/realtime-token-vectors.json, copied from the gateway's
docs/realtime-token-vectors.json): malformed, alg, bad_signature, expired (exp ≤ now), not_yet_valid (iat > now + 60),
ttl_too_long (exp − iat > 900), cfg (> 6144 chars or not a JSON object), replica, deployment, replayed.

Rejected: bad shape or signature, alg other than HS256, expired, lifetime above 15 min, a `rep` that is not this replica
(the key is per DEPLOYMENT, so `rep` is what keeps a token from being replayed on a sibling replica), a `dep` that is not
this deployment, and a `sid` already used (single use, remembered until its expiry).
"""

import base64
import hashlib
import hmac
import json
import time

MAX_LIFETIME_S = 15 * 60
CLOCK_SKEW_S = 60  # iat ≤ now + 60 (docs/realtime.md § Session token)
MAX_CFG_CHARS = 6144


class TokenError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def b64url_decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sign(claims: dict, key: bytes) -> str:
    """Test/tool helper: the gateway signs the same way."""
    head = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = b64url(json.dumps(claims, separators=(",", ":")).encode())
    sig = hmac.new(key, f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{b64url(sig)}"


def turn_credential(secret: str, session_id: str, expires_at: int) -> tuple[str, str]:
    """TURN REST credential (coturn `use-auth-secret`): username "<exp>:<sid>", credential base64(HMAC-SHA1(secret,
    username)) — what the gateway hands the browser for the `coturn` deployment (docs/realtime-edge.md § TURN)."""
    username = f"{expires_at}:{session_id}"
    return username, base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()


def rep_matches(rep: str, replica_id: str) -> bool:
    """The gateway's replica id is the provider's (Scaleway `zone:uuid`, Vast contract id); the edge may know only the
    bare server uuid (metadata), so `zone:uuid` matches `uuid` too."""
    if not replica_id:
        return True
    return rep == replica_id or rep.endswith(":" + replica_id) or replica_id.endswith(":" + rep)


class TokenVerifier:
    def __init__(self, key: bytes, replica_id: str = "", deployment: str = "", now=time.time):
        if len(key) < 16:
            raise ValueError("edge key missing (AIGW_REPLICA_TOKEN or AIGW_RT_KEY)")
        self.key, self.replica_id, self.deployment, self.now = key, replica_id, deployment, now
        self._used: dict[str, float] = {}
        self._tokens: dict[str, str] = {}

    def verify(self, token: str, consume: bool = True, transport: str = "", live=None) -> dict:
        """Single use per transport: the SDK's ladder tries WebRTC then WS with the one token of its admission (a second
        admission would charge the app's budget again and hold a second slot), so `sid` may open one session of each
        transport; the edge keeps one live session per sid (Server.supersede). Without `transport`, the sid is the key.
        `live(sid)` says the sid's session of this transport still runs here: the very token that opened it may then
        be presented again (a WebRTC re-offer after a network change). Anything else used twice is `replayed`."""
        try:
            head_b, body_b, sig_b = token.split(".")
            head = json.loads(b64url_decode(head_b))
            claims = json.loads(b64url_decode(body_b))
            sig = b64url_decode(sig_b)
        except Exception as error:  # noqa: BLE001 — any malformed token is one answer
            raise TokenError("malformed") from error
        if head.get("alg") != "HS256":
            raise TokenError("alg")
        want = hmac.new(self.key, f"{head_b}.{body_b}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(want, sig):
            raise TokenError("bad_signature")
        now = self.now()
        exp, iat = claims.get("exp"), claims.get("iat")
        if not isinstance(exp, (int, float)) or not isinstance(iat, (int, float)):
            raise TokenError("claims")
        if exp <= now:
            raise TokenError("expired")
        if iat > now + CLOCK_SKEW_S:
            raise TokenError("not_yet_valid")
        if exp - iat > MAX_LIFETIME_S:
            raise TokenError("ttl_too_long")
        sid = claims.get("sid")
        if not isinstance(sid, str) or not sid or len(sid) > 128:
            raise TokenError("claims")
        if not rep_matches(str(claims.get("rep", "")), self.replica_id):
            raise TokenError("replica")
        if self.deployment and claims.get("dep") != self.deployment:
            raise TokenError("deployment")
        try:
            cfg_raw = claims.get("cfg")
            if cfg_raw and (not isinstance(cfg_raw, str) or len(cfg_raw) > MAX_CFG_CHARS):
                raise ValueError("cfg too long")
            cfg = json.loads(b64url_decode(cfg_raw)) if cfg_raw else {}
            if not isinstance(cfg, dict):
                raise ValueError("cfg is not an object")
        except Exception as error:  # noqa: BLE001
            raise TokenError("cfg") from error
        for old, until in list(self._used.items()):
            if until < now:
                del self._used[old]
                self._tokens.pop(old, None)
        use = f"{sid}/{transport}" if transport else sid
        opened_by = self._tokens.get(use)
        resumes = opened_by is not None and live is not None and hmac.compare_digest(opened_by, token) and live(sid)
        if (use in self._used and not resumes) or sid in self._used:
            raise TokenError("replayed")
        if consume:
            self._used[use] = float(exp)
            self._tokens[use] = token
        return {**claims, "cfg": cfg}
