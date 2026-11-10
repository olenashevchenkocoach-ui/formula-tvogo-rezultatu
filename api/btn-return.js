'use strict';
/* Сторінка повернення після оплати платіжною кнопкою WayForPay.
   Підтверджену оплату записуємо в підписане cookie й ведемо на єдину сторінку подяки /thankyou.html.
   Нічого не показуємо без перевірки. Два дозволені шляхи:
   1) підписаний результат WayForPay (підпис, статус Approved, сума й валюта);
   2) якщо підпису немає, а є лише номер замовлення: офіційний запит статусу WayForPay має сказати Approved
      із правильною сумою, і цей номер ще ніким не використаний (одноразово). */
const L = require('../lib/ftr.js');
const P = require('../lib/paid.js');

const PAGE = '/thankyou.html';
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
    let d = await L.readBody(req);
    if (!d || !Object.keys(d).length) {                       // запасний варіант: результат у параметрах адреси
      try { d = Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams); } catch (e) { d = {}; }
    }
    const ref = String(d.orderReference || '');
    const refOk = /^[A-Za-z0-9_.\-]{4,64}$/.test(ref);
    const hasSig = !!d.merchantSignature;
    const signed = !!(c.secret && refOk && hasSig && String(d.merchantAccount) === String(c.account) && L.responseSignatureOk(c, d));

    if (signed) {
      if (d.transactionStatus !== 'Approved') return go(res, PAGE + '?s=failed');
      if (!L.amountMatches(d.amount, c.amount, d.currency, c.currency)) {
        console.error('btn-return: amount/currency mismatch', ref, d.amount, d.currency);
        return go(res, PAGE + '?s=check');
      }
      // Додатково питаємо статус. Якщо WayForPay прямо каже «не Approved» — відмова.
      // Якщо запит просто не вдався, довіряємо підписаному результату.
      const r = await L.checkStatus(c, ref, { amount: c.amount, currency: c.currency });
      if (!r.ok && /^(status_|amount_mismatch)/.test(r.reason)) {
        console.error('btn-return: check_status rejected', ref, r.reason);
        return go(res, PAGE + '?s=check');
      }
      if (!r.ok) console.error('btn-return: check_status unavailable, trusting signed return', ref, r.reason);
      try { await L.redis(['SET', `ftr:btnpaid:${ref}`, String(Date.now()), 'NX', 'EX', 90 * L.DAY]); } catch (e) { /* журнал необов’язковий */ }
      return go(res, PAGE, P.makeCookie(c, ref));
    }

    // Діагностика без значень: лише метод, тип запиту й назви полів
    console.error('btn-return: no valid signed result', JSON.stringify({ method: req.method, type: req.headers['content-type'] || '', fields: Object.keys(d).slice(0, 40), ref: ref ? 'yes' : 'no', sig: hasSig ? 'present' : 'absent' }));

    // Підпис є, але неправильний = підробка або збій. Нічого не даємо.
    if (hasSig || !refOk || !c.secret || !c.account) return go(res, PAGE);
    if (d.transactionStatus && d.transactionStatus !== 'Approved') return go(res, PAGE + '?s=failed');

    // Шлях 2: лише номер замовлення. Захист від перебору номерів.
    if (!(await L.rateLimit('btnret', L.clientIp(req), 20, 60))) return go(res, PAGE + '?s=check');
    const r = await L.checkStatus(c, ref, { amount: c.amount, currency: c.currency });
    if (!r.ok) {
      console.error('btn-return: unsigned path rejected', ref, r.reason);
      return go(res, PAGE + (/^status_(Declined|Expired)$/.test(r.reason) ? '?s=failed' : '?s=check'));
    }
    let first;
    try { first = await L.redis(['SET', `ftr:btnclaim:${ref}`, String(Date.now()), 'NX', 'EX', 90 * L.DAY]); }
    catch (e) { first = null; }                                  // без Redis цей шлях закритий
    if (first !== 'OK') { console.error('btn-return: unsigned path, order already used or no storage', ref); return go(res, PAGE + '?s=check'); }
    return go(res, PAGE, P.makeCookie(c, ref));
  } catch (e) {
    console.error('btn-return error', e && e.message);
    return go(res, PAGE + '?s=check');
  }
};
