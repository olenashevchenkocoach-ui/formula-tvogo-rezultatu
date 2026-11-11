/**
 * Vercel Serverless Function: /api/wayforpay-webhook
 *
 * Приймає сповіщення (serviceUrl) від WayForPay про результат оплати.
 * Якщо підпис правильний, статус Approved, сума 296 UAH —
 * надсилає подію Purchase у Meta Conversions API.
 *
 * Секрети беруться ТІЛЬКИ зі змінних середовища Vercel (в код не вписуються).
 */
const crypto = require("crypto");

const hmacMd5 = (str, key) => crypto.createHmac("md5", key).update(str, "utf8").digest("hex");
const sha256 = (str) => crypto.createHash("sha256").update(str, "utf8").digest("hex");

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "").toLowerCase());
  const y = Buffer.from(String(b || "").toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* WayForPay шле JSON, але іноді з "формовим" Content-Type — розбираємо всі варіанти */
async function readPayload(req) {
  let b = req.body;
  if (Buffer.isBuffer(b)) b = b.toString("utf8");
  if (b && typeof b === "object") {
    if (b.merchantAccount) return b;
    const keys = Object.keys(b);
    if (keys.length === 1 && keys[0].trim().startsWith("{")) {
      try { return JSON.parse(keys[0]); } catch (e) {}
    }
  }
  if (typeof b === "string" && b.trim()) {
    try { return JSON.parse(b); } catch (e) {}
    try {
      const k = [...new URLSearchParams(b).keys()][0];
      if (k && k.trim().startsWith("{")) return JSON.parse(k);
    } catch (e) {}
  }
  const raw = await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
  try { return JSON.parse(raw); } catch (e) {}
  try {
    const k = [...new URLSearchParams(raw).keys()][0];
    if (k) return JSON.parse(k);
  } catch (e) {}
  return null;
}

function normEmail(v) { return String(v || "").trim().toLowerCase(); }
function normPhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("0")) d = "38" + d; // 0501234567 -> 380501234567
  return d;
}

module.exports = async function handler(req, res) {
  const env = process.env;
  const cfg = {
    merchant: env.WFP_MERCHANT_ACCOUNT,
    secret: env.WFP_SECRET_KEY,
    pixel: env.META_PIXEL_ID,
    token: env.META_ACCESS_TOKEN,
    testCode: env.META_TEST_EVENT_CODE || "",
    amount: Number(env.EXPECTED_AMOUNT || 296),
    siteUrl: env.SITE_URL || "https://formula-tvogo-rezultatu.vercel.app/",
  };

  /* Діагностика без оплати: відкрий адресу функції в браузері (GET) */
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      configured: {
        WFP_MERCHANT_ACCOUNT: !!cfg.merchant,
        WFP_SECRET_KEY: !!cfg.secret,
        META_PIXEL_ID: !!cfg.pixel,
        META_ACCESS_TOKEN: !!cfg.token,
        META_TEST_EVENT_CODE: !!cfg.testCode,
        EXPECTED_AMOUNT: cfg.amount,
      },
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!cfg.merchant || !cfg.secret || !cfg.pixel || !cfg.token) {
    console.error("Не задано змінні середовища");
    return res.status(500).json({ error: "Server not configured" });
  }

  const p = await readPayload(req);
  if (!p || !p.orderReference) return res.status(400).json({ error: "Bad payload" });

  /* 1. Перевірка підпису WayForPay */
  const parts = (amountStr) => [
    p.merchantAccount, p.orderReference, amountStr, p.currency,
    p.authCode, p.cardPan, p.transactionStatus, p.reasonCode,
  ].map((x) => (x === undefined || x === null ? "" : String(x))).join(";");
  const candidates = [String(p.amount), Number(p.amount).toFixed(2)];
  const signatureOk =
    String(p.merchantAccount) === String(cfg.merchant) &&
    candidates.some((a) => safeEqual(hmacMd5(parts(a), cfg.secret), p.merchantSignature));
  if (!signatureOk) {
    console.warn("Невірний підпис, order:", p.orderReference);
    return res.status(401).json({ error: "Invalid signature" });
  }

  /* 2. Відповідь, якої чекає WayForPay (інакше він повторює запит до 4 днів) */
  const time = Math.floor(Date.now() / 1000);
  const accept = {
    orderReference: p.orderReference,
    status: "accept",
    time,
    signature: hmacMd5(`${p.orderReference};accept;${time}`, cfg.secret),
  };

  /* 3. Purchase лише для підтвердженої оплати потрібної суми */
  const approved = p.transactionStatus === "Approved";
  const amountOk = Number(p.amount) === cfg.amount && p.currency === "UAH";
  if (!approved || !amountOk) {
    console.log("Пропущено (без Purchase):", p.orderReference, p.transactionStatus, p.amount, p.currency);
    return res.status(200).json(accept);
  }

  /* 4. Подія в Meta Conversions API */
  const proc = Number(p.processingDate);
  const eventTime = proc > time - 6 * 86400 && proc <= time + 60 ? Math.floor(proc) : time;

  const userData = {};
  const em = normEmail(p.email);
  const ph = normPhone(p.phone);
  if (em) userData.em = [sha256(em)];
  if (ph) userData.ph = [sha256(ph)];
  if (!em && !ph) userData.external_id = [sha256(String(p.orderReference))];

  const body = {
    data: [{
      event_name: "Purchase",
      event_time: eventTime,
      event_id: String(p.orderReference),
      action_source: "other",
      event_source_url: cfg.siteUrl,
      user_data: userData,
      custom_data: { value: cfg.amount, currency: "UAH", content_name: "Формула твого результату" },
    }],
  };
  if (cfg.testCode) body.test_event_code = cfg.testCode;

  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.pixel)}/events?access_token=${encodeURIComponent(cfg.token)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("Meta CAPI помилка:", r.status, JSON.stringify(out));
      return res.status(502).json({ error: "Meta error" }); // WayForPay повторить пізніше
    }
    console.log("Purchase надіслано в Meta:", p.orderReference, "events_received:", out.events_received);
  } catch (e) {
    console.error("Meta CAPI збій:", e && e.message);
    return res.status(502).json({ error: "Meta unreachable" });
  }

  return res.status(200).json(accept);
};
