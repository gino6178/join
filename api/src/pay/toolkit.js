// Join's back office on the PayPal Agent Toolkit (@paypal/agent-toolkit): the same tools PayPal gives AI agents, called
// here by code for the venue's side of the money. They run on Join's own PayPal account (the platform's): Join is the
// merchant that captures shares and invoices extras, and pays venues with Payouts. In the multiparty model (README)
// the venue's own account would be the payee and these would run on it.
//   reconcile   list_transactions: each capture and payout Join made for a venue, found in PayPal's own transaction
//               records, with PayPal's fee (sandbox reporting can lag by hours: not yet there is shown as pending)
//   bill        create_invoice + send_invoice: a venue bills a group's organizer for extras after the booking
//               (overtime, a racket, a second pitcher), on a PayPal-hosted invoice page
//   disputes    list_disputes / get_dispute: chargebacks on a venue's payments, matched to bookings
// With the PayPal stand-in (no sandbox keys) these answer from the stand-in's own records, so the pages still work.
import { PayPalAPI } from "@paypal/agent-toolkit/mcp";

let api = null, mode = "none", fallback = null;
// token: () => Promise<access token> (paypal.js accessToken); stand-in: the mock's own answers
export function configureToolkit({ token = null, standIn = null } = {}) {
  if (token) { mode = "sandbox"; api = { token, client: null, at: 0 }; }
  else { mode = "stand-in"; fallback = standIn; }
}
export const toolkitMode = () => mode;

async function run(method, arg) {
  if (mode !== "sandbox") return fallback?.(method, arg) ?? null;
  // a fresh client whenever the access token is renewed (they last about 9 hours)
  if (!api.client || Date.now() - api.at > 30 * 60e3) { api.client = new PayPalAPI(await api.token(), { sandbox: true }); api.at = Date.now(); }
  const out = await api.client.run(method, arg);
  const j = typeof out === "string" ? JSON.parse(out) : out;
  if (j?.error) throw new Error(`${method}: ${j.error.message || "PayPal error"}`);
  return j;
}

// Each capture and payout of a venue's bookings, matched to PayPal's transaction records
export async function reconcile(bookings) {
  const rows = [];
  for (const b of bookings) {
    for (const [pid, p] of Object.entries(b.payments || {})) if (p.captureId) rows.push({ booking: b.id, kind: "capture", who: pid, id: p.captureId, amount: p.captured ?? p.amount, status: p.status });
    if (b.payout?.batchId) rows.push({ booking: b.id, kind: "payout", who: "venue", id: b.payout.batchId, amount: b.payout.amount, status: b.payout.item || b.payout.status });
  }
  const found = new Map();
  try {
    const j = await run("list_transactions", { start_date: new Date(Date.now() - 31 * 864e5).toISOString(), end_date: new Date().toISOString(), transaction_status: "S" });
    for (const t of j?.transaction_details || []) {
      const i = t.transaction_info || {};
      found.set(i.transaction_id, { amount: Math.round(Math.abs(+i.transaction_amount?.value || 0) * 100), fee: Math.round(Math.abs(+i.fee_amount?.value || 0) * 100), event: i.transaction_event_code, at: i.transaction_initiation_date });
    }
  } catch (e) { return { mode, error: e.message, rows: rows.map((r) => ({ ...r, paypal: "unavailable" })) }; }
  return { mode, rows: rows.map((r) => { const t = found.get(r.id); return { ...r, paypal: t ? (t.amount === r.amount ? "matched" : "amount differs") : r.kind === "payout" ? "batch (items are listed separately)" : "not in PayPal reporting yet", fee: t?.fee ?? null, event: t?.event ?? null }; }) };
}

// A venue bills a group's organizer for extras, on a PayPal invoice
export async function bill({ recipient, items, note, reference, venueName }) {
  const inv = await run("create_invoice", {
    currency_code: "USD", reference, note, invoicer_business_name: venueName,
    primary_recipients: [{ billing_info: { email_address: recipient } }],
    items: items.map((x) => ({ name: x.name.slice(0, 200), quantity: "1", unit_amount: { currency_code: "USD", value: (x.amount / 100).toFixed(2) } })),
  });
  const id = inv?.id || String(inv?.href || "").split("/").pop();
  const sent = await run("send_invoice", { invoice_id: id, send_to_recipient: true, send_to_invoicer: false });
  return { id, url: sent?.href || null, status: "SENT" };
}
export const invoiceStatus = (id) => run("get_invoice", { invoice_id: id }).then((j) => ({ id, status: j?.status || "UNKNOWN" }));

// Disputes on payments Join captured
export async function disputes(captureIds) {
  const ids = new Set(captureIds);
  const j = await run("list_disputes", {});
  return (j?.items || []).filter((d) => (d.disputed_transactions || []).some((t) => ids.has(t.seller_transaction_id))).map((d) => ({ id: d.dispute_id, reason: d.reason, status: d.status, amount: d.dispute_amount?.value, transactions: (d.disputed_transactions || []).map((t) => t.seller_transaction_id) }));
}
