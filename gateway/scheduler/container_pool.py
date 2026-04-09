"""Warm container pool with scale-to-zero and snapshot-based fast starts.

Each "container" is a subprocess running gateway/worker.py.  The worker
binds a TCP server on 127.0.0.1 and executes cloudpickle'd functions sent
by the gateway over that socket.

Cold-start flow:
  1. Spawn gateway/worker.py as a subprocess.
  2. Worker writes its chosen TCP port to a file and starts listening.
  3. Pool records the port in ContainerInfo; worker is now ready.

CRIU restore flow:
  1. SnapshotManager.restore() runs `criu restore` and returns the new PID.
  2. The restored process re-binds the same listening socket (CRIU restores
     TCP listening sockets transparently).
  3. Pool reads the port from snapshot.worker_port (stored at snapshot time)
     and connects directly — no port-file scanning needed.

Idle-timeout flow:
  1. cleanup_idle() finds containers idle > idle_timeout.
  2. Calls SnapshotManager.create() and records worker_port in snapshot DB row.
  3. Sends SIGTERM to the worker subprocess; updates DB.

Race-safety:
  Concurrent acquire() calls for the same app are serialised by a per-app
  asyncio.Lock stored in _acquire_locks.  This prevents duplicate cold-starts
  when two requests arrive before the first worker is ready.
"""

from __future__ import annotations
import asyncio
import os
import pickle
import signal
import socket
import struct
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from ..db import get_session, ContainerModel, ContainerStatus, SnapshotModel
from ..builder.snapshot import SnapshotManager
from sqlmodel import select

_WORKER_SCRIPT = str(Path(__file__).parent.parent / 'worker.py')
_PORT_DIR = Path('/tmp/snapgpu-workers')
_CALL_TIMEOUT = 60  # seconds


# ── SnapshotInfo — plain data transfer object, avoids SQLAlchemy detached-instance errors ──

@dataclass
class SnapshotInfo:
    """Snapshot metadata marshalled out of the DB session before it closes.

    We never pass SQLModel objects across session boundaries — SQLAlchemy's
    default expire_on_commit=True invalidates all attributes after session
    close, making attribute access on a "detached" instance raise
    DetachedInstanceError or silently return stale/None values.
    """
    snapshot_id: str
    app_name: str
    function_name: Optional[str]
    class_name: Optional[str]
    worker_port: int


# ── ContainerInfo ─────────────────────────────────────────────────────────────

@dataclass
class ContainerInfo:
    """In-memory representation of a running worker subprocess."""
    container_id: str
    app_name: str
    function_name: Optional[str]
    class_name: Optional[str]
    gpu_device: Optional[str]
    status: str
    pid: int = 0
    worker_port: int = 0        # TCP port the worker is listening on
    last_request_at: float = 0.0
    request_count: int = 0
    _proc: Any = field(default=None, repr=False)  # subprocess.Popen handle


# ── Worker TCP call ────────────────────────────────────────────────────────────

def _call_worker(port: int, fn_data: bytes, args_data: bytes | None) -> bytes:
    """Synchronously call the worker subprocess.  Returns pickled result bytes."""
    msg = {'fn_data': fn_data, 'args_data': args_data}
    payload = pickle.dumps(msg)
    header = struct.pack('>I', len(payload))

    with socket.create_connection(('127.0.0.1', port), timeout=_CALL_TIMEOUT) as conn:
        conn.sendall(header + payload)

        resp_header = b''
        while len(resp_header) < 4:
            chunk = conn.recv(4 - len(resp_header))
            if not chunk:
                raise RuntimeError('Worker closed connection before sending response')
            resp_header += chunk
        (length,) = struct.unpack('>I', resp_header)
        data = b''
        while len(data) < length:
            chunk = conn.recv(length - len(data))
            if not chunk:
                raise RuntimeError('Worker closed connection mid-response')
            data += chunk

    resp = pickle.loads(data)
    if resp.get('status') == 'error':
        raise RuntimeError(f"Worker error: {resp.get('error')}")
    return resp['result']


# ── ContainerPool ──────────────────────────────────────────────────────────────

class ContainerPool:
    """Manages warm worker subprocesses and handles scale-to-zero decisions."""

    def __init__(
        self,
        idle_timeout: int = 300,
        snapshot_dir: str = '/var/snapgpu/snapshots',
    ):
        self.idle_timeout = idle_timeout
        self.snapshot_dir = snapshot_dir
        self._snapshot_mgr = SnapshotManager(snapshot_dir)
        self._containers: dict[str, ContainerInfo] = {}
        self._app_containers: dict[str, list[str]] = {}
        # Per-app lock prevents concurrent cold-starts for the same app name.
        self._acquire_locks: dict[str, asyncio.Lock] = {}
        _PORT_DIR.mkdir(parents=True, exist_ok=True)

    # ── Public API ────────────────────────────────────────────────────────────

    async def acquire(
        self,
        app_name: str,
        function_name: Optional[str] = None,
        class_name: Optional[str] = None,
    ) -> ContainerInfo:
        # Treat empty strings as None so snapshot queries don't miss NULL rows
        function_name = function_name or None
        class_name = class_name or None
        """Return a ready container.  Priority: warm → snapshot restore → cold start.

        Serialised per app name: only one coroutine executes the cold-start/
        restore path at a time, preventing duplicate worker spawns.
        """
        # Fast path: check warm pool before acquiring lock
        container = self._find_warm(app_name, function_name, class_name)
        if container:
            container.status = 'running'
            container.last_request_at = time.time()
            container.request_count += 1
            return container

        if app_name not in self._acquire_locks:
            self._acquire_locks[app_name] = asyncio.Lock()

        async with self._acquire_locks[app_name]:
            # Re-check after acquiring lock (another coroutine may have started one)
            container = self._find_warm(app_name, function_name, class_name)
            if container:
                container.status = 'running'
                container.last_request_at = time.time()
                container.request_count += 1
                return container

            snapshot = await self._find_snapshot(app_name, function_name, class_name)
            if snapshot:
                container = await self._restore_from_snapshot(snapshot)
                if container:
                    return container

            return await self._cold_start(app_name, function_name, class_name)

    def release(self, container_id: str) -> None:
        """Mark container idle after a successful request completes."""
        info = self._containers.get(container_id)
        if info:
            info.status = 'idle'
            info.last_request_at = time.time()

    def release_dead(self, container_id: str) -> None:
        """Remove a container whose worker process has crashed.

        Called instead of release() when pool.call() raises, so the dead
        container is not returned to the idle pool and served to future callers.
        """
        info = self._containers.pop(container_id, None)
        if not info:
            return
        if info.app_name in self._app_containers:
            self._app_containers[info.app_name] = [
                c for c in self._app_containers[info.app_name] if c != container_id
            ]
        # Best-effort kill in case the process is still running
        if info.pid:
            try:
                os.kill(info.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        with get_session() as session:
            db_model = session.exec(
                select(ContainerModel).where(ContainerModel.container_id == container_id)
            ).first()
            if db_model:
                db_model.status = ContainerStatus.ERROR
                session.add(db_model)
                session.commit()
        print(f'[pool] removed dead container {container_id}', flush=True)

    async def call(
        self,
        container: ContainerInfo,
        fn_data: bytes,
        args_data: bytes | None,
    ) -> bytes:
        """Execute fn inside the worker subprocess and return pickled result."""
        return await asyncio.to_thread(_call_worker, container.worker_port, fn_data, args_data)

    async def restore_from_snapshot_id(self, snapshot_id: str) -> Optional[ContainerInfo]:
        """Public entry point: look up snapshot by ID and restore it."""
        snap_info: Optional[SnapshotInfo] = None
        with get_session() as session:
            snap = session.exec(
                select(SnapshotModel).where(SnapshotModel.snapshot_id == snapshot_id)
            ).first()
            if snap:
                snap_info = SnapshotInfo(
                    snapshot_id=snap.snapshot_id,
                    app_name=snap.app_name,
                    function_name=snap.function_name,
                    class_name=snap.class_name,
                    worker_port=snap.worker_port or 0,
                )
        if not snap_info:
            print(f'[pool] Snapshot {snapshot_id} not found in DB', flush=True)
            return None
        return await self._restore_from_snapshot(snap_info)

    async def cleanup_idle(self) -> None:
        """Stop containers that have been idle longer than idle_timeout."""
        now = time.time()
        to_stop = [
            cid for cid, info in list(self._containers.items())
            if info.status == 'idle' and (now - info.last_request_at) > self.idle_timeout
        ]
        for cid in to_stop:
            await self._stop_container(cid, create_snapshot=True)

    # ── Private helpers ────────────────────────────────────────────────────────

    def _find_warm(
        self, app_name: str, function_name: Optional[str], class_name: Optional[str]
    ) -> Optional[ContainerInfo]:
        for cid in self._app_containers.get(app_name, []):
            info = self._containers.get(cid)
            if not info or info.status != 'idle':
                continue
            if function_name and info.function_name != function_name:
                continue
            if class_name and info.class_name != class_name:
                continue
            return info
        return None

    async def _find_snapshot(
        self, app_name: str, function_name: Optional[str], class_name: Optional[str]
    ) -> Optional[SnapshotInfo]:
        """Return the latest matching snapshot as a plain SnapshotInfo DTO.

        We marshal attributes out before the session closes to avoid SQLAlchemy
        DetachedInstanceError when the caller accesses fields later.
        """
        with get_session() as session:
            query = select(SnapshotModel).where(SnapshotModel.app_name == app_name)
            if function_name:
                query = query.where(SnapshotModel.function_name == function_name)
            if class_name:
                query = query.where(SnapshotModel.class_name == class_name)
            # Only snapshots that have a stored port (created by this pool implementation).
            # Use != None — SQLAlchemy rewrites this to IS NOT NULL.
            query = query.where(SnapshotModel.worker_port != None)  # noqa: E711
            query = query.order_by(SnapshotModel.created_at.desc())  # type: ignore[arg-type]
            snap = session.exec(query).first()
            if snap is None:
                return None
            # Marshal while session is still open
            return SnapshotInfo(
                snapshot_id=snap.snapshot_id,
                app_name=snap.app_name,
                function_name=snap.function_name,
                class_name=snap.class_name,
                worker_port=snap.worker_port or 0,
            )

    async def _cold_start(
        self, app_name: str, function_name: Optional[str], class_name: Optional[str]
    ) -> ContainerInfo:
        """Spawn a new worker subprocess and wait for it to be ready."""
        container_id = f'snap-{app_name}-{uuid.uuid4().hex[:12]}'
        port_file = str(_PORT_DIR / f'{container_id}.port')

        # Redirect stdout/stderr to DEVNULL.  The port is communicated via the
        # port_file, NOT stdout.  Using PIPE here would fill the 64 KB kernel
        # buffer and deadlock the worker if it emits verbose output (e.g. model
        # loading logs) before the pool reads from the pipe.
        proc = await asyncio.to_thread(
            subprocess.Popen,
            [sys.executable, _WORKER_SCRIPT, '--port-file', port_file, '--app-name', app_name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        port = await asyncio.to_thread(_wait_for_port_file, port_file, timeout=10.0)
        if not port:
            proc.kill()
            # Reap the zombie so it doesn't linger; ignore timeout if already dead
            await asyncio.to_thread(_reap_proc, proc)
            raise RuntimeError(f'Worker for {app_name} did not start within 10s')

        await asyncio.to_thread(_wait_for_connection, port, timeout=5.0)

        info = ContainerInfo(
            container_id=container_id,
            app_name=app_name,
            function_name=function_name,
            class_name=class_name,
            gpu_device=None,
            status='running',
            pid=proc.pid,
            worker_port=port,
            last_request_at=time.time(),
            request_count=1,
            _proc=proc,
        )
        self._register(info)
        print(f'[pool] cold-start {container_id} pid={proc.pid} port={port}', flush=True)
        return info

    async def _restore_from_snapshot(self, snapshot: SnapshotInfo) -> Optional[ContainerInfo]:
        """CRIU-restore a worker process from a snapshot.

        Accepts a SnapshotInfo DTO (not a SQLModel) so there is no risk of
        DetachedInstanceError — all attributes were marshalled before the DB
        session closed.

        The worker's TCP port is stored in snapshot.worker_port — set when the
        snapshot was created by _stop_container.  After CRIU restore the process
        is listening on the same port again; we connect directly without scanning
        any port files.
        """
        if not snapshot.worker_port:
            print(f'[pool] Snapshot {snapshot.snapshot_id} has no worker_port — cannot restore', flush=True)
            return None

        pid = await asyncio.to_thread(self._snapshot_mgr.restore, snapshot.snapshot_id)
        if not pid:
            print(f'[pool] CRIU restore of {snapshot.snapshot_id} failed — falling back to cold start', flush=True)
            return None

        # Verify the restored process is accepting connections (up to 10 s)
        try:
            await asyncio.to_thread(_wait_for_connection, snapshot.worker_port, timeout=10.0)
        except RuntimeError:
            # Process restored but not responding — kill it to avoid a ghost
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            print(f'[pool] Restored worker (pid={pid}) not responding on port {snapshot.worker_port} — killed', flush=True)
            return None

        container_id = f'snap-{snapshot.app_name}-{int(time.time() * 1000)}'
        info = ContainerInfo(
            container_id=container_id,
            app_name=snapshot.app_name,
            function_name=snapshot.function_name,
            class_name=snapshot.class_name,
            gpu_device=None,
            status='running',
            pid=pid,
            worker_port=snapshot.worker_port,
            last_request_at=time.time(),
            request_count=1,
        )
        self._register(info)
        print(f'[pool] restored {snapshot.snapshot_id} → pid={pid} port={snapshot.worker_port}', flush=True)
        return info

    async def _stop_container(self, container_id: str, create_snapshot: bool = True) -> None:
        """Checkpoint (optionally) and stop a worker subprocess."""
        info = self._containers.get(container_id)
        if not info:
            return

        # Mark stopping immediately so _find_warm skips this container during
        # the SIGTERM grace period — prevents a new request from grabbing it.
        info.status = 'stopping'

        if create_snapshot and self._snapshot_mgr.criu_available and info.pid:
            with get_session() as session:
                db_model = session.exec(
                    select(ContainerModel).where(ContainerModel.container_id == container_id)
                ).first()
                image_tag = db_model.image_tag if db_model else ''
            snap_id = await asyncio.to_thread(
                self._snapshot_mgr.create,
                container_id,
                info.app_name,
                info.pid,
                function_name=info.function_name,
                class_name=info.class_name,
                image_tag=image_tag,
                include_gpu=True,
            )
            if snap_id:
                # Store worker_port in the snapshot so restore can connect directly.
                with get_session() as session:
                    snap = session.exec(
                        select(SnapshotModel).where(SnapshotModel.snapshot_id == snap_id)
                    ).first()
                    if snap:
                        snap.worker_port = info.worker_port
                        session.add(snap)
                        session.commit()
                print(f'[pool] checkpointed {container_id} → {snap_id} (port={info.worker_port})', flush=True)

        # Send SIGTERM; escalate to SIGKILL after 5 s; reap zombie via proc.wait()
        if info.pid:
            try:
                os.kill(info.pid, signal.SIGTERM)
                await asyncio.sleep(5)
                try:
                    os.kill(info.pid, 0)   # still alive?
                    os.kill(info.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            except ProcessLookupError:
                pass
            # Reap the subprocess so it doesn't linger as a zombie
            if info._proc is not None:
                try:
                    await asyncio.to_thread(info._proc.wait, 2)
                except Exception:
                    pass

        # Clean up port file (not needed: port is in snapshot DB row)
        (_PORT_DIR / f'{container_id}.port').unlink(missing_ok=True)

        del self._containers[container_id]
        if info.app_name in self._app_containers:
            self._app_containers[info.app_name] = [
                c for c in self._app_containers[info.app_name] if c != container_id
            ]

        with get_session() as session:
            db_model = session.exec(
                select(ContainerModel).where(ContainerModel.container_id == container_id)
            ).first()
            if db_model:
                db_model.status = ContainerStatus.STOPPED
                session.add(db_model)
                session.commit()

    def _register(self, info: ContainerInfo) -> None:
        """Add a ContainerInfo to in-memory and DB registries."""
        self._containers[info.container_id] = info
        self._app_containers.setdefault(info.app_name, []).append(info.container_id)

        with get_session() as session:
            model = ContainerModel(
                container_id=info.container_id,
                app_name=info.app_name,
                function_name=info.function_name,
                class_name=info.class_name,
                status=ContainerStatus.RUNNING,
            )
            session.add(model)
            session.commit()

    def get_port_for_pid(self, pid: int) -> Optional[int]:
        """Return the TCP port of a running worker with the given PID, or None."""
        for info in self._containers.values():
            if info.pid == pid:
                return info.worker_port
        return None

    async def evict_app(self, app_name: str) -> None:
        """Stop all containers for an app without creating snapshots.

        Called by delete_app so worker processes are actually terminated,
        not just marked 'stopping' in the DB.
        """
        cids = list(self._app_containers.get(app_name, []))
        for cid in cids:
            await self._stop_container(cid, create_snapshot=False)

    # ── Stats ─────────────────────────────────────────────────────────────────

    @property
    def stats(self) -> dict:
        running = sum(1 for c in self._containers.values() if c.status == 'running')
        idle = sum(1 for c in self._containers.values() if c.status == 'idle')
        return {
            'total': len(self._containers),
            'running': running,
            'idle': idle,
            'apps': len(self._app_containers),
        }


# ── I/O helpers (run in a thread so they don't block the event loop) ──────────

def _wait_for_port_file(port_file: str, timeout: float) -> Optional[int]:
    """Poll until the worker writes its port file, then return the port."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            text = Path(port_file).read_text().strip()
            if text.isdigit():
                return int(text)
        except FileNotFoundError:
            pass
        time.sleep(0.1)
    return None


def _reap_proc(proc: subprocess.Popen, timeout: float = 2.0) -> None:
    """Wait for a process to exit; ignore errors (process may already be gone)."""
    try:
        proc.wait(timeout=timeout)
    except Exception:
        pass


def _wait_for_connection(port: int, timeout: float) -> None:
    """Probe TCP port until the worker is accepting connections."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f'Worker TCP port {port} not ready after {timeout}s')
