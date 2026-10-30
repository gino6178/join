#!/usr/bin/env bash
# Start Join on a Linux machine with an NVIDIA card: its own Ollama with Qwen2.5 0.5B for the website agent, a local
# Hardhat chain for receipt anchoring, and the Join server. Safe to run again: what's running is left alone.
#   deploy/start.sh          start (Join on :8790, Ollama on 127.0.0.1:11437, the chain on 127.0.0.1:8545)
#   deploy/start.sh stop     stop all three
# Settings: OLLAMA_BIN (an ollama binary), NODE_BIN (node 20+), GPU (CUDA device, default 0), PUBLIC_URL, PORT.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${JOIN_RUN:-$HOME/join-run}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
OLLAMA_BIN="${OLLAMA_BIN:-$(command -v ollama)}"
NPM="$(dirname "$NODE_BIN")/npm"
OLLAMA_PORT=11437 MODEL="${SCOUT_MODEL:-qwen2.5:0.5b}"
mkdir -p "$RUN/ollama/models" "$RUN/logs"

stop() {
  fuser -k "$OLLAMA_PORT/tcp" 2>/dev/null; pkill -u "$USER" -f "[h]ardhat node --hostname 127.0.0.1 --port 8545"
  pkill -u "$USER" -f "${ROOT}/api/src/[s]erver.js"
  echo "stopped"
}
[ "${1:-}" = "stop" ] && { stop; exit 0; }

# Ollama for Join only (its own port and model folder), so it never touches another app's Ollama
if ! curl -s "127.0.0.1:$OLLAMA_PORT/api/tags" >/dev/null; then
  ( cd "$RUN/ollama" && env CUDA_VISIBLE_DEVICES="${GPU:-0}" OLLAMA_VULKAN=0 OLLAMA_CONTEXT_LENGTH=4096 OLLAMA_KEEP_ALIVE=24h \
      OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT" OLLAMA_MODELS="$RUN/ollama/models" setsid nohup "$OLLAMA_BIN" serve > "$RUN/logs/ollama.log" 2>&1 < /dev/null & )
  for i in $(seq 20); do curl -s "127.0.0.1:$OLLAMA_PORT/api/tags" >/dev/null && break; sleep 0.5; done
  echo "ollama on 127.0.0.1:$OLLAMA_PORT (GPU ${GPU:-0}), log: $RUN/logs/ollama.log"
else echo "ollama already running on :$OLLAMA_PORT"; fi
OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT" "$OLLAMA_BIN" list | grep -q "^$MODEL" || OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT" "$OLLAMA_BIN" pull "$MODEL"

# the local chain for receipts (development accounts only)
if ! pgrep -u "$USER" -f "[h]ardhat node --hostname 127.0.0.1 --port 8545" >/dev/null; then
  ( cd "$ROOT/chain" && PATH="$(dirname "$NODE_BIN"):$PATH" setsid nohup "$NPM" run chain > "$RUN/logs/chain.log" 2>&1 < /dev/null & )
  for i in $(seq 30); do curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' 127.0.0.1:8545 >/dev/null && break; sleep 1; done
  echo "chain on 127.0.0.1:8545, log: $RUN/logs/chain.log"
else echo "chain already running"; fi

if ! pgrep -u "$USER" -f "${ROOT}/api/src/[s]erver.js" >/dev/null; then
  ( cd "$ROOT/api" && SCOUT_LLM_URL="http://127.0.0.1:$OLLAMA_PORT" SCOUT_MODEL="$MODEL" setsid nohup "$NODE_BIN" "$ROOT/api/src/server.js" > "$RUN/logs/join.log" 2>&1 < /dev/null & )
  echo "Join on :${PORT:-8790} (website agent: $MODEL), log: $RUN/logs/join.log"
else echo "Join already running (restart with: $0 stop && $0)"; fi
