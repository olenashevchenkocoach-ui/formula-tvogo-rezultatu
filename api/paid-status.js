'use strict';
/* Сторінка paid.html питає тут, чи є в цьому браузері підтверджена оплата. */
const L = require('../lib/ftr.js');
const P = require('../lib/paid.js');

module.exports = async (req, res) => {
  const c = L.cfg();
  const base = { bot_url: `https://t.me/${c.tgBot}`, support_url: c.supportUrl || '' };
  try {
    const ref = P.readCookie(c, req);
    if (!ref) return L.json(res, 200, { ...base, state: 'unknown' });
    return L.json(res, 200, { ...base, state: 'ready', order: ref });
  } catch (e) {
    console.error('paid-status', e && e.message);
    return L.json(res, 200, { ...base, state: 'unknown' });
  }
};
