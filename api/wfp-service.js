'use strict';
/* Серверне підписане повідомлення WayForPay (serviceUrl). Єдине джерело правди про оплату. */
const L = require('../lib/ftr.js');

module.exports = async (req, res) => {
  const c = L.cfg();
  if (req.method !== 'POST') return L.json(res, 405, { error: 'method_not_allowed' });
  try {
    if (!c.account || !c.secret) return L.json(res, 503, { error: 'not_configured' });
    const d = await L.readBody(req);
    const ref = String(d.orderReference || '');

    if (!L.validRef(ref) || String(d.merchantAccount) !== String(c.account) || !L.responseSignatureOk(c, d)) {
      console.error('wfp-service: bad signature or account', ref);
      return L.json(res, 400, { error: 'bad_signature' });
    }

    const order = await L.getOrder(ref);
    if (!order) {
      console.error('wfp-service: unknown order (signed)', ref);
      return L.json(res, 200, L.acceptReply(c, ref));
    }

    if (d.transactionStatus === 'Approved') {
      if (L.amountMatches(d.amount, order.amount, d.currency, order.currency)) {
        await L.markPaid(ref);
      } else {
        console.error('wfp-service: amount/currency mismatch', ref, d.amount, d.currency);
      }
    } else if (d.transactionStatus === 'Refunded' || d.transactionStatus === 'Voided') {
      await L.redis(['SET', L.K.void(ref), '1', 'EX', 60 * L.DAY]);
    }
    return L.json(res, 200, L.acceptReply(c, ref));
  } catch (e) {
    console.error('wfp-service error', e && e.message);
    return L.json(res, 500, { error: 'server_error' }); // WayForPay повторить спробу
  }
};
