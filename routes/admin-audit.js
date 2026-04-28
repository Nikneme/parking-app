'use strict';

function registerAdminAuditRoutes({
  app,
  isIsAdminRequired,
  requirePermission,
  dbQuery,
  formatMoscowDateTime,
  parseAuditFilters,
  buildAuditWhere,
}) {
  app.get('/admin/audit', isIsAdminRequired, async (req, res) => {
    const filters = parseAuditFilters(req.query);
    const { whereSql, args } = buildAuditWhere(filters);

    const result = await dbQuery(
      `SELECT a.ts,
              to_char(a.ts AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY HH24:MI:SS') AS ts_msk,
              a.actor_id, a.actor_phone, a.actor_fio, a.actor_organization, a.actor_position,
              a.action, a.target_type, a.target_id, a.details, a.ip, a.ua,
              z.name as zone_name
       FROM public.audit a
       LEFT JOIN public.zones z ON z.id = (a.details->>'zoneId')
       ${whereSql}
       ORDER BY a.ts DESC
       LIMIT 500`,
      args
    );

    const entries = result.rows.map((entry) => ({
      ts: entry.ts,
      tsMsk: entry.ts_msk || formatMoscowDateTime(entry.ts),
      actorId: entry.actor_id,
      actorPhone: entry.actor_phone,
      actorFio: entry.actor_fio,
      actorOrganization: entry.actor_organization,
      actorPosition: entry.actor_position,
      action: entry.action,
      targetType: entry.target_type,
      targetId: entry.target_id,
      details: (() => {
        if (!entry.details) return null;
        if (typeof entry.details === 'string') {
          try { return JSON.parse(entry.details); } catch { return entry.details; }
        }
        return entry.details;
      })(),
      ip: entry.ip,
      ua: entry.ua,
    }));

    const csvUrl = '/admin/audit.csv' + (
      (filters.date_from || filters.date_to)
        ? ('?' + new URLSearchParams({
            ...(filters.date_from ? { date_from: filters.date_from } : {}),
            ...(filters.date_to ? { date_to: filters.date_to } : {}),
          }).toString())
        : ''
    );

    res.render('admin_audit', {
      user: req.session.user,
      bodyClass: 'page-audit',
      entries,
      filters,
      csvUrl,
    });
  });

  app.get('/admin/audit.csv', isIsAdminRequired, async (req, res) => {
    const filters = parseAuditFilters(req.query);
    const { whereSql, args } = buildAuditWhere(filters);

    const ACTION_LABELS = {
      login: 'Вход',
      open: 'Открытие устройства',
      create: 'Создание',
      update: 'Изменение',
      reset_pin: 'Сброс пароля',
      clear_transit_log: 'Очистка журнала транзита',
      delete: 'Удаление',
    };

    const TYPE_LABELS = {
      user: 'Учетная запись',
      users: 'Учетные записи',
      device: 'Устройство',
      devices: 'Устройства',
      zone: 'Участок',
      zones: 'Участки',
      transit_event: 'Событие транзита',
      transit_events: 'Журнал транзита',
      audit: 'Аудит',
      log: 'Журнал',
      logs: 'Журнал событий',
    };

    const ROLE_LABELS = {
      user: 'Арендатор',
      admin: 'Администратор',
      dispatcher: 'Диспетчер',
    };

    const METHOD_LABELS = {
      http: 'HTTP',
      https: 'HTTPS',
      get: 'GET',
      post: 'POST',
      none: 'Без авторизации',
      basic: 'Базовая авторизация',
    };

    const ZONE_LABELS = {
      buffer: 'Северный въезд',
      europlan: 'Этажи 2-9',
      'Elevator doors': 'Лифтовые двери',
      'Above-ground gates': 'Надземные ворота',
      'Above-ground doors': 'Надземные двери',
      'Underground gates': 'Подземные ворота',
      'Underground doors': 'Подземные двери',
      overground: 'Наземный уровень',
      pedestrian: 'Входы и лифты',
      underground: 'Подземный уровень',
      transit: 'Рампа на эстакаду',
    };

    const actionLabel = (value) => ACTION_LABELS[String(value || '').trim()] || String(value || '');
    const typeLabel = (value) => TYPE_LABELS[String(value || '').trim()] || String(value || '');
    const roleLabel = (value) => ROLE_LABELS[String(value || '').trim()] || String(value || '');
    const methodLabel = (value) => METHOD_LABELS[String(value || '').trim().toLowerCase()] || String(value || '');
    const zoneLabel = (value) => ZONE_LABELS[String(value || '').trim()] || String(value || '');
    const boolRu = (value) => (value ? 'да' : 'нет');
    const parseDetails = (value) => {
      if (!value) return null;
      if (typeof value === 'object') return value;
      try { return JSON.parse(value); } catch { return null; }
    };

    const rowsRes = await dbQuery(
      `SELECT ts,
              to_char(ts AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY HH24:MI:SS') AS ts_msk,
              actor_id, actor_phone, actor_fio, actor_organization, actor_position,
              action, target_type, target_id, details, ip, ua
       FROM public.audit
       ${whereSql}
       ORDER BY ts DESC`,
      args
    );

    const zonesMap = Object.fromEntries(
      (await dbQuery('SELECT id, name FROM public.zones')).rows.map((zone) => [String(zone.id || ''), String(zone.name || '')])
    );
    const devicesMap = Object.fromEntries(
      (await dbQuery('SELECT id, name FROM public.devices')).rows.map((device) => [String(device.id || ''), String(device.name || '')])
    );
    const usersMap = Object.fromEntries(
      (await dbQuery('SELECT id, fio FROM public.users')).rows.map((user) => [String(user.id || ''), String(user.fio || '')])
    );

    const targetLabel = (row, details) => {
      const type = String(row.target_type || '').trim();
      const id = String(row.target_id || '').trim();

      if (type === 'zone' || type === 'zones') return zonesMap[id] || zoneLabel(id) || '—';
      if (type === 'device' || type === 'devices') {
        const gwName =
          details && details.gw && details.gw.data &&
          Array.isArray(details.gw.data.results) &&
          details.gw.data.results[0] &&
          details.gw.data.results[0].name
            ? details.gw.data.results[0].name
            : '';
        return gwName || devicesMap[id] || id || '—';
      }
      if (type === 'user' || type === 'users') {
        if (details && details.fio) return details.fio;
        if (id === 'admin') return 'Администратор';
        if (id === 'user') return 'Арендатор';
        if (id === 'dispatcher') return 'Диспетчер';
        return usersMap[id] || 'Арендатор';
      }
      return id || '—';
    };

    const detailsLabel = (details, raw) => {
      if (!details) {
        return String(raw || '')
          .replace(/\busers\b/gi, 'Учетные записи')
          .replace(/\buser\b/gi, 'Учетная запись')
          .replace(/\bdevices\b/gi, 'Устройства')
          .replace(/\bdevice\b/gi, 'Устройство')
          .replace(/\bzones\b/gi, 'Участки')
          .replace(/\bzone\b/gi, 'Участок')
          .replace(/\badmin\b/gi, 'Администратор')
          .replace(/\bdispatcher\b/gi, 'Диспетчер')
          .replace(/Elevator doors/g, 'Лифтовые двери')
          .replace(/Above-ground gates/g, 'Надземные ворота')
          .replace(/Above-ground doors/g, 'Надземные двери')
          .replace(/Underground gates/g, 'Подземные ворота')
          .replace(/Underground doors/g, 'Подземные двери')
          .replace(/\bbuffer\b/g, 'Северный въезд')
          .replace(/\beuroplan\b/g, 'Этажи 2-9')
          .replace(/\boverground\b/g, 'Наземный уровень')
          .replace(/\bpedestrian\b/g, 'Входы и лифты')
          .replace(/\bunderground\b/g, 'Подземный уровень')
          .replace(/\btransit\b/g, 'Рампа на эстакаду')
          .slice(0, 300);
      }

      const out = [];
      if (details.fio) out.push(`ФИО: ${details.fio}`);
      if (details.phone) out.push(`Телефон: ${details.phone}`);
      if (details.email) out.push(`Email: ${details.email}`);
      if (details.role) out.push(`Роль: ${roleLabel(details.role)}`);
      if (details.zoneId) out.push(`Участок: ${zonesMap[String(details.zoneId)] || zoneLabel(details.zoneId)}`);
      if (details.zone) out.push(`Участок: ${zonesMap[String(details.zone)] || zoneLabel(details.zone)}`);
      if (details.name) out.push(`Название: ${details.name}`);
      if (details.method) out.push(`Метод: ${methodLabel(details.method)}`);
      if (details.url) out.push(`Адрес: ${details.url}`);
      if (details.ip) out.push(`IP: ${details.ip}`);
      if (details.auth_type) out.push(`Авторизация: ${methodLabel(details.auth_type)}`);
      if (details.isActive !== undefined) out.push(`Активен: ${boolRu(details.isActive)}`);
      if (details.is_active !== undefined) out.push(`Активен: ${boolRu(details.is_active)}`);
      if (details.pin_changed) out.push('Пароль изменён');
      if (details.pin_generated) out.push('Пароль сгенерирован');
      if (details.pin_set) out.push('Пароль задан вручную');
      if (details.http_status) out.push(`HTTP статус: ${details.http_status}`);
      if (details.gw && details.gw.http_status) out.push(`Шлюз: HTTP ${details.gw.http_status}`);
      return out.length ? out.join(' • ') : '—';
    };

    const sep = ';';
    const header = ['Дата/время (МСК)', 'ФИО', 'Телефон', 'Организация', 'Должность', 'Действие', 'Тип цели', 'Цель', 'Детали', 'IP', 'UA'];
    const esc = (value) => {
      const source = String(value ?? '');
      const escaped = source.replace(/"/g, '""');
      return /[";\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
    };
    const lines = [header.join(sep)];

    (rowsRes.rows || []).forEach((row) => {
      const details = parseDetails(row.details);
      lines.push([
        row.ts_msk || '',
        row.actor_fio || '',
        row.actor_phone || '',
        row.actor_organization || '',
        row.actor_position || '',
        actionLabel(row.action),
        typeLabel(row.target_type),
        targetLabel(row, details),
        detailsLabel(details, row.details),
        row.ip || '',
        row.ua || '',
      ].map(esc).join(sep));
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
    res.send('\ufeff' + lines.join('\n'));
  });

  app.post('/admin/audit/clear', requirePermission('audit.view'), async (req, res) => {
    await dbQuery('DELETE FROM public.audit');
    res.redirect('/admin/audit');
  });
}

module.exports = {
  registerAdminAuditRoutes,
};
