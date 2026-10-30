"""Text embeddings for Serve's memory (memory.js), with Meta's DRAMA (facebook/drama-base, CC BY-NC 4.0), on the CPU.

DRAMA is a pruned Llama with bidirectional attention, mean pooling and normalization; queries get "Query: " in front.
That is done here on a plain LlamaModel (no code from the model repository is run): attention is made bidirectional by
passing a 4D padding-only mask, so no token is hidden from another. Matryoshka-trained, so vectors can be cut to `dim`.

Reads one JSON line per request, {"queries": [...]} or {"documents": [...]}, optional "dim", and answers one line,
{"vectors": [[...], ...]}. DRAMA_REVISION pins the model's commit; files come from the local Hugging Face cache.
"""
import json
import os
import sys

import torch
import torch.nn.functional as F
from transformers import AutoTokenizer, LlamaModel

NAME = os.environ.get("DRAMA_MODEL", "facebook/drama-base")
REV = os.environ.get("DRAMA_REVISION", "7ef3558878de60517678f955e6e290c138650fe8")
torch.set_num_threads(int(os.environ.get("EMBED_THREADS", "8")))
try:
    tok = AutoTokenizer.from_pretrained(NAME, revision=REV, local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1")
    model = LlamaModel.from_pretrained(NAME, revision=REV, dtype=torch.float32).eval()
    for layer in model.layers:
        layer.self_attn.is_causal = False
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
except Exception as e:
    for _ in sys.stdin:
        print(json.dumps({"error": f"DRAMA is not available ({type(e).__name__}: {e})"[:200]}), flush=True)
    sys.exit(0)


def encode(texts, dim=None, query=False):
    if query:
        texts = ["Query: " + t for t in texts]
    enc = tok(texts, padding=True, truncation=True, max_length=512, return_tensors="pt")
    pad = enc["attention_mask"]
    # (batch, 1, 1, keys): 0 where a token may be seen, the dtype's minimum where it is padding; no causal part
    mask = (1.0 - pad[:, None, None, :].float()) * torch.finfo(torch.float32).min
    with torch.no_grad():
        h = model(input_ids=enc["input_ids"], attention_mask=mask).last_hidden_state
    h = h[:, :, : dim or h.shape[-1]].masked_fill(~pad[..., None].bool(), 0.0)
    return F.normalize(h.sum(1) / pad.sum(1)[..., None], p=2, dim=1)


for line in sys.stdin:
    try:
        req = json.loads(line)
        q = "queries" in req
        v = encode(req["queries"] if q else req["documents"], req.get("dim"), query=q)
        print(json.dumps({"vectors": [[round(x, 5) for x in row] for row in v.tolist()]}), flush=True)
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"[:200]}), flush=True)
