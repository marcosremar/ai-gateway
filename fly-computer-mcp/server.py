import base64
import json
import os
import subprocess

from mcp.server.fastmcp import FastMCP, Image

APP = os.environ.get("FLY_APP", "weathered-canyon-498")
FLYCTL = os.environ.get("FLYCTL", "flyctl")
mcp = FastMCP("fly-computer")

_machine = {"id": os.environ.get("FLY_MACHINE")}


def fly(*args, timeout=120):
    r = subprocess.run([FLYCTL, *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "flyctl failed").strip())
    return r.stdout


def machine_id():
    if _machine["id"]:
        return _machine["id"]
    rows = json.loads(fly("machine", "list", "--app", APP, "--json"))
    if not rows:
        raise RuntimeError(f"no machines in app {APP}")
    _machine["id"] = rows[0]["id"]
    return _machine["id"]


def run_remote(script: str, timeout=60) -> str:
    b64 = base64.b64encode(script.encode()).decode()
    cmd = f"bash -lc 'echo {b64} | base64 -d | bash'"
    return fly("machine", "exec", machine_id(), cmd, "--app", APP, "--timeout", str(timeout), timeout=timeout + 30)


def b64var(name: str, value: str) -> str:
    enc = base64.b64encode(value.encode()).decode()
    return f'{name}=$(printf %s {enc} | base64 -d)\n'


@mcp.tool()
def machine_status() -> str:
    rows = json.loads(fly("machine", "list", "--app", APP, "--json"))
    return json.dumps([{"id": m["id"], "state": m.get("state"), "region": m.get("region")} for m in rows])


@mcp.tool()
def machine_start() -> str:
    return fly("machine", "start", machine_id(), "--app", APP).strip() or "started"


@mcp.tool()
def machine_stop() -> str:
    return fly("machine", "stop", machine_id(), "--app", APP).strip() or "stopped"


@mcp.tool()
def vnc_url() -> str:
    return f"https://{APP}.fly.dev/vnc.html?autoconnect=true&resize=remote"


@mcp.tool()
def screenshot() -> Image:
    out = run_remote(
        "export DISPLAY=:0\nscrot -o /tmp/shot.png\n"
        "echo __B64__; base64 -w0 /tmp/shot.png; echo; echo __END__\n"
    )
    body = out.split("__B64__", 1)[1].split("__END__", 1)[0]
    data = base64.b64decode("".join(body.split()))
    return Image(data=data, format="png")


@mcp.tool()
def click(x: int, y: int, button: str = "left", double: bool = False) -> str:
    btn = {"left": 1, "middle": 2, "right": 3}.get(button, 1)
    rep = "--repeat 2 --delay 120 " if double else ""
    run_remote(f"export DISPLAY=:0\nxdotool mousemove {x} {y} click {rep}{btn}\n")
    return f"clicked {button}{'x2' if double else ''} at {x},{y}"


@mcp.tool()
def move(x: int, y: int) -> str:
    run_remote(f"export DISPLAY=:0\nxdotool mousemove {x} {y}\n")
    return f"moved to {x},{y}"


@mcp.tool()
def scroll(x: int, y: int, direction: str = "down", amount: int = 3) -> str:
    btn = {"up": 4, "down": 5, "left": 6, "right": 7}.get(direction, 5)
    run_remote(f"export DISPLAY=:0\nxdotool mousemove {x} {y} click --repeat {amount} {btn}\n")
    return f"scrolled {direction} {amount} at {x},{y}"


@mcp.tool()
def type_text(text: str) -> str:
    script = "export DISPLAY=:0\n" + b64var("T", text) + 'printf %s "$T" | xdotool type --clearmodifiers --file -\n'
    run_remote(script)
    return f"typed {len(text)} chars"


@mcp.tool()
def press_key(key: str, modifiers: list[str] | None = None) -> str:
    combo = "+".join((modifiers or []) + [key])
    run_remote(f"export DISPLAY=:0\nxdotool key --clearmodifiers {combo}\n")
    return f"pressed {combo}"


@mcp.tool()
def open_url(url: str) -> str:
    script = (
        "export DISPLAY=:0\n" + b64var("U", url) +
        "pkill -f chromium 2>/dev/null || true\nsleep 1\n"
        'nohup chromium --no-sandbox --disable-dev-shm-usage --disable-gpu '
        '--no-first-run --window-size=1280,800 "$U" >/tmp/chromium.log 2>&1 &\n'
    )
    run_remote(script)
    return f"opened {url}"


@mcp.tool()
def launch(command: str) -> str:
    script = "export DISPLAY=:0\n" + b64var("C", command) + 'nohup bash -lc "$C" >/tmp/launch.log 2>&1 &\n'
    run_remote(script)
    return f"launched: {command}"


@mcp.tool()
def exec_shell(command: str, timeout: int = 60) -> str:
    return run_remote(b64var("C", command) + 'bash -lc "$C"\n', timeout=timeout)


if __name__ == "__main__":
    mcp.run()
