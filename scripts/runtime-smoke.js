'use strict';

const BASE_URL = String(process.env.SMOKE_BASE_URL || 'http://127.0.0.1:18080').replace(/\/+$/g, '');
const PHONE = String(process.env.SMOKE_PHONE || process.env.ADMIN_PHONE || '79000000000');
const PIN = String(process.env.SMOKE_PIN || process.env.ADMIN_PIN || 'RuntimeAdmin1234');
const DEVICE_ID = String(process.env.SMOKE_DEVICE_ID || 'door1');
const ZONE_ID = String(process.env.SMOKE_ZONE_ID || 'overground');
const ZONE_NAME = String(process.env.SMOKE_ZONE_NAME || 'Наземный уровень');
const ZONE_NAME_EDITED = `${ZONE_NAME} тест`;

let cookie = '';

function updateCookie(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];
  if (setCookies.length) {
    cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
  }
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;

  const res = await fetch(`${BASE_URL}${path}`, {
    redirect: 'manual',
    ...options,
    headers,
  });
  updateCookie(res);
  return { res, text: await res.text() };
}

function extractCsrf(html) {
  const match = String(html || '').match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error('CSRF token not found');
  return match[1];
}

function assertStep(name, condition, details = '') {
  const prefix = condition ? '[ok]' : '[fail]';
  console.log(`${prefix} ${name}${details ? ` - ${details}` : ''}`);
  if (!condition) process.exitCode = 1;
}

async function main() {
  const health = await request('/health');
  assertStep('health', health.res.status === 200 && health.text.includes('"ok":true'), `status=${health.res.status}`);

  const dataLeak = await request('/data/users.json');
  assertStep('/data/users.json closed', dataLeak.res.status === 404, `status=${dataLeak.res.status}`);

  const loginPage = await request('/login');
  const csrf = extractCsrf(loginPage.text);
  assertStep('login page + csrf', loginPage.res.status === 200 && csrf.length > 20, `status=${loginPage.res.status}`);

  const badCsrf = await request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ phone: PHONE, pin: PIN, _csrf: 'bad-token' }),
  });
  assertStep('bad csrf rejected', badCsrf.res.status === 403, `status=${badCsrf.res.status}`);

  const login = await request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ phone: PHONE, pin: PIN, _csrf: csrf }),
  });
  assertStep(
    'login succeeds',
    login.res.status === 302 && login.res.headers.get('location') === '/',
    `status=${login.res.status}, location=${login.res.headers.get('location')}`,
  );

  const dashboard = await request('/');
  assertStep('dashboard loads', dashboard.res.status === 200 && dashboard.text.includes('data-open-device'), `status=${dashboard.res.status}`);

  const open = await request(`/api/open/${encodeURIComponent(DEVICE_ID)}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: '{}',
  });
  assertStep(
    `open ${DEVICE_ID} via gateway`,
    open.res.status === 200 && open.text.includes('"ok":true') && open.text.includes('"requestId"'),
    `status=${open.res.status}`,
  );

  const logs = await request('/logs');
  assertStep('logs page loads', logs.res.status === 200 && logs.text.includes('Журнал') && logs.text.includes('Команда'), `status=${logs.res.status}`);

  const filteredLogs = await request('/logs?status=ok&event=open');
  assertStep(
    'logs filters load',
    filteredLogs.res.status === 200 && filteredLogs.text.includes('Только успешные') && filteredLogs.text.includes('Результат'),
    `status=${filteredLogs.res.status}`,
  );

  const logsCsv = await request('/logs.csv?status=ok&event=open');
  assertStep(
    'logs csv export works',
    logsCsv.res.status === 200 && String(logsCsv.res.headers.get('content-type') || '').includes('text/csv'),
    `status=${logsCsv.res.status}`,
  );

  const zonesBefore = await request('/admin/zones');
  assertStep(
    'zones page loads',
    zonesBefore.res.status === 200 && zonesBefore.text.includes('Участки') && zonesBefore.text.includes(ZONE_NAME),
    `status=${zonesBefore.res.status}`,
  );

  const zoneUpdate = await request(`/admin/zones/${encodeURIComponent(ZONE_ID)}/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: ZONE_NAME_EDITED, _csrf: csrf }),
  });
  assertStep(
    'zone rename redirects',
    zoneUpdate.res.status === 302 && zoneUpdate.res.headers.get('location') === '/admin/zones',
    `status=${zoneUpdate.res.status}`,
  );

  const zonesAfterUpdate = await request('/admin/zones');
  assertStep(
    'zone rename persists',
    zonesAfterUpdate.res.status === 200 && zonesAfterUpdate.text.includes(ZONE_NAME_EDITED),
    `status=${zonesAfterUpdate.res.status}`,
  );

  await request(`/admin/zones/${encodeURIComponent(ZONE_ID)}/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: ZONE_NAME, _csrf: csrf }),
  });
}

main().catch((error) => {
  console.error('[fail] runtime smoke crashed');
  console.error(error);
  process.exit(1);
});
