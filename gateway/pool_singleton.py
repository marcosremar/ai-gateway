"""Module-level ContainerPool singleton shared by routes and main."""

import threading
from .scheduler.container_pool import ContainerPool

_pool: ContainerPool | None = None
_pool_lock = threading.Lock()


def get_pool() -> ContainerPool:
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = ContainerPool()
    return _pool
