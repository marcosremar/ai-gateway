FROM ubuntu:24.04
RUN apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker:cli /usr/local/bin/docker /usr/bin/docker
# Container stand-ins for the VM's init system: systemctl restarts nginx, shutdown is a no-op.
RUN printf '#!/bin/sh\nnginx -s stop 2>/dev/null; sleep 0.5; nginx\n' > /usr/local/bin/systemctl && chmod +x /usr/local/bin/systemctl \
 && printf '#!/bin/sh\necho "shutdown $*" >> /srv/shutdown.log\n' > /usr/local/sbin/shutdown && chmod +x /usr/local/sbin/shutdown
