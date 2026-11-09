'use strict';
/* Сторінка повернення після оплати КОПІЄЮ платіжної кнопки.
   Підтверджену оплату записуємо в підписане cookie й ведемо на paid.html.
   Нічого не показуємо без перевірки: підпис WayForPay, статус Approved, сума й валюта. */
const L = require('../lib/ftr.js');
const P = require('../lib/paid.js');

const go = (res, target, cookie) => {
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.statusCode = 303;
  res.setHeader('Location', target);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
};

module.exports = async (req, res) => {
  const c = L.cfg();
  try {
    const d = await L.readBody(req);
    const ref = String(d.orderReference || '');
    const signed = c.secret && ref && String(d.merchantAccount) === String(c.account) && L.responseSignatureOk(c, d);
    if (!signed) {
      console.error('btn-return: no valid signed result', ref ? 'ref present' : 'no ref');
      return go(res, '/paid.html');                       // сторінка сама покаже стан за cookie
    }
    if (d.transactionStatus !== 'Approved') return go(res, '/paid.html?s=failed');
    if (!L.amountMatches(d.amount, c.amount, d.currency, c.currency)) {
      console.error('btn-return: amount/currency mismatch', ref, d.amount, d.currency);
      return go(res, '/paid.html?s=check');
    }
    // Додаткова перевірка офіційним запитом статусу. Якщо WayForPay прямо каже «не Approved» — відмова.
    // Якщо запит просто не вдався, довіряємо підписаному результату повернення.
    const r = await L.checkStatus(c, ref, { amount: c.amount, currency: c.currency });
    if (!r.ok && /^(status_|amount_mismatch)/.test(r.reason)) {
      console.error('btn-return: check_status rejected', ref, r.reason);
      return go(res, '/paid.html?s=check');
    }
    if (!r.ok) console.error('btn-return: check_status unavailable, trusting signed return', ref, r.reason);
    try { await L.redis(['SET', `ftr:btnpaid:${ref}`, String(Date.now()), 'NX', 'EX', 90 * L.DAY]); } catch (e) { /* журнал необов’язковий */ }
    return go(res, '/paid.html', P.makeCookie(c, ref));
  } catch (e) {
    console.error('btn-return error', e && e.message);
    return go(res, '/paid.html?s=check');
  }
};
