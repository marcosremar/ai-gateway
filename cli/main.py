"""SnapGPU CLI — deploy, serve, monitor GPU functions.

Usage:
    snapgpu deploy app.py
    snapgpu serve app.py
    snapgpu logs my-service
    snapgpu status
    snapgpu stop my-service
"""

from __future__ import annotations
import os
import sys
import importlib.util
from pathlib import Path
from typing import Optional

try:
    import typer
    from rich.console import Console
    from rich.table import Table
except ImportError:
    print("CLI requires: pip install typer rich")
    sys.exit(1)

try:
    import httpx
except ImportError:
    print("CLI requires: pip install httpx")
    sys.exit(1)

app = typer.Typer(name="snapgpu", help="GPU serverless platform")
console = Console()

GATEWAY_URL = os.environ.get("SNAPGPU_GATEWAY_URL", "http://localhost:8000")


def _load_app_from_file(file_path: str):
    """Load a SnapGPU App from a Python file."""
    path = Path(file_path).resolve()
    if not path.exists():
        console.print(f"[red]File not found: {file_path}[/red]")
        raise typer.Exit(1)

    # Import the module
    spec = importlib.util.spec_from_file_location("_snapgpu_app", str(path))
    if not spec or not spec.loader:
        console.print(f"[red]Cannot load: {file_path}[/red]")
        raise typer.Exit(1)

    module = importlib.util.module_from_spec(spec)
    sys.modules["_snapgpu_app"] = module
    spec.loader.exec_module(module)

    # Find the App instance
    from snapgpu import App
    apps = [v for v in vars(module).values() if isinstance(v, App)]
    if not apps:
        console.print(f"[red]No snapgpu.App() found in {file_path}[/red]")
        raise typer.Exit(1)

    return apps[0]


@app.command()
def deploy(
    file: str = typer.Argument(..., help="Python file containing the SnapGPU app"),
    force: bool = typer.Option(False, "--force", "-f", help="Force rebuild images"),
):
    """Deploy an app to the SnapGPU gateway."""
    console.print(f"[bold]Deploying {file}...[/bold]")

    snapgpu_app = _load_app_from_file(file)
    app_spec = snapgpu_app.to_spec()

    console.print(f"  App: [cyan]{snapgpu_app.name}[/cyan]")
    console.print(f"  Functions: {', '.join(snapgpu_app.registered_functions) or 'none'}")
    console.print(f"  Classes: {', '.join(snapgpu_app.registered_classes) or 'none'}")

    # Deploy to gateway
    try:
        resp = httpx.post(
            f"{GATEWAY_URL}/v1/apps/{snapgpu_app.name}/deploy",
            json={"spec": app_spec, "force_rebuild": force},
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        console.print(f"\n[green]✓ Deployed {snapgpu_app.name}[/green]")
        console.print(f"  Status: {data.get('status')}")
        console.print(f"  Functions: {', '.join(data.get('functions', []))}")
        console.print(f"  Classes: {', '.join(data.get('classes', []))}")
    except httpx.ConnectError:
        console.print(f"\n[red]✗ Cannot connect to gateway at {GATEWAY_URL}[/red]")
        console.print("  Start the gateway: python -m gateway.main")
        raise typer.Exit(1)
    except httpx.HTTPStatusError as e:
        console.print(f"\n[red]✗ Deploy failed: {e.response.text}[/red]")
        raise typer.Exit(1)


@app.command()
def serve(
    file: str = typer.Argument(..., help="Python file containing the SnapGPU app"),
    port: int = typer.Option(8000, "--port", "-p"),
):
    """Run app locally in dev mode (no containers, no GPU routing)."""
    console.print(f"[bold]Serving {file} locally on port {port}...[/bold]")

    snapgpu_app = _load_app_from_file(file)

    console.print(f"  App: [cyan]{snapgpu_app.name}[/cyan]")
    for fn_name, handle in snapgpu_app._functions.items():
        console.print(f"  Function: {fn_name} → POST /v1/invoke/{snapgpu_app.name}/{fn_name}")

    # Create a minimal FastAPI server for local dev
    from fastapi import FastAPI
    import uvicorn

    dev_app = FastAPI(title=f"SnapGPU Dev: {snapgpu_app.name}")

    @dev_app.get("/health")
    async def health():
        return {"status": "ok", "mode": "local-dev", "app": snapgpu_app.name}

    for fn_name, handle in snapgpu_app._functions.items():
        _fn = handle._fn
        _name = fn_name

        @dev_app.post(f"/v1/invoke/{snapgpu_app.name}/{_name}")
        async def invoke(body: dict, fn=_fn):
            result = fn(**body) if body else fn()
            return {"status": "completed", "result": result}

    uvicorn.run(dev_app, host="0.0.0.0", port=port)


@app.command()
def status():
    """Show running apps and containers."""
    try:
        resp = httpx.get(f"{GATEWAY_URL}/v1/apps", timeout=10)
        resp.raise_for_status()
        apps = resp.json()
    except httpx.ConnectError:
        console.print(f"[red]Cannot connect to gateway at {GATEWAY_URL}[/red]")
        raise typer.Exit(1)

    if not apps:
        console.print("[dim]No apps deployed[/dim]")
        return

    table = Table(title="SnapGPU Apps")
    table.add_column("Name", style="cyan")
    table.add_column("Status")
    table.add_column("Functions")
    table.add_column("Classes")

    for a in apps:
        status_style = "green" if a["status"] == "active" else "yellow"
        table.add_row(
            a["name"],
            f"[{status_style}]{a['status']}[/{status_style}]",
            ", ".join(a.get("functions", [])) or "-",
            ", ".join(a.get("classes", [])) or "-",
        )

    console.print(table)


@app.command()
def stop(name: str = typer.Argument(..., help="App name to stop")):
    """Stop and remove an app."""
    try:
        resp = httpx.delete(f"{GATEWAY_URL}/v1/apps/{name}", timeout=30)
        resp.raise_for_status()
        data = resp.json()
        console.print(f"[green]✓ Stopped {name}[/green]")
        console.print(f"  Containers stopped: {data.get('containers_stopped', 0)}")
    except httpx.HTTPStatusError as e:
        console.print(f"[red]✗ {e.response.text}[/red]")
        raise typer.Exit(1)


@app.command()
def logs(name: str = typer.Argument(..., help="App name")):
    """Stream logs for an app (placeholder)."""
    console.print(f"[dim]Streaming logs for {name}... (Ctrl+C to stop)[/dim]")
    console.print("[yellow]Log streaming not yet implemented — check gateway logs directly[/yellow]")


def main():
    app()


if __name__ == "__main__":
    main()
