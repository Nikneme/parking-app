'use strict';

const http = require('http');

const port = Number(process.env.MOCK_GATEWAY_PORT || 9090);
const host = process.env.MOCK_GATEWAY_HOST || '127.0.0.1';
const expectedKey = String(process.env.GATEWAY_KEY || 'dev-gateway-key');
const failIds = new Set(String(process.env.MOCK_GATEWAY_FAIL_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));
const events = [];

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    send(res, 200, { ok: true, service: 'mock-gateway', events: events.length });
    return;
  }

  if (req.method === 'GET' && req.url === '/events') {
    send(res, 200, { ok: true, events });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/open') {
    send(res, 404, { ok: false, error: 'not found' });
    return;
  }

  if (expectedKey && req.headers['x-gateway-key'] !== expectedKey) {
    send(res, 401, { ok: false, error: 'bad gateway key' });
    return;
  }

  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const deviceId = String(body.deviceId || '').trim();
    const action = String(body.action || 'open').trim();
    const requestId = String(body.requestId || '').trim();

    if (!deviceId) {
      send(res, 400, { ok: false, error: 'deviceId is required' });
      return;
    }

    const event = {
      datetime: new Date().toISOString(),
      requestId: requestId || null,
      deviceId,
      action,
      contractVersion: body.contractVersion || null,
      hasDeviceSnapshot: !!body.device,
      ok: !failIds.has(deviceId),
    };
    events.push(event);

    if (!event.ok) {
      send(res, 504, { ok: false, requestId: requestId || null, error: 'emulated timeout', deviceId, action });
      return;
    }

    send(res, 200, { ok: true, requestId: requestId || null, emulated: true, deviceId, action });
  } catch (error) {
    send(res, 400, { ok: false, error: error.message || String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`Mock gateway: http://${host}:${port}`);
  console.log(`Use with: GATEWAY_BASE_URL=http://${host}:${port} GATEWAY_KEY=${expectedKey} node server.js`);
});
