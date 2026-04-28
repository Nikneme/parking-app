'use strict';

const crypto = require('crypto');

function registerAdminZonesRoutes({
  app,
  requirePermission,
  dbQuery,
  loadAll,
  appendAudit,
  parseListInput,
  buildDevicesByZone,
  deviceNaturalSort,
  syncZoneDevices,
}) {
  app.get('/admin/zones', requirePermission('zones.manage'), async (req, res) => {
    const { zones, devices } = await loadAll();
    const devicesByZone = buildDevicesByZone(devices);

    res.render('admin_zones', {
      title: 'Админ • Участки',
      bodyClass: 'admin-page',
      user: req.session.user,
      zones: Object.values(zones),
      allDevices: Object.values(devices).sort(deviceNaturalSort),
      devicesByZone,
    });
  });

  app.post('/admin/zones/create', requirePermission('zones.manage'), async (req, res) => {
    const id = String(req.body.id || '').trim() || crypto.randomUUID();
    const name = String(req.body.name || '').trim();
    await dbQuery(
      `INSERT INTO public.zones(id,name,sort)
       VALUES ($1,$2,0)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
      [id, name]
    );
    await appendAudit(req, 'create', 'zone', id, { name });
    res.redirect('/admin/zones');
  });

  app.post('/admin/zones/:id/update', requirePermission('zones.manage'), async (req, res) => {
    const id = String(req.params.id || '').trim();
    const name = String(req.body.name || '').trim();
    if (!id || !name) {
      return res.redirect('/admin/zones');
    }

    const hasDeviceSelection = String(req.body.device_ids_present || '') === '1';
    const selectedDeviceIds = hasDeviceSelection ? parseListInput(req.body.device_ids) : null;
    let attached = [];
    let detached = [];

    await dbQuery(
      `UPDATE public.zones
         SET name = $2
       WHERE id = $1`,
      [id, name]
    );

    if (hasDeviceSelection) {
      const { devices } = await loadAll();
      ({ attached, detached } = await syncZoneDevices({
        dbQuery,
        zoneId: id,
        selectedDeviceIds,
        devicesMap: devices,
      }));
    }

    await appendAudit(req, 'update', 'zone', id, {
      name,
      device_ids: selectedDeviceIds,
      attached,
      detached,
    });
    res.redirect('/admin/zones');
  });

  app.post('/admin/zones/:id/delete', requirePermission('zones.manage'), async (req, res) => {
    const id = String(req.params.id);

    await dbQuery(`UPDATE public.users SET zones = array_remove(zones, $1) WHERE zones @> ARRAY[$1]::text[]`, [id]);
    await dbQuery(`UPDATE public.devices SET zone_id = NULL, zone = NULL WHERE zone_id = $1 OR zone = $1`, [id]);
    await dbQuery(`DELETE FROM public.zones WHERE id=$1`, [id]);

    await appendAudit(req, 'delete', 'zone', id, {});
    res.redirect('/admin/zones');
  });
}

module.exports = {
  registerAdminZonesRoutes,
};
