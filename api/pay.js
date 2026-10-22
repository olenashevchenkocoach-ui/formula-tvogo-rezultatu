'use strict';
/* Старт оплати: створює замовлення, підписує запит WayForPay (Purchase) і переводить покупця на оплату.
   Якщо щось не так (немає налаштувань, збій Redis) або PAYMENTS_MODE=legacy — відправляє на стару кнопку,
   щоб продажі не зупинялись. */
const L = require('../lib/ftr.js');

module.exports = async (req, res) => {
  const c = L.cfg();
  const legacy = reason => {
    if (reason) console.error('pay -> legacy:', reason);
    res.statusCode = 302;
    res.setHeader('Location', c.legacyUrl);
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  };
  try {
    if (c.mode === 'legacy') return legacy();
    if (!c.account || !c.secret) return legacy('wfp_not_configured');
    if (!(await L.rateLimit('pay', L.clientIp(req), 12, 60))) return legacy('rate_limited');

    const ref = L.newRef();
    const order = { amount: String(c.amount), currency: c.currency, created: Date.now() };
    const saved = await L.redis(['SET', L.K.order(ref), JSON.stringify(order), 'EX', 7 * L.DAY]);
    if (saved !== 'OK') return legacy('redis_set_failed');

    const p = {
      orderReference: ref,
      orderDate: String(Math.floor(Date.now() / 1000)),
      amount: String(c.amount),
      productName: [c.product],
      productCount: ['1'],
      productPrice: [String(c.amount)],
    };
    const fields = [
      ['merchantAccount', c.account],
      ['merchantAuthType', 'SimpleSignature'],
      ['merchantDomainName', c.domain],
      ['merchantTransactionSecureType', 'AUTO'],
      ['merchantSignature', L.purchaseSignature(c, p)],
      ['language', 'UA'],
      ['returnUrl', `${c.site}/api/wfp-return`],
      ['serviceUrl', `${c.site}/api/wfp-service`],
      ['orderReference', p.orderReference],
      ['orderDate', p.orderDate],
      ['amount', p.amount],
      ['currency', c.currency],
      ['productName[]', p.productName[0]],
      ['productPrice[]', p.productPrice[0]],
      ['productCount[]', p.productCount[0]],
    ];
    const inputs = fields.map(([k, v]) => `<input type="hidden" name="${L.esc(k)}" value="${L.esc(v)}">`).join('');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', L.setOrderCookie(ref));
    res.end(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Перехід до оплати…</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F9F5EE;color:#2E1F1B;font:500 17px/1.5 Manrope,Arial,sans-serif;text-align:center;padding:24px}button{margin-top:16px;padding:16px 28px;border:0;border-radius:999px;background:#7A2E2E;color:#fff;font:600 16px Manrope,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}</style></head>
<body><form id="f" method="post" action="https://secure.wayforpay.com/pay" accept-charset="utf-8">${inputs}
<div>Переходимо до безпечної оплати…</div><noscript><button type="submit">Перейти до оплати</button></noscript></form>
<script>document.getElementById('f').submit()</script></body></html>`);
  } catch (e) {
    legacy('exception: ' + (e && e.message));
  }
};
