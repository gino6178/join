#!/usr/bin/env bash
# Ollama for Serve: its own instance on one GPU, port 11435, with the settings every measurement in the README used
# (a 16,384-token context, 4 requests in parallel, CUDA only). start.sh runs it from ollama/serve.sh. GPU, OLLAMA_BIN and
# OLLAMA_MODELS can point elsewhere: on our server the models sit on a NAS folder (the root disk is nearly full) and
# the binary is an Ollama already installed there, so its copy sets both.
cd "$(dirname "$0")"
CUDA_VISIBLE_DEVICES="${GPU:-1}" GGML_VK_VISIBLE_DEVICES=-1 OLLAMA_VULKAN=0 OLLAMA_CONTEXT_LENGTH=16384 OLLAMA_NUM_PARALLEL=4 OLLAMA_KEEP_ALIVE=24h OLLAMA_HOST=127.0.0.1:11435 OLLAMA_MODELS="${OLLAMA_MODELS:-$HOME/.ollama/models}" exec "${OLLAMA_BIN:-ollama}" serve
