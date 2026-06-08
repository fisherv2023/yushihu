// Painting Eye License Worker
// Endpoints:
//   POST /webhook           — creem webhook (HMAC-SHA256)
//   GET /success?email=xxx  — show license key after payment
//   POST /verify            — verify key {"key":"..."}
//   GET /recover?email=xxx  — recover lost key

const AIRTABLE_BASE_URL = "https://api.airtable.com/v0";

function genKey() {
  // PE-XXXX-XXXX-XXXX format, 12 alphanumeric chars
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion
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
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function airtableGet(path, apiKey) {
  const res = await fetch(`${AIRTABLE_BASE_URL}/${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  return res.json();
}

async function airtablePost(path, data, apiKey) {
  const res = await fetch(`${AIRTABLE_BASE_URL}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function airtablePatch(path, data, apiKey) {
  const res = await fetch(`${AIRTABLE_BASE_URL}/${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function storeLicenseKey(email, orderId, apiKey, baseId) {
  const key = genKey();
  const data = {
    records: [{
      fields: {
        email: email,
        license_key: key,
        status: "active",
        order_id: orderId,
        created_at: new Date().toISOString(),
      },
    }],
  };
  await airtablePost(`${baseId}/license_keys`, data, apiKey);
  return key;
}

async function findKeyByEmail(email, apiKey, baseId) {
  const encoded = encodeURIComponent(`{email}="${email}"`);
  const result = await airtableGet(
    `${baseId}/license_keys?filterByFormula=${encoded}&sort[0][field]=created_at&sort[0][direction]=desc&maxRecords=1`,
    apiKey
  );
  if (result.records && result.records.length > 0) {
    const rec = result.records[0];
    if (rec.fields.status === "active") {
      return rec.fields.license_key;
    }
  }
  return null;
}

async function findKeyByCode(key, apiKey, baseId) {
  const encoded = encodeURIComponent(`{license_key}="${key}"`);
  const result = await airtableGet(
    `${baseId}/license_keys?filterByFormula=${encoded}&maxRecords=1`,
    apiKey
  );
  if (result.records && result.records.length > 0) {
    const rec = result.records[0];
    return rec.fields.status === "active";
  }
  return false;
}

function htmlPage(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:32px 24px;max-width:380px;width:100%}h1{font-size:20px;font-weight:600;margin-bottom:8px}.sub{font-size:13px;opacity:.5;margin-bottom:20px}.key{font-family:monospace;font-size:22px;letter-spacing:.05em;background:rgba(255,255,255,.08);padding:12px 20px;border-radius:10px;user-select:all;word-break:break-all;margin-bottom:16px}.note{font-size:12px;opacity:.4;margin-top:16px;line-height:1.6}.btn{display:inline-block;padding:12px 28px;border-radius:24px;background:#fff;color:#111;font-size:15px;font-weight:600;text-decoration:none;margin-top:12px}.err{color:#ff5c5c;font-size:14px;margin-top:12px}</style></head><body>${body}</body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // === POST /webhook — creem webhook ===
    if (pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();
      const signature = request.headers.get("creem-signature");

      const isValid = await verifySignature(body, signature, env.CREEM_WEBHOOK_SECRET);
      if (!isValid) {
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 401, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      let event;
      try { event = JSON.parse(body); } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // creem sends checkout.completed events
      if (event.eventType === "checkout.completed" && event.object) {
        const checkout = event.object;
        const order = checkout.order || {};
        const customer = checkout.customer || order.customer || {};
        const email = customer.email || order.metadata?.user_email || event.object.metadata?.user_email;

        if (!email) {
          return new Response(JSON.stringify({ error: "Email not found in webhook" }), {
            status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const orderId = order.id || checkout.id || "unknown";
        console.log(`Payment received: ${email}, order: ${orderId}`);

        try {
          const key = await storeLicenseKey(email, orderId, env.AIRTABLE_API_KEY, env.AIRTABLE_BASE_ID);
          console.log(`Key generated for ${email}: ${key}`);
          return new Response(JSON.stringify({ success: true, email, key }), {
            status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        } catch (err) {
          console.error("Airtable error:", err);
          return new Response(JSON.stringify({ error: "Database error" }), {
            status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
      }

      // Also handle payment.succeeded (older creem event format)
      if (event.event === "payment.succeeded" && event.data?.object) {
        const payment = event.data.object;
        const email = payment.customer?.email || payment.metadata?.user_email;
        if (!email) {
          return new Response(JSON.stringify({ error: "Email not found" }), {
            status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        try {
          const key = await storeLicenseKey(email, payment.id, env.AIRTABLE_API_KEY, env.AIRTABLE_BASE_ID);
          return new Response(JSON.stringify({ success: true, email, key }), {
            status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: "Database error" }), {
            status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
      }

      console.log("Unhandled event type:", event.eventType || event.event);
      return new Response(JSON.stringify({ info: "Event received" }), {
        status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    // === GET /success?email=xxx — show key page ===
    if (pathname === "/success" && request.method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) {
        return new Response(htmlPage("Error", '<div class="card"><h1>Missing Email</h1><p class="sub">No email provided.</p></div>'), {
          status: 400, headers: { "Content-Type": "text/html" },
        });
      }

      try {
        const key = await findKeyByEmail(email, env.AIRTABLE_API_KEY, env.AIRTABLE_BASE_ID);
        if (key) {
          return new Response(htmlPage("Your License Key",
            `<div class="card"><h1>🎉 Purchase Complete</h1><p class="sub">Your Painting Eye license key:</p><div class="key">${key}</div><p class="note">Copy this key. Open Painting Eye → tap the lock icon → paste and activate.<br>Keep this page or screenshot — the key can also be recovered with your email.</p><a class="btn" href="https://yushihu.top/painting-eye.html">Open Painting Eye</a></div>`
          ), { status: 200, headers: { "Content-Type": "text/html" } });
        } else {
          return new Response(htmlPage("Processing...",
            `<div class="card"><h1>⏳ Processing</h1><p class="sub">Your payment is being processed. Refresh in a moment, or check your email.</p><p class="note">If you don't see your key within a few minutes, use the recovery option in the app.</p></div>`
          ), { status: 200, headers: { "Content-Type": "text/html" } });
        }
      } catch (err) {
        return new Response(htmlPage("Error", '<div class="card"><h1>Error</h1><p class="err">Something went wrong. Try again later.</p></div>'), {
          status: 500, headers: { "Content-Type": "text/html" },
        });
      }
    }

    // === POST /verify — verify license key ===
    if (pathname === "/verify" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ valid: false, error: "Invalid JSON" }), {
          status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      const key = (body.key || "").trim().toUpperCase();
      if (!key || !key.startsWith("PE-")) {
        return new Response(JSON.stringify({ valid: false, error: "Invalid key format" }), {
          status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      try {
        const valid = await findKeyByCode(key, env.AIRTABLE_API_KEY, env.AIRTABLE_BASE_ID);
        return new Response(JSON.stringify({ valid }), {
          status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ valid: false, error: "Verification failed" }), {
          status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }
    }

    // === GET /recover?email=xxx — recover lost key ===
    if (pathname === "/recover" && request.method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) {
        return new Response(JSON.stringify({ error: "Email required" }), {
          status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      try {
        const key = await findKeyByEmail(email, env.AIRTABLE_API_KEY, env.AIRTABLE_BASE_ID);
        if (key) {
          return new Response(JSON.stringify({ key }), {
            status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "No license found for this email" }), {
          status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Recovery failed" }), {
          status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }
    }

    // 404
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  },
};
