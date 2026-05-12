'use strict';

if (process.env.NODE_ENV === 'production' && String(process.env.ALLOW_DEMO_ARTIFACTS || '').toLowerCase() !== 'true') {
  console.error('This demo/development script is disabled in production.');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function readJson(relPath) {
  const file = path.join(root, relPath);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfExists(relPath) {
  const file = path.join(root, relPath);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function redactUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      const login = url.username ? `${url.username.slice(0, 2)}***` : '';
      url.username = login;
      url.password = '******';
      return url.toString();
    }
  } catch {}

  return raw.replace(/\/\/([^:@/\s]+):([^@/\s]+)@/g, '//$1:******@');
}

function toMapById(items) {
  const out = {};
  for (const item of items) out[item.id] = item;
  return out;
}

function parseZones() {
  const raw = readJsonIfExists('data/zones.json') || {
    buffer: { name: 'Северный въезд' },
    europlan: { name: 'Этажи 2-9' },
    overground: { name: 'Наземный уровень' },
    pedestrian: { name: 'Входы и лифты' },
    underground: { name: 'Подземный уровень' },
    transit: { name: 'Рампа на эстакаду' },
  };
  const zones = Object.entries(raw).map(([id, value], index) => ({
    id,
    name: String(value.name || value.title || id).replace(/^[^\wА-Яа-я]+/u, '').trim() || id,
    sort: index * 10,
  }));

  return toMapById(zones);
}

function parseDevices() {
  const raw = readJsonIfExists('data/devices.json') || readJsonIfExists('devices.example.json') || {
    test_gate_in: {
      name: 'Тестовые ворота (въезд)',
      zone: 'transit',
      type: 'http',
      method: 'POST',
      url: 'http://example.local/open/in',
    },
    test_door_1: {
      name: 'Тестовая дверь',
      zone: 'pedestrian',
      type: 'http',
      method: 'POST',
      url: 'http://example.local/open/door1',
    },
  };
  return Object.entries(raw).map(([id, value], index) => {
    const url = String(value.url || '').trim();
    let authType = 'none';
    let username = '';

    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) {
        authType = 'basic';
        username = parsed.username;
        parsed.username = '';
        parsed.password = '';
      }
    } catch {}

    return {
      id,
      name: String(value.name || id).trim(),
      zoneId: String(value.zone_id || value.zone || 'buffer').trim(),
      type: String(value.type || 'http').trim(),
      method: String(value.method || 'POST').toUpperCase(),
      url,
      redactedUrl: redactUrl(url),
      auth_type: authType,
      username,
      enabled: value.enabled !== false,
      is_active: value.is_active !== false,
      sort: Number.isFinite(Number(value.sort)) ? Number(value.sort) : index,
    };
  });
}

function buildActors(zones) {
  const zoneIds = Object.keys(zones);
  const pedestrianAndBuffer = zoneIds.filter((id) => ['pedestrian', 'buffer'].includes(id));

  return {
    sysadmin: {
      id: 'admin',
      fio: 'Администратор',
      phone: digitsOnly(process.env.ADMIN_PHONE || '79000000000'),
      pin: String(process.env.ADMIN_PIN || 'DemoAdmin1234'),
      role: 'admin',
      is_is_admin: true,
      zones: zoneIds,
      is_active: true,
    },
    dispatcher: {
      id: 'dispatcher-demo',
      fio: 'Диспетчер демо',
      phone: '79000000001',
      pin: 'Demo1234',
      role: 'dispatcher',
      is_is_admin: false,
      zones: pedestrianAndBuffer,
      is_active: true,
    },
    tenant: {
      id: 'tenant-demo',
      fio: 'Пользователь демо',
      phone: '79000000002',
      pin: 'Demo1234',
      role: 'user',
      is_is_admin: false,
      zones: ['pedestrian'],
      is_active: true,
    },
    blocked: {
      id: 'blocked-demo',
      fio: 'Отключенный пользователь',
      phone: '79000000003',
      pin: 'Demo1234',
      role: 'user',
      is_is_admin: false,
      zones: [],
      is_active: false,
    },
  };
}

function getEffectiveRole(user) {
  if (!user) return 'guest';
  if (user.role === 'admin' && user.is_is_admin) return 'sysadmin';
  return user.role || 'user';
}

function canViewLogs(user) {
  return ['sysadmin', 'admin', 'dispatcher'].includes(getEffectiveRole(user));
}

function login(users, phone, pin) {
  const normalized = digitsOnly(phone);
  const user = Object.values(users).find((candidate) => digitsOnly(candidate.phone) === normalized);
  if (!user) return { ok: false, status: 401, error: 'Телефон не найден' };
  if (user.is_active === false) return { ok: false, status: 401, error: 'Пользователь отключен' };
  if (String(user.pin) !== String(pin)) return { ok: false, status: 401, error: 'Неверный пароль' };
  return { ok: true, status: 302, redirect: '/', user };
}

function dashboard(user, zones, devices) {
  const role = getEffectiveRole(user);
  const allowedZones = role === 'admin' || role === 'sysadmin'
    ? new Set(Object.keys(zones))
    : new Set(asArray(user.zones));

  const groups = [];
  for (const zoneId of allowedZones) {
    const zoneDevices = devices
      .filter((device) => device.is_active !== false && device.zoneId === zoneId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    if (zoneDevices.length) {
      groups.push({ zoneId, zoneName: zones[zoneId]?.name || zoneId, devices: zoneDevices });
    }
  }

  return groups;
}

function fakeGateway(device, options = {}) {
  const failedIds = new Set(String(options.failIds || '').split(',').map((x) => x.trim()).filter(Boolean));
  if (failedIds.has(device.id)) {
    return { ok: false, http_status: 504, error: 'emulated gateway timeout', elapsed_ms: 7000 };
  }
  return { ok: true, http_status: 200, elapsed_ms: 34, data: { ok: true, emulated: true, deviceId: device.id } };
}

function openDevice(user, zones, devicesById, deviceId, options = {}) {
  const device = devicesById[deviceId];
  if (!device || device.is_active === false) return { ok: false, status: 404, error: 'Устройство не найдено' };
  if (device.enabled === false) return { ok: false, status: 409, error: 'Устройство отключено' };

  const role = getEffectiveRole(user);
  const allowed = role === 'admin' || role === 'sysadmin' || asArray(user.zones).includes(device.zoneId);
  if (!allowed) return { ok: false, status: 403, error: 'Нет доступа' };

  const gateway = fakeGateway(device, options);
  const zoneName = zones[device.zoneId]?.name || device.zoneId;
  return {
    ok: gateway.ok,
    status: gateway.ok ? 200 : 502,
    point: `${device.name} - ${zoneName}`,
    gateway,
  };
}

function printLine(status, name, details) {
  const prefix = status ? '[ok]' : '[fail]';
  console.log(`${prefix} ${name}`);
  if (details) console.log(`     ${details}`);
}

function run() {
  const zones = parseZones();
  const devices = parseDevices();
  const devicesById = toMapById(devices);
  const users = buildActors(zones);
  const logs = [];

  const hasJson = process.argv.includes('--json');
  const credentialUrls = devices.filter((device) => device.auth_type === 'basic');

  const loginOk = login(users, users.sysadmin.phone, users.sysadmin.pin);
  const loginWrong = login(users, users.sysadmin.phone, 'bad-pin');
  const loginBlocked = login(users, users.blocked.phone, users.blocked.pin);

  const adminGroups = dashboard(users.sysadmin, zones, devices);
  const tenantGroups = dashboard(users.tenant, zones, devices);
  const tenantDevice = tenantGroups[0]?.devices[0];
  const deniedDevice = devices.find((device) => !asArray(users.tenant.zones).includes(device.zoneId));
  const disabledDevice = { ...tenantDevice, enabled: false };
  const disabledMap = { ...devicesById, [disabledDevice.id]: disabledDevice };

  const openAllowed = tenantDevice
    ? openDevice(users.tenant, zones, devicesById, tenantDevice.id, { failIds: process.env.SIM_GATEWAY_FAIL_IDS })
    : { ok: false, status: 404, error: 'Нет доступного устройства для пользователя' };
  const openDenied = deniedDevice
    ? openDevice(users.tenant, zones, devicesById, deniedDevice.id)
    : { ok: false, status: 404, error: 'Нет устройства вне зон пользователя' };
  const openDisabled = tenantDevice
    ? openDevice(users.tenant, zones, disabledMap, tenantDevice.id)
    : { ok: false, status: 404, error: 'Нет доступного устройства для отключения' };

  for (const [event, result] of [
    ['login', loginOk],
    ['open_allowed', openAllowed],
    ['open_denied', openDenied],
    ['open_disabled', openDisabled],
  ]) {
    logs.push({
      datetime: new Date().toISOString(),
      event,
      actor: users.tenant.fio,
      result: result.ok ? 'ok' : result.error,
      status: result.status,
    });
  }

  const report = {
    summary: {
      zones: Object.keys(zones).length,
      devices: devices.length,
      devicesWithEmbeddedCredentials: credentialUrls.length,
      actors: Object.keys(users).length,
      logs: logs.length,
    },
    scenarios: {
      loginOk,
      loginWrong,
      loginBlocked,
      dashboardAdminGroups: adminGroups.length,
      dashboardTenantGroups: tenantGroups.length,
      canDispatcherViewLogs: canViewLogs(users.dispatcher),
      openAllowed,
      openDenied,
      openDisabled,
    },
    sampleDevice: devices[0] ? {
      id: devices[0].id,
      name: devices[0].name,
      zoneId: devices[0].zoneId,
      url: devices[0].redactedUrl,
    } : null,
    logs,
  };

  if (hasJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('Эмуляция сценариев приложения "Моя парковка"');
  console.log(`Данные: ${report.summary.zones} зон, ${report.summary.devices} устройств, ${report.summary.actors} демо-актора`);
  console.log(`URL с embedded-учеткой: ${report.summary.devicesWithEmbeddedCredentials} (в выводе скрыты)`);
  console.log('');

  printLine(loginOk.ok, 'Вход системного администратора', `redirect=${loginOk.redirect || '-'}, phone=${users.sysadmin.phone}`);
  printLine(!loginWrong.ok, 'Отказ при неверном PIN', loginWrong.error);
  printLine(!loginBlocked.ok, 'Отказ отключенному пользователю', loginBlocked.error);
  printLine(adminGroups.length > 0, 'Дашборд администратора', `${adminGroups.length} групп зон`);
  printLine(tenantGroups.length > 0, 'Дашборд обычного пользователя', `${tenantGroups.length} групп зон`);
  printLine(canViewLogs(users.dispatcher), 'Диспетчер видит журнал', 'permission=logs.view');
  printLine(openAllowed.ok, 'Открытие разрешенного устройства', `${openAllowed.point || openAllowed.error}, status=${openAllowed.status}`);
  printLine(!openDenied.ok && openDenied.status === 403, 'Запрет открытия вне зоны', `${openDenied.error}, status=${openDenied.status}`);
  printLine(!openDisabled.ok && openDisabled.status === 409, 'Запрет отключенного устройства', `${openDisabled.error}, status=${openDisabled.status}`);

  if (report.sampleDevice) {
    console.log('');
    console.log(`Пример устройства: ${report.sampleDevice.id} / ${report.sampleDevice.name}`);
    console.log(`URL: ${report.sampleDevice.url}`);
  }

  console.log('');
  console.log(`Сформировано событий журнала: ${logs.length}`);
}

run();
