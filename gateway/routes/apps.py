"""App management endpoints — CRUD + deploy."""

from __future__ import annotations
import asyncio
import subprocess
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone

from ..db import get_session, AppModel, AppStatus, ContainerModel
from ..pool_singleton import get_pool
from sqlmodel import select

router = APIRouter(prefix="/v1/apps", tags=["apps"])


class AppCreate(BaseModel):
    name: str
    spec: dict


class AppResponse(BaseModel):
    name: str
    status: str
    functions: list[str]
    classes: list[str]
    created_at: str


class DeployRequest(BaseModel):
    spec: dict
    force_rebuild: bool = False


@router.post("", status_code=201)
async def create_app(body: AppCreate) -> AppResponse:
    """Register a new app."""
    with get_session() as session:
        existing = session.exec(select(AppModel).where(AppModel.name == body.name)).first()
        if existing:
            raise HTTPException(400, f"App '{body.name}' already exists")

        app = AppModel(name=body.name, status=AppStatus.ACTIVE)
        app.spec = body.spec
        session.add(app)
        session.commit()
        session.refresh(app)

        return AppResponse(
            name=app.name,
            status=app.status,
            functions=list(body.spec.get("functions", {}).keys()),
            classes=list(body.spec.get("classes", {}).keys()),
            created_at=app.created_at.isoformat(),
        )


@router.get("")
async def list_apps() -> list[AppResponse]:
    """List all registered apps."""
    with get_session() as session:
        apps = session.exec(select(AppModel)).all()
        return [
            AppResponse(
                name=a.name,
                status=a.status,
                functions=list(a.spec.get("functions", {}).keys()),
                classes=list(a.spec.get("classes", {}).keys()),
                created_at=a.created_at.isoformat(),
            )
            for a in apps
        ]


@router.get("/{app_name}")
async def get_app(app_name: str) -> dict:
    """Get app details including spec."""
    with get_session() as session:
        app = session.exec(select(AppModel).where(AppModel.name == app_name)).first()
        if not app:
            raise HTTPException(404, f"App '{app_name}' not found")

        # Count containers
        containers = session.exec(
            select(ContainerModel).where(ContainerModel.app_name == app_name)
        ).all()

        return {
            "name": app.name,
            "status": app.status,
            "spec": app.spec,
            "containers": {
                "total": len(containers),
                "running": len([c for c in containers if c.status == "running"]),
                "idle": len([c for c in containers if c.status == "idle"]),
            },
            "created_at": app.created_at.isoformat(),
            "updated_at": app.updated_at.isoformat(),
        }


@router.delete("/{app_name}")
async def delete_app(app_name: str):
    """Delete an app and stop all its containers."""
    with get_session() as session:
        app = session.exec(select(AppModel).where(AppModel.name == app_name)).first()
        if not app:
            raise HTTPException(404, f"App '{app_name}' not found")

        containers = session.exec(
            select(ContainerModel).where(ContainerModel.app_name == app_name)
        ).all()
        container_count = len(containers)

        session.delete(app)
        session.commit()

    # Terminate worker subprocesses (no snapshot — app is being deleted).
    # Fire-and-forget: evict_app may take up to ~5 s per container (SIGTERM
    # grace period), so we don't await it in the request path.
    asyncio.create_task(get_pool().evict_app(app_name))

    return {"status": "deleted", "app": app_name, "containers_stopped": container_count}


@router.get("/{app_name}/pid")
async def get_app_pid(app_name: str) -> dict:
    """Return the host PID of the running process for an app.

    Used by SnapgpuClient.createSnapshot() so it can pass an explicit PID
    to CRIU rather than relying on auto-detection that isn't yet implemented.
    Uses pgrep -f to search the process command line for the app name.
    """
    try:
        result = subprocess.run(
            ["pgrep", "-f", app_name],
            capture_output=True, text=True, timeout=5,
        )
        pids = [int(p) for p in result.stdout.strip().split() if p.strip().isdigit()]
        if pids:
            return {"pid": pids[0], "found": True}
    except Exception:
        pass
    return {"pid": None, "found": False}


@router.post("/{app_name}/deploy")
async def deploy_app(app_name: str, body: DeployRequest) -> dict:
    """Deploy or update an app with new spec."""
    with get_session() as session:
        app = session.exec(select(AppModel).where(AppModel.name == app_name)).first()
        if not app:
            # Auto-create
            app = AppModel(name=app_name, status=AppStatus.DEPLOYING)

        app.spec = body.spec
        app.status = AppStatus.DEPLOYING
        app.updated_at = datetime.now(timezone.utc)
        session.add(app)
        session.commit()

    # Mark active immediately, then warm up one container in the background.
    with get_session() as session:
        app = session.exec(select(AppModel).where(AppModel.name == app_name)).first()
        if app:
            app.status = AppStatus.ACTIVE
            app.updated_at = datetime.now(timezone.utc)
            session.add(app)
            session.commit()

    # Pre-warm: acquire + immediately release a container so it's ready for
    # the first real request (avoids cold-start latency on first invoke).
    async def _warmup():
        pool = get_pool()
        try:
            container = await pool.acquire(app_name)
            pool.release(container.container_id)
        except Exception as exc:
            print(f"[deploy] warmup for '{app_name}' failed: {exc}", flush=True)

    asyncio.create_task(_warmup())

    return {
        "status": "deployed",
        "app": app_name,
        "functions": list(body.spec.get("functions", {}).keys()),
        "classes": list(body.spec.get("classes", {}).keys()),
    }
