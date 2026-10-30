"""Prompt Guard 2 for Serve (guard.js): reads one JSON line per request, {"texts": [...]}, and answers one JSON line,
{"scores": [...]}, the probability that each text is written to instruct a model (a prompt injection or jailbreak).
The model stays loaded; it runs on the CPU. PROMPT_GUARD names it (Llama-Prompt-Guard-2-86M by default) and
PROMPT_GUARD_REVISION pins its commit; files come from the local Hugging Face cache (guard.js sets HF_HUB_OFFLINE).
"""
import json
import os
import sys

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

name = os.environ.get("PROMPT_GUARD", "meta-llama/Llama-Prompt-Guard-2-86M")
rev = os.environ.get("PROMPT_GUARD_REVISION") or None
local = os.environ.get("HF_HUB_OFFLINE") == "1"
try:
    tok = AutoTokenizer.from_pretrained(name, revision=rev, local_files_only=local)
    model = AutoModelForSequenceClassification.from_pretrained(name, revision=rev, local_files_only=local).eval()
except Exception as e:  # not downloaded, or the terms not accepted on Hugging Face
    for _ in sys.stdin:
        print(json.dumps({"error": f"Prompt Guard is not available ({type(e).__name__})"}), flush=True)
    sys.exit(0)
torch.set_num_threads(int(os.environ.get("GUARD_THREADS", "4")))

for line in sys.stdin:
    try:
        texts = json.loads(line).get("texts", [])
        with torch.no_grad():
            enc = tok(texts, return_tensors="pt", padding=True, truncation=True, max_length=512)
            probs = torch.softmax(model(**enc).logits, dim=-1)
        # the last label is the malicious one (LABEL_1)
        print(json.dumps({"scores": probs[:, -1].tolist()}), flush=True)
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"[:200]}), flush=True)
