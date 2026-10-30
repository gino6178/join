#!/usr/bin/env bash
# Bring up Serve's server side, leaving alone whatever already runs: Muse Glimmer on its own Ollama (GPU 1, port 11435),
# Llama Guard 3 1B on a CPU Ollama (port 11436) when ollama/guard.sh is there, and the
# agent gateway on port 8790.
# The script goes in the deployment's root, beside ollama/, agent/ and pose/:
#   ./start.sh          start what is not running yet
#   ./start.sh stop     stop these services (an `ollama pull` that is still going stops with them)
# What differs from one machine to the next comes from the environment, or from start.env next to this script, which
# is read first when it is there: NODE_BIN (the node binary; default: node on the PATH), REEL_PYTHON (a Python with
# torch and transformers, for highlight reels; unset, reels stay off) and REEL_HF_CACHE (the Hugging Face cache for the
# reel and memory models; unset, Hugging Face's own default).
set -o nounset # an unset variable stops the script rather than reading as empty
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
if [ -f "$ROOT/start.env" ]; then . "$ROOT/start.env"; fi
NODE_BIN="${NODE_BIN:-node}"
listening() { ss -Hltn "sport = :$1" | grep -q .; } # something listens on TCP port $1
if [ "${1:-}" = "stop" ]; then
  fuser -k 11435/tcp 11436/tcp 8790/tcp 2>/dev/null
  echo "stopped Glimmer, Llama Guard and the gateway"
  exit 0
fi
# Each service is forked into a session of its own (setsid -f), so it keeps running when this script and the ssh
# login that ran it are gone.
if listening 11435; then
  echo "Ollama :11435 already running"
else
  (cd "$ROOT/ollama" && setsid -f ./serve.sh >> ollama.log 2>&1 < /dev/null)
  echo "Muse Glimmer (Ollama) is starting on :11435 on GPU 1; log: $ROOT/ollama/ollama.log"
  # ask for the model at once, so the first player does not wait: loading reads about 17 GB and takes minutes
  setsid -f bash -c 'sleep 5; curl -s -m 600 127.0.0.1:11435/api/generate -d "{\"model\":\"muse-glimmer\",\"keep_alive\":\"24h\",\"prompt\":\"\"}" > /dev/null' < /dev/null > /dev/null 2>&1
fi
# Llama Guard 3 1B on the CPU (its own Ollama, port 11436): the safety check on what the player writes and what a model
# writes for them (agent/src/guard.js)
if [ -x "$ROOT/ollama/guard.sh" ] && ! listening 11436; then
  cd "$ROOT/ollama" && setsid -f ./guard.sh >> "$ROOT/ollama/guard.log" 2>&1 < /dev/null
  echo "Llama Guard (Ollama, CPU) starting on :11436, log: $ROOT/ollama/guard.log"
fi
if listening 8790; then
  echo "gateway :8790 already running (to restart it: $0 stop && $0)"
  exit 0
fi
# the gateway talks to the Glimmer above, and to the embedding model on the machine's main Ollama (port 11434)
(
  cd "$ROOT/agent" || exit 1
  export PORT=8790 LLM_URL=http://127.0.0.1:11435/v1 LLM_MODEL=muse-glimmer LLM_DEVICE="RTX 3090 (CUDA)"
  export EMBED_URL=http://127.0.0.1:11434 ALLOW_ORIGINS=http://127.0.0.1:5191,http://localhost:5191
  export REEL_PYTHON="${REEL_PYTHON:-}" REEL_SCRIPT="$ROOT/pose/reel.py" REEL_GPU=0 REEL_HF_CACHE="${REEL_HF_CACHE:-}"
  # the highlight's camera effect (zoom and cut, a short orbit): docs/web_features.md
  export REEL_EFFECTS_SCRIPT="${REEL_EFFECTS_SCRIPT:-$ROOT/orbit/orbit.py}" REEL_EFFECTS_PYTHON="${REEL_EFFECTS_PYTHON:-$ROOT/orbit/venv/bin/python}"
  export ORBIT_MAPANYTHING="${ORBIT_MAPANYTHING:-$ROOT/orbit/weights/map-anything-apache}"
  setsid -f "$NODE_BIN" --unhandled-rejections=warn src/server.js >> "$ROOT/agent/gateway.log" 2>&1 < /dev/null
  echo "$(date "+%F %T") gateway starting on :8790 -> muse-glimmer" >> "$ROOT/agent/gateway.log"
)
echo "gateway is starting on :8790 with muse-glimmer; log: $ROOT/agent/gateway.log"
