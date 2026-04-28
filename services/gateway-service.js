'use strict';

const axios = require('axios');

function createGatewayService(options = {}) {
  const {
    gatewayBaseUrl = '',
    gatewayKey = '',
    gatewayTimeoutMs = 7000,
    includeDeviceSecrets = false,
  } = options;

  function publicDeviceSnapshot(device) {
    const snapshot = {
      id: device?.id || '',
      name: device?.name || '',
      zoneId: device?.zoneId || device?.zone_id || '',
      type: device?.type || 'http',
      method: device?.method || 'POST',
      url: device?.url || '',
      ip: device?.ip || null,
      relay: device?.relay ?? null,
      auth_type: device?.auth_type || 'none',
      username: device?.username ? String(device.username) : '',
      has_password: !!device?.password,
    };

    if (includeDeviceSecrets) {
      snapshot.password = device?.password || '';
    }

    return snapshot;
  }

  async function gatewayOpen({ requestId, device, action = 'open', actor, sessionId }) {
    if (!gatewayBaseUrl || !gatewayKey) {
      return {
        ok: false,
        code: 'GATEWAY_NOT_CONFIGURED',
        http_status: 0,
        error: 'GATEWAY_BASE_URL/GATEWAY_KEY not configured',
        elapsed_ms: 0,
      };
    }

    const payload = {
      contractVersion: 1,
      requestId,
      deviceId: device?.id,
      action,
      issuedAt: new Date().toISOString(),
      session: sessionId || null,
      actor: actor ? {
        id: actor.id || null,
        role: actor.role || null,
        is_is_admin: !!actor.is_is_admin,
      } : null,
      device: publicDeviceSnapshot(device),
    };

    const url = `${gatewayBaseUrl}/api/open`;
    const started = Date.now();
    try {
      const response = await axios.post(url, payload, {
        timeout: gatewayTimeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Key': gatewayKey,
        },
        validateStatus: () => true,
      });

      return {
        ok: response.status >= 200 && response.status < 300 && response.data?.ok !== false,
        request_id: requestId,
        http_status: response.status,
        data: response.data,
        elapsed_ms: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        request_id: requestId,
        http_status: 0,
        error: error?.message || String(error),
        elapsed_ms: Date.now() - started,
      };
    }
  }

  return {
    publicDeviceSnapshot,
    gatewayOpen,
  };
}

module.exports = {
  createGatewayService,
};
