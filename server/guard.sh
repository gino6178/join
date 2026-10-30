#!/usr/bin/env bash
# Llama Guard 3 1B for Serve, on the CPU: its own Ollama on port 11436, so it takes no GPU memory from Muse Glimmer.
# start.sh runs it from ollama/guard.sh. OLLAMA_BIN and OLLAMA_MODELS can point elsewhere (pull: OLLAMA_HOST=127.0.0.1:11436 ollama pull llama-guard3:1b).
cd "$(dirname "$0")"
CUDA_VISIBLE_DEVICES="" GGML_VK_VISIBLE_DEVICES=-1 OLLAMA_VULKAN=0 OLLAMA_HOST=127.0.0.1:11436 OLLAMA_NUM_PARALLEL=2 OLLAMA_KEEP_ALIVE=24h \
OLLAMA_MODELS="${OLLAMA_MODELS:-$HOME/.ollama/models}" exec "${OLLAMA_BIN:-ollama}" serve
