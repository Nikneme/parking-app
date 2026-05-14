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
const FALLBACK_TRANSIT_LOG = path.join(__dirname, 'data', 'transit_events.jsonl');

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 8080);
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
if (!SESSION_SECRET || SESSION_SECRET === 'change-me-in-railway') {
  throw new Error('SESSION_SECRET must be set to a strong unique value.');
}
const GATEWAY_BASE_URL = String(process.env.GATEWAY_BASE_URL || '').replace(/\/+$/g, '');
const GATEWAY_KEY = String(process.env.GATEWAY_KEY || '');
const GATEWAY_TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 7000);
const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const IS_PRODUCTION = NODE_ENV === 'production';
const ALLOW_REFERENCE_DEVICE_SEED = String(process.env.ALLOW_REFERENCE_DEVICE_SEED || (IS_PRODUCTION ? 'false' : 'true')).toLowerCase() === 'true';

if (IS_PRODUCTION && isDevDb) {
  throw new Error('DEV_MEMORY_DB=true is forbidden in production. Configure DATABASE_URL/PG_URL.');
}

const APP_BASE_URL = String(process.env.APP_BASE_URL || 'https://moyaparkovka.ru').replace(/\/+$/g, '');
const DISPATCHER_PHONE = String(process.env.DISPATCHER_PHONE || '+7 936 004-67-42').trim();
const SESSION_STORE_ENABLED = !!(process.env.DATABASE_URL || process.env.PG_URL);
const SMTP_HOST = String(process.env.SMTP_HOST || '');
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
const SMTP_USER = String(process.env.SMTP_USER || '');
const SMTP_PASS = String(process.env.SMTP_PASS || '');
const MAIL_FROM = String(process.env.MAIL_FROM || SMTP_USER || 'mmoyaparkovka@yandex.ru');
const MAIL_INCLUDE_PASSWORD = false; // Р СћР вЂ” 4.2: Р Т‘Р ВµР в„–РЎРѓРЎвЂљР Р†РЎС“РЎР‹РЎвЂ°Р С‘Р Вµ PIN/Р С—Р В°РЎР‚Р С•Р В»Р С‘ Р Р…Р С‘Р С”Р С•Р С–Р Т‘Р В° Р Р…Р Вµ Р С•РЎвЂљР С—РЎР‚Р В°Р Р†Р В»РЎРЏРЎР‹РЎвЂљРЎРѓРЎРЏ Р С—Р С• email
const GATEWAY_SEND_DEVICE_SECRETS = String(process.env.GATEWAY_SEND_DEVICE_SECRETS || '').toLowerCase() === 'true';
const START_PIN_TTL_HOURS = Math.max(1, Number(process.env.START_PIN_TTL_HOURS || 24));
const PIN_MIN_LENGTH = Math.max(8, Number(process.env.PIN_MIN_LENGTH || 8));
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_RATE_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_MAX || 8);
const LOGIN_IP_RATE_MAX = Math.max(LOGIN_MAX_ATTEMPTS, Number(process.env.LOGIN_IP_RATE_MAX || LOGIN_MAX_ATTEMPTS * 5));
const LOGIN_PHONE_RATE_MAX = Math.max(LOGIN_MAX_ATTEMPTS, Number(process.env.LOGIN_PHONE_RATE_MAX || LOGIN_MAX_ATTEMPTS * 3));
const ALLOW_FILE_TRANSIT_FALLBACK = String(process.env.ALLOW_FILE_TRANSIT_FALLBACK || (IS_PRODUCTION ? 'false' : 'true')).toLowerCase() === 'true';
const ALLOW_DB_INIT_FAILURE = String(process.env.ALLOW_DB_INIT_FAILURE || '').toLowerCase() === 'true';

if (IS_PRODUCTION && GATEWAY_SEND_DEVICE_SECRETS) {
  throw new Error('GATEWAY_SEND_DEVICE_SECRETS=true is forbidden in production.');
}

if (String(process.env.MAIL_INCLUDE_PASSWORD || '').toLowerCase() === 'true') {
  console.warn('РІС™В РїС‘РЏ MAIL_INCLUDE_PASSWORD is ignored: passwords are never sent by email.');
}

if (GATEWAY_SEND_DEVICE_SECRETS) {
  console.warn('РІС™В РїС‘РЏ GATEWAY_SEND_DEVICE_SECRETS=true: device passwords may be included in gateway payloads.');
}

if (ALLOW_FILE_TRANSIT_FALLBACK) {
  console.warn('РІС™В РїС‘РЏ File transit fallback is enabled. When DB fails, part of the transit log may be written to a local file.');
}

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
  loginIpMaxAttempts: LOGIN_IP_RATE_MAX,
  loginPhoneMaxAttempts: LOGIN_PHONE_RATE_MAX,
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
  return role === 'admin' ? 'Р С’Р Т‘Р СР С‘Р Р…Р С‘РЎРѓРЎвЂљРЎР‚Р В°РЎвЂљР С•РЎР‚' : (role === 'dispatcher' ? 'Р вЂќР С‘РЎРѓР С—Р ВµРЎвЂљРЎвЂЎР ВµРЎР‚' : 'Р С’РЎР‚Р ВµР Р…Р Т‘Р В°РЎвЂљР С•РЎР‚');
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


function getStartPinExpiresAt() {
  return new Date(Date.now() + START_PIN_TTL_HOURS * 60 * 60 * 1000);
}

function isPinExpired(user) {
  if (!user || !user.pin_expires_at) return false;
  const expiresAt = new Date(user.pin_expires_at);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now();
}

function userNeedsPinChange(user) {
  return !!(user && (user.must_change_pin || isPinExpired(user)));
}

function pinChangeReason(user) {
  return isPinExpired(user) ? 'expired' : 'required';
}

function validateNewPin(pin, user = {}) {
  const value = String(pin || '');
  if (value.length < PIN_MIN_LENGTH) {
    return `Р СџР В°РЎР‚Р С•Р В»РЎРЉ Р Т‘Р С•Р В»Р В¶Р ВµР Р… РЎРѓР С•Р Т‘Р ВµРЎР‚Р В¶Р В°РЎвЂљРЎРЉ Р Р…Р Вµ Р СР ВµР Р…Р ВµР Вµ ${PIN_MIN_LENGTH} РЎРѓР С‘Р СР Р†Р С•Р В»Р С•Р Р†.`;
  }
  const digits = digitsOnly(value);
  if (digits && digits === digitsOnly(user.phone || '')) {
    return 'Р СџР В°РЎР‚Р С•Р В»РЎРЉ Р Р…Р Вµ Р Т‘Р С•Р В»Р В¶Р ВµР Р… РЎРѓР С•Р Р†Р С—Р В°Р Т‘Р В°РЎвЂљРЎРЉ РЎРѓ Р Р…Р С•Р СР ВµРЎР‚Р С•Р С РЎвЂљР ВµР В»Р ВµРЎвЂћР С•Р Р…Р В°.';
  }
  if (/^(.)\1+$/.test(value)) {
    return 'Р СџР В°РЎР‚Р С•Р В»РЎРЉ Р Р…Р Вµ Р Т‘Р С•Р В»Р В¶Р ВµР Р… РЎРѓР С•РЎРѓРЎвЂљР С•РЎРЏРЎвЂљРЎРЉ Р С‘Р В· Р С•Р Т‘Р Р…Р С•Р С–Р С• Р С—Р С•Р Р†РЎвЂљР С•РЎР‚РЎРЏРЎР‹РЎвЂ°Р ВµР С–Р С•РЎРѓРЎРЏ РЎРѓР С‘Р СР Р†Р С•Р В»Р В°.';
  }
  return '';
}

const DEVICE_SECRET_PREFIX = 'enc:v1:gcm:';
const DEVICE_SECRET_KEY_MATERIAL = String(process.env.DEVICE_SECRET_ENCRYPTION_KEY || '').trim();
const DEVICE_SECRET_PLACEHOLDERS = new Set(['', 'change-me', 'replace-with-another-long-random-secret']);
if (DEVICE_SECRET_PLACEHOLDERS.has(DEVICE_SECRET_KEY_MATERIAL)) {
  if (IS_PRODUCTION) {
    throw new Error('DEVICE_SECRET_ENCRYPTION_KEY must be set to a strong unique value in production.');
  }
  console.warn('DEVICE_SECRET_ENCRYPTION_KEY is not set; falling back to SESSION_SECRET for local development only.');
}
const DEVICE_SECRET_KEY = crypto.createHash('sha256').update(DEVICE_SECRET_KEY_MATERIAL || SESSION_SECRET).digest();

function encryptDeviceSecret(value) {
  const plain = String(value || '');
  if (!plain || plain.startsWith(DEVICE_SECRET_PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DEVICE_SECRET_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${DEVICE_SECRET_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptDeviceSecret(value) {
  const stored = String(value || '');
  if (!stored || !stored.startsWith(DEVICE_SECRET_PREFIX)) return stored;
  try {
    const rest = stored.slice(DEVICE_SECRET_PREFIX.length);
    const [ivB64, tagB64, dataB64] = rest.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', DEVICE_SECRET_KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    console.warn('device secret decrypt failed:', error?.message || error);
    return '';
  }
}

async function sendWelcomeEmail({ to, fio, phone, pin, role }) {
  if (!to || !mailTransport) return false;

  const siteUrl = APP_BASE_URL || 'https://moyaparkovka.ru';
  const safeName = String(fio || 'Р С™Р С•Р В»Р В»Р ВµР С–Р В°');
  const safeLogin = String(phone || '');
  const safeRole = roleLabelRu(String(role || 'user'));
  const passwordLineHtml = `<div style="margin:0 0 8px 0;"><span style="color:#94a3b8;">Р СџР В°РЎР‚Р С•Р В»РЎРЉ:</span> Р С—Р С•Р В»РЎС“РЎвЂЎР С‘РЎвЂљР Вµ РЎС“ Р В°Р Т‘Р СР С‘Р Р…Р С‘РЎРѓРЎвЂљРЎР‚Р В°РЎвЂљР С•РЎР‚Р В°</div>`;
  const passwordLineText = 'Р СџР В°РЎР‚Р С•Р В»РЎРЉ: Р С—Р С•Р В»РЎС“РЎвЂЎР С‘РЎвЂљР Вµ РЎС“ Р В°Р Т‘Р СР С‘Р Р…Р С‘РЎРѓРЎвЂљРЎР‚Р В°РЎвЂљР С•РЎР‚Р В°';

  const html = `
  <div style="margin:0;padding:0;background:#0b1220;font-family:Arial,sans-serif;color:#e5e7eb;">
    <div style="max-width:640px;margin:0 auto;padding:24px 16px;">
      <div style="background:linear-gradient(135deg,#1f3b73 0%,#0f172a 100%);border:1px solid rgba(255,255,255,.08);border-radius:20px;overflow:hidden;">
        <div style="padding:28px 24px;border-bottom:1px solid rgba(255,255,255,.08);">
          <div style="font-size:24px;font-weight:700;margin-bottom:8px;">Р СљР С•РЎРЏ Р С—Р В°РЎР‚Р С”Р С•Р Р†Р С”Р В°</div>
          <div style="font-size:14px;color:#cbd5e1;">Р вЂќР С•РЎРѓРЎвЂљРЎС“Р С— Р Р† РЎРѓР С‘РЎРѓРЎвЂљР ВµР СРЎС“ РЎРѓР С•Р В·Р Т‘Р В°Р Р…</div>
        </div>
        <div style="padding:24px;">
          <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">Р вЂ”Р Т‘РЎР‚Р В°Р Р†РЎРѓРЎвЂљР Р†РЎС“Р в„–РЎвЂљР Вµ, ${safeName}.</p>
          <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">Р вЂ™Р В°РЎв‚¬ Р В°Р С”Р С”Р В°РЎС“Р Р…РЎвЂљ Р Р† <b>Р’В«Р СљР С•РЎРЏ Р С—Р В°РЎР‚Р С”Р С•Р Р†Р С”Р В°Р’В»</b> Р С–Р С•РЎвЂљР С•Р Р†.</p>
          <div style="background:#111827;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:16px 18px;margin:0 0 18px 0;">
            <div style="margin:0 0 8px 0;"><span style="color:#94a3b8;">Р РЋР В°Р в„–РЎвЂљ:</span> <a href="${siteUrl}" style="color:#93c5fd;text-decoration:none;">${siteUrl}</a></div>
            <div style="margin:0 0 8px 0;"><span style="color:#94a3b8;">Р вЂєР С•Р С–Р С‘Р Р…:</span> <b>${safeLogin}</b></div>
            ${passwordLineHtml}
            <div><span style="color:#94a3b8;">Р В Р С•Р В»РЎРЉ:</span> <b>${safeRole}</b></div>
          </div>
          <div style="margin:0 0 20px 0;">
            <a href="${siteUrl}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">Р СџР ВµРЎР‚Р ВµР в„–РЎвЂљР С‘ Р Р…Р В° РЎРѓР В°Р в„–РЎвЂљ</a>
          </div>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8;">Р вЂўРЎРѓР В»Р С‘ Р С—Р С‘РЎРѓРЎРЉР СР С• Р С—РЎР‚Р С‘РЎв‚¬Р В»Р С• Р Р†Р В°Р С Р С—Р С• Р С•РЎв‚¬Р С‘Р В±Р С”Р Вµ, Р С—РЎР‚Р С•РЎРѓРЎвЂљР С• Р С—РЎР‚Р С•Р С‘Р С–Р Р…Р С•РЎР‚Р С‘РЎР‚РЎС“Р в„–РЎвЂљР Вµ Р ВµР С–Р С•.</p>
        </div>
      </div>
    </div>
  </div>`;

  const text = [
    'Р СљР С•РЎРЏ Р С—Р В°РЎР‚Р С”Р С•Р Р†Р С”Р В°',
    '',
    `Р вЂ”Р Т‘РЎР‚Р В°Р Р†РЎРѓРЎвЂљР Р†РЎС“Р в„–РЎвЂљР Вµ, ${safeName}.`,
    'Р вЂ™Р В°РЎв‚¬ Р В°Р С”Р С”Р В°РЎС“Р Р…РЎвЂљ Р Р† Р’В«Р СљР С•РЎРЏ Р С—Р В°РЎР‚Р С”Р С•Р Р†Р С”Р В°Р’В» Р С–Р С•РЎвЂљР С•Р Р†.',
    `Р РЋР В°Р в„–РЎвЂљ: ${siteUrl}`,
    `Р вЂєР С•Р С–Р С‘Р Р…: ${safeLogin}`,
    passwordLineText,
    `Р В Р С•Р В»РЎРЉ: ${safeRole}`,
  ].join('\n');

  await mailTransport.sendMail({
    from: MAIL_FROM,
    to,
    subject: 'Р вЂќР С•РЎРѓРЎвЂљРЎС“Р С— Р Р† РЎРѓР С‘РЎРѓРЎвЂљР ВµР СРЎС“ Р’В«Р СљР С•РЎРЏ Р С—Р В°РЎР‚Р С”Р С•Р Р†Р С”Р В°Р’В»',
    html,
    text,
  });

  return true;
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
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

app.use(['/data', '/public/data', '/.git', '/__MACOSX'], (req, res) => {
  res.status(404).send('Not found');
});

const STATIC_OPTIONS = {
  dotfiles: 'deny',
  index: false,
  redirect: false,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', IS_PRODUCTION ? 'public, max-age=86400' : 'no-store');
  },
};
app.use('/public', express.static(path.join(__dirname, 'public'), STATIC_OPTIONS));
app.use(express.static(path.join(__dirname, 'public'), STATIC_OPTIONS));
app.use((req, res, next) => {
  res.locals.title = res.locals.title || 'Моя парковка';
  res.locals.bodyClass = res.locals.bodyClass || '';
  res.locals.user = req.session?.user || null;
  next();
});
app.use(async (req, res, next) => {
  if (!req.session?.user?.id) return next();

  try {
    const r = await dbQuery(
      `SELECT id, fio, phone, organization, position, role, is_is_admin, zones, assignable_zones, is_tenant_contact, parking_floors, parking_groups, parking_spots, preferred_routes, is_active, must_change_pin, pin_expires_at
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


function isPinChangeBypassRequest(req) {
  if (isStaticRequest(req)) return true;
  return req.path === '/login'
    || req.path === '/logout'
    || req.path === '/change-password'
    || req.path === '/health';
}

app.use((req, res, next) => {
  const user = req.session?.user || null;
  if (!user || !userNeedsPinChange(user) || isPinChangeBypassRequest(req)) return next();

  if (req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/api/')) {
    return res.status(428).json({ ok: false, error: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ РЎРѓР СР ВµР Р…Р С‘РЎвЂљРЎРЉ Р Р†РЎР‚Р ВµР СР ВµР Р…Р Р…РЎвЂ№Р в„– Р С—Р В°РЎР‚Р С•Р В»РЎРЉ.' });
  }

  return res.redirect(`/change-password?reason=${encodeURIComponent(pinChangeReason(user))}`);
});
app.use((req, res, next) => {
  const original = req.originalUrl || '';
  const rules = [
    { from: '/Р В°Р Т‘Р СР С‘Р Р…Р С‘РЎРѓРЎвЂљРЎР‚Р В°РЎвЂљР С•РЎР‚', to: '/admin' },
    { from: '/Р Р†Р С•Р в„–РЎвЂљР С‘ Р Р† РЎРѓР С‘РЎРѓРЎвЂљР ВµР СРЎС“', to: '/login' },
    { from: '/Р Р†РЎвЂ¦Р С•Р Т‘', to: '/login' },
    { from: '/Р Р†РЎвЂ№РЎвЂ¦Р С•Р Т‘', to: '/logout' },
    { from: '/Р Р†РЎвЂ№РЎвЂ¦Р С•Р Т‘ Р С‘Р В· РЎРѓР С‘РЎРѓРЎвЂљР ВµР СРЎвЂ№', to: '/logout' },
    { from: '/Р В¶РЎС“РЎР‚Р Р…Р В°Р В»', to: '/logs' },
  ];

  for (const r of rules) {
    if (original === r.from || original.startsWith(r.from + '/') || original.startsWith(encodeURI(r.from) + '/')) {
      const suffix = original.startsWith(r.from) ? original.slice(r.from.length) : original.slice(encodeURI(r.from).length);
      const newUrl = r.to + suffix;
      if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(302, newUrl);
      req.url = newUrl;
      return next();
    }
  }

  next();
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.engine('ejs', require('ejs').__express);

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
function formatMoscowDateTime(v) {
  if (!v) return '';
  const d = (v instanceof Date) ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);

  try {
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
    const pad = (n) => String(n).padStart(2, '0');
    const ms = d.getTime() + 3 * 60 * 60 * 1000;
    const u = new Date(ms);
    return `${pad(u.getUTCDate())}.${pad(u.getUTCMonth() + 1)}.${u.getUTCFullYear()} ${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())}:${pad(u.getUTCSeconds())}`;
  }
}

const RU_TRANSIT_EVENT = {
  open: 'Р С›РЎвЂљР С”РЎР‚РЎвЂ№РЎвЂљР С‘Р Вµ',
  close: 'Р вЂ”Р В°Р С”РЎР‚РЎвЂ№РЎвЂљР С‘Р Вµ',
  unlock: 'Р С›РЎвЂљР С”РЎР‚РЎвЂ№РЎвЂљР С‘Р Вµ',
  lock: 'Р вЂ”Р В°Р С”РЎР‚РЎвЂ№РЎвЂљР С‘Р Вµ',
  error: 'Р С›РЎв‚¬Р С‘Р В±Р С”Р В°',
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
      label: 'Р РЃР В»РЎР‹Р В· Р Р…Р Вµ Р Р…Р В°РЎРѓРЎвЂљРЎР‚Р С•Р ВµР Р…',
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
      label: ok ? 'Р РЃР В»РЎР‹Р В· Р С•Р Р…Р В»Р В°Р в„–Р Р…' : 'Р РЃР В»РЎР‹Р В· Р С•РЎвЂљР Р†Р ВµРЎвЂЎР В°Р ВµРЎвЂљ РЎРѓ Р С•РЎв‚¬Р С‘Р В±Р С”Р С•Р в„–',
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
      label: 'Р РЃР В»РЎР‹Р В· Р Р…Р ВµР Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р ВµР Р…',
      http_status: 0,
      elapsed_ms: Date.now() - started,
      error: e?.message || String(e),
    };
  }
}

async function loadAll() {
  return loadOperationsState({ dbQuery, mapAdminUser, decryptDeviceSecret });
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
  if (!list.length) return 'Р СџР С•Р С”Р В° Р Р…Р С‘РЎвЂЎР ВµР С–Р С• Р Р…Р Вµ Р С—Р С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С•';

  const names = list.map((device) => String(device?.name || '').trim()).filter(Boolean);
  const zoneKey = String(zoneId || '').trim().toLowerCase();
  const floorLabels = [...new Set(
    names
      .map((name) => {
        const match = name.match(/(\d+)\s*(?:РЎРЊРЎвЂљ|РЎРЊРЎвЂљР В°Р В¶)/iu);
        return match ? `${match[1]} РЎРЊРЎвЂљ.` : null;
      })
      .filter(Boolean)
  )].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  if (floorLabels.length) return `Р В­РЎвЂљР В°Р В¶Р С‘ ${floorLabels.join(', ')}`;

  const liftCount = names.filter((name) => /Р В»Р С‘РЎвЂћРЎвЂљ/iu.test(name)).length;
  const entranceCount = names.filter((name) => /Р Т‘Р Р†Р ВµРЎР‚|Р Р†РЎвЂ¦Р С•Р Т‘/iu.test(name)).length;
  if (zoneKey === 'pedestrian' && (liftCount || entranceCount)) {
    return 'Р вЂ™РЎвЂ¦Р С•Р Т‘РЎвЂ№ РЎРѓ 1 РЎРЊРЎвЂљР В°Р В¶Р В° Р С‘ Р В»Р С‘РЎвЂћРЎвЂљРЎвЂ№';
  }
  if (liftCount || entranceCount) {
    const parts = [];
    if (liftCount) parts.push(liftCount > 1 ? `${liftCount} Р В»Р С‘РЎвЂћРЎвЂљР В°` : 'Р В»Р С‘РЎвЂћРЎвЂљ');
    if (entranceCount) parts.push(entranceCount > 1 ? `${entranceCount} Р Р†РЎвЂ¦Р С•Р Т‘Р С•Р Р†` : 'Р Р†РЎвЂ¦Р С•Р Т‘');
    return parts.join(' Р С‘ ');
  }

  const entryCount = names.filter((name) => /Р Р†РЎР‰Р ВµР В·Р Т‘|Р В·Р В°Р ВµР В·Р Т‘/iu.test(name)).length;
  const exitCount = names.filter((name) => /Р Р†РЎвЂ№Р ВµР В·Р Т‘/iu.test(name)).length;
  if (zoneKey === 'buffer') return 'Р РЃР В»Р В°Р С–Р В±Р В°РЎС“Р СРЎвЂ№ РЎС“ РЎРѓР ВµР Р†Р ВµРЎР‚Р Р…Р С•Р С–Р С• Р Р†РЎР‰Р ВµР В·Р Т‘Р В°';
  if (zoneKey === 'transit') return 'Р В Р В°Р СР С—Р В° Р С‘ РЎв‚¬Р В»Р В°Р С–Р В±Р В°РЎС“Р СРЎвЂ№ Р Р…Р В° РЎРЊРЎРѓРЎвЂљР В°Р С”Р В°Р Т‘РЎС“';
  if (zoneKey === 'underground' && (entryCount || exitCount)) return 'Р вЂ™РЎР‰Р ВµР В·Р Т‘РЎвЂ№ Р Р† Р С—Р С•Р Т‘Р В·Р ВµР СР Р…РЎС“РЎР‹ РЎвЂЎР В°РЎРѓРЎвЂљРЎРЉ';
  if (zoneKey === 'overground' && (entryCount || exitCount)) return 'Р вЂ™РЎР‰Р ВµР В·Р Т‘РЎвЂ№ Р С‘ Р Р†РЎвЂ№Р ВµР В·Р Т‘РЎвЂ№ Р Р…Р В° Р Р…Р В°Р В·Р ВµР СР Р…Р С•Р С РЎС“РЎР‚Р С•Р Р†Р Р…Р Вµ';
  if (zoneKey === 'europlan' && (entryCount || exitCount)) return 'Р вЂ”Р В°Р ВµР В·Р Т‘ Р С‘ Р Р†РЎвЂ№Р ВµР В·Р Т‘ Р С—Р С• РЎРЊРЎвЂљР В°Р В¶Р В°Р С';
  if (entryCount || exitCount) {
    const parts = [];
    if (entryCount) parts.push(entryCount > 1 ? `${entryCount} Р Р†РЎР‰Р ВµР В·Р Т‘Р В°` : 'Р Р†РЎР‰Р ВµР В·Р Т‘');
    if (exitCount) parts.push(exitCount > 1 ? `${exitCount} Р Р†РЎвЂ№Р ВµР В·Р Т‘Р В°` : 'Р Р†РЎвЂ№Р ВµР В·Р Т‘');
    return parts.join(' Р С‘ ');
  }

  if (/РЎРѓР ВµР Р†Р ВµРЎР‚Р Р…РЎвЂ№Р в„– Р Р†РЎР‰Р ВµР В·Р Т‘|РЎР‚Р В°Р СР С—Р В°|РЎРЊРЎРѓРЎвЂљР В°Р С”Р В°Р Т‘/iu.test(String(zoneName || ''))) return 'Р РЃР В»Р В°Р С–Р В±Р В°РЎС“Р СРЎвЂ№ Р С‘ Р С—РЎР‚Р С•Р ВµР В·Р Т‘РЎвЂ№';

  return `${list.length} ${pluralRu(list.length, 'Р Р†Р В°РЎР‚Р С‘Р В°Р Р…РЎвЂљ', 'Р Р†Р В°РЎР‚Р С‘Р В°Р Р…РЎвЂљР В°', 'Р Р†Р В°РЎР‚Р С‘Р В°Р Р…РЎвЂљР С•Р Р†')}`;
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
  if (!raw) return 'Р СњР ВµРЎвЂљ РЎРѓРЎвЂљР В°РЎвЂљРЎС“РЎРѓР В°';
  if (raw === 'ok') return 'Р Р€РЎРѓР С—Р ВµРЎв‚¬Р Р…Р С•';
  if (raw === 'denied') return 'Р СњР ВµРЎвЂљ Р Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р В°';
  if (raw === 'disabled') return 'Р С›РЎвЂљР С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С•';
  if (raw.startsWith('gw_error:')) return 'Р С›РЎв‚¬Р С‘Р В±Р С”Р В° РЎв‚¬Р В»РЎР‹Р В·Р В°';
  return raw;
}

function buildDashboardTimeline(recentEvents) {
  const list = (Array.isArray(recentEvents) ? recentEvents : []).slice().reverse();
  const grouped = new Map();

  list.forEach((event) => {
    const dt = event?.datetime ? new Date(event.datetime) : null;
    if (!dt || Number.isNaN(dt.getTime())) return;
    const label = formatMoscowDateTime(dt).split(' ')[1]?.slice(0, 5) || 'РІР‚вЂќ';
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
      point: event?.point || 'РІР‚вЂќ',
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
const DEFAULT_ZONES = [
  { id: 'buffer',      name: 'Р РЋР ВµР Р†Р ВµРЎР‚Р Р…РЎвЂ№Р в„– Р Р†РЎР‰Р ВµР В·Р Т‘',         sort: 10 },
  { id: 'europlan',    name: 'Р В­РЎвЂљР В°Р В¶Р С‘ 2-9',              sort: 20 },
  { id: 'overground',  name: 'Р СњР В°Р В·Р ВµР СР Р…РЎвЂ№Р в„– РЎС“РЎР‚Р С•Р Р†Р ВµР Р…РЎРЉ',       sort: 30 },
  { id: 'pedestrian',  name: 'Р вЂ™РЎвЂ¦Р С•Р Т‘РЎвЂ№ Р С‘ Р В»Р С‘РЎвЂћРЎвЂљРЎвЂ№',          sort: 40 },
  { id: 'underground', name: 'Р СџР С•Р Т‘Р В·Р ВµР СР Р…РЎвЂ№Р в„– РЎС“РЎР‚Р С•Р Р†Р ВµР Р…РЎРЉ',      sort: 50 },
  { id: 'transit',     name: 'Р В Р В°Р СР С—Р В° Р Р…Р В° РЎРЊРЎРѓРЎвЂљР В°Р С”Р В°Р Т‘РЎС“',      sort: 60 },
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
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([id, v]) => ({ id, ...(v || {}) }));
  }
  return [];
}

async function seedDevicesFromJson() {
  try {
    const c = await dbQuery('SELECT COUNT(*)::int AS c FROM public.devices');
    if ((c.rows?.[0]?.c ?? 0) > 0) return;
  } catch (e) {
    console.error('seedDevicesFromJson: COUNT(*) failed', e?.message || e);
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
  if (!list.length) {
    if (!ALLOW_REFERENCE_DEVICE_SEED) {
      console.warn('devices.json Р С—РЎС“РЎРѓРЎвЂљР С•Р в„–/Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р… РІР‚вЂќ РЎР‚Р ВµРЎвЂћР ВµРЎР‚Р ВµР Р…РЎРѓР Р…РЎвЂ№Р Вµ РЎС“РЎРѓРЎвЂљРЎР‚Р С•Р в„–РЎРѓРЎвЂљР Р†Р В° Р Р…Р Вµ РЎРѓР С•Р В·Р Т‘Р В°РЎР‹РЎвЂљРЎРѓРЎРЏ Р Р† production. Р вЂќР С•Р В±Р В°Р Р†РЎРЉРЎвЂљР Вµ РЎР‚Р ВµР В°Р В»РЎРЉР Р…РЎвЂ№Р Вµ РЎС“РЎРѓРЎвЂљРЎР‚Р С•Р в„–РЎРѓРЎвЂљР Р†Р В° РЎвЂЎР ВµРЎР‚Р ВµР В· Р В°Р Т‘Р СР С‘Р Р…Р С”РЎС“ Р С‘Р В»Р С‘ Р С‘Р СР С—Р С•РЎР‚РЎвЂљ.');
      return;
    }
    console.log('РІвЂћв„–РїС‘РЏ devices.json Р С—РЎС“РЎРѓРЎвЂљР С•Р в„–/Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р… РІР‚вЂќ РЎРѓР С•Р В·Р Т‘Р В°РЎР‹ РЎР‚Р ВµРЎвЂћР ВµРЎР‚Р ВµР Р…РЎРѓР Р…РЎвЂ№Р в„– Р Р…Р В°Р В±Р С•РЎР‚ РЎС“РЎРѓРЎвЂљРЎР‚Р С•Р в„–РЎРѓРЎвЂљР Р† Р Т‘Р В»РЎРЏ Р В»Р С•Р С”Р В°Р В»РЎРЉР Р…Р С•Р в„– Р С—РЎР‚Р С•Р Р†Р ВµРЎР‚Р С”Р С‘');
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
    password: password ? encryptDeviceSecret(password) : '',
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
        const pwd = d.password ? encryptDeviceSecret(d.password) : (u.password ? encryptDeviceSecret(u.password) : null);
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

  const secretRows = await dbQuery("SELECT id, password FROM public.devices WHERE COALESCE(password,'') <> ''");
  for (const d of secretRows.rows || []) {
    const stored = String(d.password || '');
    if (stored && !stored.startsWith(DEVICE_SECRET_PREFIX)) {
      await dbQuery('UPDATE public.devices SET password=$2, updated_at=NOW() WHERE id=$1', [d.id, encryptDeviceSecret(stored)]);
    }
  }
}

function isIsAdminRequired(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.redirect('/');
  if (!req.session.user.is_is_admin) return res.redirect('/admin/users');
  next();
}
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
  getStartPinExpiresAt,
  userNeedsPinChange,
  pinChangeReason,
  validateNewPin,
  pinMinLength: PIN_MIN_LENGTH,
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
  getStartPinExpiresAt,
  startPinTtlHours: START_PIN_TTL_HOURS,
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
  const fio = process.env.ADMIN_FIO || 'Р С’Р Т‘Р СР С‘Р Р…Р С‘РЎРѓРЎвЂљРЎР‚Р В°РЎвЂљР С•РЎР‚';
  await dbQuery(
    `INSERT INTO public.users(id,fio,phone,organization,position,pin,role,is_is_admin,zones,is_active,must_change_pin,pin_created_at,pin_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,'admin',true,$7,true,true,NOW(),$8)
     ON CONFLICT (id) DO NOTHING`,
    [id, fio, adminPhone, null, null, await hashPin(adminPin), [], getStartPinExpiresAt()]
  );

  console.log('РІСљвЂ¦ Р РЋР С•Р В·Р Т‘Р В°Р Р… Р В°Р Т‘Р СР С‘Р Р… Р С—Р С• РЎС“Р СР С•Р В»РЎвЂЎР В°Р Р…Р С‘РЎР‹:', adminPhone);
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
    `INSERT INTO public.users(id,fio,phone,email,organization,position,pin,role,is_is_admin,zones,assignable_zones,is_tenant_contact,parking_floors,parking_groups,parking_spots,preferred_routes,is_active,must_change_pin,pin_changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,false,NOW())
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
      fio: 'Р С’Р Т‘Р СР С‘Р Р…Р С‘РЎРѓРЎвЂљРЎР‚Р В°РЎвЂљР С•РЎР‚ РЎРѓР СР ВµР Р…РЎвЂ№',
      phone: '79000000010',
      pin: 'RuntimeAdminLite1234',
      role: 'admin',
      is_is_admin: false,
      zones: ['europlan', 'pedestrian', 'buffer', 'overground'],
      assignable_zones: ['europlan', 'pedestrian', 'buffer', 'overground'],
      organization: 'Р СљР С•РЎРЏ Р С—Р В°РЎР‚Р С”Р С•Р Р†Р С”Р В°',
      position: 'Р С’Р Т‘Р СР С‘Р Р…Р С‘РЎРѓРЎвЂљРЎР‚Р В°РЎвЂљР С•РЎР‚',
    },
    {
      id: 'demo-dispatcher',
      fio: 'Р вЂќР С‘РЎРѓР С—Р ВµРЎвЂљРЎвЂЎР ВµРЎР‚ Р С—Р В°РЎР‚Р С”Р С•Р Р†Р С”Р С‘',
      phone: '79000000020',
      pin: 'RuntimeDispatch1234',
      role: 'dispatcher',
      is_is_admin: false,
      zones: ['pedestrian', 'buffer', 'europlan', 'overground', 'underground', 'transit'],
      assignable_zones: null,
      is_tenant_contact: true,
      organization: 'Р СљР С•РЎРЏ Р С—Р В°РЎР‚Р С”Р С•Р Р†Р С”Р В°',
      position: 'Р вЂќР С‘РЎРѓР С—Р ВµРЎвЂљРЎвЂЎР ВµРЎР‚',
    },
    {
      id: 'demo-tenant-europlan',
      fio: 'Р С’РЎР‚Р ВµР Р…Р Т‘Р В°РЎвЂљР С•РЎР‚ 7 РЎРЊРЎвЂљР В°Р В¶Р В°',
      phone: '79000000030',
      pin: 'RuntimeEuro1234',
      role: 'user',
      is_is_admin: false,
      zones: ['europlan'],
      assignable_zones: null,
      organization: 'Р РЋР ВµР С”РЎвЂ Р С‘РЎРЏ 7A',
      position: 'Р С’РЎР‚Р ВµР Р…Р Т‘Р В°РЎвЂљР С•РЎР‚',
      parking_floors: ['7'],
      parking_groups: ['Р РЋР ВµР С”РЎвЂ Р С‘РЎРЏ 7A'],
      parking_spots: ['7-124', '7-125'],
      preferred_routes: ['7 РЎРЊРЎвЂљР В°Р В¶', 'Р Р†РЎР‰Р ВµР В·Р Т‘', 'Р Р†РЎвЂ№Р ВµР В·Р Т‘'],
    },
    {
      id: 'demo-tenant-pedestrian',
      fio: 'Р С’РЎР‚Р ВµР Р…Р Т‘Р В°РЎвЂљР С•РЎР‚ Р СџР ВµРЎв‚¬Р ВµРЎвЂ¦Р С•Р Т‘Р Р…РЎвЂ№Р в„– Р Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—',
      phone: '79000000031',
      pin: 'RuntimeWalk1234',
      role: 'user',
      is_is_admin: false,
      zones: ['pedestrian'],
      assignable_zones: null,
      organization: 'Р вЂР В°РЎв‚¬Р Р…РЎРЏ Р С’',
      position: 'Р С’РЎР‚Р ВµР Р…Р Т‘Р В°РЎвЂљР С•РЎР‚',
      parking_floors: ['7'],
      parking_groups: ['Р вЂєР С•Р В±Р В±Р С‘ Р С’'],
      parking_spots: ['Р вЂєР С‘РЎвЂћРЎвЂљ 1'],
      preferred_routes: ['Р В»Р С‘РЎвЂћРЎвЂљРЎвЂ№', 'Р Т‘Р Р†Р ВµРЎР‚Р С‘'],
    },
    {
      id: 'demo-tenant-drive',
      fio: 'Р С’РЎР‚Р ВµР Р…Р Т‘Р В°РЎвЂљР С•РЎР‚ Р СњР В°Р В·Р ВµР СР Р…РЎвЂ№Р в„– Р СР В°РЎР‚РЎв‚¬РЎР‚РЎС“РЎвЂљ',
      phone: '79000000032',
      pin: 'RuntimeDrive1234',
      role: 'user',
      is_is_admin: false,
      zones: ['buffer', 'overground'],
      assignable_zones: null,
      organization: 'Р СџР В°РЎР‚Р С”Р С‘Р Р…Р С– Р РЋР ВµР Р†Р ВµРЎР‚',
      position: 'Р С’РЎР‚Р ВµР Р…Р Т‘Р В°РЎвЂљР С•РЎР‚',
      parking_floors: ['2'],
      parking_groups: ['Р РЋР ВµР С”РЎвЂљР С•РЎР‚ B2'],
      parking_spots: ['B2-07'],
      preferred_routes: ['Р Р†РЎР‰Р ВµР В·Р Т‘РЎвЂ№', 'Р Р†РЎвЂ№Р ВµР В·Р Т‘РЎвЂ№'],
    },
    {
      id: 'demo-tenant-underground',
      fio: 'Р С’РЎР‚Р ВµР Р…Р Т‘Р В°РЎвЂљР С•РЎР‚ Р СџР С•Р Т‘Р В·Р ВµР СР Р…РЎвЂ№Р в„– Р СР В°РЎР‚РЎв‚¬РЎР‚РЎС“РЎвЂљ',
      phone: '79000000033',
      pin: 'RuntimeUnderground1234',
      role: 'user',
      is_is_admin: false,
      zones: ['underground', 'transit'],
      assignable_zones: null,
      organization: 'Р СџР В°РЎР‚Р С”Р С‘Р Р…Р С– Р В®Р С–',
      position: 'Р С’РЎР‚Р ВµР Р…Р Т‘Р В°РЎвЂљР С•РЎР‚',
      parking_floors: ['2'],
      parking_groups: ['Р РЋР ВµР С”РЎвЂљР С•РЎР‚ P2'],
      parking_spots: ['P2-18'],
      preferred_routes: ['РЎв‚¬Р В»Р В°Р С–Р В±Р В°РЎС“Р СРЎвЂ№', 'Р Р†РЎР‰Р ВµР В·Р Т‘РЎвЂ№'],
    },
  ];

  const created = [];
  for (const spec of demoUsers) {
    if (await ensureDemoUser(spec)) created.push(spec.phone);
  }

  if (created.length) {
    console.log('РІСљвЂ¦ Р РЋР С•Р В·Р Т‘Р В°Р Р…РЎвЂ№ Р Т‘Р ВµР СР С•-Р С—Р С•Р В»РЎРЉР В·Р С•Р Р†Р В°РЎвЂљР ВµР В»Р С‘:', created.join(', '));
  }
}

(async () => {
  try {
    if (!isDevDb && !databaseUrlConfigured) {
      throw new Error('DATABASE_URL/PG_URL must be set. For local demo use DEV_MEMORY_DB=true.');
    }
    await ensureSchema();
    await ensureDefaultZones();
    await seedDevicesFromJson();
    await ensureExtraSecuritySchema();
    await ensureDefaultAdmin();
    await ensureDemoUsers();
    await loadAll();
  } catch (e) {
    console.error('DB init error:', e);
    if (!ALLOW_DB_INIT_FAILURE) {
      console.error('Startup aborted: database initialization failed. Set DEV_MEMORY_DB=true for local demo mode.');
      process.exit(1);
    }
  }

  app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
   console.log(`РІСљвЂ¦ Р СљР С•РЎРЏ Р С—Р В°РЎР‚Р С”Р С•Р Р†Р С”Р В° Р В·Р В°Р С—РЎС“РЎвЂ°Р ВµР Р…: http://127.0.0.1:${PORT}`);
  });
})();
