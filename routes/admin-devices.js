'use strict';

const crypto = require('crypto');

function checkboxToBool(value) {
  return Array.isArray(value)
    ? (value.includes('true') || value.includes('on'))
    : (value === 'on' || value === 'true');
}

function registerAdminDevicesRoutes({
  app,
  requirePermission,
  dbQuery,
  loadAll,
  appendAudit,
  parseDeviceSecretFields,
}) {
  app.get('/admin/devices', requirePermission('devices.manage'), async (req, res) => {
    const { devices, zones } = await loadAll();
    res.render('admin_devices', {
      title: 'Админ • Устройства',
      bodyClass: 'admin-page',
      user: req.session.user,
      devices: Object.values(devices),
      zones: Object.values(zones),
    });
  });

  app.post('/admin/devices/create', requirePermission('devices.manage'), async (req, res) => {
    const id = String(req.body.id || '').trim() || crypto.randomUUID();
    const name = String(req.body.name || '').trim();
    const zoneId = String(req.body.zoneId || '').trim();
    const method = String(req.body.method || 'http').trim();
    const endpoint = parseDeviceSecretFields(req.body.url, req.body.auth_type, req.body.username, req.body.password);

    await dbQuery(
      `INSERT INTO public.devices(id,name,zone_id,method,url,ip,auth_type,username,password,sort,is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,true)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name,
         zone_id=EXCLUDED.zone_id,
         method=EXCLUDED.method,
         url=EXCLUDED.url,
         ip=EXCLUDED.ip,
         auth_type=EXCLUDED.auth_type,
         username=EXCLUDED.username,
         password=EXCLUDED.password`,
      [id, name, zoneId || null, method, endpoint.url, endpoint.ip, endpoint.auth_type, endpoint.username || null, endpoint.password || null]
    );

    await appendAudit(req, 'create', 'device', id, {
      name,
      zoneId,
      method,
      url: endpoint.url,
      ip: endpoint.ip,
      auth_type: endpoint.auth_type,
    });
    res.redirect('/admin/devices');
  });

  app.post('/admin/devices/:id/update', requirePermission('devices.manage'), async (req, res) => {
    const id = String(req.params.id);
    const name = String(req.body.name || '').trim();
    const zoneId = String(req.body.zoneId || '').trim();
    const method = String(req.body.method || 'http').trim();
    const existingRes = await dbQuery(
      `SELECT auth_type, username, password FROM public.devices WHERE id=$1 LIMIT 1`,
      [id]
    );
    const endpoint = parseDeviceSecretFields(
      req.body.url,
      req.body.auth_type,
      req.body.username,
      req.body.password,
      existingRes.rows[0] || {}
    );
    const isActive = checkboxToBool(req.body.is_active);

    await dbQuery(
      `UPDATE public.devices
       SET name=$2, zone_id=$3, method=$4, url=$5, ip=$6, auth_type=$7, username=$8, password=$9, is_active=$10
       WHERE id=$1`,
      [id, name, zoneId || null, method, endpoint.url, endpoint.ip, endpoint.auth_type, endpoint.username || null, endpoint.password || null, isActive]
    );

    await appendAudit(req, 'update', 'device', id, {
      name,
      zoneId,
      method,
      url: endpoint.url,
      ip: endpoint.ip,
      auth_type: endpoint.auth_type,
      isActive,
    });
    res.redirect('/admin/devices');
  });

  app.post('/admin/devices/:id/delete', requirePermission('devices.manage'), async (req, res) => {
    const id = String(req.params.id);
    await dbQuery(`DELETE FROM public.devices WHERE id=$1`, [id]);
    await appendAudit(req, 'delete', 'device', id, {});
    res.redirect('/admin/devices');
  });
}

module.exports = {
  registerAdminDevicesRoutes,
};
