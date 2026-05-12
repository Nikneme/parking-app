'use strict';

const crypto = require('crypto');

function roleFromInput(value) {
  const roleRaw = String(value || 'user').trim();
  return roleRaw === 'admin' ? 'admin' : (roleRaw === 'dispatcher' ? 'dispatcher' : 'user');
}

function checkboxToBool(value) {
  return Array.isArray(value)
    ? (value.includes('true') || value.includes('on'))
    : (value === 'on' || value === 'true');
}

function sortUsers(usersMap = {}) {
  return Object.values(usersMap).sort((a, b) => {
    const fioA = String(a?.fio || '').trim();
    const fioB = String(b?.fio || '').trim();

    if (fioA && fioB) {
      const byFio = fioA.localeCompare(fioB, 'ru', { sensitivity: 'base' });
      if (byFio !== 0) return byFio;
    } else if (fioA && !fioB) {
      return -1;
    } else if (!fioA && fioB) {
      return 1;
    }

    return String(a?.phone || '').localeCompare(String(b?.phone || ''), 'ru', { sensitivity: 'base' });
  });
}

function buildUserZoneOptions(allZones, actor) {
  if (actor?.role === 'admin' && !actor?.is_is_admin && Array.isArray(actor?.assignable_zones)) {
    const allowed = new Set(actor.assignable_zones.map((item) => String(item || '').trim()).filter(Boolean));
    return allZones.filter((zone) => allowed.has(String(zone.id || '').trim()));
  }
  return allZones;
}

function buildUserErrorToast(query) {
  const uiError = String(query?.error || '').trim();
  if (uiError === 'cannot_delete_sysadmin') return 'Вы не можете удалить СИС-админа.';
  if (uiError === 'cannot_disable_sysadmin') return 'Вы не можете отключить СИС-админа.';
  return '';
}

function registerAdminUsersRoutes({
  app,
  requirePermission,
  dbQuery,
  loadAll,
  appendAudit,
  sendWelcomeEmail,
  setGeneratedPinNotice,
  consumeGeneratedPinNotice,
  hashPin,
  genPassword,
  digitsOnly,
  applyAdminUserZoneLimit,
  parseZonesInput,
  parseListInput,
  mapSessionUser,
  getStartPinExpiresAt,
  startPinTtlHours = 24,
}) {
  app.get('/admin/users', requirePermission('users.manage'), async (req, res) => {
    const { users, zones } = await loadAll();
    const generatedPinNotice = consumeGeneratedPinNotice(req);
    const allZones = Object.values(zones);
    const userZoneOptions = buildUserZoneOptions(allZones, req.session.user);
    const errorToast = buildUserErrorToast(req.query);

    res.render('admin_users', {
      title: 'Админ • Люди и роли',
      bodyClass: 'admin-page',
      user: req.session.user,
      users: sortUsers(users),
      zones: userZoneOptions,
      allZones,
      errorToast,
      generatedPinNotice,
    });
  });

  app.post('/admin/users/create', requirePermission('users.manage'), async (req, res) => {
    const id = crypto.randomUUID();
    const fio = String(req.body.fio || '').trim();
    const phone = digitsOnly(req.body.phone);
    const email = String(req.body.email || '').trim().toLowerCase();
    const organization = String(req.body.organization || '').trim();
    const position = String(req.body.position || '').trim();
    const role = roleFromInput(req.body.role);
    const isIsAdmin = !!req.session.user?.is_is_admin && checkboxToBool(req.body.is_is_admin);
    const isTenantContact = role !== 'user' && checkboxToBool(req.body.is_tenant_contact);
    const zones = applyAdminUserZoneLimit(req.session.user, req.body.zones);
    const assignableZonesRaw = parseZonesInput(req.body.assignable_zones);
    const assignableZones = (req.session.user?.is_is_admin && role === 'admin' && !isIsAdmin) ? assignableZonesRaw : null;
    const parkingFloors = parseListInput(req.body.parking_floors);
    const parkingGroups = parseListInput(req.body.parking_groups);
    const parkingSpots = parseListInput(req.body.parking_spots);
    const preferredRoutes = parseListInput(req.body.preferred_routes);
    const pinFromForm = String(req.body.pin ?? '');
    const rawPin = (pinFromForm && pinFromForm.length >= 4) ? pinFromForm : genPassword(10);
    const storedPin = await hashPin(rawPin);
    const startPinExpiresAt = getStartPinExpiresAt();

    await dbQuery(
      `INSERT INTO public.users(id,fio,phone,email,organization,position,pin,role,is_is_admin,zones,assignable_zones,is_tenant_contact,parking_floors,parking_groups,parking_spots,preferred_routes,is_active,must_change_pin,pin_created_at,pin_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,true,NOW(),$17)`,
      [id, fio || null, phone, email || null, organization || null, position || null, storedPin, role, isIsAdmin, zones, assignableZones, isTenantContact, parkingFloors, parkingGroups, parkingSpots, preferredRoutes, startPinExpiresAt]
    );
    if (isTenantContact) {
      await dbQuery(`UPDATE public.users SET is_tenant_contact=false WHERE id<>$1`, [id]);
    }

    await appendAudit(req, 'create', 'user', id, {
      fio,
      phone,
      email,
      organization,
      position,
      role,
      is_is_admin: isIsAdmin,
      zones,
      assignable_zones: assignableZones,
      is_tenant_contact: isTenantContact,
      parking_floors: parkingFloors,
      parking_groups: parkingGroups,
      parking_spots: parkingSpots,
      preferred_routes: preferredRoutes,
      pin_set: !!pinFromForm,
      pin_generated: !pinFromForm,
      must_change_pin: true,
      pin_expires_at: startPinExpiresAt,
    });

    if (email) {
      try {
        await sendWelcomeEmail({ to: email, fio, phone, pin: rawPin, role });
      } catch (error) {
        console.warn('sendWelcomeEmail failed:', error?.message || error);
      }
    }

    if (!pinFromForm) {
      setGeneratedPinNotice(req, {
        user_id: id,
        fio,
        phone,
        email,
        pin: rawPin,
        reason: 'create',
        expires_at: startPinExpiresAt,
        ttl_hours: startPinTtlHours,
      });
    }

    res.redirect('/admin/users');
  });

  app.post('/admin/users/:id/update', requirePermission('users.manage'), async (req, res) => {
    const id = String(req.params.id);
    const fio = String(req.body.fio || '').trim();
    const phone = digitsOnly(req.body.phone);
    const email = String(req.body.email || '').trim().toLowerCase();
    const organization = String(req.body.organization || '').trim();
    const position = String(req.body.position || '').trim();
    const role = roleFromInput(req.body.role);
    const isIsAdmin = !!req.session.user?.is_is_admin && checkboxToBool(req.body.is_is_admin);
    const isTenantContact = role !== 'user' && checkboxToBool(req.body.is_tenant_contact);
    const isActive = checkboxToBool(req.body.is_active);
    const zones = applyAdminUserZoneLimit(req.session.user, req.body.zones);
    const assignableZonesRaw = parseZonesInput(req.body.assignable_zones);
    const parkingFloors = parseListInput(req.body.parking_floors);
    const parkingGroups = parseListInput(req.body.parking_groups);
    const parkingSpots = parseListInput(req.body.parking_spots);
    const preferredRoutes = parseListInput(req.body.preferred_routes);
    const pinFromForm = String(req.body.pin ?? '');
    const sendEmail = req.body.send_email === '1';
    const rawPin = (pinFromForm && pinFromForm.length >= 4)
      ? pinFromForm
      : (sendEmail ? genPassword(10) : null);
    const storedPin = rawPin ? await hashPin(rawPin) : null;
    const startPinExpiresAt = storedPin ? getStartPinExpiresAt() : null;

    const targetRes = await dbQuery('SELECT id, is_is_admin, assignable_zones, is_tenant_contact, email, pin FROM public.users WHERE id=$1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.redirect('/admin/users');

    if (!req.session.user?.is_is_admin && target.is_is_admin && !isActive) {
      return res.redirect('/admin/users?error=cannot_disable_sysadmin');
    }

    let nextAssignableZones = target.assignable_zones == null ? null : (Array.isArray(target.assignable_zones) ? target.assignable_zones : []);
    if (role !== 'admin' || target.is_is_admin === true) {
      nextAssignableZones = null;
    } else if (req.session.user?.is_is_admin) {
      nextAssignableZones = assignableZonesRaw;
    }

    await dbQuery(
      `UPDATE public.users
       SET fio=$2, phone=$3, email=$4, organization=$5, position=$6, role=$7, zones=$8, assignable_zones=$9, is_tenant_contact=$10, parking_floors=$11, parking_groups=$12, parking_spots=$13, preferred_routes=$14, is_active=$15,
           pin = COALESCE($16, pin),
           must_change_pin = CASE WHEN $16 IS NULL THEN must_change_pin ELSE TRUE END,
           pin_created_at = CASE WHEN $16 IS NULL THEN pin_created_at ELSE NOW() END,
           pin_expires_at = CASE WHEN $16 IS NULL THEN pin_expires_at ELSE $17 END,
           pin_changed_at = CASE WHEN $16 IS NULL THEN pin_changed_at ELSE NULL END,
           updated_at = NOW()
       WHERE id=$1`,
      [id, fio || null, phone, email || null, organization || null, position || null, role, zones, nextAssignableZones, isTenantContact, parkingFloors, parkingGroups, parkingSpots, preferredRoutes, isActive, storedPin, startPinExpiresAt]
    );
    if (isTenantContact) {
      await dbQuery(`UPDATE public.users SET is_tenant_contact=false WHERE id<>$1`, [id]);
    }

    await appendAudit(req, 'update', 'user', id, {
      fio,
      phone,
      email,
      organization,
      position,
      role,
      zones,
      assignable_zones: nextAssignableZones,
      is_tenant_contact: isTenantContact,
      parking_floors: parkingFloors,
      parking_groups: parkingGroups,
      parking_spots: parkingSpots,
      preferred_routes: preferredRoutes,
      isActive,
      pin_changed: !!storedPin,
      must_change_pin: !!storedPin,
      pin_expires_at: startPinExpiresAt,
    });

    const targetEmail = email || String(target.email || '').trim();

    if (sendEmail && targetEmail && rawPin) {
      try {
        await sendWelcomeEmail({
          to: targetEmail,
          fio,
          phone,
          pin: rawPin,
          role,
        });
      } catch (error) {
        console.warn('sendWelcomeEmail after update failed:', error?.message || error);
      }
    }

    if (sendEmail && rawPin && !pinFromForm) {
      setGeneratedPinNotice(req, {
        user_id: id,
        fio,
        phone,
        email: targetEmail,
        pin: rawPin,
        reason: 'email',
        expires_at: startPinExpiresAt,
        ttl_hours: startPinTtlHours,
      });
    }

    if (req.session.user && String(req.session.user.id) === id) {
      req.session.user = {
        ...req.session.user,
        ...mapSessionUser({
          id,
          fio,
          phone,
          organization,
          position,
          role,
          is_is_admin: req.session.user.is_is_admin,
          zones,
          assignable_zones: req.session.user.is_is_admin ? null : nextAssignableZones,
          is_tenant_contact: isTenantContact,
          parking_floors: parkingFloors,
          parking_groups: parkingGroups,
          parking_spots: parkingSpots,
          preferred_routes: preferredRoutes,
          is_active: isActive,
          must_change_pin: storedPin ? true : req.session.user.must_change_pin,
          pin_expires_at: storedPin ? startPinExpiresAt : req.session.user.pin_expires_at,
        }),
      };
    }

    res.redirect('/admin/users');
  });

  app.post('/admin/users/:id/reset_pin', requirePermission('pin.reset'), async (req, res) => {
    const id = String(req.params.id);
    const rawPin = genPassword(10);
    const startPinExpiresAt = getStartPinExpiresAt();
    const targetRes = await dbQuery('SELECT fio, phone, email FROM public.users WHERE id=$1 LIMIT 1', [id]);
    const target = targetRes.rows[0] || {};
    await dbQuery(`UPDATE public.users SET pin=$2, must_change_pin=true, pin_created_at=NOW(), pin_expires_at=$3, pin_changed_at=NULL, updated_at=NOW() WHERE id=$1`, [id, await hashPin(rawPin), startPinExpiresAt]);
    await appendAudit(req, 'reset_pin', 'user', id, { pin_generated: true, must_change_pin: true, pin_expires_at: startPinExpiresAt });
    setGeneratedPinNotice(req, {
      user_id: id,
      fio: target.fio || '',
      phone: target.phone || '',
      email: target.email || '',
      pin: rawPin,
      reason: 'reset',
      expires_at: startPinExpiresAt,
      ttl_hours: startPinTtlHours,
    });
    if (req.session.user && String(req.session.user.id) === id) {
      req.session.user.must_change_pin = true;
      req.session.user.pin_expires_at = startPinExpiresAt;
    }
    res.redirect('/admin/users');
  });

  app.post('/admin/users/:id/delete', requirePermission('users.manage'), async (req, res) => {
    const id = String(req.params.id);

    if (req.session.user && String(req.session.user.id) === id) {
      return res.redirect('/admin/users');
    }

    const targetRes = await dbQuery('SELECT id, is_is_admin FROM public.users WHERE id=$1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.redirect('/admin/users');

    if (!req.session.user?.is_is_admin && target.is_is_admin) {
      return res.redirect('/admin/users?error=cannot_delete_sysadmin');
    }

    await dbQuery(`DELETE FROM public.users WHERE id=$1`, [id]);
    await appendAudit(req, 'delete', 'user', id, {});
    res.redirect('/admin/users');
  });
}

module.exports = {
  registerAdminUsersRoutes,
};
