"""AlignmentCheck for Serve (align.js): does an agent's plan still serve what it was asked to do?
Meta's LlamaFirewall (MIT) has a scanner, AlignmentCheck, that reads an agent's trace (the user's request, then each
action with its reason and result) and says whether the action the agent is about to take serves that request. It is
wired to a hosted Llama model; its client is OpenAI-compatible, so the subclass below points it at our own Muse Glimmer
(ALIGN_URL, ALIGN_MODEL) and it is registered as a custom scanner, "serve_alignment_check".

One JSON line in per check, one JSON line out:
  in   {"id": 1, "goal": "...", "actions": [{"action": "find_partners", "input": {...}, "thought": "...", "result": "..."}, ...]}
       the last action is the one about to be taken (its result, if any, is ignored)
  out  {"id": 1, "aligned": true | false, "checked": true | false, "decision": "allow" | "human_in_the_loop_required" | ...,
        "seconds": 3.1, "tokens": {"prompt": 900, "output": 120}, "reason": "...", "error": "..."}
Fail-closed: a check that did not run (no answer from the model, a reply that is not the format, no goal, no actions,
a line that is not JSON) is "aligned": false with "checked": false. Only a verdict from the model says aligned.
"""
import asyncio
import json
import os
import sys
import time

from llamafirewall import AssistantMessage, LlamaFirewall, Role, ScanDecision, ScanResult, ScanStatus, ToolMessage, UserMessage, register_llamafirewall_scanner
from llamafirewall.scanners import custom_check_scanner
from llamafirewall.scanners.experimental.alignmentcheck_scanner import AlignmentCheckOutputSchema, AlignmentCheckScanner
from llamafirewall.utils.base_llm import LLMClient
from openai import OpenAI

URL = os.environ.get("ALIGN_URL", "http://127.0.0.1:11445/v1").rstrip("/")
MODEL = os.environ.get("ALIGN_MODEL", "muse-glimmer")
THINK = os.environ.get("ALIGN_THINK", "low")  # Glimmer's reasoning effort: short, so the verdict comes quickly
TIMEOUT = float(os.environ.get("ALIGN_TIMEOUT_S", "90"))
FAILED = "[check failed] "
last = {}  # the last model call's tokens and error (one check at a time: the worker reads one line, answers it)


class GlimmerClient(LLMClient):
    """LlamaFirewall's LLM client, on Muse Glimmer: no hosted API key, one try with a timeout, Glimmer's reasoning at
    ALIGN_THINK, and the call's token counts kept for the ledger."""

    def __init__(self) -> None:
        super().__init__(model_name=MODEL, api_base_url=URL, api_key=os.environ.get("ALIGN_API_KEY", "none"))
        self.client = OpenAI(api_key=os.environ.get("ALIGN_API_KEY", "none"), base_url=URL, timeout=TIMEOUT, max_retries=0)

    async def call(self, prompt, system_prompt, output_schema, temperature=0.0, additional_messages=None):
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}, *(additional_messages or [])]
        extra = {"reasoning_effort": THINK} if THINK and THINK != "default" else {}
        r = await asyncio.to_thread(lambda: self.client.beta.chat.completions.parse(model=self.model_name, messages=messages, response_format=output_schema, temperature=temperature, extra_body=extra))
        u = r.usage
        last["tokens"] = {"prompt": getattr(u, "prompt_tokens", 0) or 0, "output": getattr(u, "completion_tokens", 0) or 0}
        parsed = r.choices[0].message.parsed
        if parsed is None:
            raise ValueError("the reply is not in the scanner's format")
        return parsed


# LlamaFirewall's LLM-based scanners build their client in CustomCheckScanner's constructor, for the hosted model (and
# refuse to start without its API key): in this worker, that client is Muse Glimmer's
custom_check_scanner.LLMClient = lambda **_: GlimmerClient()


@register_llamafirewall_scanner("serve_alignment_check")
class ServeAlignmentCheck(AlignmentCheckScanner):
    """AlignmentCheck as LlamaFirewall ships it (its prompt, its schema, its verdict), on Muse Glimmer. A failure is
    marked in the reason so the worker can tell "the model said misaligned" from "the check did not run"; both block."""

    def __init__(self, scanner_name: str = "Serve AlignmentCheck") -> None:
        super().__init__(scanner_name=scanner_name)  # its client is GlimmerClient (above)

    async def _evaluate_with_llm(self, text: str) -> AlignmentCheckOutputSchema:
        try:
            return await self.llm.call(prompt=text, system_prompt=self.system_prompt, output_schema=self.output_schema, temperature=self.temperature)
        except Exception as e:  # the scanner's own rule: an error is treated as misaligned
            last["error"] = f"{type(e).__name__}: {e}"[:200]
            return self._get_default_error_response()

    def _get_default_error_response(self) -> AlignmentCheckOutputSchema:
        return AlignmentCheckOutputSchema(observation=FAILED + last.get("error", "error"), thought="The check did not run, so the action is not taken as aligned.", conclusion=True)

    async def scan(self, message, past_trace=None) -> ScanResult:
        r = await super().scan(message, past_trace)
        # LlamaFirewall's scanner allows when it has no trace or no user message; here that is a check that did not run
        if r.status != ScanStatus.SUCCESS:
            return ScanResult(decision=ScanDecision.HUMAN_IN_THE_LOOP_REQUIRED, reason=FAILED + r.reason, score=1.0, status=ScanStatus.ERROR)
        return r


firewall = LlamaFirewall({Role.ASSISTANT: ["serve_alignment_check"]})


def step(a: dict) -> str:
    inp = a.get("input", "")
    inp = inp if isinstance(inp, str) else json.dumps(inp, ensure_ascii=False)
    return f"THOUGHT: {str(a.get('thought') or '')[:400]}\nACTION: {str(a.get('action') or '')[:80]}\nACTION INPUT: {inp[:1200]}"


def check(req: dict) -> dict:
    goal, actions = str(req.get("goal") or "").strip(), [a for a in req.get("actions") or [] if isinstance(a, dict)]
    if not goal or not actions:
        return {"aligned": False, "checked": False, "error": "no goal or no actions to check"}
    trace = [UserMessage(content=goal[:2000])]
    for a in actions[:-1][-40:]:
        trace.append(AssistantMessage(content=step(a)))
        if a.get("result") not in (None, ""):
            trace.append(ToolMessage(content=str(a["result"])[:800]))
    last.clear()
    t0 = time.time()
    r = asyncio.run(firewall.scan_async(AssistantMessage(content=step(actions[-1])), trace))
    out = {"seconds": round(time.time() - t0, 3), "tokens": last.get("tokens", {"prompt": 0, "output": 0}), "decision": r.decision.value}
    if r.reason.startswith("Observation: " + FAILED) or r.reason.startswith(FAILED) or r.status == ScanStatus.ERROR:
        return {**out, "aligned": False, "checked": False, "error": last.get("error") or r.reason[:200]}
    return {**out, "aligned": r.decision == ScanDecision.ALLOW, "checked": True, "reason": r.reason[:600]}


for line in sys.stdin:
    rid = None
    try:
        req = json.loads(line)
        rid = req.get("id")
        res = check(req)
    except Exception as e:
        res = {"aligned": False, "checked": False, "error": f"{type(e).__name__}: {e}"[:200]}
    print(json.dumps({"id": rid, **res}), flush=True)
