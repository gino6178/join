#!/usr/bin/env bash
# A public HTTPS address for a Join running on this machine, through a free Cloudflare quick tunnel (no account).
# With it, PayPal can reach Join: payers come back to the return URLs, and Join subscribes itself to PayPal's webhooks
# (14 events, verified with verify-webhook-signature) on its next start, because PUBLIC_URL is HTTPS.
#   deploy/tunnel.sh            start the tunnel and print the address
#   deploy/tunnel.sh --apply    also set PUBLIC_URL in api/.env to it and restart Join (deploy/start.sh)
#   deploy/tunnel.sh stop       stop the tunnel
# Anyone with the address can reach the site, and demo sign-in has no password: turn it off (DEMO_SIGNIN=0) unless
# that's what you want. A quick tunnel's address changes every time it starts.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${JOIN_RUN:-$HOME/join-run}"
PORT="${PORT:-$(grep -E '^PORT=' "$ROOT/api/.env" 2>/dev/null | cut -d= -f2)}"; PORT="${PORT:-8790}"
CLOUDFLARED="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/bin/cloudflared")}"
mkdir -p "$RUN/logs"
LOG="$RUN/logs/tunnel.log"

if [ "${1:-}" = "stop" ]; then pkill -u "$USER" -f "[c]loudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT" && echo "tunnel stopped"; exit 0; fi

if ! pgrep -u "$USER" -f "[c]loudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT" >/dev/null; then
  : > "$LOG"
  setsid nohup "$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > "$LOG" 2>&1 < /dev/null &
fi
URL=""
for i in $(seq 40); do URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)"; [ -n "$URL" ] && break; sleep 0.5; done
[ -z "$URL" ] && { echo "no address yet; see $LOG"; exit 1; }
echo "Join is public at $URL (port $PORT)"

if [ "${1:-}" = "--apply" ]; then
  if grep -qE '^PUBLIC_URL=' "$ROOT/api/.env"; then sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=$URL|" "$ROOT/api/.env"; else echo "PUBLIC_URL=$URL" >> "$ROOT/api/.env"; fi
  "$ROOT/deploy/start.sh" stop >/dev/null 2>&1; PORT="$PORT" "$ROOT/deploy/start.sh"
  echo "PUBLIC_URL set; Join restarted and will register PayPal's webhooks at $URL/paypal/webhook"
fi
