import base64
import json
import os
import time

from daytona import (
    Daytona,
    DaytonaConfig,
    CreateSandboxFromSnapshotParams,
)
from mcp.server.fastmcp import FastMCP, Image

CONFIG_PATH = os.path.expanduser("~/Library/Application Support/daytona/config.json")


def load_credentials():
    key = os.environ.get("DAYTONA_API_KEY")
    url = os.environ.get("DAYTONA_API_URL", "https://app.daytona.io/api")
    if key:
        return key, url
    prof = json.load(open(CONFIG_PATH))["profiles"][0]
    return prof["api"]["key"], prof["api"]["url"]


api_key, api_url = load_credentials()
daytona = Daytona(DaytonaConfig(api_key=api_key, api_url=api_url))
mcp = FastMCP("daytona-computer")

state = {"sandbox_id": os.environ.get("DAYTONA_SANDBOX_ID")}


def current():
    if not state["sandbox_id"]:
        raise RuntimeError("no active desktop; call desktop_start or desktop_attach first")
    return daytona.get(state["sandbox_id"])


def decode_png(b64: str) -> bytes:
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    return base64.b64decode(b64)


@mcp.tool()
def desktop_start(allow_network: bool = True, auto_stop_minutes: int = 30) -> str:
    params = CreateSandboxFromSnapshotParams(
        labels={"purpose": "computer-use-mcp"},
        auto_stop_interval=auto_stop_minutes,
        auto_delete_interval=120,
        network_block_all=not allow_network,
    )
    sb = daytona.create(params, timeout=180)
    state["sandbox_id"] = sb.id
    sb.computer_use.start()
    for _ in range(40):
        if str(getattr(sb.computer_use.get_status(), "status", "")).lower() == "active":
            break
        time.sleep(2)
    vnc = sb.get_preview_link(6080)
    return json.dumps({
        "sandbox_id": sb.id,
        "vnc_url": getattr(vnc, "url", None),
        "vnc_token": getattr(vnc, "token", None),
    })


@mcp.tool()
def desktop_attach(sandbox_id: str) -> str:
    sb = daytona.get(sandbox_id)
    sb.computer_use.start()
    state["sandbox_id"] = sandbox_id
    vnc = sb.get_preview_link(6080)
    return json.dumps({"sandbox_id": sandbox_id, "vnc_url": getattr(vnc, "url", None), "vnc_token": getattr(vnc, "token", None)})


@mcp.tool()
def desktop_list() -> str:
    items = []
    for sb in daytona.list():
        items.append({"id": sb.id, "state": str(getattr(sb, "state", "")), "labels": getattr(sb, "labels", {})})
    return json.dumps(items)


@mcp.tool()
def vnc_url() -> str:
    vnc = current().get_preview_link(6080)
    return json.dumps({"vnc_url": getattr(vnc, "url", None), "vnc_token": getattr(vnc, "token", None)})


@mcp.tool()
def screenshot(show_cursor: bool = True) -> Image:
    shot = current().computer_use.screenshot.take_full_screen(show_cursor=show_cursor)
    return Image(data=decode_png(shot.screenshot), format="png")


@mcp.tool()
def click(x: int, y: int, button: str = "left", double: bool = False) -> str:
    current().computer_use.mouse.click(x, y, button=button, double=double)
    return f"clicked {button} at {x},{y}"


@mcp.tool()
def move(x: int, y: int) -> str:
    current().computer_use.mouse.move(x, y)
    return f"moved to {x},{y}"


@mcp.tool()
def scroll(x: int, y: int, direction: str = "down", amount: int = 3) -> str:
    current().computer_use.mouse.scroll(x, y, direction, amount)
    return f"scrolled {direction} {amount} at {x},{y}"


@mcp.tool()
def type_text(text: str) -> str:
    current().computer_use.keyboard.type(text)
    return f"typed {len(text)} chars"


@mcp.tool()
def press_key(key: str, modifiers: list[str] | None = None) -> str:
    current().computer_use.keyboard.press(key, modifiers=modifiers)
    return f"pressed {'+'.join((modifiers or []) + [key])}"


@mcp.tool()
def exec_shell(command: str, timeout: int = 60) -> str:
    r = current().process.exec(command, timeout=timeout)
    return json.dumps({"exit_code": getattr(r, "exit_code", None), "output": getattr(r, "result", "")})


@mcp.tool()
def desktop_stop() -> str:
    daytona.stop(current())
    return f"stopped {state['sandbox_id']}"


@mcp.tool()
def desktop_delete() -> str:
    sid = state["sandbox_id"]
    daytona.delete(current())
    state["sandbox_id"] = None
    return f"deleted {sid}"


if __name__ == "__main__":
    mcp.run()
