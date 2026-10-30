// The feed's two sheets: sharing a post outside the club (Instagram and Facebook through the phone's share sheet, as
// highlights already do; WhatsApp and Threads through their public share links), and reporting a post or a comment.
// Both are native dialogs: Escape and a tap outside close them, and focus comes back to the button that opened them.
import { useEffect, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import Brand from "../components/Brand.jsx";
import { shareLinks } from "./share.js";
import { mediaUrl } from "./feedApi.js";
import { FIcon } from "./FeedParts.jsx";

function Sheet({ open, onClose, labelledBy, children }) {
  const d = useRef(null);
  useEffect(() => {
    const el = d.current;
    if (!el) return;
    if (open && !el.open) el.showModal?.();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={d} className="fd-sheet" aria-labelledby={labelledBy} onClose={onClose} onClick={(e) => { if (e.target === d.current) onClose(); }}>
      <div className="fd-sheet-in">{children}</div>
    </dialog>
  );
}

// what goes out: a paper's title, year and link; a member's own post or highlight, with its clip where the phone can
// take a file. Only papers and the member's own posts can be shared outside the club.
export function ShareSheet({ p, club, open, onClose }) {
  const [msg, setMsg] = useState("");
  useEffect(() => { if (open) setMsg(""); }, [open]);
  if (!p) return null;
  const text = p.kind === "paper" ? `${p.paper.title} (${p.paper.year ?? "n.d."}) ${p.paper.link} · from ${club} on Serve` : `${p.text || ""}${p.text ? " " : ""}· from ${club} on Serve`;
  const l = shareLinks(text);
  const withFile = async (app) => {
    if (p.media && !p.media.static) {
      try {
        const blob = await (await fetch(await mediaUrl(p.media.id))).blob(), f = new File([blob], `serve-${p.id}.${blob.type.includes("mp4") ? "mp4" : blob.type.includes("webm") ? "webm" : "jpg"}`, { type: blob.type });
        if (navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], text }); return setMsg(`Shared. Pick ${app} in the share sheet if it did not open.`); }
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = f.name; a.click();
      } catch { return setMsg("Sharing cancelled."); }
    } else if (navigator.share) {
      try { await navigator.share({ text }); return setMsg(`Shared. Pick ${app} in the share sheet if it did not open.`); } catch { return setMsg("Sharing cancelled."); }
    }
    await navigator.clipboard?.writeText(text).catch(() => {});
    setMsg(p.media ? `This browser can't hand a file to ${app}: the file is downloaded and the text copied. Post them from ${app}.` : `The text is copied. Paste it into ${app}.`);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(text); setMsg("Copied."); } catch { setMsg("This browser did not allow copying."); } };
  return (
    <Sheet open={open} onClose={onClose} labelledBy="fd-share-h">
      <header className="fd-sheet-h"><h2 id="fd-share-h">Share outside the club</h2><button className="icon-btn sm" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button></header>
      <p className="tiny muted">{p.kind === "paper" ? "The paper's title and link go out, nothing else." : "Your post goes out as you wrote it. Comments and likes stay in the club."}</p>
      <div className="fd-share-grid">
        <button className="fd-share-btn" onClick={() => withFile("Instagram")}><Brand name="instagram" size={22} />Instagram</button>
        <button className="fd-share-btn" onClick={() => withFile("Facebook")}><Brand name="facebook" size={22} />Facebook</button>
        <a className="fd-share-btn" href={l.whatsapp} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={22} />WhatsApp</a>
        <a className="fd-share-btn" href={l.threads} target="_blank" rel="noopener noreferrer"><Icon name="share" size={22} />Threads</a>
        <button className="fd-share-btn" onClick={copy}><FIcon name="copy" size={22} />Copy text</button>
      </div>
      <p className="tiny" role="status" aria-live="polite">{msg}</p>
    </Sheet>
  );
}

export const REASONS = [["unkind", "Unkind or harassing"], ["private", "Shares someone's private details"], ["unsafe", "Unsafe or harmful"], ["spam", "Spam"], ["wrong", "Misleading about a paper"], ["other", "Something else"]];
export function ReportSheet({ target, open, onClose, onSend }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState(""), [done, setDone] = useState("");
  useEffect(() => { if (open) { setReason(""); setErr(""); setDone(""); } }, [open]);
  const send = async (e) => {
    e.preventDefault();
    if (!reason) return setErr("Pick a reason.");
    setBusy(true); setErr("");
    try { const r = await onSend(reason); setDone(r?.hidden ? "Thanks. It's hidden now until the club's maintainer looks at it." : "Thanks. The club's maintainer sees reports. When three members report something, it's hidden until they look."); }
    catch (x) { setErr(x.message || "The report did not go through."); }
    finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} labelledBy="fd-rep-h">
      <header className="fd-sheet-h"><h2 id="fd-rep-h">Report {target?.comment ? "this comment" : "this post"}</h2><button className="icon-btn sm" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button></header>
      {done ? (<><p className="fd-rep-done"><Icon name="check" size={20} />{done}</p><button className="btn primary sm" onClick={onClose}>Done</button></>) : (
        <form onSubmit={send} className="fd-rep">
          <fieldset>
            <legend className="tiny muted">Who wrote it won't see who reported it.</legend>
            {REASONS.map(([k, l]) => <label key={k} className="fd-radio"><input type="radio" name="reason" value={k} checked={reason === k} onChange={() => setReason(k)} />{l}</label>)}
          </fieldset>
          {err && <p className="err" role="alert">{err}</p>}
          <div className="fd-row"><button className="btn primary sm" disabled={busy} aria-busy={busy}><FIcon name="flag" size={16} />{busy ? "Sending…" : "Send report"}</button><button type="button" className="btn ghost sm" onClick={onClose}>Cancel</button></div>
        </form>
      )}
    </Sheet>
  );
}
