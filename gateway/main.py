"""SnapGPU Gateway — FastAPI control plane."""

from __future__ import annotations
import asyncio
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI

from .db import get_engine
from .pool_singleton import get_pool
from .routes import health, apps, invoke, images, snapshots


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    get_engine()

    # ── Optional: restore from a pre-existing snapshot at boot ────────────────
    # When SNAPGPU_RESTORE_SNAPSHOT_ID is set (injected by SnapgpuClient), skip
    # cold start and CRIU-restore the previous worker state instead.
    restore_id = os.environ.get('SNAPGPU_RESTORE_SNAPSHOT_ID', '')
    preload_app = os.environ.get('SNAPGPU_PRELOAD_APP', '')

    if restore_id and preload_app:
        print(f'[snapgpu-gateway] Restoring snapshot {restore_id} for app {preload_app}', flush=True)
        pool = get_pool()
        try:
            container = await pool.restore_from_snapshot_id(restore_id)
            if container:
                pool.release(container.container_id)
                print(f'[snapgpu-gateway] Restored {restore_id} → pid={container.pid} port={container.worker_port}', flush=True)
            else:
                print(f'[snapgpu-gateway] Restore failed — will cold-start on first request', flush=True)
        except Exception as exc:
            print(f'[snapgpu-gateway] Restore error: {exc} — will cold-start on first request', flush=True)

    elif preload_app:
        # No snapshot yet: pre-warm a cold-start worker so model loads now,
        # not on the first real request.
        print(f'[snapgpu-gateway] Pre-warming app {preload_app}', flush=True)
        pool = get_pool()
        try:
            container = await pool.acquire(preload_app)
            pool.release(container.container_id)
            print(f'[snapgpu-gateway] Pre-warm done — worker pid={container.pid} port={container.worker_port}', flush=True)
        except Exception as exc:
            print(f'[snapgpu-gateway] Pre-warm error: {exc}', flush=True)

    # ── Background idle-cleanup task ──────────────────────────────────────────
    cleanup_task = asyncio.create_task(_idle_cleanup_loop())

    def _on_cleanup_done(t: asyncio.Task) -> None:
        if t.cancelled():
            return
        exc = t.exception()
        if exc:
            print(f'[snapgpu-gateway] Idle-cleanup task ended unexpectedly: {exc}', flush=True)

    cleanup_task.add_done_callback(_on_cleanup_done)

    print('[snapgpu-gateway] Started', flush=True)
    yield

    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    print('[snapgpu-gateway] Shutting down', flush=True)


async def _idle_cleanup_loop() -> None:
    """Periodically checkpoint and stop idle worker subprocesses."""
    while True:
        await asyncio.sleep(60)
        try:
            await get_pool().cleanup_idle()
        except Exception as exc:
            print(f'[snapgpu-gateway] Idle-cleanup error: {exc}', flush=True)


app = FastAPI(
    title='SnapGPU Gateway',
    description='GPU serverless control plane — deploy, invoke, and manage GPU functions',
    version='0.1.0',
    lifespan=lifespan,
)

app.include_router(health.router)
app.include_router(apps.router)
app.include_router(invoke.router)
app.include_router(images.router)
app.include_router(snapshots.router)


@app.get('/')
async def root():
    return {
        'service': 'snapgpu-gateway',
        'version': '0.1.0',
        'docs': '/docs',
    }


def start():
    """Entry point for `snapgpu gateway` or `uvicorn gateway.main:app`."""
    import uvicorn
    port = int(os.environ.get('SNAPGPU_PORT', '8000'))
    uvicorn.run(app, host='0.0.0.0', port=port)


if __name__ == '__main__':
    start()
