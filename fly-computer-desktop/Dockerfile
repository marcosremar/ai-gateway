FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:0

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify fluxbox \
      xdotool scrot x11-utils dbus-x11 xprintidle iproute2 curl \
      openssh-server \
      chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY authorized_keys /root/.ssh/authorized_keys
COPY start.sh /start.sh
COPY idle-stop.sh /idle-stop.sh
RUN chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys && chmod +x /start.sh /idle-stop.sh

EXPOSE 6080
CMD ["/start.sh"]
