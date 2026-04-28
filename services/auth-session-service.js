'use strict';

function createAuthSessionService(options = {}) {
  const {
    digitsOnly,
    mailIncludePassword = false,
    loginWindowMs = 15 * 60 * 1000,
    loginMaxAttempts = 8,
  } = options;

  const loginAttempts = new Map();

  function setGeneratedPinNotice(req, notice) {
    if (!req.session) return;
    req.session.generatedPinNotice = {
      user_id: notice.user_id || '',
      fio: notice.fio || '',
      phone: notice.phone || '',
      pin: notice.pin || '',
      reason: notice.reason || 'generated',
      mail_includes_password: !!mailIncludePassword,
      email: notice.email || '',
    };
  }

  function consumeGeneratedPinNotice(req) {
    const notice = req.session?.generatedPinNotice || null;
    if (req.session) delete req.session.generatedPinNotice;
    return notice;
  }

  function clientIp(req) {
    return req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  }

  function loginRateKey(req, phone) {
    return `${clientIp(req)}:${digitsOnly(phone)}`;
  }

  function checkLoginRateLimit(req, phone) {
    const now = Date.now();
    const key = loginRateKey(req, phone);
    const item = loginAttempts.get(key);
    if (!item || item.resetAt <= now) {
      loginAttempts.set(key, { count: 0, resetAt: now + loginWindowMs });
      return { ok: true, key };
    }
    if (item.count >= loginMaxAttempts) {
      return { ok: false, key, retryAfterSec: Math.ceil((item.resetAt - now) / 1000) };
    }
    return { ok: true, key };
  }

  function recordLoginFailure(key) {
    if (!key) return;
    const now = Date.now();
    const item = loginAttempts.get(key) || { count: 0, resetAt: now + loginWindowMs };
    item.count += 1;
    item.resetAt = item.resetAt > now ? item.resetAt : now + loginWindowMs;
    loginAttempts.set(key, item);
  }

  function clearLoginFailures(key) {
    if (key) loginAttempts.delete(key);
  }

  return {
    setGeneratedPinNotice,
    consumeGeneratedPinNotice,
    checkLoginRateLimit,
    recordLoginFailure,
    clearLoginFailures,
  };
}

module.exports = {
  createAuthSessionService,
};
