'use strict';
/* Спільні функції для оплати «Формула твого результату».
   Секрети беруться лише зі змінних середовища Vercel. */
const crypto = require('crypto');

const ENV = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

const cfg = () => ({
  account: ENV('WFP_MERCHANT_ACCOUNT'),
  secret: ENV('WFP_SECRET_KEY'),
  domain: ENV('WFP_MERCHANT_DOMAIN', 'formula-tvogo-rezultatu.vercel.app'),
  site: (ENV('SITE_URL', 'https://formula-tvogo-rezultatu.vercel.app')).replace(/\/+$/, ''),
  amount: ENV('ORDER_AMOUNT', '365'),
  currency: ENV('ORDER_CURRENCY', 'UAH'),
  product: ENV('PRODUCT_NAME', 'Практикум «Формула твого результату»'),
  legacyUrl: ENV('LEGACY_PAY_URL', 'https://secure.wayforpay.com/button/b4af500b9d91f'),
  mode: ENV('PAYMENTS_MODE', 'new'),
  tgToken: ENV('TELEGRAM_BOT_TOKEN'),
  tgChat: ENV('TELEGRAM_CHAT_ID'),
  tgBot: ENV('TG_BOT_USERNAME', 'formula_rezultatu_bot'),
  inviteHours: Math.max(1, parseInt(ENV('INVITE_TTL_HOURS', '72'), 10) || 72),
  adminKey: ENV('ADMIN_KEY'),
  supportUrl: ENV('SUPPORT_URL', ''),
});

/* ---------- WayForPay ---------- */
const hmacMd5 = (str, key) => crypto.createHmac('md5', key).update(str, 'utf8').digest('hex');

const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '').toLowerCase());
  const y = Buffer.from(String(b || '').toLowerCase());
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/* Підпис запиту Purchase: merchantAccount;merchantDomainName;orderReference;orderDate;amount;currency;
   productName[];productCount[];productPrice[] */
function purchaseSignature(c, p) {
  const s = [c.account, c.domain, p.orderReference, p.orderDate, p.amount, c.currency,
    ...p.productName, ...p.productCount, ...p.productPrice].join(';');
  return hmacMd5(s, c.secret);
}

/* Підпис відповіді/повідомлення WayForPay: merchantAccount;orderReference;amount;currency;authCode;
   cardPan;transactionStatus;reasonCode. Сума може бути записана як 365 або 365.00 — пробуємо обидва
   варіанти, обидва криптографічно коректні лише з нашим секретним ключем. */
function responseSignatureOk(c, d) {
  if (!d || !d.merchantSignature || !c.secret) return false;
  const amounts = new Set([String(d.amount)]);
  const n = Number(d.amount);
  if (Number.isFinite(n)) { amounts.add(n.toFixed(2)); amounts.add(String(n)); }
  for (const a of amounts) {
    const s = [d.merchantAccount, d.orderReference, a, d.currency, d.authCode, d.cardPan,
      d.transactionStatus, d.reasonCode].map(v => (v === undefined || v === null ? '' : String(v))).join(';');
    if (safeEq(hmacMd5(s, c.secret), d.merchantSignature)) return true;
  }
  return false;
}

/* Відповідь для WayForPay на serviceUrl */
function acceptReply(c, orderReference) {
  const time = Math.floor(Date.now() / 1000);
  return { orderReference, status: 'accept', time, signature: hmacMd5(`${orderReference};accept;${time}`, c.secret) };
}

/* Офіційна перевірка статусу замовлення (CHECK_STATUS). Повертає {ok, reason, data}. */
async function checkStatus(c, orderReference, expected) {
  const body = {
    transactionType: 'CHECK_STATUS',
    merchantAccount: c.account,
    orderReference,
    merchantSignature: hmacMd5(`${c.account};${orderReference}`, c.secret),
    apiVersion: 1,
  };
  let r, d;
  try {
    r = await fetch('https://api.wayforpay.com/api', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    d = await r.json();
  } catch (e) { return { ok: false, reason: 'wfp_unreachable' }; }
  if (!d || d.transactionStatus === undefined) return { ok: false, reason: 'wfp_no_status', data: d };
  if (String(d.orderReference) !== String(orderReference)) return { ok: false, reason: 'wfp_order_mismatch' };
  if (!responseSignatureOk(c, { ...d, merchantAccount: d.merchantAccount || c.account })) return { ok: false, reason: 'wfp_bad_signature', data: d };
  if (String(d.merchantAccount) !== String(c.account)) return { ok: false, reason: 'wfp_account_mismatch' };
  if (d.transactionStatus !== 'Approved') return { ok: false, reason: 'status_' + d.transactionStatus, data: d };
  if (expected && !amountMatches(d.amount, expected.amount, d.currency, expected.currency)) return { ok: false, reason: 'amount_mismatch', data: d };
  return { ok: true, data: d };
}

const amountMatches = (got, want, gotCur, wantCur) =>
  Number(got) === Number(want) && String(gotCur).toUpperCase() === String(wantCur).toUpperCase();

/* ---------- Redis (Upstash REST) ---------- */
function redisCreds() {
  const url = ENV('KV_REST_API_URL', ENV('UPSTASH_REDIS_REST_URL'));
  const token = ENV('KV_REST_API_TOKEN', ENV('UPSTASH_REDIS_REST_TOKEN'));
  if (!url || !token) throw new Error('redis_not_configured');
  return { url, token };
}
async function redis(cmd) {
  const { url, token } = redisCreds();
  const r = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd), signal: AbortSignal.timeout(6000),
  });
  const j = await r.json();
  if (j.error) throw new Error('redis_error: ' + j.error);
  return j.result;
}
const K = {
  order: ref => `ftr:order:${ref}`,
  paid: ref => `ftr:paid:${ref}`,
  void: ref => `ftr:void:${ref}`,
  lock: ref => `ftr:invlock:${ref}`,
  inv: ref => `ftr:inv:${ref}`,
  chk: ref => `ftr:chk:${ref}`,
  rl: (name, id) => `ftr:rl:${name}:${id}`,
};
const DAY = 86400;

/* Обмеження частоти (не блокує продажі, якщо Redis недоступний) */
async function rateLimit(name, id, max, windowSec) {
  try {
    const k = K.rl(name, crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16));
    const n = await redis(['INCR', k]);
    if (n === 1) await redis(['EXPIRE', k, windowSec]);
    return n <= max;
  } catch (e) { return true; }
}

/* ---------- HTTP-утиліти ---------- */
const clientIp = req => String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'x').trim();

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  let raw = '';
  if (!req.readableEnded) {
    raw = await new Promise((resolve, reject) => {
      let d = ''; req.setEncoding('utf8');
      req.on('data', c => { d += c; if (d.length > 200000) { reject(new Error('too_big')); req.destroy(); } });
      req.on('end', () => resolve(d)); req.on('error', reject);
    });
  }
  if (!raw && req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
  }
  return parseBody(raw);
}
function parseBody(raw) {
  raw = String(raw || '').trim();
  if (!raw) return {};
  try { const j = JSON.parse(raw); if (j && typeof j === 'object') return j; } catch (e) {}
  const out = {};
  const sp = new URLSearchParams(raw);
  for (const [k, v] of sp.entries()) out[k] = v;
  const keys = Object.keys(out);
  if (keys.length === 1 && out[keys[0]] === '' && keys[0].trim().startsWith('{')) {
    try { return JSON.parse(keys[0]); } catch (e) {}
  }
  return out;
}

const cookieName = 'ftr_o';
const getCookie = (req, name) => {
  const m = String(req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
};
const setOrderCookie = ref =>
  `${cookieName}=${encodeURIComponent(ref)}; Path=/; Max-Age=${3 * DAY}; HttpOnly; Secure; SameSite=Lax`;
const validRef = ref => /^FTR-[A-Za-z0-9_-]{8,48}$/.test(String(ref || ''));
const newRef = () => 'FTR-' + Date.now().toString(36) + crypto.randomBytes(9).toString('base64url');

const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
};
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/* ---------- Telegram: одноразове запрошення ---------- */
async function tg(c, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${c.tgToken}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}), signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  return j;
}
/* ID супергрупи інколи копіюють без префікса -100: пробуємо обидва варіанти */
async function resolveChatId(c) {
  const raw = String(c.tgChat || '').trim();
  const cands = [raw];
  const digits = raw.replace(/^-100/, '').replace(/^-/, '');
  if (/^\d+$/.test(digits)) { cands.push('-100' + digits); cands.push('-' + digits); }
  for (const id of [...new Set(cands)]) {
    const j = await tg(c, 'getChat', { chat_id: id });
    if (j.ok) return { id: j.result.id, title: j.result.title };
  }
  throw new Error('telegram_chat_not_found');
}
async function createInvite(c, ref) {
  const chat = await resolveChatId(c);
  const j = await tg(c, 'createChatInviteLink', {
    chat_id: chat.id,
    name: ref.slice(0, 32),
    member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + c.inviteHours * 3600,
  });
  if (!j.ok || !j.result || !j.result.invite_link) throw new Error('telegram_invite_failed: ' + (j.description || ''));
  return j.result.invite_link;
}

/* ---------- Логіка замовлення ---------- */
async function getOrder(ref) {
  const v = await redis(['GET', K.order(ref)]);
  return v ? JSON.parse(v) : null;
}

/* Позначити замовлення оплаченим (ідемпотентно) */
async function markPaid(ref) { await redis(['SET', K.paid(ref), '1', 'EX', 60 * DAY]); }

/* Видати (один раз) персональне запрошення для оплаченого замовлення.
   Повертає {state:'ready',url} | {state:'pending'} | {state:'error'} */
async function issueInvite(c, ref) {
  const existing = await redis(['GET', K.inv(ref)]);
  if (existing) return { state: 'ready', url: existing };
  const got = await redis(['SET', K.lock(ref), '1', 'NX', 'EX', 60]);
  if (got !== 'OK') return { state: 'pending' };
  try {
    const url = await createInvite(c, ref);
    await redis(['SET', K.inv(ref), url, 'EX', 60 * DAY]);
    return { state: 'ready', url };
  } catch (e) {
    console.error('issueInvite failed', ref, e.message);
    await redis(['DEL', K.lock(ref)]);
    return { state: 'error' };
  }
}

module.exports = {
  cfg, hmacMd5, safeEq, purchaseSignature, responseSignatureOk, acceptReply, checkStatus, amountMatches,
  redis, K, DAY, rateLimit, clientIp, readBody, parseBody, getCookie, setOrderCookie, cookieName, validRef, newRef,
  json, esc, tg, resolveChatId, createInvite, getOrder, markPaid, issueInvite,
};
