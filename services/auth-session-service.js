'use strict';

function createAuthSessionService(options = {}) {
  const {
    digitsOnly,
    mailIncludePassword = false,
    loginWindowMs = 15 * 60 * 1000,
    loginMaxAttempts = 8,
    loginIpMaxAttempts = loginMaxAttempts * 5,
    loginPhoneMaxAttempts = loginMaxAttempts * 3,
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
      mail_includes_password: false,
      email: notice.email || '',
      expires_at: notice.expires_at || null,
      ttl_hours: notice.ttl_hours || null,
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

  function loginRateScopes(req, phone) {
    const ip = clientIp(req);
    const phoneDigits = digitsOnly(phone) || 'empty';
    return [
      { key: `ip_phone:${ip}:${phoneDigits}`, max: loginMaxAttempts, scope: 'ip_phone' },
      { key: `ip:${ip}`, max: loginIpMaxAttempts, scope: 'ip' },
      { key: `phone:${phoneDigits}`, max: loginPhoneMaxAttempts, scope: 'phone' },
    ];
  }

  function readAttempt(scope, now) {
    const item = loginAttempts.get(scope.key);
    if (!item || item.resetAt <= now) {
      const fresh = { count: 0, resetAt: now + loginWindowMs, max: scope.max, scope: scope.scope };
      loginAttempts.set(scope.key, fresh);
      return fresh;
    }
    return item;
  }

  function checkLoginRateLimit(req, phone) {
    const now = Date.now();
    const scopes = loginRateScopes(req, phone);
    for (const scope of scopes) {
      const item = readAttempt(scope, now);
      if (item.count >= scope.max) {
        return {
          ok: false,
          key: scope.key,
          scopes,
          scope: scope.scope,
          retryAfterSec: Math.ceil((item.resetAt - now) / 1000),
        };
      }
    }
    return { ok: true, key: scopes[0].key, scopes };
  }

  function recordLoginFailure(rateOrKey) {
    const scopes = Array.isArray(rateOrKey?.scopes)
      ? rateOrKey.scopes
      : [{ key: String(rateOrKey || ''), max: loginMaxAttempts, scope: 'legacy' }];
    const now = Date.now();
    for (const scope of scopes) {
      if (!scope.key) continue;
      const item = loginAttempts.get(scope.key) || { count: 0, resetAt: now + loginWindowMs, max: scope.max, scope: scope.scope };
      item.count += 1;
      item.max = scope.max;
      item.scope = scope.scope;
      item.resetAt = item.resetAt > now ? item.resetAt : now + loginWindowMs;
      loginAttempts.set(scope.key, item);
    }
  }

  function clearLoginFailures(rateOrKey) {
    const scopes = Array.isArray(rateOrKey?.scopes)
      ? rateOrKey.scopes
      : [{ key: String(rateOrKey || '') }];
    for (const scope of scopes) {
      if (scope.key) loginAttempts.delete(scope.key);
    }
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
