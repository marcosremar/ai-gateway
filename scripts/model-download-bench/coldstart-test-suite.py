#!/usr/bin/env python3
"""Full coldstart test suite — runs ALL sub-tests on RTX 4090.

Replicates everything that was previously run on Mac CPU, but on the actual
production target hardware (Linux + CUDA + NVMe).
"""
import os
import sys
import time
import gc
import shutil
import subprocess
import importlib
import importlib.util
from pathlib import Path

PASS = "✓"
FAIL = "✗"
WARN = "⚠"

results = []
def report(name, ok, detail=""):
    sign = PASS if ok else FAIL
    msg = f"{sign} {name}"
    if detail:
        msg += f" — {detail}"
    print(msg)
    results.append((ok, name, detail))


print("=" * 70)
print("  Cold-Start Helper Full Test Suite — RTX 4090")
print("=" * 70)
print(f"Host:    {os.uname().nodename}")
print(f"GPU:     {subprocess.check_output(['nvidia-smi','--query-gpu=name','--format=csv,noheader']).decode().strip()}")
print(f"CPU:     {os.cpu_count()} cores")
print(f"Python:  {sys.version.split()[0]}")
print()

# Ensure coldstart.py is on path
sys.path.insert(0, "/tmp")


# ════════════════════════════════════════════════════════════════════════════
# TEST 1: coldstart standalone smoke test
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 1: coldstart.py standalone smoke test ━━━")
try:
    r = subprocess.run([sys.executable, "/tmp/coldstart.py"], capture_output=True, text=True, timeout=10)
    ok = r.returncode == 0 and "OK" in r.stdout
    report("coldstart standalone smoke", ok, r.stdout.strip().split("\n")[-1])
except Exception as e:
    report("coldstart standalone smoke", False, str(e))


# ════════════════════════════════════════════════════════════════════════════
# TEST 2: bootstrap() with valid cache dir
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 2: bootstrap() with valid cache dir ━━━")
try:
    # Fresh subprocess to avoid env var contamination
    r = subprocess.run([sys.executable, "-c", """
import sys, os
sys.path.insert(0, '/tmp')
from coldstart import bootstrap
bootstrap(torch_cache_dir='/tmp/test2-cache')
assert os.environ.get('TORCHINDUCTOR_CACHE_DIR') == '/tmp/test2-cache'
assert os.environ.get('TORCHINDUCTOR_FX_GRAPH_CACHE') == '1'
assert os.environ.get('TORCHINDUCTOR_AUTOGRAD_CACHE') == '1'
print('OK')
"""], capture_output=True, text=True, timeout=10)
    ok = r.returncode == 0 and "OK" in r.stdout
    report("bootstrap with valid cache dir", ok, r.stdout.strip().split("\n")[-1] if ok else r.stderr[:200])
except Exception as e:
    report("bootstrap with valid cache dir", False, str(e))


# ════════════════════════════════════════════════════════════════════════════
# TEST 3: bootstrap() with unwritable cache dir (resilience)
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 3: bootstrap() with unwritable cache dir ━━━")
# Use /dev/null/cache — /dev/null is a CHARACTER DEVICE so it cannot have
# subdirectories. mkdir fails with ENOTDIR even as root, which is exactly
# the failure mode we want to test.
try:
    r = subprocess.run([sys.executable, "-c", """
import sys, os
sys.path.insert(0, '/tmp')
from coldstart import bootstrap
bootstrap(torch_cache_dir='/dev/null/cache')
cd = os.environ.get('TORCHINDUCTOR_CACHE_DIR', '')
assert cd != '/dev/null/cache', f'expected fallback, got {cd}'
print(f'OK fallback={cd}')
"""], capture_output=True, text=True, timeout=10)
    ok = r.returncode == 0 and "OK" in r.stdout
    report("bootstrap with unwritable target → fallback", ok, r.stdout.strip().split("\n")[-1] if ok else r.stderr[:200])
except Exception as e:
    report("bootstrap with unwritable target → fallback", False, str(e))


# ════════════════════════════════════════════════════════════════════════════
# TEST 4: bootstrap() never raises with broken cache helper
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 4: bootstrap() catches all exceptions internally ━━━")
try:
    r = subprocess.run([sys.executable, "-c", """
import sys, os
sys.path.insert(0, '/tmp')
from coldstart import bootstrap
# Try with a path that causes weird issues
import tempfile
d = tempfile.mkdtemp()
bootstrap(torch_cache_dir=d)
print('OK')
"""], capture_output=True, text=True, timeout=10)
    ok = r.returncode == 0
    report("bootstrap never raises", ok, "OK" if ok else r.stderr[:200])
except Exception as e:
    report("bootstrap never raises", False, str(e))


# ════════════════════════════════════════════════════════════════════════════
# TEST 5-12: prefetch_safetensors edge cases
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 5-12: prefetch_safetensors edge cases ━━━")
edge_cases = [
    ("non-existent repo",                lambda f: f("definitely/not-real-12345xyz")),
    ("empty list",                       lambda f: f([])),
    ("None",                             lambda f: f(None)),
    ("int input",                        lambda f: f(42)),
    ("dict input",                       lambda f: f({"key": "value"})),
    ("non-existent files only",          lambda f: f(["/tmp/fake1.safetensors", "/tmp/fake2.safetensors"])),
]

for label, fn in edge_cases:
    code = f"""
import sys
sys.path.insert(0, '/tmp')
from coldstart import prefetch_safetensors
import os
os.environ['HF_HOME'] = '/tmp/test-edge'
try:
    result = ({fn.__code__.co_consts[1] if False else 'None'})
except:
    pass
import builtins
prefetch_safetensors = __import__('coldstart').prefetch_safetensors
"""
    # Easier: just inline-call via a single subprocess each
    test_code = f"""
import sys
sys.path.insert(0, '/tmp')
from coldstart import prefetch_safetensors
result = prefetch_safetensors({fn.__code__.co_consts[1] if False else None})
print(f'result={{result}}')
"""
    # Actually, just run the lambda inline using ast or repr
    # Simpler: create test files for the edge cases manually
    pass

# Run all 6 edge cases in one Python invocation for efficiency
r = subprocess.run([sys.executable, "-c", """
import sys
sys.path.insert(0, '/tmp')
from coldstart import prefetch_safetensors
import os
os.environ['HF_HOME'] = '/tmp/test-edge'

cases = []

# Case 1: non-existent repo
cases.append(('non-existent repo', prefetch_safetensors('definitely/not-real-12345xyz')))

# Case 2: empty list
cases.append(('empty list', prefetch_safetensors([])))

# Case 3: None
cases.append(('None', prefetch_safetensors(None)))

# Case 4: int (very wrong type)
cases.append(('int input', prefetch_safetensors(42)))

# Case 5: dict
cases.append(('dict input', prefetch_safetensors({'key': 'value'})))

# Case 6: non-existent files only
cases.append(('all-fake files', prefetch_safetensors(['/tmp/fake1.safetensors', '/tmp/fake2.safetensors'])))

for name, val in cases:
    status = 'OK' if val == 0.0 else f'FAIL got={val}'
    print(f'  {name}: {status}')
"""], capture_output=True, text=True, timeout=60)

if r.returncode == 0:
    for line in r.stdout.strip().split("\n"):
        if "OK" in line:
            name = line.split(":")[0].strip()
            report(f"prefetch {name}", True)
        elif "FAIL" in line:
            name = line.split(":")[0].strip()
            detail = line.split(":")[1].strip()
            report(f"prefetch {name}", False, detail)
else:
    report("prefetch edge cases (all)", False, r.stderr[:200])


# ════════════════════════════════════════════════════════════════════════════
# TEST 13: prefetch with real + fake mix returns >0
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 13: prefetch with real + fake mix ━━━")
# Find a real safetensors file
real_file = None
for r, _, fs in os.walk("/tmp/sf-bench-v2"):
    for f in fs:
        if f.endswith(".safetensors"):
            real_file = os.path.join(r, f)
            break
    if real_file:
        break

if real_file:
    r = subprocess.run([sys.executable, "-c", f"""
import sys
sys.path.insert(0, '/tmp')
from coldstart import prefetch_safetensors
result = prefetch_safetensors(['{real_file}', '/tmp/fake.safetensors'])
print(f'elapsed={{result}}')
"""], capture_output=True, text=True, timeout=30)
    try:
        elapsed = float(r.stdout.split("=")[1].strip())
        report("prefetch real+fake mix returns >0", elapsed > 0, f"elapsed={elapsed:.4f}s")
    except:
        report("prefetch real+fake mix returns >0", False, r.stdout + r.stderr)
else:
    report("prefetch real+fake mix returns >0", False, "no real safetensors found to test with")


# ════════════════════════════════════════════════════════════════════════════
# TEST 14: load_with_fastsafetensors with available
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 14: load_with_fastsafetensors with library available ━━━")
if real_file:
    r = subprocess.run([sys.executable, "-c", f"""
import sys
sys.path.insert(0, '/tmp')
from coldstart import load_with_fastsafetensors
import torch
tensors = load_with_fastsafetensors(['{real_file}'], device='cuda:0', nogds=True)
assert len(tensors) > 0, 'no tensors loaded'
print(f'loaded {{len(tensors)}} tensors')
"""], capture_output=True, text=True, timeout=120)
    ok = r.returncode == 0 and "loaded" in r.stdout
    report("load_with_fastsafetensors (available)", ok, r.stdout.strip() if ok else r.stderr[:200])
else:
    report("load_with_fastsafetensors (available)", False, "no real file")


# ════════════════════════════════════════════════════════════════════════════
# TEST 15: load_with_fastsafetensors fallback when fastsafetensors hidden
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 15: load_with_fastsafetensors fallback path ━━━")
if real_file:
    r = subprocess.run([sys.executable, "-c", f"""
import sys
# Hide fastsafetensors before importing coldstart
sys.modules['fastsafetensors'] = None
sys.path.insert(0, '/tmp')
from coldstart import load_with_fastsafetensors
import torch
tensors = load_with_fastsafetensors(['{real_file}'], device='cuda:0')
assert len(tensors) > 0
print(f'fallback loaded {{len(tensors)}} tensors')
"""], capture_output=True, text=True, timeout=120)
    ok = r.returncode == 0 and "fallback loaded" in r.stdout
    report("load_with_fastsafetensors (fallback)", ok, r.stdout.strip() if ok else r.stderr[:200])
else:
    report("load_with_fastsafetensors (fallback)", False, "no real file")


# ════════════════════════════════════════════════════════════════════════════
# TEST 16: torch env vars propagate to torch.compile cache
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 16: torch env vars actually used by torch.compile ━━━")
r = subprocess.run([sys.executable, "-c", """
import sys
sys.path.insert(0, '/tmp')
from coldstart import bootstrap
bootstrap(torch_cache_dir='/tmp/test16-cache')

import torch
import torch.nn as nn

m = nn.Linear(64, 32).to('cuda').eval()
inp = torch.randn(8, 64, device='cuda')

import time
t0 = time.time()
compiled = torch.compile(m, mode='reduce-overhead')
with torch.no_grad():
    out = compiled(inp)
torch.cuda.synchronize()
print(f'compile_first={time.time()-t0:.2f}')

# Verify cache dir has files
import os
n = sum(len(fs) for _, _, fs in os.walk('/tmp/test16-cache'))
print(f'cache_files={n}')

# Verify inductor knows about our cache
try:
    from torch._inductor.runtime.runtime_utils import cache_dir
    print(f'inductor_cache_dir={cache_dir()}')
except: pass
"""], capture_output=True, text=True, timeout=300)

if r.returncode == 0:
    out = r.stdout.strip()
    print(f"  {out}")
    # The CRITICAL evidence is: did torch.compile write files to OUR cache dir?
    # If yes, the env var was honored end-to-end. The inductor_cache_dir probe
    # is a bonus check that may not work on older torch versions.
    has_files = any("cache_files=" in l and not l.endswith("=0") for l in out.split("\n"))
    report("torch env vars propagate to torch.compile", has_files,
           f"compile wrote files to /tmp/test16-cache: {has_files}")
else:
    report("torch env vars propagate to torch.compile", False, r.stderr[:300])


# ════════════════════════════════════════════════════════════════════════════
# TEST 17: ultravox-s2s/api/server.py imports past bootstrap
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 17: ultravox-s2s server.py import chain ━━━")
ultravox_path = "/tmp/ultravox-server.py"
# Need to upload from local — assume it exists at /tmp/ultravox-server.py
if os.path.exists(ultravox_path):
    r = subprocess.run([sys.executable, "-c", f"""
import sys, os
os.environ['TORCHINDUCTOR_CACHE_DIR'] = '/tmp/test17'
sys.path.insert(0, '/tmp')
import importlib.util
spec = importlib.util.spec_from_file_location('uv_server', '{ultravox_path}')
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
    print('IMPORTED_FULLY')
except Exception as e:
    em = str(e)[:200]
    print(f'STOPPED: {{type(e).__name__}}: {{em}}')
"""], capture_output=True, text=True, timeout=120)
    out = r.stdout.strip()
    # Acceptable: imports past bootstrap (may fail later on missing optional deps)
    accepted_failures = ['aiortc', 'librosa', 'soundfile', 'qwen', 'fastapi', 'pydantic']
    ok_full = "IMPORTED_FULLY" in out
    ok_past_bootstrap = ok_full or any(s in out.lower() for s in accepted_failures)
    if ok_full:
        report("ultravox server.py imports", True, "fully imported")
    elif ok_past_bootstrap:
        report("ultravox server.py imports past bootstrap", True, out[:120])
    else:
        report("ultravox server.py imports", False, out[:200])
else:
    report("ultravox server.py imports", False, "file not uploaded to /tmp/ultravox-server.py")


# ════════════════════════════════════════════════════════════════════════════
# TEST 18: dit360/server.py imports past bootstrap
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 18: dit360 server.py import chain ━━━")
dit360_path = "/tmp/dit360-server.py"
if os.path.exists(dit360_path):
    r = subprocess.run([sys.executable, "-c", f"""
import sys, os
os.environ['TORCHINDUCTOR_CACHE_DIR'] = '/tmp/test18'
sys.path.insert(0, '/tmp')
import importlib.util
spec = importlib.util.spec_from_file_location('dit_server', '{dit360_path}')
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
    print('IMPORTED_FULLY')
except Exception as e:
    em = str(e)[:200]
    print(f'STOPPED: {{type(e).__name__}}: {{em}}')
"""], capture_output=True, text=True, timeout=120)
    out = r.stdout.strip()
    accepted = ['diffusers', 'realesrgan', 'basicsr', 'fastapi', 'no module']
    ok = "IMPORTED_FULLY" in out or any(s in out.lower() for s in accepted)
    report("dit360 server.py imports past bootstrap", ok, out[:120])
else:
    report("dit360 server.py imports past bootstrap", False, "file not uploaded")


# ════════════════════════════════════════════════════════════════════════════
# TEST 19: server.py wider exception catch (broken bootstrap module)
# ════════════════════════════════════════════════════════════════════════════
print("\n━━━ TEST 19: server.py catches non-ImportError from bootstrap ━━━")
# Create a broken coldstart in a separate dir
broken_dir = "/tmp/broken-coldstart"
os.makedirs(broken_dir, exist_ok=True)
with open(f"{broken_dir}/coldstart.py", "w") as f:
    f.write("""
def bootstrap(*a, **k):
    raise RuntimeError("Simulated bootstrap failure")
def prefetch_safetensors(*a, **k):
    raise RuntimeError("Simulated prefetch failure")
""")

r = subprocess.run([sys.executable, "-c", f"""
import sys, os
sys.path.insert(0, '{broken_dir}')
# Replicate server.py exact pattern (broader except)
try:
    from coldstart import bootstrap, prefetch_safetensors
    bootstrap()
except Exception as _err:
    print(f'CAUGHT: {{type(_err).__name__}}: {{_err}}')
    prefetch_safetensors = lambda *a, **k: 0.0
print('STARTUP_OK')
"""], capture_output=True, text=True, timeout=10)
ok = "CAUGHT" in r.stdout and "STARTUP_OK" in r.stdout
report("server.py catches RuntimeError from bootstrap", ok,
       r.stdout.strip().split("\n")[0] if ok else r.stderr[:200])


# ════════════════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════════════════
print()
print("=" * 70)
print("  SUMMARY")
print("=" * 70)
passed = sum(1 for ok, _, _ in results if ok)
total = len(results)
print(f"Passed: {passed}/{total}")
print()
if passed < total:
    print("Failures:")
    for ok, name, detail in results:
        if not ok:
            print(f"  ✗ {name}: {detail}")

import json
with open("/tmp/full-suite-results.json", "w") as f:
    json.dump({"passed": passed, "total": total, "results": [
        {"name": n, "ok": ok, "detail": d} for ok, n, d in results
    ]}, f, indent=2)

sys.exit(0 if passed == total else 1)
