'use strict';
/* Службовий інструмент власниці: перевірка налаштувань і ручна видача запрошення за номером замовлення.
   Доступ тільки з ключем ADMIN_KEY (заголовок x-admin-key). */
const crypto = require('crypto');
const L = require('../lib/ftr.js');

const sameKey = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a || '')).digest();
  const y = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(x, y);
};

module.exports = async (req, res) => {
  const c = L.cfg();
  if (req.method !== 'POST') return L.json(res, 405, { error: 'method_not_allowed' });
  try {
    if (!c.adminKey || c.adminKey.length < 16) return L.json(res, 503, { error: 'ADMIN_KEY не задано (мінімум 16 символів)' });
    if (!(await L.rateLimit('admin', L.clientIp(req), 20, 600))) return L.json(res, 429, { error: 'too_many_requests' });
    if (!sameKey(req.headers['x-admin-key'], c.adminKey)) return L.json(res, 401, { error: 'wrong_key' });
    const d = await L.readBody(req);

    if (d.action === 'health') {
      const out = {
        env: {
          WFP_MERCHANT_ACCOUNT: !!c.account, WFP_SECRET_KEY: !!c.secret, TELEGRAM_BOT_TOKEN: !!c.tgToken,
          TELEGRAM_CHAT_ID: !!c.tgChat, ADMIN_KEY: true,
        },
        settings: { mode: c.mode, site: c.site, domain: c.domain, amount: c.amount, currency: c.currency, inviteHours: c.inviteHours },
        urls: { pay: `${c.site}/api/pay`, service: `${c.site}/api/wfp-service`, return: `${c.site}/api/wfp-return` },
      };
      try { await L.redis(['SET', 'ftr:health', '1', 'EX', 60]); out.redis = (await L.redis(['GET', 'ftr:health'])) === '1' ? 'ok' : 'fail'; }
      catch (e) { out.redis = 'ПОМИЛКА: ' + e.message; }
      if (c.tgToken) {
        const me = await L.tg(c, 'getMe');
        out.telegramBot = me.ok ? '@' + me.result.username : 'ПОМИЛКА: ' + (me.description || '');
        if (me.ok && c.tgChat) {
          try {
            const chat = await L.resolveChatId(c);
            out.telegramChat = { id: chat.id, title: chat.title };
            const m = await L.tg(c, 'getChatMember', { chat_id: chat.id, user_id: me.result.id });
            out.botInChat = m.ok
              ? { status: m.result.status, canInviteUsers: m.result.status === 'creator' ? true : !!m.result.can_invite_users }
              : 'ПОМИЛКА: ' + (m.description || '');
          } catch (e) { out.telegramChat = 'ПОМИЛКА: ' + e.message; }
        }
      }
      return L.json(res, 200, out);
    }

    if (d.action === 'invite') {
      const ref = String(d.order || '').trim();
      if (!/^[A-Za-z0-9_.\-]{4,64}$/.test(ref)) return L.json(res, 400, { error: 'bad_order_number' });
      const order = await L.getOrder(ref);
      const expected = order || { amount: c.amount, currency: c.currency };
      const r = await L.checkStatus(c, ref, expected);
      if (!r.ok) return L.json(res, 200, { ok: false, reason: r.reason });
      const url = await L.createInvite(c, ref);
      console.error('admin invite issued for', ref); // запис у журнал Vercel
      return L.json(res, 200, { ok: true, invite_url: url, note: 'Одноразове посилання, діє ' + c.inviteHours + ' год.' });
    }
    return L.json(res, 400, { error: 'unknown_action' });
  } catch (e) {
    console.error('admin error', e && e.message);
    return L.json(res, 500, { error: e && e.message });
  }
};
