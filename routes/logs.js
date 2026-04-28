'use strict';

function registerLogsRoutes({
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
}) {
  app.use((req, res, next) => {
    if (req.path === '/logs' || req.path === '/logs.csv') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  app.get('/logs', requirePermission('logs.view'), async (req, res) => {
    const user = req.session.user;
    const filters = parseTransitLogFilters(req.query);
    const { whereSql, args } = buildTransitLogWhere(filters);

    let logs = [];
    let points = [];
    let events = [];
    let results = [];

    try {
      const result = await dbQuery(
        `SELECT datetime,
                to_char(datetime AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY HH24:MI:SS') AS datetime_msk,
                point, event, source, result, session, request_id, details,
                actor_fio, actor_phone, actor_organization, actor_position
         FROM public.transit_events
         ${whereSql}
         ORDER BY datetime DESC
         LIMIT 500`,
        args
      );
      logs = result.rows;

      const pts = await dbQuery(`SELECT DISTINCT point FROM public.transit_events ORDER BY point ASC LIMIT 200`);
      const evs = await dbQuery(`SELECT DISTINCT event FROM public.transit_events ORDER BY event ASC LIMIT 200`);
      const resu = await dbQuery(`SELECT DISTINCT result FROM public.transit_events ORDER BY result ASC LIMIT 200`);
      points = pts.rows.map((item) => item.point).filter(Boolean);
      events = evs.rows.map((item) => item.event).filter(Boolean);
      results = resu.rows.map((item) => item.result).filter(Boolean);
    } catch (error) {
      const all = readFallbackTransitEvents(2000);
      const filtered = all.filter((item) => transitEventMatchesFilters(item, filters));

      logs = filtered.slice(0, 500).map((item) => ({ ...item, datetime_msk: formatMoscowDateTime(item.datetime) }));
      points = Array.from(new Set(all.map((item) => item.point).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b)));
      events = Array.from(new Set(all.map((item) => item.event).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b)));
      results = Array.from(new Set(all.map((item) => item.result).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b)));

      console.warn('⚠️ /logs using fallback file because DB query failed:', error?.message || error);
    }

    res.render('logs', {
      title: 'Журнал проходов и проездов',
      bodyClass: 'page-logs',
      user,
      logs,
      logSummary: buildTransitLogSummary(logs),
      quickLinks: buildTransitLogQuickLinks(filters),
      filters,
      options: { points, events, results },
      exportUrlBase: buildTransitLogUrl('/logs.csv', filters),
    });
  });

  app.get('/logs.csv', requirePermission('logs.view'), async (req, res) => {
    let rows = [];
    try {
      const filters = parseTransitLogFilters(req.query);
      const { whereSql, args } = buildTransitLogWhere(filters);

      const result = await dbQuery(
        `SELECT datetime,
                to_char(datetime AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY') AS date_msk,
                to_char(datetime AT TIME ZONE 'Europe/Moscow', 'HH24:MI:SS') AS time_msk,
                point, event, source, result, session, request_id, details,
                actor_fio, actor_phone, actor_organization, actor_position
         FROM public.transit_events
         ${whereSql}
         ORDER BY datetime DESC`,
        args
      );

      rows = result.rows;
    } catch (error) {
      const filters = parseTransitLogFilters(req.query);
      rows = readFallbackTransitEvents(1000000)
        .filter((item) => transitEventMatchesFilters(item, filters))
        .map((item) => ({ ...item, datetime_msk: formatMoscowDateTime(item.datetime) }));
      console.warn('⚠️ /logs.csv using fallback file because DB query failed:', error?.message || error);
    }

    const sep = ';';
    const header = ['Дата/время (МСК)', 'Что открывали', 'Событие', 'ФИО', 'Телефон', 'Организация', 'Должность', 'Источник', 'Результат', 'Команда', 'Сессия'];
    const lines = [header.join(sep)];
    rows.forEach((log) => {
      const esc = (value) => {
        const source = String(value ?? '');
        const escaped = source.replace(/"/g, '""');
        return /[";\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
      };

      const dtMsk = log.datetime_msk || formatMoscowDateTime(log.datetime);
      const evRu = ruTransitEvent(log.event);
      lines.push([
        dtMsk,
        log.point,
        evRu,
        (log.actor_fio || '').trim(),
        log.actor_phone,
        log.actor_organization,
        log.actor_position,
        log.source,
        log.result,
        log.request_id,
        log.session,
      ].map(esc).join(sep));
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="transit_log.csv"');
    res.send('\ufeff' + lines.join('\n'));
  });

  app.post('/logs/clear', requirePermission('users.manage'), async (req, res) => {
    try {
      await dbQuery('TRUNCATE TABLE public.transit_events');
      await appendAudit(req, 'clear_transit_log', 'transit_events', '*', {});
    } catch (error) {
      console.error('clear_transit_log error', error);
    }

    clearFallbackTransitLog();
    return res.redirect('/logs');
  });
}

module.exports = {
  registerLogsRoutes,
};
