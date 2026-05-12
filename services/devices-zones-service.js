'use strict';

function toMapById(rows) {
  const out = {};
  (rows || []).forEach((row) => {
    out[row.id] = row;
  });
  return out;
}

function deviceNaturalSort(a, b) {
  const aName = String((a && (a.name || a.id)) || '').trim();
  const bName = String((b && (b.name || b.id)) || '').trim();

  const aMatch = aName.match(/(\d+)/);
  const bMatch = bName.match(/(\d+)/);
  const aNum = aMatch ? Number(aMatch[1]) : Number.POSITIVE_INFINITY;
  const bNum = bMatch ? Number(bMatch[1]) : Number.POSITIVE_INFINITY;

  if (aNum !== bNum) return aNum - bNum;

  const byName = aName.localeCompare(bName, 'ru', {
    numeric: true,
    sensitivity: 'base',
  });
  if (byName !== 0) return byName;

  return String((a && a.id) || '').localeCompare(String((b && b.id) || ''), 'ru', {
    numeric: true,
    sensitivity: 'base',
  });
}

function mapDeviceRow(deviceRow = {}, decryptDeviceSecret = (value) => value) {
  return {
    id: deviceRow.id,
    name: deviceRow.name,
    zoneId: deviceRow.zone_id,
    type: deviceRow.type || 'http',
    method: deviceRow.method,
    url: deviceRow.url,
    ip: deviceRow.ip || null,
    relay: deviceRow.relay ?? null,
    auth_type: deviceRow.auth_type || 'none',
    username: deviceRow.username || '',
    password: decryptDeviceSecret(deviceRow.password || ''),
    enabled: deviceRow.enabled !== false,
    sort: deviceRow.sort ?? 0,
    is_active: deviceRow.is_active !== false,
  };
}

async function loadOperationsState({ dbQuery, mapAdminUser, decryptDeviceSecret = (value) => value }) {
  const [users, zones, devices] = await Promise.all([
    dbQuery(`SELECT id,fio,phone,email,organization,position,pin,role,is_is_admin,zones,assignable_zones,is_tenant_contact,parking_floors,parking_groups,parking_spots,preferred_routes,is_active,must_change_pin,pin_expires_at FROM public.users ORDER BY created_at ASC`),
    dbQuery(`SELECT id,name,sort FROM public.zones ORDER BY sort ASC, name ASC`),
    dbQuery(`SELECT id,name,zone_id,type,method,url,ip,relay,enabled,sort,is_active,auth_type,username,password FROM public.devices ORDER BY sort ASC, name ASC`),
  ]);

  return {
    users: toMapById((users.rows || []).map(mapAdminUser)),
    zones: toMapById((zones.rows || []).map((zone) => ({ id: zone.id, name: zone.name, sort: zone.sort ?? 0 }))),
    devices: toMapById((devices.rows || []).map((row) => mapDeviceRow(row, decryptDeviceSecret))),
  };
}

function buildDevicesByZone(devicesMap = {}) {
  const devicesByZone = {};
  for (const device of Object.values(devicesMap || {})) {
    const zoneId = String(device.zoneId || device.zone_id || device.zone || '').trim();
    if (!zoneId) continue;
    (devicesByZone[zoneId] ||= []).push(device);
  }

  for (const zoneId of Object.keys(devicesByZone)) {
    devicesByZone[zoneId].sort(deviceNaturalSort);
  }

  return devicesByZone;
}

async function syncZoneDevices({ dbQuery, zoneId, selectedDeviceIds, devicesMap }) {
  const attached = [];
  const detached = [];
  const selectedSet = new Set(selectedDeviceIds || []);

  for (const device of Object.values(devicesMap || {})) {
    const deviceId = String(device.id || '').trim();
    if (!deviceId) continue;

    const currentZoneId = String(device.zoneId || device.zone_id || device.zone || '').trim();
    const shouldBelong = selectedSet.has(deviceId);
    const belongsNow = currentZoneId === zoneId;

    if (belongsNow && !shouldBelong) {
      await dbQuery(
        `UPDATE public.devices
           SET zone_id=$2, zone=$2
         WHERE id=$1`,
        [deviceId, null]
      );
      detached.push(device.name || deviceId);
    } else if (!belongsNow && shouldBelong) {
      await dbQuery(
        `UPDATE public.devices
           SET zone_id=$2, zone=$2
         WHERE id=$1`,
        [deviceId, zoneId]
      );
      attached.push(device.name || deviceId);
    }
  }

  return { attached, detached };
}

module.exports = {
  buildDevicesByZone,
  deviceNaturalSort,
  loadOperationsState,
  mapDeviceRow,
  syncZoneDevices,
};
