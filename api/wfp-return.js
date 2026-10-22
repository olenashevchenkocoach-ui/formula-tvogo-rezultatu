'use strict';
/* Сторінка повернення після оплати. Тут нічого не видаємо: лише запам’ятовуємо замовлення
   (якщо WayForPay надіслав коректно підписаний результат) і ведемо на thanks.html. */
const L = require('../lib/ftr.js');

module.exports = async (req, res) => {
  const c = L.cfg();
  let target = '/thanks.html';
  try {
    const d = await L.readBody(req);
    const ref = String(d.orderReference || '');
    if (L.validRef(ref) && c.secret && String(d.merchantAccount) === String(c.account) && L.responseSignatureOk(c, d)) {
      res.setHeader('Set-Cookie', L.setOrderCookie(ref));
      if (d.transactionStatus && d.transactionStatus !== 'Approved') target = '/thanks.html?s=failed';
    }
  } catch (e) { console.error('wfp-return', e && e.message); }
  res.statusCode = 303;
  res.setHeader('Location', target);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
};
