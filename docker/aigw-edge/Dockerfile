# aigw-edge — the generic realtime sidecar of every ai-gateway GPU replica (docs/realtime-edge.md). CPU only: it never
# loads a model; it reaches the model container over HTTP on 127.0.0.1 (EDGE_UPSTREAM). The gateway's cloud-init runs it
# with `docker run --network host --env-file /srv/aigw/edge.env` when a deployment sets `realtime`.
#   docker build -t ghcr.io/marcosremar/aigw-edge:<tag> docker/aigw-edge
# Licenses: aiortc / aioice / pylibsrtp (BSD-3), PyAV (BSD-3; bundles FFmpeg LGPL + libopus BSD), aiohttp (Apache-2),
# numpy (BSD-3), cryptography (Apache-2/BSD). ~330 MB image (python:3.12-slim + wheels), nothing next to the models.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --only-binary :all: -r requirements.txt
COPY telemetry.py ./
COPY aigw_edge ./aigw_edge
# Unprivileged: the edge binds 127.0.0.1:8020 and UDP ≥ 10000 only.
USER 65534:65534
CMD ["python", "-m", "aigw_edge"]
