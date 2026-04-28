'use strict';

const crypto = require('crypto');

function registerDashboardRoutes({
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
  dispatcherPhone,
}) {
  app.get('/', authRequired, async (req, res) => {
    const state = await loadAll();
    const user = req.session.user;
    const { byZone, accessibleDevices } = buildDashboardAccess(state, user);
    const recentEvents = filterDashboardEvents(byZone, await loadRecentTransitEvents(24));
    const zoneSummary = buildZoneSummary(byZone, recentEvents);
    const supportContact = buildDashboardSupportContact(state.users, dispatcherPhone);

    res.render('dashboard', {
      title: 'Parking GIT',
      bodyClass: 'dash-page',
      user,
      byZone,
      dashboardStats: buildDashboardStats(byZone, accessibleDevices, recentEvents),
      dashboardDevices: accessibleDevices,
      recentEvents,
      zoneSummary,
      dashboardTimeline: buildDashboardTimeline(recentEvents),
      dashboardAttention: buildAttentionEvents(recentEvents),
      supportContact,
    });
  });

  app.get('/api/gateway/status', authRequired, async (req, res) => {
    const status = await getGatewayStatus();
    res.status(status.ok ? 200 : 503).json(status);
  });

  app.get('/api/dashboard/live', authRequired, async (req, res) => {
    const state = await loadAll();
    const { byZone, accessibleDevices } = buildDashboardAccess(state, req.session.user);
    const recentEvents = filterDashboardEvents(byZone, await loadRecentTransitEvents(24));
    const gateway = await getGatewayStatus();

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      gateway,
      stats: buildDashboardStats(byZone, accessibleDevices, recentEvents),
      zones: buildZoneSummary(byZone, recentEvents),
      recentEvents: recentEvents.map(clientTransitEvent),
      timeline: buildDashboardTimeline(recentEvents),
      attentionEvents: buildAttentionEvents(recentEvents),
    });
  });

  app.post('/api/open/:deviceId', authRequired, async (req, res) => {
    const deviceId = String(req.params.deviceId);
    const requestId = crypto.randomUUID();
    const { zones, devices } = await loadAll();
    const user = req.session.user;
    const actor = {
      id: user.id,
      phone: user.phone,
      fio: user.fio,
      organization: user.organization,
      position: user.position,
      role: user.role,
      is_is_admin: user.is_is_admin,
    };

    const device = devices[deviceId];
    if (!device || device.is_active === false) {
      return res.status(404).json({ ok: false, requestId, reason: 'missing', error: 'Устройство не найдено', deviceName: deviceId, zoneName: null });
    }

    const zoneName = zones[device.zoneId]?.name || null;
    if (device.enabled === false) {
      await appendTransitEvent({
        point: device.name || deviceId,
        event: 'open',
        source: user.phone || user.id,
        result: 'disabled',
        session: String(req.sessionID || ''),
        actor,
        requestId,
        details: { status: 'disabled', deviceId, zoneId: device.zoneId },
      });
      return res.status(409).json({ ok: false, requestId, reason: 'disabled', error: 'Устройство отключено', deviceName: device.name || deviceId, zoneName });
    }

    const allowed = (user.role === 'admin') || (Array.isArray(user.zones) && user.zones.includes(device.zoneId));
    if (!allowed) {
      await appendTransitEvent({
        point: device.name || deviceId,
        event: 'open',
        source: user.phone || user.id,
        result: 'denied',
        session: String(req.sessionID || ''),
        actor,
        requestId,
        details: { status: 'denied', deviceId, zoneId: device.zoneId },
      });
      return res.status(403).json({ ok: false, requestId, reason: 'denied', error: 'Нет доступа', deviceName: device.name || deviceId, zoneName });
    }

    const point = zoneName ? `${device.name || deviceId} — ${zoneName}` : (device.name || deviceId);
    const command = {
      requestId,
      action: 'open',
      deviceId,
      zoneId: device.zoneId,
      startedAt: new Date().toISOString(),
    };

    const gatewayResult = await gatewayOpen({
      requestId,
      device: { ...device, id: deviceId },
      action: command.action,
      actor,
      sessionId: String(req.sessionID || ''),
    });
    command.finishedAt = new Date().toISOString();
    command.status = gatewayResult.ok ? 'ok' : 'gateway_error';
    command.elapsed_ms = gatewayResult.elapsed_ms;

    await appendTransitEvent({
      point,
      event: 'open',
      source: user.phone || user.id,
      result: gatewayResult.ok ? 'ok' : `gw_error:${gatewayResult.http_status || 0}`,
      session: String(req.sessionID || ''),
      actor,
      requestId,
      details: {
        requestId,
        status: command.status,
        deviceId,
        zoneId: device.zoneId,
        gateway: {
          http_status: gatewayResult.http_status,
          elapsed_ms: gatewayResult.elapsed_ms,
          error: gatewayResult.error || null,
        },
      },
    });

    await appendAudit(req, 'open', 'device', deviceId, { requestId, zoneId: device.zoneId, command, gw: gatewayResult });

    if (!gatewayResult.ok) {
      return res.status(502).json({ ok: false, requestId, reason: 'gateway', error: 'Шлюз недоступен/ошибка', deviceName: device.name || deviceId, zoneName, ...gatewayResult });
    }

    return res.json({ ok: true, requestId, reason: 'ok', deviceName: device.name || deviceId, zoneName, ...gatewayResult });
  });
}

module.exports = {
  registerDashboardRoutes,
};
