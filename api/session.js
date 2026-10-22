'use strict';
/* Сторінка подяки питає тут стан оплати. Особисте запрошення видається лише після підтвердженої оплати. */
const L = require('../lib/ftr.js');

module.exports = async (req, res) => {
  const c = L.cfg();
  const base = { bot_url: `https://t.me/${c.tgBot}`, support_url: c.supportUrl || '' };
  try {
    if (!(await L.rateLimit('sess', L.clientIp(req), 90, 60))) return L.json(res, 429, { ...base, state: 'pending' });
    const ref = L.getCookie(req, L.cookieName);
    if (!L.validRef(ref)) return L.json(res, 200, { ...base, state: 'unknown' });
    const order = await L.getOrder(ref);
    if (!order) return L.json(res, 200, { ...base, state: 'unknown' });
    if (await L.redis(['GET', L.K.void(ref)])) return L.json(res, 200, { ...base, state: 'refunded', order: ref });

    let paid = !!(await L.redis(['GET', L.K.paid(ref)]));
    if (!paid) {
      // Якщо повідомлення ще не дійшло — перевіряємо статус офіційним запитом (не частіше, ніж раз на 4 с)
      const first = await L.redis(['SET', L.K.chk(ref), '1', 'NX', 'EX', 4]);
      if (first === 'OK') {
        const r = await L.checkStatus(c, ref, order);
        if (r.ok) { await L.markPaid(ref); paid = true; }
        else if (/^status_(Declined|Expired|Refunded|Voided)$/.test(r.reason)) {
          return L.json(res, 200, { ...base, state: 'failed', order: ref });
        } else if (!/^status_/.test(r.reason)) console.error('session check', ref, r.reason);
      }
    }
    if (!paid) return L.json(res, 200, { ...base, state: 'pending' });

    const inv = await L.issueInvite(c, ref);
    if (inv.state === 'ready') return L.json(res, 200, { ...base, state: 'ready', invite_url: inv.url, order: ref });
    if (inv.state === 'pending') return L.json(res, 200, { ...base, state: 'pending' });
    return L.json(res, 200, { ...base, state: 'error', order: ref });
  } catch (e) {
    console.error('session error', e && e.message);
    return L.json(res, 200, { ...base, state: 'error' });
  }
};
