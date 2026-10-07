"""Unit tests of the edge telemetry emitter (stdlib unittest): cd docker/aigw-edge && python3 -m unittest test_telemetry"""

import hashlib
import hmac
import io
import json
import os
import sys
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telemetry  # noqa: E402

TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"


class FakeOpener:
    def __init__(self, codes=None):
        self.codes = list(codes or [])
        self.requests = []

    def __call__(self, req, timeout):
        self.requests.append(req)
        code = self.codes.pop(0) if self.codes else 200
        if isinstance(code, Exception):
            raise code
        if code >= 400:
            raise urllib.error.HTTPError(req.full_url, code, "err", {}, io.BytesIO(b"{}"))
        return io.BytesIO(b"{}")

    def bodies(self):
        return [json.loads(r.data.decode())["events"] for r in self.requests]


def emitter(opener, **kw):
    return telemetry.TelemetryEmitter("https://gw.test/", "r-1", "replica-secret", opener=opener, start_thread=False, **kw)


class EdgeTelemetryTest(unittest.TestCase):
    def test_auth_headers_are_hmac_of_the_replica_token(self):
        op = FakeOpener()
        tel = emitter(op)
        tel.emit("vad.segment", trace_id=TRACE, session_id="s-1", turn_id="t-1", dur_ms=840.4, attrs={"speechMs": 790})
        tel.flush()
        req = op.requests[0]
        self.assertEqual(req.full_url, "https://gw.test/v1/telemetry/events")
        expected = hmac.new(b"replica-secret", b"aigw-telemetry-v1", hashlib.sha256).hexdigest()
        self.assertEqual(req.get_header("Authorization"), "Bearer " + expected)
        self.assertEqual(req.get_header("X-aigw-replica"), "r-1")
        e = op.bodies()[0][0]
        self.assertEqual(e["source"], "edge")
        self.assertEqual(e["traceId"], TRACE)
        self.assertEqual(e["durMs"], 840)
        self.assertEqual(e["attrs"], {"speechMs": 790})

    def test_signature_vector_shared_with_the_gateway(self):
        # Same vector as __tests__/unit/telemetry/auth-ingest.test.ts and docs/api/telemetry.md.
        self.assertEqual(telemetry.edge_signature("replica-secret"),
                         "523cc3e7d85def44143d386ac5a1c35acceb7ba3c83e09680cb6f1ada19967ad")

    def test_batches_and_bounded_queue(self):
        op = FakeOpener()
        tel = emitter(op, max_batch=2, max_queue=3)
        for i in range(5):
            tel.emit("vad.segment", trace_id=TRACE, attrs={"i": i})
        self.assertEqual(tel.stats["dropped"], 2)
        tel.flush()
        flat = [e for b in op.bodies() for e in b]
        self.assertEqual(flat[0]["event"], "telemetry.dropped")
        self.assertEqual(flat[0]["attrs"], {"count": 2})
        self.assertEqual([e["attrs"]["i"] for e in flat[1:]], [2, 3, 4])
        self.assertTrue(all(len(b) <= 2 for b in op.bodies()))

    def test_retry_on_5xx_and_network_drop_on_4xx(self):
        op = FakeOpener([503, OSError("down"), 200, 400])
        tel = emitter(op)
        tel.emit("turn.done", trace_id=TRACE)
        tel.flush()  # 503: kept
        tel.flush()  # network: kept
        tel.flush()  # 200
        self.assertEqual(tel.stats["sent"], 1)
        tel.emit("turn.done", trace_id=TRACE)
        tel.flush()  # 400: dropped
        self.assertEqual(tel.stats["failed"], 1)

    def test_never_raises_and_filters_bad_input(self):
        op = FakeOpener([RuntimeError("boom")])
        tel = emitter(op)
        tel.emit("Bad Name")
        tel.emit("x.y", level="fatal", trace_id="nope", attrs={"long": "x" * 201, "obj": {"a": 1}, "ok": 1, "nan": float("nan")})
        tel.flush()
        tel.flush()
        e = op.bodies()[-1][0]
        self.assertEqual(e["level"], "info")
        self.assertRegex(e["traceId"], r"^[0-9a-f]{32}$")
        self.assertEqual(e["attrs"], {"ok": 1})

    def test_traceparent_helper(self):
        self.assertEqual(telemetry.trace_id_from_traceparent("00-%s-00f067aa0ba902b7-01" % TRACE), TRACE)
        self.assertIsNone(telemetry.trace_id_from_traceparent("garbage"))
        self.assertIsNone(telemetry.trace_id_from_traceparent(None))


if __name__ == "__main__":
    unittest.main()
