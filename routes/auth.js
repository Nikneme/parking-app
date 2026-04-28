'use strict';

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
}) {
  app.get('/login', (req, res) => {
    res.render('login', {
      title: 'Вход • Parking GIT',
      bodyClass: 'auth-page',
      error: null,
    });
  });

  app.post('/login', async (req, res) => {
    const phoneIn = digitsOnly(req.body.phone);
    const pinIn = String(req.body.pin ?? '');
    const rate = checkLoginRateLimit(req, phoneIn);

    if (!rate.ok) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      return res.status(429).render('login', {
        title: 'Вход • Parking GIT',
        bodyClass: 'auth-page',
        error: 'Слишком много попыток входа. Повторите позже.',
      });
    }

    try {
      const result = await dbQuery(
        `SELECT id,fio,phone,organization,position,pin,role,is_is_admin,zones,assignable_zones,is_tenant_contact,parking_floors,parking_groups,parking_spots,preferred_routes,is_active
         FROM public.users
         WHERE regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') = $1
         LIMIT 1`,
        [phoneIn]
      );

      const user = result.rows[0];
      if (!user) {
        recordLoginFailure(rate.key);
        return res.status(401).render('login', { title: 'Вход • Parking GIT', bodyClass: 'auth-page', error: 'Телефон не найден' });
      }
      if (user.is_active === false) {
        recordLoginFailure(rate.key);
        return res.status(401).render('login', { title: 'Вход • Parking GIT', bodyClass: 'auth-page', error: 'Аккаунт отключён' });
      }

      const pinOk = await verifyPin(pinIn, user.pin);
      if (!pinOk) {
        recordLoginFailure(rate.key);
        return res.status(401).render('login', { title: 'Вход • Parking GIT', bodyClass: 'auth-page', error: 'Неверный пароль' });
      }
      clearLoginFailures(rate.key);

      if (!isHashedPin(user.pin)) {
        await dbQuery(`UPDATE public.users SET pin=$2, updated_at=NOW() WHERE id=$1`, [user.id, await hashPin(pinIn)]);
      }

      req.session.user = mapSessionUser(user);
      await appendAudit(req, 'login', 'user', user.id, { phone: user.phone });
      return req.session.save((err) => {
        if (err) console.error('session save error:', err);
        res.redirect('/');
      });
    } catch (error) {
      console.error('login error:', error?.message || error);
      return res.status(500).render('login', { title: 'Вход • Parking GIT', bodyClass: 'auth-page', error: 'Ошибка сервера. Повторите позже.' });
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
