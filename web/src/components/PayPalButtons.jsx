import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

// PayPal's JS SDK v6 on the page: the person approves their payment in a PayPal popup (PayPal, Pay Later, or Venmo where
// they are eligible) without leaving Join. The order already exists (Join made it when they joined); the buttons only
// approve it, and Join authorizes it on the server. Without PayPal sandbox keys (the stand-in), or if the SDK can't load,
// it falls back to the plain link to PayPal's approval page.
let sdkLoad = null;
const loadSdk = (src) => (sdkLoad ||= new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); }));

export default function PayPalButtons({ bookingId, orderId, approveUrl, label, onDone }) {
  const box = useRef(null);
  const [state, setState] = useState("loading"), [err, setErr] = useState(null);
  useEffect(() => {
    let off = false;
    (async () => {
      const cfg = await api("/api/paypal/sdk").catch(() => null);
      if (!cfg?.token || !orderId) { setState("link"); return; }
      await loadSdk(cfg.sdk);
      const sdk = await window.paypal.createInstance({ clientToken: cfg.token, components: ["paypal-payments", "venmo-payments"], pageType: "checkout" });
      const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
      const options = {
        onApprove: async () => { try { await api(`/api/bookings/${bookingId}/approved`, { method: "POST" }); onDone?.(); } catch (e) { setErr(e.message); } },
        onCancel: () => setErr("You closed PayPal without approving."),
        onError: (e) => setErr(String(e?.message || e)),
      };
      const order = () => Promise.resolve({ orderId });
      const add = (tag, session, attrs = {}) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        el.addEventListener("click", () => session.start({ presentationMode: "auto" }, order()));
        box.current?.appendChild(el);
      };
      if (off || !box.current) return;
      if (methods.isEligible("paypal")) add("paypal-button", sdk.createPayPalOneTimePaymentSession(options), { type: "pay" });
      if (methods.isEligible("paylater") && sdk.createPayLaterOneTimePaymentSession) { const d = methods.getDetails("paylater"); add("paypal-pay-later-button", sdk.createPayLaterOneTimePaymentSession(options), { productCode: d.productCode, countryCode: d.countryCode }); }
      if (methods.isEligible("venmo") && sdk.createVenmoOneTimePaymentSession) add("venmo-button", sdk.createVenmoOneTimePaymentSession(options));
      setState(box.current.children.length ? "buttons" : "link");
    })().catch(() => !off && setState("link"));
    return () => { off = true; if (box.current) box.current.innerHTML = ""; };
  }, [bookingId, orderId]);
  return (
    <div className="pp-buttons">
      <div ref={box} className="pp-box" />
      {state === "loading" && <span className="small muted">Loading PayPal…</span>}
      {state === "link" && approveUrl && <a className="btn primary" href={approveUrl}>{label || "Approve in PayPal"}</a>}
      {err && <span className="small err">{err}</span>}
    </div>
  );
}
