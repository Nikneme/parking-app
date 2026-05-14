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
  const ACTION_LABELS = {
    login: 'Вход',
    logout: 'Выход',
    login_failed: 'Неудачный вход',
    login_rate_limited: 'Ограничение входа',
    change_pin: 'Смена пароля',
    reset_pin: 'Сброс пароля',
    open: 'Открытие устройства',
    create: 'Создание',
    update: 'Изменение',
    delete: 'Удаление',
    clear_transit_log: 'Очистка журнала транзита',
  };

  const TYPE_LABELS = {
    user: 'Учетная запись',
    users: 'Учетные записи',
    device: 'Устройство',
    devices: 'Устройства',
    zone: 'Участок',
    zones: 'Участки',
    auth: 'Авторизация',
    session: 'Сессия',
    audit: 'Аудит',
    log: 'Журнал',
    logs: 'Журнал событий',
    transit_event: 'Событие транзита',
    transit_events: 'Журнал транзита',
  };

  const ROLE_LABELS = {
    user: 'Арендатор',
    admin: 'Администратор',
    dispatcher: 'Диспетчер',
  };

  const REASON_LABELS = {
    not_found: 'пользователь не найден',
    inactive: 'учетная запись отключена',
    bad_pin: 'неверный пароль',
    first_login_or_reset: 'первый вход или сброс пароля',
    unknown: 'неизвестная причина',
  };

  const SCOPE_LABELS = {
    ip_phone: 'IP + телефон',
    ip: 'IP-адрес',
    phone: 'телефон',
    unknown: 'неизвестно',
  };

  const ZONE_LABELS = {
    buffer: 'Северный въезд',
    europlan: 'Этажи 2-9',
    overground: 'Наземный уровень',
    pedestrian: 'Входы и лифты',
    underground: 'Подземный уровень',
    transit: 'Рампа на эстакаду',
    'Elevator doors': 'Лифтовые двери',
    'Above-ground gates': 'Надземные ворота',
    'Above-ground doors': 'Надземные двери',
    'Underground gates': 'Подземные ворота',
    'Underground doors': 'Подземные двери',
  };

  const METHOD_LABELS = {
    http: 'HTTP',
    https: 'HTTPS',
    get: 'GET',
    post: 'POST',
    none: 'Без авторизации',
    basic: 'Базовая авторизация',
  };

  const actionLabel = (value) => ACTION_LABELS[String(value || '').trim()] || String(value || '');
  const typeLabel = (value) => TYPE_LABELS[String(value || '').trim()] || String(value || '');
  const roleLabel = (value) => ROLE_LABELS[String(value || '').trim()] || String(value || '');
  const reasonLabel = (value) => REASON_LABELS[String(value || '').trim()] || String(value || '');
  const scopeLabel = (value) => SCOPE_LABELS[String(value || '').trim()] || String(value || '');
  const zoneLabel = (value) => ZONE_LABELS[String(value || '').trim()] || String(value || '');
  const methodLabel = (value) => METHOD_LABELS[String(value || '').trim().toLowerCase()] || String(value || '');
  const boolRu = (value) => (value ? 'да' : 'нет');

  const parseDetails = (value) => {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return null; }
  };

  const targetLabel = (row, details) => {
    const type = String(row.target_type || '').trim();
    const id = String(row.target_id || '').trim();

    if (type === 'user' || type === 'users') {
      if (details && details.fio) return details.fio;
      if (id === 'admin') return 'Администратор';
      if (id === 'user') return 'Арендатор';
      if (id === 'dispatcher') return 'Диспетчер';
      return id || 'Учетная запись';
    }

    if (type === 'zone' || type === 'zones') {
      return zoneLabel(id || (details && (details.zoneId || details.zone)) || '') || '—';
    }

    if (type === 'device' || type === 'devices') {
      const gatewayName = details && details.gw && details.gw.data &&
        Array.isArray(details.gw.data.results) &&
        details.gw.data.results[0] &&
        details.gw.data.results[0].name;
      return gatewayName || (details && details.name) || id || 'Устройство';
    }

    return id || '—';
  };

  const detailsLabel = (details, raw) => {
    if (!details) {
      return String(raw || '')
        .replace(/login_failed/g, 'Неудачный вход')
        .replace(/login_rate_limited/g, 'Ограничение входа')
        .replace(/bad_pin/g, 'неверный пароль')
        .replace(/not_found/g, 'пользователь не найден')
        .replace(/inactive/g, 'учетная запись отключена')
        .replace(/ip_phone/g, 'IP + телефон')
        .replace(/\busers\b/gi, 'Учетные записи')
        .replace(/\buser\b/gi, 'Учетная запись')
        .replace(/\bdevices\b/gi, 'Устройства')
        .replace(/\bdevice\b/gi, 'Устройство')
        .replace(/\bzones\b/gi, 'Участки')
        .replace(/\bzone\b/gi, 'Участок')
        .replace(/\badmin\b/gi, 'Администратор')
        .slice(0, 300);
    }

    const out = [];
    if (details.fio) out.push(`ФИО: ${details.fio}`);
    if (details.phone) out.push(`Телефон: ${details.phone}`);
    if (details.email) out.push(`Email: ${details.email}`);
    if (details.role) out.push(`Роль: ${roleLabel(details.role)}`);
    if (details.reason) out.push(`Причина: ${reasonLabel(details.reason)}`);
    if (details.scope) out.push(`Лимит: ${scopeLabel(details.scope)}`);
    if (details.retry_after_sec !== undefined) out.push(`Повтор через: ${details.retry_after_sec} сек.`);
    if (details.zoneId) out.push(`Участок: ${zoneLabel(details.zoneId)}`);
    if (details.zone) out.push(`Участок: ${zoneLabel(details.zone)}`);
    if (details.name) out.push(`Название: ${details.name}`);
    if (details.method) out.push(`Метод: ${methodLabel(details.method)}`);
    if (details.url) out.push(`Адрес: ${details.url}`);
    if (details.ip) out.push(`IP: ${details.ip}`);
    if (details.auth_type) out.push(`Авторизация: ${methodLabel(details.auth_type)}`);
    if (details.isActive !== undefined) out.push(`Активен: ${boolRu(details.isActive)}`);
    if (details.is_active !== undefined) out.push(`Активен: ${boolRu(details.is_active)}`);
    if (details.pin_changed) out.push('Пароль изменен');
    if (details.pin_generated) out.push('Пароль сгенерирован');
    if (details.pin_set) out.push('Пароль задан вручную');
    if (details.must_change_pin) out.push('Требуется смена пароля при входе');
    if (details.pin_expires_at) out.push(`Срок действия пароля: ${details.pin_expires_at}`);
    if (details.http_status) out.push(`HTTP статус: ${details.http_status}`);
    if (details.gw && details.gw.http_status) out.push(`Шлюз: HTTP ${details.gw.http_status}`);
    return out.length ? out.join(' • ') : '—';
  };

  app.get('/admin/audit', isIsAdminRequired, async (req, res, next) => {
    try {
      const filters = parseAuditFilters(req.query);
      const { whereSql, args } = buildAuditWhere(filters);

      const result = await dbQuery(
        `SELECT ts,
                to_char(ts AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY HH24:MI:SS') AS ts_msk,
                actor_id, actor_phone, actor_fio, actor_organization, actor_position,
                action, target_type, target_id, details, ip, ua
         FROM public.audit
         ${whereSql}
         ORDER BY ts DESC
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
        details: parseDetails(entry.details) || entry.details,
        ip: entry.ip,
        ua: entry.ua,
      }));

      const query = new URLSearchParams();
      if (filters.date_from) query.set('date_from', filters.date_from);
      if (filters.date_to) query.set('date_to', filters.date_to);
      const csvUrl = '/admin/audit.csv' + (query.toString() ? `?${query.toString()}` : '');

      res.render('admin_audit', {
        user: req.session.user,
        bodyClass: 'page-audit',
        entries,
        filters,
        csvUrl,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin/audit.csv', isIsAdminRequired, async (req, res, next) => {
    try {
      const filters = parseAuditFilters(req.query);
      const { whereSql, args } = buildAuditWhere(filters);

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
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/audit/clear', requirePermission('audit.view'), async (req, res, next) => {
    try {
      await dbQuery('DELETE FROM public.audit');
      res.redirect('/admin/audit');
    } catch (error) {
      next(error);
    }
  });
}

module.exports = {
  registerAdminAuditRoutes,
};
