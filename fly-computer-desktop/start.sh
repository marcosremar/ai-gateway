#!/usr/bin/env bash
set -e
export DISPLAY=:0
rm -f /tmp/.X0-lock

ssh-keygen -A 2>/dev/null
mkdir -p /run/sshd
/usr/sbin/sshd -p 2222

Xvfb :0 -screen 0 1280x800x24 -ac +extension RANDR &
for _ in $(seq 1 40); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.3; done

fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :0 -forever -shared -nopw -rfbport 5900 -bg -o /tmp/x11vnc.log

/idle-stop.sh &

exec websockify --web=/usr/share/novnc '[::]:6080' localhost:5900
