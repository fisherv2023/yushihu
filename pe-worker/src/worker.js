// Painting Eye License Worker — KV-backed
// Endpoints:
//   POST /checkout            — create creem checkout session {email: "xxx"}
//   POST /webhook             — creem webhook (HMAC-SHA256)
//   GET /success?email=xxx    — show license key after payment
//   POST /verify              — verify key {"key":"..."}
//   GET /recover?email=xxx    — recover lost key

function genKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let key = "PE-";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) key += "-";
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

async function verifySignature(body, signature, secret) {
  if (!secret || !signature || !body) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const sigBytes = hexToBytes(signature);
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(body));
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function storeLicense(email, orderId, kv) {
  const key = genKey();
  const data = JSON.stringify({ email, order_id: orderId, status: "active", created_at: new Date().toISOString() });
  await kv.put("key:" + key, data);
  await kv.put("email:" + email.toLowerCase().trim(), key);
  return key;
}

async function findKeyByEmail(email, kv) {
  const key = await kv.get("email:" + email.toLowerCase().trim());
  if (!key) return null;
  const data = await kv.get("key:" + key);
  if (!data) return null;
  const rec = JSON.parse(data);
  return rec.status === "active" ? key : null;
}

async function verifyKey(key, kv) {
  const data = await kv.get("key:" + key);
  if (!data) return false;
  const rec = JSON.parse(data);
  return rec.status === "active";
}

function htmlPage(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:32px 24px;max-width:380px;width:100%}h1{font-size:20px;font-weight:600;margin-bottom:8px}.sub{font-size:13px;opacity:.5;margin-bottom:20px}.key{font-family:monospace;font-size:22px;letter-spacing:.05em;background:rgba(255,255,255,.08);padding:12px 20px;border-radius:10px;user-select:all;word-break:break-all;margin-bottom:16px}.note{font-size:12px;opacity:.4;margin-top:16px;line-height:1.6}.btn{display:inline-block;padding:12px 28px;border-radius:24px;background:#fff;color:#111;font-size:15px;font-weight:600;text-decoration:none;margin-top:12px}.err{color:#ff5c5c;font-size:14px;margin-top:12px}</style></head><body>${body}</body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const kv = env.LICENSE_STORE;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // === POST /checkout — create creem checkout session ===
    if (pathname === "/checkout" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }
      const email = (body.email || "").trim();
      if (!email || !email.includes("@")) {
        return new Response(JSON.stringify({ error: "Valid email required" }), { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }
      try {
        const creemRes = await fetch("https://test-api.creem.io/v1/checkouts", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.CREEM_API_KEY },
          body: JSON.stringify({
            product_id: env.CREEM_PRODUCT_ID,
            units: 1,
            customer: { email },
            success_url: `https://pe-worker.yuyang918.workers.dev/success`,
            metadata: { user_email: email }
          })
        });
        const data = await creemRes.json();
        if (!creemRes.ok) {
          console.error("Creem checkout error:", JSON.stringify(data));
          return new Response(JSON.stringify({ error: "Payment service unavailable" }), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ url: data.checkout_url }), { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Checkout creation failed" }), { status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }
    }

    // === POST /webhook ===
    if (pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();
      const signature = request.headers.get("creem-signature");
      if (!(await verifySignature(body, signature, env.CREEM_WEBHOOK_SECRET))) {
        return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }
      let event;
      try { event = JSON.parse(body); } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }

      let email = null, orderId = null;

      if (event.eventType === "checkout.completed" && event.object) {
        const o = event.object;
        email = o.customer?.email || o.order?.customer?.email || o.metadata?.user_email;
        orderId = o.order?.id || o.id;
      } else if (event.event === "payment.succeeded" && event.data?.object) {
        const p = event.data.object;
        email = p.customer?.email || p.metadata?.user_email;
        orderId = p.id;
      }

      if (!email) {
        return new Response(JSON.stringify({ error: "Email not found" }), { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }

      const key = await storeLicense(email, orderId || "unknown", kv);
      console.log(`Key ${key} for ${email}`);
      return new Response(JSON.stringify({ success: true, key }), { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }

    // === GET /success?email=xxx ===
    if (pathname === "/success" && request.method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) {
        return new Response(htmlPage("Payment Complete",
          `<div class="card"><h1>🎉 Payment Confirmed</h1><p class="sub">Your license key is ready.</p><p class="note">To get your key:<br>1. Open <a href="https://yushihu.top/painting-eye.html" style="color:#6ab">Painting Eye</a><br>2. Tap <b>Recover Lost Key</b><br>3. Enter your purchase email</p><a class="btn" href="https://yushihu.top/painting-eye.html">Open Painting Eye</a></div>`
        ), { status: 200, headers: { "Content-Type": "text/html" } });
      }
      const key = await findKeyByEmail(email, kv);
      if (key) {
        return new Response(htmlPage("Your License Key",
          `<div class="card"><h1>🎉 Purchase Complete</h1><p class="sub">Your Painting Eye license key:</p><div class="key">${key}</div><p class="note">Copy this key. Open Painting Eye → enter license key → activate.<br>Keep this page — the key can also be recovered with your email.</p><a class="btn" href="https://yushihu.top/painting-eye.html">Open Painting Eye</a></div>`
        ), { status: 200, headers: { "Content-Type": "text/html" } });
      }
      return new Response(htmlPage("Processing...", `<div class="card"><h1>⏳ Processing</h1><p class="sub">Your payment is being processed. Refresh in a moment.</p></div>`), { status: 200, headers: { "Content-Type": "text/html" } });
    }

    // === POST /verify ===
    if (pathname === "/verify" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ valid: false }), { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }
      const key = (body.key || "").trim().toUpperCase();
      if (!key.startsWith("PE-")) {
        return new Response(JSON.stringify({ valid: false }), { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }
      const valid = await verifyKey(key, kv);
      return new Response(JSON.stringify({ valid }), { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }

    // === GET /recover?email=xxx ===
    if (pathname === "/recover" && request.method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) {
        return new Response(JSON.stringify({ error: "Email required" }), { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }
      const key = await findKeyByEmail(email, kv);
      if (key) {
        return new Response(JSON.stringify({ key }), { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "No license found" }), { status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
  },
};
