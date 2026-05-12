'use strict';

function renderLogin(res, error = null) {
  return res.render('login', {
    title: 'Вход • Parking GIT',
    bodyClass: 'auth-page',
    error,
  });
}

function renderChangePassword(res, req, options = {}) {
  const reason = String(options.reason || req.query?.reason || '').trim();
  const title = reason === 'expired'
    ? 'Срок действия временного пароля истёк'
    : 'Требуется сменить временный пароль';

  return res.render('change_password', {
    title: `${title} • Parking GIT`,
    bodyClass: 'auth-page',
    user: req.session?.user || null,
    error: options.error || null,
    success: options.success || null,
    reason,
    pinMinLength: options.pinMinLength || 8,
  });
}

function registerAuthRoutes({
  app,
  dbQuery,
  digitsOnly,
  mapSessionUser,
  verifyPin,
  isHashedPin,
  hashPin,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  appendAudit,
  getStartPinExpiresAt,
  userNeedsPinChange,
  pinChangeReason,
  validateNewPin,
  pinMinLength = 8,
}) {
  app.get('/login', (req, res) => renderLogin(res));

  app.post('/login', async (req, res) => {
    const phoneIn = digitsOnly(req.body.phone);
    const pinIn = String(req.body.pin ?? '');
    const rate = checkLoginRateLimit(req, phoneIn);

    if (!rate.ok) {
      await appendAudit(req, 'login_rate_limited', 'auth', phoneIn || 'unknown', {
        phone: phoneIn,
        scope: rate.scope || 'unknown',
        retry_after_sec: rate.retryAfterSec,
      });
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      return res.status(429).render('login', {
        title: 'Вход • Parking GIT',
        bodyClass: 'auth-page',
        error: 'Слишком много попыток входа. Повторите позже.',
      });
    }

    try {
      const result = await dbQuery(
        `SELECT id,fio,phone,organization,position,pin,role,is_is_admin,zones,assignable_zones,is_tenant_contact,parking_floors,parking_groups,parking_spots,preferred_routes,is_active,must_change_pin,pin_expires_at
         FROM public.users
         WHERE regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') = $1
         LIMIT 1`,
        [phoneIn]
      );

      const user = result.rows[0];
      const genericError = 'Неверный телефон или пароль';
      if (!user) {
        recordLoginFailure(rate);
        await appendAudit(req, 'login_failed', 'auth', phoneIn || 'unknown', { phone: phoneIn, reason: 'not_found' });
        return res.status(401).render('login', { title: 'Вход • Parking GIT', bodyClass: 'auth-page', error: genericError });
      }
      if (user.is_active === false) {
        recordLoginFailure(rate);
        await appendAudit(req, 'login_failed', 'user', user.id, { phone: user.phone, reason: 'inactive' });
        return res.status(401).render('login', { title: 'Вход • Parking GIT', bodyClass: 'auth-page', error: genericError });
      }

      const pinOk = await verifyPin(pinIn, user.pin);
      if (!pinOk) {
        recordLoginFailure(rate);
        await appendAudit(req, 'login_failed', 'user', user.id, { phone: user.phone, reason: 'bad_pin' });
        return res.status(401).render('login', { title: 'Вход • Parking GIT', bodyClass: 'auth-page', error: genericError });
      }
      clearLoginFailures(rate);

      let sessionUserRow = { ...user };
      if (!isHashedPin(user.pin)) {
        const expiresAt = getStartPinExpiresAt();
        const nextPin = await hashPin(pinIn);
        await dbQuery(
          `UPDATE public.users
           SET pin=$2,
               must_change_pin=true,
               pin_created_at=COALESCE(pin_created_at, NOW()),
               pin_expires_at=$3,
               updated_at=NOW()
           WHERE id=$1`,
          [user.id, nextPin, expiresAt]
        );
        sessionUserRow = { ...sessionUserRow, pin: nextPin, must_change_pin: true, pin_expires_at: expiresAt };
      }

      req.session.user = mapSessionUser(sessionUserRow);
      await appendAudit(req, 'login', 'user', user.id, { phone: user.phone });

      return req.session.save((err) => {
        if (err) console.error('session save error:', err);
        if (userNeedsPinChange(req.session.user)) {
          return res.redirect(`/change-password?reason=${encodeURIComponent(pinChangeReason(req.session.user))}`);
        }
        return res.redirect('/');
      });
    } catch (error) {
      console.error('login error:', error?.message || error);
      return res.status(500).render('login', { title: 'Вход • Parking GIT', bodyClass: 'auth-page', error: 'Ошибка сервера. Повторите позже.' });
    }
  });

  app.get('/change-password', (req, res) => {
    if (!req.session?.user) return res.redirect('/login');
    return renderChangePassword(res, req, { pinMinLength });
  });

  app.post('/change-password', async (req, res) => {
    if (!req.session?.user) return res.redirect('/login');

    const newPin = String(req.body.new_pin || '');
    const confirmPin = String(req.body.new_pin_confirm || '');
    const user = req.session.user;

    if (newPin !== confirmPin) {
      return res.status(400).render('change_password', {
        title: 'Смена пароля • Parking GIT',
        bodyClass: 'auth-page',
        user,
        error: 'Пароль и подтверждение не совпадают.',
        success: null,
        reason: String(req.query?.reason || ''),
        pinMinLength,
      });
    }

    const validationError = validateNewPin(newPin, user);
    if (validationError) {
      return res.status(400).render('change_password', {
        title: 'Смена пароля • Parking GIT',
        bodyClass: 'auth-page',
        user,
        error: validationError,
        success: null,
        reason: String(req.query?.reason || ''),
        pinMinLength,
      });
    }

    try {
      const currentRes = await dbQuery(
        `SELECT id, phone, pin, is_active FROM public.users WHERE id=$1 LIMIT 1`,
        [String(user.id)]
      );
      const current = currentRes.rows[0];
      if (!current || current.is_active === false) {
        return req.session.destroy(() => res.redirect('/login'));
      }
      if (await verifyPin(newPin, current.pin)) {
        return res.status(400).render('change_password', {
          title: 'Смена пароля • Parking GIT',
          bodyClass: 'auth-page',
          user,
          error: 'Новый пароль не должен совпадать с временным.',
          success: null,
          reason: String(req.query?.reason || ''),
          pinMinLength,
        });
      }

      await dbQuery(
        `UPDATE public.users
         SET pin=$2,
             must_change_pin=false,
             pin_changed_at=NOW(),
             pin_created_at=NULL,
             pin_expires_at=NULL,
             updated_at=NOW()
         WHERE id=$1`,
        [String(user.id), await hashPin(newPin)]
      );
      req.session.user.must_change_pin = false;
      req.session.user.pin_expires_at = null;
      await appendAudit(req, 'change_pin', 'user', String(user.id), { reason: 'first_login_or_reset' });
      return req.session.save(() => res.redirect('/'));
    } catch (error) {
      console.error('change password error:', error?.message || error);
      return res.status(500).render('change_password', {
        title: 'Смена пароля • Parking GIT',
        bodyClass: 'auth-page',
        user,
        error: 'Ошибка сервера. Повторите позже.',
        success: null,
        reason: String(req.query?.reason || ''),
        pinMinLength,
      });
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });
}

module.exports = {
  registerAuthRoutes,
};
