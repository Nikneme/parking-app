'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const axios = require('axios');
const nodemailer = require('nodemailer');

const { dbQuery, ensureSchema, isDevDb, databaseUrlConfigured } = require('./db');
const { buildReferenceDevices } = require('./services/device-catalog');
const {
  buildDevicesByZone,
  deviceNaturalSort,
  loadOperationsState,
  syncZoneDevices,
} = require('./services/devices-zones-service');
const { registerAdminDevicesRoutes } = require('./routes/admin-devices');
const { registerAdminAuditRoutes } = require('./routes/admin-audit');
const { registerAdminUsersRoutes } = require('./routes/admin-users');
const { registerAdminZonesRoutes } = require('./routes/admin-zones');
const { registerAuthRoutes } = require('./routes/auth');
const { registerDashboardRoutes } = require('./routes/dashboard');
const { registerLogsRoutes } = require('./routes/logs');
const { createAuditService } = require('./services/audit-service');
const { createAuthSessionService } = require('./services/auth-session-service');
const { createGatewayService } = require('./services/gateway-service');
const { createTransitLogService } = require('./services/transit-log-service');
const {
  applyAdminUserZoneLimit,
  buildDashboardSupportContact,
  digitsOnly,
  mapAdminUser,
  mapSessionUser,
  parseListInput,
  parseZonesInput,
} = require('./services/users-service');

// Fallback file log (when DB is temporarily unavailable)
const FALLBACK_TRANSIT_LOG = path.join(__dirname, 'data', 'transit_events.jsonl');

const app = express();
app.set('trust proxy', 1);


// --- базовые настройки ---
const PORT = Number(process.env.PORT || 8080);
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
if (!SESSION_SECRET || SESSION_SECRET === 'change-me-in-railway') {
  throw new Error('SESSION_SECRET must be set to a strong unique value.');
}

// --- object gateway (local devices) ---
// Пример: https://xxxx.trycloudflare.com   (БЕЗ слеша в конце)
const GATEWAY_BASE_URL = String(process.env.GATEWAY_BASE_URL || '').replace(/\/+$/g, '');
const GATEWAY_KEY = String(process.env.GATEWAY_KEY || '');
const GATEWAY_TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 7000);
const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const IS_PRODUCTION = NODE_ENV === 'production';

const APP_BASE_URL = String(process.env.APP_BASE_URL || 'https://moyaparkovka.ru').replace(/\/+$/g, '');
const DISPATCHER_PHONE = String(process.env.DISPATCHER_PHONE || '+7 936 004-67-42').trim();
const SESSION_STORE_ENABLED = !!(process.env.DATABASE_URL || process.env.PG_URL);
const SMTP_HOST = String(process.env.SMTP_HOST || '');
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
const SMTP_USER = String(process.env.SMTP_USER || '');
const SMTP_PASS = String(process.env.SMTP_PASS || '');
const MAIL_FROM = String(process.env.MAIL_FROM || SMTP_USER || 'mmoyaparkovka@yandex.ru');
const MAIL_INCLUDE_PASSWORD = String(process.env.MAIL_INCLUDE_PASSWORD || '').toLowerCase() === 'true';
const GATEWAY_SEND_DEVICE_SECRETS = String(process.env.GATEWAY_SEND_DEVICE_SECRETS || '').toLowerCase() === 'true';
const ALLOW_FILE_TRANSIT_FALLBACK = String(process.env.ALLOW_FILE_TRANSIT_FALLBACK || (IS_PRODUCTION ? 'false' : 'true')).toLowerCase() === 'true';
const ALLOW_DB_INIT_FAILURE = String(process.env.ALLOW_DB_INIT_FAILURE || '').toLowerCase() === 'true';

if (IS_PRODUCTION && MAIL_INCLUDE_PASSWORD) {
  throw new Error('MAIL_INCLUDE_PASSWORD=true is forbidden in production.');
}

if (IS_PRODUCTION && GATEWAY_SEND_DEVICE_SECRETS) {
  throw new Error('GATEWAY_SEND_DEVICE_SECRETS=true is forbidden in production.');
}

if (MAIL_INCLUDE_PASSWORD) {
  console.warn('⚠️ MAIL_INCLUDE_PASSWORD=true: passwords may be sent by email. Disable this outside of temporary internal use.');
}

if (GATEWAY_SEND_DEVICE_SECRETS) {
  console.warn('⚠️ GATEWAY_SEND_DEVICE_SECRETS=true: device passwords may be included in gateway payloads.');
}

if (ALLOW_FILE_TRANSIT_FALLBACK) {
  console.warn('⚠️ File transit fallback is enabled. When DB fails, part of the transit log may be written to a local file.');
}

const LOGIN_WINDOW_MS = Number(process.env.LOGIN_RATE_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_MAX || 8);

const gatewayService = createGatewayService({
  gatewayBaseUrl: GATEWAY_BASE_URL,
  gatewayKey: GATEWAY_KEY,
  gatewayTimeoutMs: GATEWAY_TIMEOUT_MS,
  includeDeviceSecrets: GATEWAY_SEND_DEVICE_SECRETS,
});

const transitLogService = createTransitLogService({
  dbQuery,
  fs,
  fallbackLogPath: FALLBACK_TRANSIT_LOG,
  allowFileTransitFallback: ALLOW_FILE_TRANSIT_FALLBACK,
});
const auditService = createAuditService({ dbQuery });
const authSessionService = createAuthSessionService({
  digitsOnly,
  mailIncludePassword: MAIL_INCLUDE_PASSWORD,
  loginWindowMs: LOGIN_WINDOW_MS,
  loginMaxAttempts: LOGIN_MAX_ATTEMPTS,
});

const {
  gatewayOpen,
} = gatewayService;

const {
  appendTransitEvent,
  readFallbackTransitEvents,
  normalizeTransitEvent,
  loadRecentTransitEvents,
} = transitLogService;
const {
  appendAudit,
  parseAuditFilters,
  buildAuditWhere,
} = auditService;
const {
  setGeneratedPinNotice,
  consumeGeneratedPinNotice,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
} = authSessionService;

const mailTransport = (SMTP_HOST && SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

class PgSessionStore extends session.Store {
  get(sid, cb) {
    dbQuery(
      `SELECT sess FROM public.sessions WHERE sid=$1 AND expires > NOW() LIMIT 1`,
      [sid]
    ).then((r) => cb(null, r.rows[0]?.sess || null)).catch(cb);
  }

  set(sid, sess, cb) {
    const expires = sess.cookie?.expires
      ? new Date(sess.cookie.expires)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    dbQuery(
      `INSERT INTO public.sessions(sid, sess, expires)
       VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE SET sess=EXCLUDED.sess, expires=EXCLUDED.expires`,
      [sid, sess, expires]
    ).then(() => cb?.()).catch(cb);
  }

  destroy(sid, cb) {
    dbQuery(`DELETE FROM public.sessions WHERE sid=$1`, [sid]).then(() => cb?.()).catch(cb);
  }

  touch(sid, sess, cb) {
    const expires = sess.cookie?.expires
      ? new Date(sess.cookie.expires)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    dbQuery(
      `UPDATE public.sessions SET sess=$2, expires=$3 WHERE sid=$1`,
      [sid, sess, expires]
    ).then(() => cb?.()).catch(cb);
  }
}

const scryptAsync = promisify(crypto.scrypt);
const PIN_HASH_PREFIX = 'pin:v1:scrypt:';

function roleLabelRu(role) {
  return role === 'admin' ? 'Администратор' : (role === 'dispatcher' ? 'Диспетчер' : 'Арендатор');
}

function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    const leftHash = crypto.createHash('sha256').update(left).digest();
    const rightHash = crypto.createHash('sha256').update(right).digest();
    crypto.timingSafeEqual(leftHash, rightHash);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function isHashedPin(pin) {
  return String(pin || '').startsWith(PIN_HASH_PREFIX);
}

async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(String(pin || ''), salt, 64);
  return `${PIN_HASH_PREFIX}${salt}:${derived.toString('hex')}`;
}

async function verifyPin(inputPin, storedPin) {
  const stored = String(storedPin || '');
  if (!stored) return false;

  if (!isHashedPin(stored)) {
    return safeEqualString(inputPin, stored);
  }

  const rest = stored.slice(PIN_HASH_PREFIX.length);
  const [salt, hashHex] = rest.split(':');
  if (!salt || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(String(inputPin || ''), salt, expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

async function sendWelcomeEmail({ to, fio, phone, pin, role }) {
  if (!to || !mailTransport) return false;

  const siteUrl = APP_BASE_URL || 'https://moyaparkovka.ru';
  const safeName = String(fio || 'Коллега');
  const safeLogin = String(phone || '');
  const safePin = String(pin || '');
  const safeRole = roleLabelRu(String(role || 'user'));
  const passwordLineHtml = MAIL_INCLUDE_PASSWORD
    ? `<div style="margin:0 0 8px 0;"><span style="color:#94a3b8;">Пароль:</span> <b>${safePin}</b></div>`
    : `<div style="margin:0 0 8px 0;"><span style="color:#94a3b8;">Пароль:</span> получите у администратора</div>`;
  const passwordLineText = MAIL_INCLUDE_PASSWORD
    ? `Пароль: ${safePin}`
    : 'Пароль: получите у администратора';

  const html = `
  <div style="margin:0;padding:0;background:#0b1220;font-family:Arial,sans-serif;color:#e5e7eb;">
    <div style="max-width:640px;margin:0 auto;padding:24px 16px;">
      <div style="background:linear-gradient(135deg,#1f3b73 0%,#0f172a 100%);border:1px solid rgba(255,255,255,.08);border-radius:20px;overflow:hidden;">
        <div style="padding:28px 24px;border-bottom:1px solid rgba(255,255,255,.08);">
          <div style="font-size:24px;font-weight:700;margin-bottom:8px;">Моя парковка</div>
          <div style="font-size:14px;color:#cbd5e1;">Доступ в систему создан</div>
        </div>
        <div style="padding:24px;">
          <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">Здравствуйте, ${safeName}.</p>
          <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">Ваш аккаунт в <b>«Моя парковка»</b> готов.</p>
          <div style="background:#111827;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:16px 18px;margin:0 0 18px 0;">
            <div style="margin:0 0 8px 0;"><span style="color:#94a3b8;">Сайт:</span> <a href="${siteUrl}" style="color:#93c5fd;text-decoration:none;">${siteUrl}</a></div>
            <div style="margin:0 0 8px 0;"><span style="color:#94a3b8;">Логин:</span> <b>${safeLogin}</b></div>
            ${passwordLineHtml}
            <div><span style="color:#94a3b8;">Роль:</span> <b>${safeRole}</b></div>
          </div>
          <div style="margin:0 0 20px 0;">
            <a href="${siteUrl}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">Перейти на сайт</a>
          </div>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8;">Если письмо пришло вам по ошибке, просто проигнорируйте его.</p>
        </div>
      </div>
    </div>
  </div>`;

  const text = [
    'Моя парковка',
    '',
    `Здравствуйте, ${safeName}.`,
    'Ваш аккаунт в «Моя парковка» готов.',
    `Сайт: ${siteUrl}`,
    `Логин: ${safeLogin}`,
    passwordLineText,
    `Роль: ${safeRole}`,
  ].join('\n');

  await mailTransport.sendMail({
    from: MAIL_FROM,
    to,
    subject: 'Доступ в систему «Моя парковка»',
    html,
    text,
  });

  return true;
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    // Railway / reverse-proxy: helps secure cookies + sessions work correctly
    proxy: true,
    store: SESSION_STORE_ENABLED ? new PgSessionStore() : undefined,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

const CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function isStaticRequest(req) {
  return req.path.startsWith('/public/') || req.path.startsWith('/data/') || req.path === '/app.css' || req.path === '/brand.jpg';
}

app.use((req, res, next) => {
  if (isStaticRequest(req)) return next();
  if (req.session) {
    res.locals.csrfToken = ensureCsrfToken(req);
  }
  next();
});

app.use((req, res, next) => {
  if (!CSRF_METHODS.has(req.method)) return next();

  const expected = req.session?.csrfToken || '';
  const actual = String(req.body?._csrf || req.headers['x-csrf-token'] || '');

  if (expected && actual && safeEqualString(actual, expected)) return next();

  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(403).json({ ok: false, error: 'CSRF token invalid' });
  }
  return res.status(403).send('CSRF token invalid');
});

app.use(['/data', '/public/data'], (req, res) => {
  res.status(404).send('Not found');
});

// Static assets: allow both /app.css and /public/app.css
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// Default locals for all templates (prevents EJS ReferenceError on missing vars)
app.use((req, res, next) => {
  res.locals.title = res.locals.title || 'Parking GIT';
  res.locals.bodyClass = res.locals.bodyClass || '';
  res.locals.user = req.session?.user || null;
  next();
});

// session guard: block inactive users immediately
app.use(async (req, res, next) => {
  if (!req.session?.user?.id) return next();

  try {
    const r = await dbQuery(
      `SELECT id, fio, phone, organization, position, role, is_is_admin, zones, assignable_zones, is_tenant_contact, parking_floors, parking_groups, parking_spots, preferred_routes, is_active
       FROM public.users
       WHERE id = $1
       LIMIT 1`,
      [String(req.session.user.id)]
    );

    const u = r.rows[0];
    if (!u || u.is_active === false) {
      return req.session.destroy(() => res.redirect('/login'));
    }

    Object.assign(req.session.user, mapSessionUser(u));
    res.locals.user = req.session.user;

    return next();
  } catch (e) {
    console.warn('inactive session guard error:', e?.message || e);
    return next();
  }
});

// If browser auto-translation rewrites URLs into Russian, keep the app working.
// (e.g. "/администратор/устройства" -> "/admin/devices")
app.use((req, res, next) => {
  const original = req.originalUrl || '';
  const rules = [
    { from: '/администратор', to: '/admin' },
    { from: '/войти в систему', to: '/login' },
    { from: '/вход', to: '/login' },
    { from: '/выход', to: '/logout' },
    { from: '/выход из системы', to: '/logout' },
    { from: '/журнал', to: '/logs' },
  ];

  for (const r of rules) {
    if (original === r.from || original.startsWith(r.from + '/') || original.startsWith(encodeURI(r.from) + '/')) {
      const suffix = original.startsWith(r.from) ? original.slice(r.from.length) : original.slice(encodeURI(r.from).length);
      const newUrl = r.to + suffix;
      // For GET/HEAD it's safe to redirect.
      if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(302, newUrl);
      // For POST/PUT/etc. keep the method and internally rewrite the URL.
      req.url = newUrl;
      return next();
    }
  }

  next();
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.engine('ejs', require('ejs').__express);

// статика (если есть)

function genPassword(len = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += chars[crypto.randomInt(0, chars.length)];
  }
  return out;
}

function genPin(len = 4) {
  const n = crypto.randomInt(0, 10 ** len);
  return String(n).padStart(len, '0');
}

const MOSCOW_TZ = 'Europe/Moscow';

function clearFallbackTransitLog() {
  try {
    if (fs.existsSync(FALLBACK_TRANSIT_LOG)) fs.writeFileSync(FALLBACK_TRANSIT_LOG, '', 'utf-8');
  } catch {}
}

// Форматирование времени строго в МСК, независимо от таймзоны сервера
function formatMoscowDateTime(v) {
  if (!v) return '';
  const d = (v instanceof Date) ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);

  try {
    // "16.02.2026, 20:32:39" -> "16.02.2026 20:32:39"
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: MOSCOW_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(d).replace(',', '');
  } catch {
    // fallback: фиксированный UTC+3
    const pad = (n) => String(n).padStart(2, '0');
    const ms = d.getTime() + 3 * 60 * 60 * 1000;
    const u = new Date(ms);
    return `${pad(u.getUTCDate())}.${pad(u.getUTCMonth() + 1)}.${u.getUTCFullYear()} ${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())}:${pad(u.getUTCSeconds())}`;
  }
}

const RU_TRANSIT_EVENT = {
  open: 'Открытие',
  close: 'Закрытие',
  unlock: 'Открытие',
  lock: 'Закрытие',
  error: 'Ошибка',
};

function ruTransitEvent(ev) {
  const k = String(ev || '').trim();
  return RU_TRANSIT_EVENT[k] || k;
}

function normalizeTransitLogTime(value, mode) {
  const raw = String(value || '').trim();
  if (!raw) return mode === 'end' ? '23:59:59' : '00:00:00';
  if (/^\d{2}:\d{2}$/.test(raw)) return mode === 'end' ? `${raw}:59` : `${raw}:00`;
  return raw;
}

function parseTransitLogFilters(query = {}) {
  return {
    point: String(query.point || '').trim(),
    event: String(query.event || '').trim(),
    status: String(query.status || '').trim(),
    result: String(query.result || '').trim(),
    request_id: String(query.request_id || '').trim(),
    date_from: String(query.date_from || '').trim(),
    date_to: String(query.date_to || '').trim(),
    time_from: String(query.time_from || '').trim(),
    time_to: String(query.time_to || '').trim(),
    fio: String(query.fio || '').trim(),
    organization: String(query.organization || '').trim(),
    position: String(query.position || '').trim(),
  };
}

function buildTransitLogWhere(filters) {
  const wh = [];
  const args = [];
  const push = (sql, val) => {
    args.push(val);
    wh.push(sql.replace('$X', `$${args.length}`));
  };

  if (filters.point) push(`point = $X`, filters.point);
  if (filters.event) push(`event = $X`, filters.event);
  if (filters.status === 'ok') wh.push(`COALESCE(result, '') = 'ok'`);
  if (filters.status === 'attention') wh.push(`COALESCE(result, '') <> '' AND COALESCE(result, '') <> 'ok'`);
  if (filters.result) push(`COALESCE(result, '') = $X`, filters.result);
  if (filters.request_id) push(`COALESCE(request_id, '') ILIKE $X`, `%${filters.request_id}%`);
  if (filters.fio) push(`COALESCE(actor_fio, '') ILIKE $X`, `%${filters.fio}%`);
  if (filters.organization) push(`COALESCE(actor_organization, '') ILIKE $X`, `%${filters.organization}%`);
  if (filters.position) push(`COALESCE(actor_position, '') ILIKE $X`, `%${filters.position}%`);
  if (filters.date_from) {
    push(
      `(datetime AT TIME ZONE 'Europe/Moscow') >= ($X::timestamp)`,
      `${filters.date_from} ${normalizeTransitLogTime(filters.time_from, 'start')}`,
    );
  }
  if (filters.date_to) {
    push(
      `(datetime AT TIME ZONE 'Europe/Moscow') <= ($X::timestamp)`,
      `${filters.date_to} ${normalizeTransitLogTime(filters.time_to, 'end')}`,
    );
  }

  return {
    whereSql: wh.length ? `WHERE ${wh.join(' AND ')}` : '',
    args,
  };
}

function transitEventMatchesFilters(row, filters) {
  const item = normalizeTransitEvent(row);
  const point = String(item.point || '').trim();
  const event = String(item.event || '').trim();
  const result = String(item.result || '').trim();
  const requestId = String(item.request_id || item.requestId || '').trim();
  const fio = String(item.actor_fio || item.fio || '').trim();
  const org = String(item.actor_organization || item.organization || '').trim();
  const pos = String(item.actor_position || item.position || '').trim();

  if (filters.point && point !== filters.point) return false;
  if (filters.event && event !== filters.event) return false;
  if (filters.status === 'ok' && result !== 'ok') return false;
  if (filters.status === 'attention' && (!result || result === 'ok')) return false;
  if (filters.result && result !== filters.result) return false;
  if (filters.request_id && !requestId.toLowerCase().includes(filters.request_id.toLowerCase())) return false;
  if (filters.fio && !fio.toLowerCase().includes(filters.fio.toLowerCase())) return false;
  if (filters.organization && !org.toLowerCase().includes(filters.organization.toLowerCase())) return false;
  if (filters.position && !pos.toLowerCase().includes(filters.position.toLowerCase())) return false;

  const dt = item.datetime ? new Date(item.datetime) : null;
  if (dt && filters.date_from) {
    const from = new Date(`${filters.date_from}T${normalizeTransitLogTime(filters.time_from, 'start')}+03:00`);
    if (dt < from) return false;
  }
  if (dt && filters.date_to) {
    const to = new Date(`${filters.date_to}T${normalizeTransitLogTime(filters.time_to, 'end')}+03:00`);
    if (dt > to) return false;
  }

  return true;
}

function currentMoscowDateIso() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (type) => parts.find((item) => item.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
  }
}

function buildTransitLogUrl(basePath, filters, overrides = {}) {
  const params = new URLSearchParams();
  const merged = { ...(filters || {}), ...(overrides || {}) };
  Object.entries(merged).forEach(([key, value]) => {
    const text = String(value || '').trim();
    if (text) params.set(key, text);
  });
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function buildTransitLogQuickLinks(filters) {
  const today = currentMoscowDateIso();
  return {
    all: buildTransitLogUrl('/logs', filters, { status: '', result: '' }),
    ok: buildTransitLogUrl('/logs', filters, { status: 'ok', result: '' }),
    attention: buildTransitLogUrl('/logs', filters, { status: 'attention', result: '' }),
    today: buildTransitLogUrl('/logs', filters, { date_from: today, date_to: today, time_from: '', time_to: '' }),
    reset: '/logs',
  };
}

function buildTransitLogSummary(logs) {
  const list = Array.isArray(logs) ? logs : [];
  const total = list.length;
  const ok = list.filter((item) => String(item?.result || '').trim().toLowerCase() === 'ok').length;
  const attention = total - ok;
  const uniquePoints = new Set(list.map((item) => String(item?.point || '').trim()).filter(Boolean)).size;
  const uniqueActors = new Set(
    list.map((item) => String(item?.actor_phone || item?.actor_fio || '').trim()).filter(Boolean)
  ).size;

  return {
    total,
    ok,
    attention,
    uniquePoints,
    uniqueActors,
    latestAt: list[0]?.datetime_msk || formatMoscowDateTime(list[0]?.datetime) || '',
  };
}

async function getGatewayStatus() {
  if (!GATEWAY_BASE_URL || !GATEWAY_KEY) {
    return {
      configured: false,
      ok: false,
      status: 'not_configured',
      label: 'Шлюз не настроен',
      elapsed_ms: 0,
    };
  }

  const started = Date.now();
  try {
    const r = await axios.get(`${GATEWAY_BASE_URL}/health`, {
      timeout: Math.min(GATEWAY_TIMEOUT_MS, 3000),
      headers: { 'X-Gateway-Key': GATEWAY_KEY },
      validateStatus: () => true,
    });

    const ok = r.status >= 200 && r.status < 300 && r.data?.ok !== false;
    return {
      configured: true,
      ok,
      status: ok ? 'online' : 'error',
      label: ok ? 'Шлюз онлайн' : 'Шлюз отвечает с ошибкой',
      http_status: r.status,
      elapsed_ms: Date.now() - started,
      service: r.data?.service || null,
      events: Number.isFinite(Number(r.data?.events)) ? Number(r.data.events) : null,
    };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      status: 'offline',
      label: 'Шлюз недоступен',
      http_status: 0,
      elapsed_ms: Date.now() - started,
      error: e?.message || String(e),
    };
  }
}

async function loadAll() {
  return loadOperationsState({ dbQuery, mapAdminUser });
}

function buildDashboardAccess({ zones, devices }, user) {
  const allowedZoneIds = (user.role === 'admin')
    ? Object.keys(zones)
    : (Array.isArray(user.zones) ? user.zones : []);
  const devicesArr = Object.values(devices).filter((d) => d.is_active !== false);

  const byZone = [];
  allowedZoneIds.forEach((zid) => {
    const z = zones[zid];
    const dz = devicesArr.filter((d) => d.zoneId === zid);
    if (z && dz.length) {
      byZone.push({ zoneId: zid, zoneName: z.name, devices: dz });
    }
  });

  const accessibleDevices = byZone.flatMap((group) => (
    Array.isArray(group.devices)
      ? group.devices.map((device) => ({
          id: device.id,
          name: device.name,
          zoneId: group.zoneId,
          zoneName: group.zoneName,
          enabled: device.enabled !== false,
        }))
      : []
  ));

  return { byZone, accessibleDevices };
}

function eventMatchesZone(event, zoneId, zoneName) {
  const eventZone = String(event?.zone_id || event?.details?.zoneId || '').trim();
  if (eventZone && eventZone === String(zoneId || '').trim()) return true;
  const point = String(event?.point || '').toLowerCase();
  return !!zoneName && point.includes(String(zoneName).toLowerCase());
}

function describeZoneDevices(devices, zoneName, zoneId) {
  const list = Array.isArray(devices) ? devices : [];
  if (!list.length) return 'Пока ничего не подключено';

  const names = list.map((device) => String(device?.name || '').trim()).filter(Boolean);
  const zoneKey = String(zoneId || '').trim().toLowerCase();
  const floorLabels = [...new Set(
    names
      .map((name) => {
        const match = name.match(/(\d+)\s*(?:эт|этаж)/iu);
        return match ? `${match[1]} эт.` : null;
      })
      .filter(Boolean)
  )].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  if (floorLabels.length) return `Этажи ${floorLabels.join(', ')}`;

  const liftCount = names.filter((name) => /лифт/iu.test(name)).length;
  const entranceCount = names.filter((name) => /двер|вход/iu.test(name)).length;
  if (zoneKey === 'pedestrian' && (liftCount || entranceCount)) {
    return 'Входы с 1 этажа и лифты';
  }
  if (liftCount || entranceCount) {
    const parts = [];
    if (liftCount) parts.push(liftCount > 1 ? `${liftCount} лифта` : 'лифт');
    if (entranceCount) parts.push(entranceCount > 1 ? `${entranceCount} входов` : 'вход');
    return parts.join(' и ');
  }

  const entryCount = names.filter((name) => /въезд|заезд/iu.test(name)).length;
  const exitCount = names.filter((name) => /выезд/iu.test(name)).length;
  if (zoneKey === 'buffer') return 'Шлагбаумы у северного въезда';
  if (zoneKey === 'transit') return 'Рампа и шлагбаумы на эстакаду';
  if (zoneKey === 'underground' && (entryCount || exitCount)) return 'Въезды в подземную часть';
  if (zoneKey === 'overground' && (entryCount || exitCount)) return 'Въезды и выезды на наземном уровне';
  if (zoneKey === 'europlan' && (entryCount || exitCount)) return 'Заезд и выезд по этажам';
  if (entryCount || exitCount) {
    const parts = [];
    if (entryCount) parts.push(entryCount > 1 ? `${entryCount} въезда` : 'въезд');
    if (exitCount) parts.push(exitCount > 1 ? `${exitCount} выезда` : 'выезд');
    return parts.join(' и ');
  }

  if (/северный въезд|рампа|эстакад/iu.test(String(zoneName || ''))) return 'Шлагбаумы и проезды';

  return `${list.length} ${pluralRu(list.length, 'вариант', 'варианта', 'вариантов')}`;
}

function buildZoneSummary(byZone, recentEvents) {
  return (byZone || []).map((group) => {
    const devices = Array.isArray(group.devices) ? group.devices : [];
    const lastEvent = (recentEvents || []).find((event) => eventMatchesZone(event, group.zoneId, group.zoneName)) || null;
    return {
      id: group.zoneId,
      name: group.zoneName,
      devices: devices.length,
      descriptor: describeZoneDevices(devices, group.zoneName, group.zoneId),
      lastPoint: lastEvent?.point || null,
      lastResult: dashboardResultLabel(lastEvent?.result),
      lastRequestId: lastEvent?.request_id || null,
      lastAt: lastEvent?.datetime_msk || lastEvent?.datetime || null,
    };
  });
}

function filterDashboardEvents(byZone, recentEvents) {
  const groups = Array.isArray(byZone) ? byZone : [];
  const list = Array.isArray(recentEvents) ? recentEvents : [];
  if (!groups.length) return [];
  return list.filter((event) => groups.some((group) => eventMatchesZone(event, group.zoneId, group.zoneName)));
}

function isDashboardAttentionEvent(event) {
  const result = String(event?.result || '').trim().toLowerCase();
  return !!result && result !== 'ok';
}

function dashboardResultLabel(result) {
  const raw = String(result || '').trim();
  if (!raw) return 'Нет статуса';
  if (raw === 'ok') return 'Успешно';
  if (raw === 'denied') return 'Нет доступа';
  if (raw === 'disabled') return 'Отключено';
  if (raw.startsWith('gw_error:')) return 'Ошибка шлюза';
  return raw;
}

function buildDashboardTimeline(recentEvents) {
  const list = (Array.isArray(recentEvents) ? recentEvents : []).slice().reverse();
  const grouped = new Map();

  list.forEach((event) => {
    const dt = event?.datetime ? new Date(event.datetime) : null;
    if (!dt || Number.isNaN(dt.getTime())) return;
    const label = formatMoscowDateTime(dt).split(' ')[1]?.slice(0, 5) || '—';
    const current = grouped.get(label) || { label, total: 0, attention: 0 };
    current.total += 1;
    if (isDashboardAttentionEvent(event)) current.attention += 1;
    grouped.set(label, current);
  });

  const items = Array.from(grouped.values()).slice(-8);
  const maxTotal = items.reduce((acc, item) => Math.max(acc, item.total), 1);
  return items.map((item) => ({
    label: item.label,
    total: item.total,
    attention: item.attention,
    height: Math.max(16, Math.round((item.total / maxTotal) * 100)),
  }));
}

function buildAttentionEvents(recentEvents) {
  return (Array.isArray(recentEvents) ? recentEvents : [])
    .filter(isDashboardAttentionEvent)
    .slice(0, 5)
    .map((event) => ({
      point: event?.point || '—',
      datetime: event?.datetime || null,
      datetime_msk: event?.datetime_msk || null,
      result: event?.result || null,
      result_label: dashboardResultLabel(event?.result),
      request_id: event?.request_id || null,
      actor_fio: event?.actor_fio || null,
      actor_phone: event?.actor_phone || null,
      device_id: event?.device_id || event?.details?.deviceId || null,
      zone_id: event?.zone_id || event?.details?.zoneId || null,
      logs_href: event?.request_id
        ? buildTransitLogUrl('/logs', { request_id: String(event.request_id).slice(0, 8) })
        : buildTransitLogUrl('/logs', { status: 'attention', point: event?.point || '' }),
    }));
}

function clientTransitEvent(event) {
  return {
    datetime: event?.datetime || null,
    datetime_msk: event?.datetime_msk || null,
    point: event?.point || null,
    event: event?.event || null,
    result: event?.result || null,
    request_id: event?.request_id || null,
    actor_fio: event?.actor_fio || null,
    actor_phone: event?.actor_phone || null,
    device_id: event?.device_id || event?.details?.deviceId || null,
    zone_id: event?.zone_id || event?.details?.zoneId || null,
    gateway: event?.details?.gateway || null,
    result_label: dashboardResultLabel(event?.result),
  };
}

function buildDashboardStats(byZone, accessibleDevices, recentEvents) {
  const recent = Array.isArray(recentEvents) ? recentEvents : [];
  const attention = recent.filter(isDashboardAttentionEvent).length;
  return {
    zones: byZone.length,
    devices: accessibleDevices.length,
    gatewayConfigured: !!(GATEWAY_BASE_URL && GATEWAY_KEY),
    lastEvent: recent[0] || null,
    recentCount: recent.length,
    okCount: recent.length - attention,
    attentionCount: attention,
  };
}

// --- Seed defaults (zones + devices) -----------------------------------------
const DEFAULT_ZONES = [
  { id: 'buffer',      name: 'Северный въезд',         sort: 10 },
  { id: 'europlan',    name: 'Этажи 2-9',              sort: 20 },
  { id: 'overground',  name: 'Наземный уровень',       sort: 30 },
  { id: 'pedestrian',  name: 'Входы и лифты',          sort: 40 },
  { id: 'underground', name: 'Подземный уровень',      sort: 50 },
  { id: 'transit',     name: 'Рампа на эстакаду',      sort: 60 },
];

async function ensureDefaultZones() {
  const res = await dbQuery('SELECT COUNT(*)::int AS c FROM public.zones');
  if ((res.rows?.[0]?.c ?? 0) > 0) return;

  const values = [];
  const params = [];
  let i = 1;
  for (const z of DEFAULT_ZONES) {
    values.push(`($${i++}, $${i++}, $${i++}, TRUE, NOW())`);
    params.push(z.id, z.name, z.sort);
  }
  await dbQuery(
    `INSERT INTO public.zones (id, name, sort, is_active, created_at)
     VALUES ${values.join(',')}
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       sort = EXCLUDED.sort,
       is_active = TRUE`,
    params
  );
}

function parseDevicesJson(raw) {
  if (!raw) return [];
  // allowed formats:
  // 1) { "id1": {...}, "id2": {...} }
  // 2) [ {...}, {...} ]
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([id, v]) => ({ id, ...(v || {}) }));
  }
  return [];
}

async function seedDevicesFromJson() {
  // Seed only when DB is empty, so we don't overwrite devices created in админке
  try {
    const c = await dbQuery('SELECT COUNT(*)::int AS c FROM public.devices');
    if ((c.rows?.[0]?.c ?? 0) > 0) return;
  } catch (e) {
    console.error('seedDevicesFromJson: COUNT(*) failed', e?.message || e);
    // continue, schema may be just created
  }

  const candidates = [
    path.join(__dirname, 'devices.json'),
    path.join(__dirname, 'data', 'devices.json'),
  ];
  const p = candidates.find(fp => fs.existsSync(fp));

  let list = [];

  if (p) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      list = parseDevicesJson(raw);
    } catch (e) {
      console.error('devices.json: parse error', e?.message || e);
      list = [];
    }
  }

  // If file is missing/empty — create a reference device set with real route names.
  if (!list.length) {
    console.log('ℹ️ devices.json пустой/не найден — создаю референсный набор устройств');
    list = buildReferenceDevices();
  }

  for (const d of list) {
    const id = String(d.id || '').trim();
    if (!id) continue;

    const name = String(d.name || id).trim();
    const type = String(d.type || 'http').trim() || 'http';
    const method = String(d.method || 'POST').toUpperCase();
    const url = String(d.url || d.endpoint || d.link || '').trim();
    const ip = url && !/^https?:\/\//i.test(url) ? url : null;
    const zoneId = String(d.zone_id || d.zone || '').trim() || 'buffer';
    const sort = Number.isFinite(Number(d.sort)) ? Number(d.sort) : 0;
    const enabled = typeof d.enabled === 'boolean' ? d.enabled : true;

    // allow url empty (some devices can be placeholders), but keep it consistent
    await dbQuery(
      `INSERT INTO public.devices (id, name, zone_id, type, method, url, ip, enabled, sort, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         zone_id = COALESCE(EXCLUDED.zone_id, public.devices.zone_id),
         type = EXCLUDED.type,
         method = EXCLUDED.method,
         url = EXCLUDED.url,
         ip = EXCLUDED.ip,
         enabled = EXCLUDED.enabled,
         sort = EXCLUDED.sort,
         is_active = TRUE,
         updated_at = NOW()`,
      [id, name, zoneId, type, method, url, ip, enabled, sort]
    );
  }
}

function authRequired(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}

function adminRequired(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  // Для обычных пользователей закрываем всё, кроме Дашборда.
  // Вместо 403 делаем редирект на главную, чтобы UI выглядел как приложение, а не как ошибка.
  if (req.session.user.role !== 'admin') return res.redirect('/');
  next();
}



function getEffectiveRole(user) {
  if (!user) return 'guest';
  if (user.role === 'admin' && user.is_is_admin) return 'sysadmin';
  if (user.role === 'admin') return 'admin';
  if (user.role === 'dispatcher') return 'dispatcher';
  return 'user';
}

const ROLE_PERMISSIONS = {
  sysadmin: new Set([
    'dashboard.use',
    'devices.open',
    'logs.view',
    'users.manage',
    'pin.reset',
    'devices.manage',
    'zones.manage',
    'audit.view',
  ]),
  admin: new Set([
    'dashboard.use',
    'devices.open',
    'logs.view',
    'users.manage',
    'pin.reset',
  ]),
  dispatcher: new Set([
    'dashboard.use',
    'devices.open',
    'logs.view',
  ]),
  user: new Set([
    'dashboard.use',
    'devices.open',
  ]),
  guest: new Set([]),
};

function hasPermission(user, permission) {
  const role = getEffectiveRole(user);
  return ROLE_PERMISSIONS[role] ? ROLE_PERMISSIONS[role].has(permission) : false;
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.session?.user) return res.redirect('/login');
    if (!hasPermission(req.session.user, permission)) return res.redirect('/');
    next();
  };
}

function parseDeviceSecretFields(rawUrl, authTypeIn, usernameIn, passwordIn, keep = {}) {
  const src = String(rawUrl || '').trim();
  let cleanUrl = src;
  let authType = String(authTypeIn || keep.auth_type || 'none').trim() || 'none';
  let username = (usernameIn !== undefined && usernameIn !== null && String(usernameIn).trim() !== '')
    ? String(usernameIn).trim()
    : String(keep.username || '').trim();
  let password = (passwordIn !== undefined && passwordIn !== null && String(passwordIn).trim() !== '')
    ? String(passwordIn).trim()
    : String(keep.password || '').trim();

  try {
    const u = new URL(src);
    if (u.username || u.password) {
      if (!username && u.username) username = u.username;
      if (!password && u.password) password = u.password;
      u.username = '';
      u.password = '';
      cleanUrl = u.toString();
      authType = 'basic';
    }
  } catch {}

  if ((username || password) && authType === 'none') authType = 'basic';
  if (!username && !password && authType === 'basic') authType = 'none';

  const ip = cleanUrl && !/^https?:\/\//i.test(cleanUrl) ? cleanUrl : null;

  return {
    url: cleanUrl,
    ip,
    auth_type: authType,
    username,
    password,
  };
}

async function ensureExtraSecuritySchema() {
  await dbQuery("ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS auth_type text DEFAULT 'none'");
  await dbQuery("ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS username text");
  await dbQuery("ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS password text");
  await dbQuery("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role text DEFAULT 'user'");

  const r = await dbQuery("SELECT id, url, auth_type, username, password FROM public.devices");
  for (const d of r.rows || []) {
    const url = String(d.url || '').trim();
    if (!url) continue;
    try {
      const u = new URL(url);
      if (u.username || u.password) {
        const login = d.username || u.username || null;
        const pwd = d.password || u.password || null;
        u.username = '';
        u.password = '';
        await dbQuery(
          `UPDATE public.devices
             SET url=$2,
                 ip=$3,
                 auth_type=COALESCE(NULLIF(auth_type,''), 'basic'),
                 username=COALESCE(username,$4),
                 password=COALESCE(password,$5)
           WHERE id=$1`,
          [d.id, u.toString(), null, login, pwd]
        );
      }
    } catch {}
  }
}

function isIsAdminRequired(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.redirect('/');
  if (!req.session.user.is_is_admin) return res.redirect('/admin/users');
  next();
}

// --- health ---
app.get('/health', async (req, res) => {
  try {
    await dbQuery('SELECT 1 AS ok');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

registerAuthRoutes({
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
});

registerDashboardRoutes({
  app,
  authRequired,
  loadAll,
  loadRecentTransitEvents,
  buildDashboardAccess,
  filterDashboardEvents,
  buildZoneSummary,
  buildDashboardSupportContact,
  buildDashboardStats,
  buildDashboardTimeline,
  buildAttentionEvents,
  getGatewayStatus,
  clientTransitEvent,
  gatewayOpen,
  appendTransitEvent,
  appendAudit,
  dispatcherPhone: DISPATCHER_PHONE,
});

registerLogsRoutes({
  app,
  requirePermission,
  dbQuery,
  appendAudit,
  readFallbackTransitEvents,
  normalizeTransitEvent,
  transitEventMatchesFilters,
  formatMoscowDateTime,
  parseTransitLogFilters,
  buildTransitLogWhere,
  buildTransitLogSummary,
  buildTransitLogQuickLinks,
  buildTransitLogUrl,
  ruTransitEvent,
  clearFallbackTransitLog,
});


// --- admin: users/devices/zones/audit ---
registerAdminUsersRoutes({
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
});

registerAdminDevicesRoutes({
  app,
  requirePermission,
  dbQuery,
  loadAll,
  appendAudit,
  parseDeviceSecretFields,
});

registerAdminZonesRoutes({
  app,
  requirePermission,
  dbQuery,
  loadAll,
  appendAudit,
  parseListInput,
  buildDevicesByZone,
  deviceNaturalSort,
  syncZoneDevices,
});

registerAdminAuditRoutes({
  app,
  isIsAdminRequired,
  requirePermission,
  dbQuery,
  formatMoscowDateTime,
  parseAuditFilters,
  buildAuditWhere,
});

// --- bootstrap: create default admin if missing ---
async function ensureDefaultAdmin() {
  const adminPhone = digitsOnly(process.env.ADMIN_PHONE || '');
  const adminPin = String(process.env.ADMIN_PIN || '');

  if (!adminPhone || !adminPin) {
    console.warn('ADMIN_PHONE/ADMIN_PIN are not set; default admin was not created.');
    return;
  }
  if (adminPin.length < 8) {
    throw new Error('ADMIN_PIN must be at least 8 characters.');
  }

  const exists = await dbQuery(
    `SELECT id FROM public.users WHERE regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') = $1 LIMIT 1`,
    [adminPhone]
  );

  if (exists.rows.length) return;

  const id = 'admin';
  const fio = process.env.ADMIN_FIO || 'Администратор';
  // если зон ещё нет — оставляем пусто, можно назначить в админке
  await dbQuery(
    `INSERT INTO public.users(id,fio,phone,organization,position,pin,role,is_is_admin,zones,is_active)
     VALUES ($1,$2,$3,$4,$5,$6,'admin',true,$7,true)
     ON CONFLICT (id) DO NOTHING`,
    [id, fio, adminPhone, null, null, await hashPin(adminPin), []]
  );

  console.log('✅ Создан админ по умолчанию:', adminPhone);
}

async function ensureDemoUser(spec = {}) {
  const phone = digitsOnly(spec.phone || '');
  const pin = String(spec.pin || '');
  if (!phone || pin.length < 8) return false;

  const exists = await dbQuery(
    `SELECT id FROM public.users WHERE regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') = $1 LIMIT 1`,
    [phone]
  );

  if (exists.rows.length) return false;

  await dbQuery(
    `INSERT INTO public.users(id,fio,phone,email,organization,position,pin,role,is_is_admin,zones,assignable_zones,is_tenant_contact,parking_floors,parking_groups,parking_spots,preferred_routes,is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)
     ON CONFLICT (id) DO NOTHING`,
    [
      spec.id,
      spec.fio || null,
      phone,
      spec.email || null,
      spec.organization || null,
      spec.position || null,
      await hashPin(pin),
      spec.role || 'user',
      !!spec.is_is_admin,
      Array.isArray(spec.zones) ? spec.zones : [],
      spec.assignable_zones == null ? null : (Array.isArray(spec.assignable_zones) ? spec.assignable_zones : []),
      !!spec.is_tenant_contact,
      parseListInput(spec.parking_floors),
      parseListInput(spec.parking_groups),
      parseListInput(spec.parking_spots),
      parseListInput(spec.preferred_routes),
    ]
  );

  return true;
}

async function ensureDemoUsers() {
  if (!isDevDb) return;

  const demoUsers = [
    {
      id: 'demo-admin-lite',
      fio: 'Администратор смены',
      phone: '79000000010',
      pin: 'RuntimeAdminLite1234',
      role: 'admin',
      is_is_admin: false,
      zones: ['europlan', 'pedestrian', 'buffer', 'overground'],
      assignable_zones: ['europlan', 'pedestrian', 'buffer', 'overground'],
      organization: 'Моя парковка',
      position: 'Администратор',
    },
    {
      id: 'demo-dispatcher',
      fio: 'Диспетчер парковки',
      phone: '79000000020',
      pin: 'RuntimeDispatch1234',
      role: 'dispatcher',
      is_is_admin: false,
      zones: ['pedestrian', 'buffer', 'europlan', 'overground', 'underground', 'transit'],
      assignable_zones: null,
      is_tenant_contact: true,
      organization: 'Моя парковка',
      position: 'Диспетчер',
    },
    {
      id: 'demo-tenant-europlan',
      fio: 'Арендатор 7 этажа',
      phone: '79000000030',
      pin: 'RuntimeEuro1234',
      role: 'user',
      is_is_admin: false,
      zones: ['europlan'],
      assignable_zones: null,
      organization: 'Секция 7A',
      position: 'Арендатор',
      parking_floors: ['7'],
      parking_groups: ['Секция 7A'],
      parking_spots: ['7-124', '7-125'],
      preferred_routes: ['7 этаж', 'въезд', 'выезд'],
    },
    {
      id: 'demo-tenant-pedestrian',
      fio: 'Арендатор Пешеходный доступ',
      phone: '79000000031',
      pin: 'RuntimeWalk1234',
      role: 'user',
      is_is_admin: false,
      zones: ['pedestrian'],
      assignable_zones: null,
      organization: 'Башня А',
      position: 'Арендатор',
      parking_floors: ['7'],
      parking_groups: ['Лобби А'],
      parking_spots: ['Лифт 1'],
      preferred_routes: ['лифты', 'двери'],
    },
    {
      id: 'demo-tenant-drive',
      fio: 'Арендатор Наземный маршрут',
      phone: '79000000032',
      pin: 'RuntimeDrive1234',
      role: 'user',
      is_is_admin: false,
      zones: ['buffer', 'overground'],
      assignable_zones: null,
      organization: 'Паркинг Север',
      position: 'Арендатор',
      parking_floors: ['2'],
      parking_groups: ['Сектор B2'],
      parking_spots: ['B2-07'],
      preferred_routes: ['въезды', 'выезды'],
    },
    {
      id: 'demo-tenant-underground',
      fio: 'Арендатор Подземный маршрут',
      phone: '79000000033',
      pin: 'RuntimeUnderground1234',
      role: 'user',
      is_is_admin: false,
      zones: ['underground', 'transit'],
      assignable_zones: null,
      organization: 'Паркинг Юг',
      position: 'Арендатор',
      parking_floors: ['2'],
      parking_groups: ['Сектор P2'],
      parking_spots: ['P2-18'],
      preferred_routes: ['шлагбаумы', 'въезды'],
    },
  ];

  const created = [];
  for (const spec of demoUsers) {
    if (await ensureDemoUser(spec)) created.push(spec.phone);
  }

  if (created.length) {
    console.log('✅ Созданы демо-пользователи:', created.join(', '));
  }
}

(async () => {
  try {
    if (!isDevDb && !databaseUrlConfigured) {
      throw new Error('DATABASE_URL/PG_URL must be set. For local demo use DEV_MEMORY_DB=true.');
    }
    await ensureSchema();
    // 1) создаём стандартные зоны
    await ensureDefaultZones();
    // 2) загружаем устройства из devices.json или создаём тестовые
    await seedDevicesFromJson();
    // 3) выносим секреты устройств из URL в отдельные поля
    await ensureExtraSecuritySchema();
    // 4) создаём админа по умолчанию
    await ensureDefaultAdmin();
    // 5) создаём демо-роли для локальной проверки интерфейса
    await ensureDemoUsers();
    // 6) прогреваем кэш
    await loadAll();
  } catch (e) {
    console.error('DB init error:', e);
    if (!ALLOW_DB_INIT_FAILURE) {
      console.error('Startup aborted: database initialization failed. Set DEV_MEMORY_DB=true for local demo mode.');
      process.exit(1);
    }
  }

  app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
   console.log(`✅ Моя парковка запущен: http://127.0.0.1:${PORT}`);
  });
})();
