#!/usr/bin/env bash
# (Re)start the watchdog for the Meta entry, which keeps Muse Glimmer and the gateway running.
#   ~/shuttlecoach-meta/up.sh          restart the watchdog (the services come up within 30 s)
#   ~/shuttlecoach-meta/up.sh stop     stop the watchdog and the services
ROOT="$(cd "$(dirname "$0")" && pwd)"
pkill -f "$ROOT/[w]atch.sh"
if [ "${1:-}" = "stop" ]; then "$ROOT/start.sh" stop; exit 0; fi
setsid -f "$ROOT/watch.sh" > /dev/null 2>&1 < /dev/null
echo "watchdog started"
