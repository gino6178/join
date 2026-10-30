// An A2A client (Agent2Agent protocol v1.0) on the official SDK (@a2a-js/sdk, Apache 2.0): the SDK reads the agent's
// card and picks its JSON-RPC interface; this module hands the rest of Serve the protocol's own JSON shape (enum names
// such as TASK_STATE_COMPLETED, one key per part: {data} or {text}) rather than the SDK's internal objects. Your agent
// talks to the other members' agents through it the same way it would talk to an agent run by anyone else: it knows
// only the base URL.
import { ClientFactory, JsonRpcTransportFactory, withA2AExtensions } from "@a2a-js/sdk/client";
import { tracingFetch } from "./trace.js";
import { authHeader } from "./auth.js";
import * as peer from "./peer.js";
import { Role, TaskState, verifyAgentCardSignature, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";

// every request carries the W3C trace context (so the member's side of a talk is in the same trace) and the gateway's
// token, and gives up after A2A_TIMEOUT_MS (4.5 minutes: the member's agent tries the model twice, two minutes each,
// and Node's fetch would give up at five). A request to a peer gateway (peer.js) carries that gateway's signature
// instead of the token, and is given up early when the peer stops answering (preempted, its tunnel down).
const TIMEOUT = +(process.env.A2A_TIMEOUT_MS || 270000);
const fetchA2A = async (url, init = {}, again = false) => {
  const far = peer.byOrigin(String(url)), signed = far ? await peer.sign(String(url), { method: init.method || "GET", body: init.body }, peerKeys) : {};
  const headers = { ...Object.fromEntries(new Headers(init.headers || {})), ...authHeader(String(url)), ...signed };
  // (a GET to a peer, its card or its key set, is small: 10 s; a message to its agent is watched while it waits)
  const get = (init.method || "GET").toUpperCase() === "GET";
  const w = far && !get ? peer.watch(far.origin) : null, limit = init.signal || AbortSignal.timeout(far && get ? 10000 : TIMEOUT);
  let res;
  try { res = await tracingFetch(url, { ...init, headers, signal: w ? AbortSignal.any([limit, w.signal]) : limit }); } catch (e) {
    // A connection to a peer that broke before any answer (a kept-alive socket it had just closed, the tunnel
    // reconnecting) is tried once more, signed afresh, if the peer answers a probe: a message is answered once there
    // (by its id, and one still being answered is waited for), a hold, its release or a booking is the same twice, and
    // a GET (its card, its key set) changes nothing.
    if (far && !again && !limit.aborted && !w?.signal.aborted && (await peer.probe(far.origin))) { peer.count("retried"); return fetchA2A(url, init, true); }
    if (far && !limit.aborted) peer.markDown(far.origin); // refused or cut off, not our own time limit
    throw e;
  } finally { w?.stop(); }
  // a peer's answer to a message counts only if its pinned key signed it, for this very request
  return far && signed[peer.HEADER] ? peer.checkAnswer(far, res, peer.claimsOf(signed[peer.HEADER])?.jti) : res;
};
// a peer's key set, to pin it on first use (peer.js): from its own origin, no redirect followed
const peerKeys = (origin) => tracingFetch(`${origin}/a2a/keys.json`, { redirect: "error", signal: AbortSignal.timeout(10000) }).then((r) => { if (!r.ok) throw new Error(`keys: HTTP ${r.status}`); return r.json(); });
const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: fetchA2A })] }), clients = new Map(), cards = new Map();
// A member's card is used only if it is signed by the key published at its own address (/a2a/keys.json there) and
// names that same address for its messages: whoever answers at the address endorsed the card, and a card served at one
// member's address can't send the talk to another (or to this gateway, with its token). A key named elsewhere (the JWS
// jku) is not fetched, and neither fetch follows a redirect. Over plain HTTP someone on the path could replace both the
// card and the key, so for agents on other servers this is as strong as their TLS. A2A_VERIFY_CARDS=off skips it.
// For a peer gateway on the allow-list the key is the one pinned on first use (peer.js), never one fetched again: a card
// signed by any other key is refused and logged.
const keys = new Map();
// (a key list that could not be fetched is asked for again next time)
const keyAt = (origin) => {
  const p = peer.byOrigin(origin);
  if (p) return peer.keyOf(p, peerKeys).then((k) => ({ keys: k ? [k] : [] }));
  if (!keys.has(origin)) keys.set(origin, fetchA2A(`${origin}/a2a/keys.json`, { redirect: "error" }).then((r) => { if (!r.ok) throw new Error(`keys: HTTP ${r.status}`); return r.json(); }).catch((e) => { keys.delete(origin); throw e; }));
  return keys.get(origin);
};
// (a key it does not have yet, after the other side made a new one: the list is fetched once more)
export const verifierFor = (origin) => verifyAgentCardSignature(async (kid) => {
  let k = (await keyAt(origin)).keys?.find((x) => x.kid === kid);
  if (!k) { keys.delete(origin); k = (await keyAt(origin)).keys?.find((x) => x.kid === kid); }
  if (!k) throw new Error(`no key ${String(kid).slice(0, 40)} at ${origin}`);
  return k;
});
const slash = (u) => (u.endsWith("/") ? u : `${u}/`);
// what the check found, per agent address, for the app to show with a talk (talk_meta.js): verified and when, with the
// signature's algorithm; or why not. Never the key or the card itself.
const checks = new Map();
export const cardCheck = (base) => checks.get(slash(String(base || ""))) || null;
const algOf = (card) => { try { return JSON.parse(Buffer.from(card.signatures[0].protected, "base64url").toString("utf8")).alg || null; } catch { return null; } };
const clientFor = async (base) => {
  const url = base.endsWith("/") ? base : `${base}/`; // the card is found relative to the base
  if (!clients.has(url)) {
    if (process.env.A2A_VERIFY_CARDS === "off") { clients.set(url, await factory.createFromUrl(url)); checks.set(url, { verified: false, skipped: true, at: Date.now() }); }
    else {
      const no = (e) => { checks.set(url, { verified: false, at: Date.now(), reason: String(e.message || e).slice(0, 120) }); throw e; };
      // the card as it was served is what is checked, and the client is made from that same card (the SDK's own
      // check runs on its parsed copy, which does not canonicalize the same way)
      const r = await fetchA2A(new URL(AGENT_CARD_PATH, url), { headers: { "A2A-Version": A2A_PROTOCOL_VERSION }, redirect: "error" });
      if (!r.ok) no(new Error(`no Agent Card at ${url} (HTTP ${r.status})`));
      const card = await r.json();
      const origin = new URL(url).origin, far = peer.byOrigin(origin);
      await verifierFor(origin)(card).catch((e) => {
        if (far) peer.note("refused", { why: "card-not-pinned-key", peer: far.name, card: url, detail: String(e.message || e).slice(0, 80) });
        no(new Error(`its Agent Card's signature does not check out (${String(e.message || e).slice(0, 80)})`));
      });
      // the card is for this address: its JSON-RPC interface is the address it was fetched from
      const rpc = (card.supportedInterfaces || []).filter((i) => /^jsonrpc$/i.test(i.protocolBinding || ""));
      if (!rpc.length || rpc.some((i) => slash(String(i.url || "")) !== url)) {
        if (far) peer.note("refused", { why: "card-other-address", peer: far.name, card: url });
        no(new Error(`its Agent Card's signature does not check out for this address (it names ${String(rpc[0]?.url || "no JSON-RPC address").slice(0, 80)})`));
      }
      cards.set(url, card);
      clients.set(url, await factory.createFromAgentCard(card));
      checks.set(url, { verified: true, at: Date.now(), alg: algOf(card) });
    }
  }
  return clients.get(url);
};
// the SDK's objects to the protocol's JSON shape, and back
const toJson = (p) => ({ [p.content?.$case]: p.content?.value, mediaType: p.mediaType });
const toSdk = (p) => { const kind = "data" in p ? "data" : "text"; return { content: { $case: kind, value: p[kind] }, mediaType: p.mediaType || (kind === "data" ? "application/json" : "text/plain"), filename: "", metadata: undefined }; };
const plain = (t) => (!t?.status ? t : { ...t, status: { ...t.status, state: TaskState[t.status.state] },
  artifacts: (t.artifacts || []).map((a) => ({ ...a, parts: a.parts.map(toJson) })), history: (t.history || []).map((m) => ({ ...m, role: Role[m.role], parts: m.parts.map(toJson) })) });

// the extensions an agent's card declares at a path (match/likely.js EXT_PATH): their URIs, as the card names them
export const declared = (base, extPath) => (cards.get(slash(base))?.capabilities?.extensions || []).map((e) => e.uri).filter((u) => { try { return new URL(u).pathname === extPath; } catch { return false; } });
// SendMessage: the task the agent made for it (or the message it answered with), in the protocol's JSON shape.
// extensions: the paths of extensions the message uses, sent as A2A-Extensions with the URIs the agent's card declares
// for them; signal: an earlier limit than A2A_TIMEOUT_MS (a hold, which does not wait for a model)
export async function send(base, message, { extensions = [], signal } = {}) {
  const c = await clientFor(base);
  const uris = extensions.flatMap((p) => declared(base, p));
  const opts = { ...(uris.length ? { serviceParameters: withA2AExtensions(...uris) } : {}), ...(signal ? { signal } : {}) };
  const res = await c.sendMessage({ message: { messageId: message.messageId, contextId: message.contextId || "", taskId: message.taskId || "", role: Role.ROLE_USER, parts: message.parts.map(toSdk), extensions: uris, metadata: message.metadata || {}, referenceTaskIds: [] } }, Object.keys(opts).length ? opts : undefined);
  // (the message's metadata may carry the trace context, traceparent, which the receiving agent continues)
  return plain(res);
}
export async function getTask(base, id) { return plain(await (await clientFor(base)).getTask({ id, tenant: "", historyLength: 10 })); }
export async function cancelTask(base, id) { return plain(await (await clientFor(base)).cancelTask({ id, tenant: "", metadata: {} })); }
// what an artifact carries: its structured data, or its text
export const dataOf = (task, name) => task?.artifacts?.find((a) => a.name === name)?.parts?.find((p) => "data" in p)?.data ?? null;
export const textOf = (task, name) => task?.artifacts?.find((a) => a.name === name)?.parts?.find((p) => "text" in p)?.text ?? null;
