'use strict';

const state = {
  users: new Map(),
  zones: new Map(),
  devices: new Map(),
  transitEvents: [],
  audit: [],
  nextTransitEventId: 1,
  nextAuditId: 1,
};

function compactSql(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function lowerSql(text) {
  return compactSql(text).toLowerCase();
}

function ok(rows = []) {
  return { rows, rowCount: rows.length };
}

function now() {
  return new Date();
}

function clone(row) {
  if (!row) return row;
  return { ...row };
}

function digitsOnly(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function sortByCreatedAt(rows) {
  return rows.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
}

function sortBySortAndName(rows) {
  return rows.sort((a, b) => {
    const bySort = Number(a.sort || 0) - Number(b.sort || 0);
    if (bySort) return bySort;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ru', { numeric: true, sensitivity: 'base' });
  });
}

function formatMoscowDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';

  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(d).replace(',', '');
}

function normalizeUser(row = {}) {
  return {
    id: row.id,
    fio: row.fio || null,
    phone: row.phone || null,
    email: row.email || null,
    organization: row.organization || null,
    position: row.position || null,
    pin: row.pin || null,
    role: row.role || 'user',
    is_is_admin: !!row.is_is_admin,
    zones: Array.isArray(row.zones) ? row.zones : [],
    assignable_zones: row.assignable_zones == null ? null : (Array.isArray(row.assignable_zones) ? row.assignable_zones : []),
    is_tenant_contact: !!row.is_tenant_contact,
    parking_floors: Array.isArray(row.parking_floors) ? row.parking_floors : [],
    parking_groups: Array.isArray(row.parking_groups) ? row.parking_groups : [],
    parking_spots: Array.isArray(row.parking_spots) ? row.parking_spots : [],
    preferred_routes: Array.isArray(row.preferred_routes) ? row.preferred_routes : [],
    is_active: row.is_active !== false,
    must_change_pin: !!row.must_change_pin,
    pin_created_at: row.pin_created_at || null,
    pin_changed_at: row.pin_changed_at || null,
    pin_expires_at: row.pin_expires_at || null,
    created_at: row.created_at || now(),
    updated_at: row.updated_at || now(),
  };
}

function normalizeZone(row = {}) {
  return {
    id: row.id,
    name: row.name || row.id,
    description: row.description || null,
    sort: Number.isFinite(Number(row.sort)) ? Number(row.sort) : 0,
    is_active: row.is_active !== false,
    created_at: row.created_at || now(),
    updated_at: row.updated_at || now(),
  };
}

function normalizeDevice(row = {}) {
  return {
    id: row.id,
    name: row.name || row.id,
    zone_id: row.zone_id || row.zone || null,
    zone: row.zone || row.zone_id || null,
    type: row.type || 'http',
    method: row.method || 'POST',
    url: row.url || '',
    ip: row.ip || null,
    relay: row.relay ?? null,
    params: row.params || null,
    auth_type: row.auth_type || 'none',
    username: row.username || '',
    password: row.password || '',
    enabled: row.enabled !== false,
    sort: Number.isFinite(Number(row.sort)) ? Number(row.sort) : 0,
    is_active: row.is_active !== false,
    created_at: row.created_at || now(),
    updated_at: row.updated_at || now(),
  };
}

function safeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function selectUsersForLoadAll() {
  return sortByCreatedAt(Array.from(state.users.values()).map((u) => ({
    id: u.id,
    fio: u.fio,
    phone: u.phone,
    email: u.email,
    organization: u.organization,
    position: u.position,
    pin: u.pin,
    role: u.role,
    is_is_admin: u.is_is_admin,
    zones: u.zones,
    assignable_zones: u.assignable_zones,
    is_tenant_contact: !!u.is_tenant_contact,
    parking_floors: u.parking_floors,
    parking_groups: u.parking_groups,
    parking_spots: u.parking_spots,
    preferred_routes: u.preferred_routes,
    is_active: u.is_active,
    must_change_pin: !!u.must_change_pin,
    pin_expires_at: u.pin_expires_at || null,
    created_at: u.created_at,
  })));
}

function selectZonesForLoadAll() {
  return sortBySortAndName(Array.from(state.zones.values()).map((z) => ({
    id: z.id,
    name: z.name,
    sort: z.sort,
  })));
}

function selectDevicesForLoadAll() {
  return sortBySortAndName(Array.from(state.devices.values()).map((d) => ({
    id: d.id,
    name: d.name,
    zone_id: d.zone_id,
    type: d.type,
    method: d.method,
    url: d.url,
    ip: d.ip,
    relay: d.relay,
    enabled: d.enabled,
    sort: d.sort,
    is_active: d.is_active,
    auth_type: d.auth_type,
    username: d.username,
    password: d.password,
  })));
}

function findUserByPhone(phone) {
  const needle = digitsOnly(phone);
  return Array.from(state.users.values()).find((user) => digitsOnly(user.phone) === needle) || null;
}

function insertAudit(params) {
  const [
    actorId,
    actorPhone,
    actorFio,
    actorOrganization,
    actorPosition,
    action,
    targetType,
    targetId,
    details,
    ip,
    ua,
  ] = params || [];

  state.audit.push({
    id: state.nextAuditId++,
    ts: now(),
    actor_id: actorId || null,
    actor_phone: actorPhone || null,
    actor_fio: actorFio || null,
    actor_organization: actorOrganization || null,
    actor_position: actorPosition || null,
    action: action || null,
    target_type: targetType || null,
    target_id: targetId || null,
    details: details || null,
    ip: ip || null,
    ua: ua || null,
  });
}

function selectTransitEvents() {
  return [...state.transitEvents]
    .sort((a, b) => b.datetime.getTime() - a.datetime.getTime())
    .slice(0, 500)
    .map((event) => ({
      ...clone(event),
      datetime_msk: formatMoscowDateTime(event.datetime),
    }));
}

function selectAuditRows() {
  return [...state.audit]
    .sort((a, b) => b.ts.getTime() - a.ts.getTime())
    .slice(0, 500)
    .map((entry) => ({
      ...clone(entry),
      ts_msk: formatMoscowDateTime(entry.ts),
      zone_name: null,
    }));
}

async function dbQuery(text, params = []) {
  const sql = compactSql(text);
  const q = lowerSql(sql);

  if (!q || q.startsWith('create table ') || q.startsWith('alter table ') || q.startsWith('create index ')) {
    return ok();
  }

  if (q.includes('from information_schema.columns')) return ok();
  if (q === 'select 1 as ok') return ok([{ ok: 1 }]);

  if (q.startsWith('select count(*)::int as c from public.zones')) {
    return ok([{ c: state.zones.size }]);
  }

  if (q.startsWith('select count(*)::int as c from public.devices')) {
    return ok([{ c: state.devices.size }]);
  }

  if (q.startsWith('insert into public.zones')) {
    if (params.length === 2) {
      const [id, name] = params;
      state.zones.set(String(id), normalizeZone({ ...state.zones.get(String(id)), id: String(id), name }));
    } else {
      for (let i = 0; i < params.length; i += 3) {
        const [id, name, sort] = params.slice(i, i + 3);
        if (!id) continue;
        state.zones.set(String(id), normalizeZone({ ...state.zones.get(String(id)), id: String(id), name, sort }));
      }
    }
    return ok();
  }

  if (q.startsWith('insert into public.devices')) {
    const current = state.devices.get(String(params[0])) || {};
    if (q.includes('auth_type,username,password')) {
      const [id, name, zoneId, method, url, ip, authType, username, password] = params;
      state.devices.set(String(id), normalizeDevice({
        ...current,
        id: String(id),
        name,
        zone_id: zoneId,
        method,
        url,
        ip,
        auth_type: authType,
        username,
        password,
        sort: current.sort || 0,
        is_active: true,
      }));
    } else {
      const [id, name, zoneId, type, method, url, ip, enabled, sort] = params;
      state.devices.set(String(id), normalizeDevice({
        ...current,
        id: String(id),
        name,
        zone_id: zoneId,
        zone: zoneId,
        type,
        method,
        url,
        ip,
        enabled,
        sort,
        is_active: true,
      }));
    }
    return ok();
  }

  if (q.startsWith('insert into public.users')) {
    if (q.includes('email,organization,position')) {
      const [id, fio, phone, email, organization, position, pin, role, isIsAdmin, zones, assignableZones, isTenantContact, parkingFloors, parkingGroups, parkingSpots, preferredRoutes, pinExpiresAt] = params;
      state.users.set(String(id), normalizeUser({
        id: String(id),
        fio,
        phone,
        email,
        organization,
        position,
        pin,
        role,
        is_is_admin: isIsAdmin,
        zones,
        assignable_zones: assignableZones,
        is_tenant_contact: !!isTenantContact,
        parking_floors: parkingFloors,
        parking_groups: parkingGroups,
        parking_spots: parkingSpots,
        preferred_routes: preferredRoutes,
        is_active: true,
        must_change_pin: q.includes('pin_expires_at'),
        pin_created_at: q.includes('pin_created_at') ? now() : null,
        pin_changed_at: q.includes('pin_changed_at') ? now() : null,
        pin_expires_at: q.includes('pin_expires_at') ? (pinExpiresAt || null) : null,
      }));
    } else {
      const [id, fio, phone, organization, position, pin, zones, pinExpiresAt] = params;
      if (!state.users.has(String(id))) {
        state.users.set(String(id), normalizeUser({
          id: String(id),
          fio,
          phone,
          organization,
          position,
          pin,
          role: 'admin',
          is_is_admin: true,
          zones,
          is_active: true,
          must_change_pin: q.includes('pin_expires_at'),
          pin_created_at: q.includes('pin_created_at') ? now() : null,
          pin_expires_at: q.includes('pin_expires_at') ? (pinExpiresAt || null) : null,
        }));
      }
    }
    return ok();
  }

  if (q.startsWith('insert into public.transit_events')) {
    const [
      point,
      event,
      source,
      result,
      session,
      actorId,
      actorPhone,
      actorFio,
      actorOrganization,
      actorPosition,
      requestId,
      details,
    ] = params;
    state.transitEvents.push({
      id: state.nextTransitEventId++,
      datetime: now(),
      point: point || null,
      event: event || null,
      source: source || null,
      result: result || null,
      session: session || null,
      actor_id: actorId || null,
      actor_phone: actorPhone || null,
      actor_fio: actorFio || null,
      actor_organization: actorOrganization || null,
      actor_position: actorPosition || null,
      request_id: requestId || null,
      details: safeJson(details),
    });
    return ok();
  }

  if (q.startsWith('insert into public.audit')) {
    insertAudit(params);
    return ok();
  }

  if (q.startsWith('select id,fio,phone,email,organization,position,pin,role,is_is_admin,zones,assignable_zones,is_tenant_contact,parking_floors,parking_groups,parking_spots,preferred_routes,is_active')) {
    return ok(selectUsersForLoadAll());
  }

  if (q.startsWith('select id,name,sort from public.zones')) {
    return ok(selectZonesForLoadAll());
  }

  if (q.startsWith('select id,name,zone_id,type,method,url,ip,relay,enabled,sort,is_active,auth_type,username,password from public.devices')) {
    return ok(selectDevicesForLoadAll());
  }

  if (q.startsWith('select id, url, auth_type, username, password from public.devices')) {
    return ok(Array.from(state.devices.values()).map((d) => ({
      id: d.id,
      url: d.url,
      auth_type: d.auth_type,
      username: d.username,
      password: d.password,
    })));
  }

  if (q.startsWith('select auth_type, username, password from public.devices where id=$1')) {
    const device = state.devices.get(String(params[0]));
    return ok(device ? [{ auth_type: device.auth_type, username: device.username, password: device.password }] : []);
  }

  if (q.startsWith('select id, name from public.zones')) {
    return ok(Array.from(state.zones.values()).map((z) => ({ id: z.id, name: z.name })));
  }

  if (q.startsWith('select id, name from public.devices')) {
    return ok(Array.from(state.devices.values()).map((d) => ({ id: d.id, name: d.name })));
  }

  if (q.startsWith('select id, fio from public.users')) {
    return ok(Array.from(state.users.values()).map((u) => ({ id: u.id, fio: u.fio })));
  }

  if (q.startsWith('select id from public.users where regexp_replace')) {
    const user = findUserByPhone(params[0]);
    return ok(user ? [{ id: user.id }] : []);
  }

  if (q.startsWith('select id,fio,phone,organization,position,pin,role,is_is_admin,zones,assignable_zones,is_tenant_contact,parking_floors,parking_groups,parking_spots,preferred_routes,is_active')) {
    const user = findUserByPhone(params[0]);
    return ok(user ? [clone(user)] : []);
  }

  if (q.startsWith('select id, fio, phone, organization, position, role, is_is_admin, zones, assignable_zones, is_tenant_contact, parking_floors, parking_groups, parking_spots, preferred_routes, is_active')) {
    const user = state.users.get(String(params[0]));
    return ok(user ? [clone(user)] : []);
  }


  if (q.startsWith('select id, phone, pin, is_active from public.users where id=$1')) {
    const user = state.users.get(String(params[0]));
    return ok(user ? [{ id: user.id, phone: user.phone, pin: user.pin, is_active: user.is_active }] : []);
  }

  if (q.startsWith('select id, is_is_admin, assignable_zones, is_tenant_contact, email, pin from public.users where id=$1')) {
    const user = state.users.get(String(params[0]));
    return ok(user ? [{
      id: user.id,
      is_is_admin: user.is_is_admin,
      assignable_zones: user.assignable_zones,
      is_tenant_contact: !!user.is_tenant_contact,
      email: user.email,
      pin: user.pin,
    }] : []);
  }

  if (q.startsWith('select fio, phone, email from public.users where id=$1')) {
    const user = state.users.get(String(params[0]));
    return ok(user ? [{
      fio: user.fio,
      phone: user.phone,
      email: user.email,
    }] : []);
  }

  if (q.startsWith('select id, is_is_admin from public.users where id=$1')) {
    const user = state.users.get(String(params[0]));
    return ok(user ? [{ id: user.id, is_is_admin: user.is_is_admin }] : []);
  }

  if (q.startsWith('select datetime,')) {
    return ok(selectTransitEvents());
  }

  if (q.startsWith('select distinct point from public.transit_events')) {
    const points = Array.from(new Set(state.transitEvents.map((x) => x.point).filter(Boolean))).sort();
    return ok(points.map((point) => ({ point })));
  }

  if (q.startsWith('select distinct event from public.transit_events')) {
    const events = Array.from(new Set(state.transitEvents.map((x) => x.event).filter(Boolean))).sort();
    return ok(events.map((event) => ({ event })));
  }

  if (q.startsWith('select distinct result from public.transit_events')) {
    const results = Array.from(new Set(state.transitEvents.map((x) => x.result).filter(Boolean))).sort();
    return ok(results.map((result) => ({ result })));
  }

  if (q.startsWith('select a.ts,') || q.startsWith('select ts,')) {
    return ok(selectAuditRows());
  }

  if (q.startsWith('update public.devices set url=$2')) {
    const [id, url, ip, username, password] = params;
    const device = state.devices.get(String(id));
    if (device) {
      Object.assign(device, {
        url,
        ip,
        auth_type: device.auth_type || 'basic',
        username: device.username || username || '',
        password: device.password || password || '',
        updated_at: now(),
      });
    }
    return ok();
  }

  if (q.startsWith('update public.devices set name=$2')) {
    const [id, name, zoneId, method, url, ip, authType, username, password, isActive] = params;
    const device = state.devices.get(String(id));
    if (device) {
      Object.assign(device, {
        name,
        zone_id: zoneId,
        zone: zoneId,
        method,
        url,
        ip,
        auth_type: authType,
        username: username || '',
        password: password || '',
        is_active: isActive,
        updated_at: now(),
      });
    }
    return ok();
  }

  if (q.startsWith('update public.devices set zone_id = null')) {
    const id = String(params[0]);
    for (const device of state.devices.values()) {
      if (device.zone_id === id || device.zone === id) {
        device.zone_id = null;
        device.zone = null;
        device.updated_at = now();
      }
    }
    return ok();
  }

  if (q.startsWith('update public.devices set zone_id=$2, zone=$2 where id=$1')) {
    const [id, zoneId] = params;
    const device = state.devices.get(String(id));
    if (device) {
      device.zone_id = zoneId || null;
      device.zone = zoneId || null;
      device.updated_at = now();
    }
    return ok();
  }

  if (q.startsWith('update public.users set pin=$2')) {
    const [id, pin, pinExpiresAt] = params;
    const user = state.users.get(String(id));
    if (user) {
      user.pin = pin;
      if (q.includes('must_change_pin=true')) {
        user.must_change_pin = true;
        user.pin_created_at = now();
        user.pin_expires_at = pinExpiresAt || null;
        user.pin_changed_at = null;
      } else if (q.includes('must_change_pin=false')) {
        user.must_change_pin = false;
        user.pin_changed_at = now();
        user.pin_created_at = null;
        user.pin_expires_at = null;
      }
      user.updated_at = now();
    }
    return ok();
  }

  if (q.startsWith('update public.users set fio=$2')) {
    const [id, fio, phone, email, organization, position, role, zones, assignableZones, isTenantContact, parkingFloors, parkingGroups, parkingSpots, preferredRoutes, isActive, pin, pinExpiresAt] = params;
    const user = state.users.get(String(id));
    if (user) {
      Object.assign(user, {
        fio,
        phone,
        email,
        organization,
        position,
        role,
        zones: Array.isArray(zones) ? zones : [],
        assignable_zones: assignableZones,
        is_tenant_contact: !!isTenantContact,
        parking_floors: Array.isArray(parkingFloors) ? parkingFloors : [],
        parking_groups: Array.isArray(parkingGroups) ? parkingGroups : [],
        parking_spots: Array.isArray(parkingSpots) ? parkingSpots : [],
        preferred_routes: Array.isArray(preferredRoutes) ? preferredRoutes : [],
        is_active: isActive,
        updated_at: now(),
      });
      if (pin) {
        user.pin = pin;
        user.must_change_pin = true;
        user.pin_created_at = now();
        user.pin_expires_at = pinExpiresAt || null;
        user.pin_changed_at = null;
      }
    }
    return ok();
  }

  if (q.startsWith("select id, password from public.devices where coalesce(password,'') <> ''")) {
    return ok(Array.from(state.devices.values())
      .filter((d) => String(d.password || '') !== '')
      .map((d) => ({ id: d.id, password: d.password })));
  }

  if (q.startsWith('update public.devices set password=$2')) {
    const [id, password] = params;
    const device = state.devices.get(String(id));
    if (device) {
      device.password = password;
      device.updated_at = now();
    }
    return ok();
  }

  if (q.startsWith('update public.users set zones = array_remove')) {
    const zoneId = String(params[0]);
    for (const user of state.users.values()) {
      user.zones = (user.zones || []).filter((id) => id !== zoneId);
      if (Array.isArray(user.assignable_zones)) {
        user.assignable_zones = user.assignable_zones.filter((id) => id !== zoneId);
      }
    }
    return ok();
  }

  if (q.startsWith('update public.users set is_tenant_contact=false where id<>$1')) {
    const keepId = String(params[0]);
    for (const user of state.users.values()) {
      if (String(user.id) !== keepId) {
        user.is_tenant_contact = false;
        user.updated_at = now();
      }
    }
    return ok();
  }

  if (q.startsWith('update public.zones set name = $2')) {
    const [id, name] = params;
    const zone = state.zones.get(String(id));
    if (zone) {
      zone.name = name;
      zone.updated_at = now();
    }
    return ok();
  }

  if (q.startsWith('update public.users set ')) return ok();
  if (q.startsWith('update public.devices set ')) return ok();
  if (q.startsWith('update public.transit_events ')) return ok();
  if (q.startsWith('update public.audit set ')) return ok();
  if (q.startsWith('update public.zones set ')) return ok();

  if (q.startsWith('delete from public.users where id=$1')) {
    state.users.delete(String(params[0]));
    return ok();
  }

  if (q.startsWith('delete from public.devices where id=$1')) {
    state.devices.delete(String(params[0]));
    return ok();
  }

  if (q.startsWith('delete from public.zones where id=$1')) {
    state.zones.delete(String(params[0]));
    return ok();
  }

  if (q.startsWith('delete from public.audit')) {
    state.audit = [];
    return ok();
  }

  if (q.startsWith('truncate table public.transit_events')) {
    state.transitEvents = [];
    return ok();
  }

  throw new Error(`DEV_MEMORY_DB unsupported query: ${sql}`);
}

async function ensureSchema() {
  return ok();
}

module.exports = { dbQuery, ensureSchema };
