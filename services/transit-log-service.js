'use strict';

function createTransitLogService(options = {}) {
  const {
    dbQuery,
    fs,
    fallbackLogPath,
    allowFileTransitFallback = false,
  } = options;

  async function appendTransitEvent({ point, event, source, result, session: sessionId, actor, requestId, details }) {
    const entry = {
      datetime: new Date().toISOString(),
      point: point ?? null,
      event: event ?? null,
      source: source ?? null,
      result: result ?? null,
      session: sessionId ?? null,
      actor_id: actor?.id ?? null,
      actor_phone: actor?.phone ?? null,
      actor_fio: actor?.fio ?? null,
      actor_organization: actor?.organization ?? null,
      actor_position: actor?.position ?? null,
      request_id: requestId ?? null,
      details: details ?? null,
    };

    try {
      await dbQuery(
        `INSERT INTO public.transit_events(
            datetime, point, event, source, result, session,
            actor_id, actor_phone, actor_fio, actor_organization, actor_position,
            request_id, details
         )
         VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          entry.point,
          entry.event,
          entry.source || null,
          entry.result || null,
          entry.session || null,
          entry.actor_id || null,
          entry.actor_phone || null,
          entry.actor_fio || null,
          entry.actor_organization || null,
          entry.actor_position || null,
          entry.request_id || null,
          entry.details ? JSON.stringify(entry.details) : null,
        ]
      );
      return;
    } catch (error) {
      if (!allowFileTransitFallback) {
        console.error('вљ пёЏ transit log write failed and file fallback is disabled:', error?.message || error);
        return;
      }
      try {
        fs.mkdirSync(require('path').dirname(fallbackLogPath), { recursive: true });
        fs.appendFileSync(fallbackLogPath, JSON.stringify(entry) + '\n', 'utf-8');
      } catch (_) {
      }
      console.error('вљ пёЏ transit log write failed:', error?.message || error);
    }
  }

  function readFallbackTransitEvents(limit = 500) {
    if (!allowFileTransitFallback) return [];
    try {
      if (!fs.existsSync(fallbackLogPath)) return [];
      const raw = fs.readFileSync(fallbackLogPath, 'utf-8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const tail = lines.slice(Math.max(0, lines.length - limit));
      const items = [];
      for (const line of tail) {
        try {
          items.push(JSON.parse(line));
        } catch {
        }
      }
      items.sort((a, b) => String(b.datetime || '').localeCompare(String(a.datetime || '')));
      return items;
    } catch {
      return [];
    }
  }

  function normalizeTransitEvent(row) {
    const out = { ...(row || {}) };
    if (typeof out.details === 'string') {
      try {
        out.details = JSON.parse(out.details);
      } catch {
        out.details = null;
      }
    }
    if (!out.details || typeof out.details !== 'object') out.details = null;
    out.device_id = out.device_id || out.details?.deviceId || null;
    out.zone_id = out.zone_id || out.details?.zoneId || null;
    return out;
  }

  async function loadRecentTransitEvents(limit = 5) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
    try {
      const result = await dbQuery(
        `SELECT datetime,
                to_char(datetime AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY HH24:MI:SS') AS datetime_msk,
                point, event, source, result, session, request_id, details,
                actor_fio, actor_phone, actor_organization, actor_position
         FROM public.transit_events
         ORDER BY datetime DESC
         LIMIT ${safeLimit}`
      );
      return (result.rows || []).map(normalizeTransitEvent);
    } catch {
      return readFallbackTransitEvents(safeLimit).map(normalizeTransitEvent);
    }
  }

  return {
    appendTransitEvent,
    readFallbackTransitEvents,
    normalizeTransitEvent,
    loadRecentTransitEvents,
  };
}

module.exports = {
  createTransitLogService,
};
