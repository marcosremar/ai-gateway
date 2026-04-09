"""Function invocation endpoint — the core execution path."""

from __future__ import annotations
import base64
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..db import get_session, AppModel, TaskModel, TaskStatus
from ..pool_singleton import get_pool
from sqlmodel import select

router = APIRouter(prefix='/v1/invoke', tags=['invoke'])


class InvokeRequest(BaseModel):
    fn_data: Optional[str] = None    # Base64 cloudpickle'd function
    args_data: Optional[str] = None  # Base64 cloudpickle'd (args, kwargs)
    args: Optional[dict] = None      # JSON args (alternative to pickle)
    async_mode: bool = False


class InvokeResponse(BaseModel):
    status: str
    result: Optional[str] = None      # Base64 pickled result
    task_id: Optional[str] = None
    container_id: Optional[str] = None
    latency_ms: Optional[float] = None


@router.post('/{app_name}/{fn_name}')
async def invoke_function(app_name: str, fn_name: str, body: InvokeRequest) -> InvokeResponse:
    """Invoke a registered function on a warm worker subprocess.

    The pool acquires a warm container (or cold-starts / CRIU-restores one),
    executes the pickled function inside that subprocess, then releases it
    back to the idle pool.
    """
    # Validate app exists
    with get_session() as session:
        app = session.exec(select(AppModel).where(AppModel.name == app_name)).first()
        if not app:
            raise HTTPException(404, f"App '{app_name}' not found")

        spec = app.spec
        fn_spec = spec.get('functions', {}).get(fn_name)
        cls_spec = None
        if not fn_spec:
            for cls_name, cls_data in spec.get('classes', {}).items():
                if fn_name in cls_data.get('methods', []):
                    cls_spec = cls_data
                    break
            if not cls_spec:
                raise HTTPException(404, f"Function '{fn_name}' not found in app '{app_name}'")

    # Async mode — queue and return immediately
    if body.async_mode:
        task_id = str(uuid.uuid4())
        with get_session() as session:
            task = TaskModel(
                task_id=task_id,
                app_name=app_name,
                function_name=fn_name,
                status=TaskStatus.PENDING,
            )
            session.add(task)
            session.commit()
        return InvokeResponse(status='queued', task_id=task_id)

    if not body.fn_data:
        raise HTTPException(400, 'fn_data (base64 cloudpickle function) is required')

    try:
        fn_bytes = base64.b64decode(body.fn_data)
        args_bytes = base64.b64decode(body.args_data) if body.args_data else None
    except Exception:
        raise HTTPException(400, 'fn_data / args_data must be valid base64')

    # Determine whether we matched a function or a class method, so the pool
    # can route to a function-specific warm container if one exists.
    matched_function = fn_name if fn_spec else None
    matched_class = None
    if cls_spec:
        for cls_name, cls_data in spec.get('classes', {}).items():
            if fn_name in cls_data.get('methods', []):
                matched_class = cls_name
                break

    start = datetime.now(timezone.utc)
    pool = get_pool()
    container = None
    dead = False
    try:
        container = await pool.acquire(app_name, function_name=matched_function, class_name=matched_class)
        result_bytes = await pool.call(container, fn_bytes, args_bytes)
        elapsed = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        return InvokeResponse(
            status='completed',
            result=base64.b64encode(result_bytes).decode(),
            container_id=container.container_id,
            latency_ms=elapsed,
        )
    except Exception as exc:
        dead = True
        elapsed = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        raise HTTPException(500, f'Worker execution failed: {exc}') from exc
    finally:
        if container is not None:
            if dead:
                pool.release_dead(container.container_id)
            else:
                pool.release(container.container_id)


@router.get('/{app_name}/{fn_name}/status/{task_id}')
async def get_task_status(app_name: str, fn_name: str, task_id: str) -> dict:
    """Check status of an async task."""
    with get_session() as session:
        task = session.exec(select(TaskModel).where(TaskModel.task_id == task_id)).first()
        if not task:
            raise HTTPException(404, f"Task '{task_id}' not found")
        return {
            'task_id': task.task_id,
            'status': task.status,
            'result': task.result_data if task.status == 'completed' else None,
            'error': task.error if task.status == 'failed' else None,
            'created_at': task.created_at.isoformat(),
            'completed_at': task.completed_at.isoformat() if task.completed_at else None,
        }
