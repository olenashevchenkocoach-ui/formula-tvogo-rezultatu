'use strict';
/* Сторінка paid.html питає тут, чи є в цьому браузері підтверджена оплата.
   ?claim=1 — «забрати право» надіслати Purchase у Meta: сервер дозволяє це лише один раз на замовлення. */
const L = require('../lib/ftr.js');
const P = require('../lib/paid.js');

module.exports = async (req, res) => {
  const c = L.cfg();
  const base = { bot_url: `https://t.me/${c.tgBot}`, support_url: c.supportUrl || '' };
  try {
    const ref = P.readCookie(c, req);
    if (!ref) return L.json(res, 200, { ...base, state: 'unknown' });
    const out = { ...base, state: 'ready', order: ref, value: Number(c.amount), currency: String(c.currency).toUpperCase() };

    const wantsClaim = /(?:^|[?&])claim=1(?:&|$)/.test(String(req.url || '').split('?')[1] || '');
    if (wantsClaim) {
      // true — першим забрав (можна слати), false — вже забирали, null — Redis недоступний (рішає браузер)
      try {
        const got = await L.redis(['SET', `ftr:purchase:${ref}`, String(Date.now()), 'NX', 'EX', 90 * L.DAY]);
        out.first = got === 'OK';
      } catch (e) { out.first = null; }
    }
    return L.json(res, 200, out);
  } catch (e) {
    console.error('paid-status', e && e.message);
    return L.json(res, 200, { ...base, state: 'unknown' });
  }
};
