import { useState } from "react";
import { api } from "../api.js";
import Icon from "../components/Icon.jsx";
import { webMcpAvailable } from "../webmcp.js";

// Which agents may act for this person. A token is made for one agent, shown once, kept by Join only as a hash, and can
// be revoked here. It lets that agent search, negotiate and pay this person's share within their limits; it can't
// change the limits or make other tokens.
export default function Connect({ me, info, reload }) {
  const [label, setLabel] = useState("Claude Code"), [made, setMade] = useState(null), [copied, setCopied] = useState(null);
  const [scopes, setScopes] = useState(["read", "negotiate", "pay"]), [days, setDays] = useState(90), [key, setKey] = useState("");
  const make = async (e) => { e.preventDefault(); const t = await api("/api/tokens", { method: "POST", body: { label, scopes, days, key: key.trim() || null } }); setMade(t); reload(); };
  const flip = (s) => setScopes((xs) => (xs.includes(s) ? xs.filter((x) => x !== s) : [...xs, s]));
  const revoke = async (id) => { await api(`/api/tokens/${id}`, { method: "DELETE" }); reload(); };
  const url = info?.mcpUrl || `${location.origin}/mcp`, tok = made?.token || "join_YOUR_TOKEN";
  const copy = (k, text) => { navigator.clipboard?.writeText(text); setCopied(k); setTimeout(() => setCopied(null), 1500); };
  const snippets = [
    ["Claude Code", `claude mcp add --transport http join ${url} --header "Authorization: Bearer ${tok}"`],
    ["Claude Desktop (claude_desktop_config.json)", JSON.stringify({ mcpServers: { join: { command: "npx", args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${tok}`] } } }, null, 2)],
    ["Any HTTP client (REST)", `curl -X POST ${url.replace(/\/mcp$/, "")}/api/agent/find_options \\\n  -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" \\\n  -d '{"activity":"karaoke","players":3}'`],
    ["A2A agents", `Agent Card: ${url.replace(/\/mcp$/, "")}/.well-known/agent-card.json\nSend one data part: {"action":"find_options","activity":"karaoke","players":3}\nwith Authorization: Bearer ${tok}`],
  ];
  return (
    <div className="page">
      <header className="page-head"><h1>Connect your agent</h1><p className="muted">Bring your own agent: Claude, any agent that speaks MCP, A2A or HTTP, or the agent built into your browser (WebMCP). No agent? Use Join's, bottom right. It acts for you, {me.player.name.split(" ")[0]}, and only for you.</p></header>
      <form className="card form row" onSubmit={make}>
        <label><span>Name this agent</span><input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} /></label>
        <button className="btn primary"><Icon name="key" size={18} />Make a token</button>
        <fieldset className="token-opts"><legend>It may</legend>
          {[["read", "look: options, venues, plans"], ["negotiate", "negotiate, accept, answer invitations"], ["pay", "start your payments (you approve in PayPal, or saved PayPal within your limits)"]].map(([s, t]) => <label key={s} className="check"><input type="checkbox" checked={scopes.includes(s)} onChange={() => flip(s)} />{t}</label>)}
        </fieldset>
        <label><span>For</span><select value={days} onChange={(e) => setDays(+e.target.value)}>{[1, 7, 30, 90, 365].map((d) => <option key={d} value={d}>{d === 1 ? "1 day" : `${d} days`}</option>)}</select></label>
        <details className="wide"><summary className="small">Advanced: require signed requests</summary>
          <label className="wide"><span>Public key (optional): every request must then be signed with its private key (RFC 9421, as in Web Bot Auth)</span><input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Ed25519 public key, base64url (examples/signed-agent.mjs --key)" /></label>
        </details>
      </form>
      {made && <p className="note good">Token for <b>{made.label}</b>: <code className="tok">{made.token}</code> Copy it now: Join keeps only a hash and can't show it again.</p>}
      <section className="card">
        <h3>What it can and can't do</h3>
        <ul className="can">
          <li className="yes"><Icon name="check" size={16} />Find players and times, ask venues for prices, make offers, accept a deal</li>
          <li className="yes"><Icon name="check" size={16} />Start your payment: you approve it in PayPal, or it pays from saved PayPal within your limits</li>
          <li className="no"><Icon name="close" size={16} />Change your limits, save a payment method, make other tokens</li>
          <li className="no"><Icon name="close" size={16} />Go over your limits, or see a venue's lowest price</li>
        </ul>
      </section>
      <section className="card">
        <h3>Your browser's own agent (WebMCP)</h3>
        <p className="small">{webMcpAvailable() ? "This browser supports WebMCP: while you're signed in, this page offers its agent four tools: find options, negotiate, accept (you confirm on the page) and your plans. Payments stay in PayPal." : "Browsers with WebMCP let their built-in agent use this page's tools: find options, negotiate, accept (you confirm on the page) and your plans. This browser doesn't offer it yet, so there's nothing to set up."}</p>
      </section>
      {snippets.map(([k, text]) => <section key={k} className="card snippet"><header><h3>{k}</h3><button className="btn ghost small" onClick={() => copy(k, text)}>{copied === k ? "Copied" : "Copy"}</button></header><pre>{text}</pre></section>)}
      <section className="card">
        <h3>Your agents</h3>
        {!me.tokens.length ? <p className="muted small">None yet.</p> : <ul className="tokens">{me.tokens.map((t) => <li key={t.id}><span><b>{t.label}</b><small>{t.hint} · {(t.scopes || []).join(", ")}{t.signed ? " · signed requests only" : ""}{t.expires ? ` · until ${new Date(t.expires).toLocaleDateString()}` : ""} · made {new Date(t.created).toLocaleString()} · {t.lastUsed ? `last used ${new Date(t.lastUsed).toLocaleString()}` : "not used yet"}</small></span><button className="btn ghost small" onClick={() => revoke(t.id)}>Revoke</button></li>)}</ul>}
      </section>
    </div>
  );
}
