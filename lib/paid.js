'use strict';
/* Допоміжні функції сторінки «Оплату підтверджено» для платіжної кнопки.
   Нічого не змінює в lib/ftr.js. Cookie підписується секретним ключем сервера,
   тому підробити його або підібрати чужий номер замовлення неможливо. */
const crypto = require('crypto');
const L = require('./ftr.js');

const NAME = 'ftr_paid';
const MAX_AGE = 14 * 24 * 3600;

const keyFor = c => crypto.createHash('sha256').update('ftr-paid-v1:' + (c.secret || '')).digest();
const mac = (c, payload) => crypto.createHmac('sha256', keyFor(c)).update(payload).digest('base64url');

function makeCookie(c, ref) {
  const payload = Buffer.from(JSON.stringify({ r: ref, t: Math.floor(Date.now() / 1000) })).toString('base64url');
  const val = `${payload}.${mac(c, payload)}`;
  return `${NAME}=${val}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

/* Повертає номер замовлення, якщо cookie справжнє, інакше null */
function readCookie(c, req) {
  const raw = L.getCookie(req, NAME);
  if (!raw || !c.secret) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const good = mac(c, payload);
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!j || typeof j.r !== 'string' || !j.t) return null;
    if (Date.now() / 1000 - j.t > MAX_AGE) return null;
    return j.r;
  } catch (e) { return null; }
}

module.exports = { makeCookie, readCookie, NAME };
