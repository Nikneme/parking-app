'use strict';

const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function maskValue(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 6) return '***';
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}

function envStatus(name, secret = false) {
  const exists = Object.prototype.hasOwnProperty.call(process.env, name) && String(process.env[name] || '').trim() !== '';
  return {
    name,
    configured: exists,
    value: exists && !secret ? String(process.env[name]) : undefined,
    masked: exists && secret ? maskValue(process.env[name]) : undefined,
  };
}

function listRuntimeFiles() {
  const names = ['server.js', 'db.js', 'dev-db.js', 'package.json', 'package-lock.json', 'devices.example.json'];
  return names.filter((name) => fs.existsSync(path.join(process.cwd(), name)));
}

function main() {
  const pkg = readJson(path.join(process.cwd(), 'package.json'), {});
  const outputDir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(outputDir, { recursive: true });

  const inventory = {
    generated_at: new Date().toISOString(),
    project: {
      name: pkg.name || 'unknown',
      version: pkg.version || 'unknown',
      node: process.version,
      environment: process.env.NODE_ENV || 'development',
    },
    repository: {
      source_of_truth: 'Git repository controlled by the customer',
      required_branch_policy: 'production code must be committed before deployment',
      files: listRuntimeFiles(),
    },
    runtime: {
      start_command: pkg.scripts?.start || 'node server.js',
      healthcheck: '/health',
      public_static_dir: 'public',
      blocked_public_paths: ['/data', '/public/data', '/.git', '/__MACOSX'],
    },
    environment_variables: [
      envStatus('NODE_ENV'),
      envStatus('PORT'),
      envStatus('APP_BASE_URL'),
      envStatus('DATABASE_URL', true),
      envStatus('PG_URL', true),
      envStatus('PGSSL'),
      envStatus('SESSION_SECRET', true),
      envStatus('DEVICE_SECRET_ENCRYPTION_KEY', true),
      envStatus('ADMIN_PHONE', true),
      envStatus('ADMIN_PIN', true),
      envStatus('ADMIN_FIO'),
      envStatus('GATEWAY_BASE_URL'),
      envStatus('GATEWAY_KEY', true),
      envStatus('GATEWAY_TIMEOUT_MS'),
      envStatus('GATEWAY_SEND_DEVICE_SECRETS'),
      envStatus('START_PIN_TTL_HOURS'),
      envStatus('PIN_MIN_LENGTH'),
      envStatus('LOGIN_RATE_WINDOW_MS'),
      envStatus('LOGIN_RATE_MAX'),
      envStatus('LOGIN_IP_RATE_MAX'),
      envStatus('LOGIN_PHONE_RATE_MAX'),
      envStatus('SMTP_HOST'),
      envStatus('SMTP_PORT'),
      envStatus('SMTP_SECURE'),
      envStatus('SMTP_USER', true),
      envStatus('SMTP_PASS', true),
      envStatus('MAIL_FROM'),
      envStatus('ALLOW_FILE_TRANSIT_FALLBACK'),
      envStatus('ALLOW_REFERENCE_DEVICE_SEED'),
      envStatus('ALLOW_DEMO_ARTIFACTS'),
    ],
    dependencies: pkg.dependencies || {},
    scripts: pkg.scripts || {},
    external_integrations: [
      { name: 'PostgreSQL', env: ['DATABASE_URL', 'PG_URL'], required_in_production: true },
      { name: 'Gateway/controllers API', env: ['GATEWAY_BASE_URL', 'GATEWAY_KEY'], required_for_device_opening: true },
      { name: 'SMTP', env: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'], required_for_email_notifications: false },
      { name: 'Domain/DNS/SSL', expected_domain: 'moyaparkovka.ru', required_in_production: true },
    ],
  };

  const out = path.join(outputDir, 'ops-inventory.json');
  fs.writeFileSync(out, JSON.stringify(inventory, null, 2));
  console.log(out);
}

main();
