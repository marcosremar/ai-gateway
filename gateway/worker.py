"""SnapGPU subprocess worker — receives pickled function calls and executes them.

Each ContainerPool slot runs one worker process (spawned by the gateway).
The worker binds a TCP server on 127.0.0.1, writes the chosen port to a
file so the pool can reconnect after CRIU restore, then loops accepting
connections and executing cloudpickle'd functions.

CRIU snapshot of a worker process captures:
  - All Python state: imports, class instances, loaded ML models
  - GPU memory via cuda-checkpoint (if enabled)
  - The TCP listening socket (CRIU restores listening sockets transparently)

After CRIU restore the worker resumes its accept() loop with models already
loaded — turning a 2-minute cold boot into a ~2-5 second restore.
"""

from __future__ import annotations
import argparse
import os
import pickle
import socket
import struct
import threading
from pathlib import Path


# ── Wire protocol: 4-byte big-endian length + pickle payload ────────────────

def _recv(conn: socket.socket) -> dict | None:
    header = b''
    while len(header) < 4:
        chunk = conn.recv(4 - len(header))
        if not chunk:
            return None
        header += chunk
    (length,) = struct.unpack('>I', header)
    data = b''
    while len(data) < length:
        chunk = conn.recv(length - len(data))
        if not chunk:
            return None
        data += chunk
    return pickle.loads(data)  # type: ignore[no-any-return]


def _send(conn: socket.socket, obj: object) -> None:
    payload = pickle.dumps(obj)
    conn.sendall(struct.pack('>I', len(payload)) + payload)


# ── Per-connection handler ───────────────────────────────────────────────────

def _handle(conn: socket.socket) -> None:
    try:
        msg = _recv(conn)
        if msg is None:
            return
        fn_bytes: bytes = msg['fn_data']
        args_bytes: bytes | None = msg.get('args_data')

        fn = pickle.loads(fn_bytes)
        args, kwargs = pickle.loads(args_bytes) if args_bytes else ((), {})
        result = fn(*args, **kwargs)
        _send(conn, {'status': 'ok', 'result': pickle.dumps(result)})
    except Exception as exc:
        try:
            _send(conn, {'status': 'error', 'error': str(exc)})
        except Exception:
            pass
    finally:
        conn.close()


# ── Entry point ──────────────────────────────────────────────────────────────

def main() -> None:
    import signal as _signal

    parser = argparse.ArgumentParser(description='SnapGPU function worker')
    parser.add_argument('--port-file', required=True,
                        help='File to write the chosen TCP port into')
    parser.add_argument('--app-name', default='default', help='App name (for log prefix)')
    args = parser.parse_args()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', 0))
    server.listen(16)

    port = server.getsockname()[1]
    port_path = Path(args.port_file)
    port_path.parent.mkdir(parents=True, exist_ok=True)
    port_path.write_text(str(port))

    print(f'[worker/{args.app_name}] pid={os.getpid()} port={port}', flush=True)

    # Graceful shutdown: SIGTERM closes the listening socket so accept() raises
    # OSError and the loop exits cleanly, finishing any in-flight requests.
    def _shutdown(signum: int, frame: object) -> None:
        print(f'[worker/{args.app_name}] SIGTERM received — shutting down', flush=True)
        try:
            server.close()
        except OSError:
            pass

    _signal.signal(_signal.SIGTERM, _shutdown)

    while True:
        try:
            conn, _ = server.accept()
            threading.Thread(target=_handle, args=(conn,), daemon=True).start()
        except OSError:
            break


if __name__ == '__main__':
    main()
