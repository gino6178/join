// PayPal REST, sandbox by default (PAYPAL_ENV=live is refused: this is a hackathon build). Only the calls Join makes:
//   Orders v2 with intent AUTHORIZE (one order per payer), authorize, capture an authorization (final), void, refund
//   Payouts (the venue's money after the game)
//   Vault v3 (a player saves PayPal once; their agent then pays within their mandate without a redirect)
//   Webhook signature verification
// Every POST carries a PayPal-Request-Id made from the booking and the step, so a call repeated after a crash is the
// same call to PayPal, not a second charge.
const BASE = "https://api-m.sandbox.paypal.com";

export function paypal({ clientId, secret, brand = "Join" }) {
  let token = null, until = 0;
  async function auth() {
    if (token && Date.now() < until - 60e3) return token;
    const r = await fetch(`${BASE}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    if (!r.ok) throw new Error(`PayPal auth failed: ${r.status}`);
    const j = await r.json();
    token = j.access_token; until = Date.now() + j.expires_in * 1000;
    return token;
  }
  async function call(method, path, body, requestId) {
    const headers = { Authorization: `Bearer ${await auth()}`, "Content-Type": "application/json", Prefer: "return=representation" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text(), j = text ? JSON.parse(text) : {};
    if (!r.ok) { const e = new Error(`PayPal ${method} ${path}: ${r.status} ${j.name || ""} ${j.details?.[0]?.issue || j.message || ""}`.trim()); e.status = r.status; e.paypal = j; throw e; }
    return j;
  }
  const link = (j, rel) => j.links?.find((l) => l.rel === rel)?.href || null;
  const money = (cents, currency = "USD") => ({ currency_code: currency, value: (cents / 100).toFixed(2) });
  const authOf = (order) => order.purchase_units?.[0]?.payments?.authorizations?.[0] || null;

  return {
    mode: "sandbox",
    async createOrder({ amount, currency = "USD", reference, description, returnUrl, cancelUrl, vaultId = null, requestId }) {
      const payment_source = vaultId
        ? { paypal: { vault_id: vaultId } }
        : { paypal: { experience_context: { brand_name: brand, shipping_preference: "NO_SHIPPING", user_action: "CONTINUE", return_url: returnUrl, cancel_url: cancelUrl } } };
      const j = await call("POST", "/v2/checkout/orders", { intent: "AUTHORIZE", purchase_units: [{ reference_id: reference, custom_id: reference, description: description.slice(0, 127), amount: money(amount, currency) }], payment_source }, requestId);
      const a = authOf(j);
      return { id: j.id, status: j.status, approveUrl: link(j, "payer-action") || link(j, "approve"), authorization: a ? { id: a.id, status: a.status, expiresAt: a.expiration_time } : null };
    },
    async getOrder(id) {
      const j = await call("GET", `/v2/checkout/orders/${id}`);
      const a = authOf(j);
      return { id: j.id, status: j.status, authorization: a ? { id: a.id, status: a.status, expiresAt: a.expiration_time } : null, payerId: j.payer?.payer_id || null };
    },
    async authorizeOrder(id, requestId) {
      const j = await call("POST", `/v2/checkout/orders/${id}/authorize`, {}, requestId);
      const a = authOf(j);
      return { id: a.id, status: a.status, expiresAt: a.expiration_time };
    },
    async capture(authorizationId, { amount, currency = "USD", final = true, requestId }) {
      const j = await call("POST", `/v2/payments/authorizations/${authorizationId}/capture`, { amount: money(amount, currency), final_capture: final }, requestId);
      const net = j.seller_receivable_breakdown?.net_amount?.value;
      return { id: j.id, status: j.status, net: net ? Math.round(+net * 100) : null };
    },
    async voidAuthorization(authorizationId, requestId) { await call("POST", `/v2/payments/authorizations/${authorizationId}/void`, undefined, requestId); return { status: "VOIDED" }; },
    async refund(captureId, { amount, currency = "USD", requestId }) {
      const j = await call("POST", `/v2/payments/captures/${captureId}/refund`, { amount: money(amount, currency) }, requestId);
      return { id: j.id, status: j.status };
    },
    async payout({ batchId, receiver, amount, currency = "USD", note }) {
      const j = await call("POST", "/v1/payments/payouts", { sender_batch_header: { sender_batch_id: batchId, email_subject: `${brand}: a court booking was paid`, email_message: note }, items: [{ recipient_type: "EMAIL", receiver, note, sender_item_id: batchId, amount: { value: (amount / 100).toFixed(2), currency } }] });
      return { batchId: j.batch_header.payout_batch_id, status: j.batch_header.batch_status };
    },
    async getPayout(batchId) {
      const j = await call("GET", `/v1/payments/payouts/${batchId}`);
      return { batchId, status: j.batch_header.batch_status, item: j.items?.[0]?.transaction_status || null };
    },
    async vaultSetup({ returnUrl, cancelUrl, requestId }) {
      const j = await call("POST", "/v3/vault/setup-tokens", { payment_source: { paypal: { usage_type: "MERCHANT", customer_type: "CONSUMER", permit_multiple_payment_tokens: false, description: `${brand}: your agent may pay your share of games within your limits`, experience_context: { brand_name: brand, shipping_preference: "NO_SHIPPING", return_url: returnUrl, cancel_url: cancelUrl } } } }, requestId);
      return { id: j.id, approveUrl: link(j, "approve") };
    },
    async vaultToken(setupTokenId, requestId) {
      const j = await call("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } }, requestId);
      return { id: j.id, customerId: j.customer?.id || null };
    },
    async verifyWebhook(headers, rawBody, webhookId) {
      const h = (k) => headers[k] || headers[k.toLowerCase()];
      // the event goes back exactly as it came: parsing and writing it again can change it and fail the check
      const head = JSON.stringify({ auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"), transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"), webhook_id: webhookId });
      const j = await call("POST", "/v1/notifications/verify-webhook-signature", `${head.slice(0, -1)},"webhook_event":${rawBody}}`);
      return j.verification_status === "SUCCESS";
    },
  };
}
