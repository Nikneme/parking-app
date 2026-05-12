'use strict';

function createAuditService({ dbQuery }) {
  const RU_AUDIT_ACTION = {
    login: 'Вход',
    open: 'Открытие устройства',
    create: 'Создание',
    update: 'Изменение',
    reset_pin: 'Сброс PIN',
    change_pin: 'Смена PIN',
    login_failed: 'Неудачный вход',
    login_rate_limited: 'Ограничение входа',
    clear_transit_log: 'Очистка журнала транзита',
  };

  const RU_TARGET_TYPE = {
    user: 'Учетная запись',
    device: 'Устройство',
    zone: 'Участок',
    transit_events: 'Журнал транзита',
  };

  async function appendAudit(req, action, targetType, targetId, details) {
    try {
      const actor = req.session?.user || null;
      await dbQuery(
        `INSERT INTO public.audit(ts, actor_id, actor_phone, actor_fio, actor_organization, actor_position, action, target_type, target_id, details, ip, ua)
         VALUES (NOW(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          actor?.id || null,
          actor?.phone || null,
          actor?.fio || null,
          actor?.organization || null,
          actor?.position || null,
          action,
          targetType,
          targetId,
          details ? JSON.stringify(details) : null,
          req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket?.remoteAddress || null,
          req.headers['user-agent'] || null,
        ]
      );
    } catch {
      // ignore audit failures
    }
  }

  function ruAuditAction(action) {
    const key = String(action || '').trim();
    return RU_AUDIT_ACTION[key] || key;
  }

  function ruTargetType(type) {
    const key = String(type || '').trim();
    return RU_TARGET_TYPE[key] || key;
  }

  function parseAuditFilters(query = {}) {
    return {
      date_from: String(query.date_from || '').trim(),
      date_to: String(query.date_to || '').trim(),
      time_from: String(query.time_from || '').trim(),
      time_to: String(query.time_to || '').trim(),
      organization: String(query.organization || '').trim(),
      position: String(query.position || '').trim(),
      fio: String(query.fio || '').trim(),
    };
  }

  function buildAuditWhere(filters = {}) {
    const wh = [];
    const args = [];
    const push = (sql, val) => {
      args.push(val);
      wh.push(sql.replace('$X', `$${args.length}`));
    };

    if (filters.date_from) push(`(ts AT TIME ZONE 'Europe/Moscow')::date >= $X::date`, filters.date_from);
    if (filters.date_to) push(`(ts AT TIME ZONE 'Europe/Moscow')::date <= $X::date`, filters.date_to);
    if (filters.time_from) push(`(ts AT TIME ZONE 'Europe/Moscow')::time >= $X::time`, filters.time_from);
    if (filters.time_to) push(`(ts AT TIME ZONE 'Europe/Moscow')::time <= $X::time`, filters.time_to);
    if (filters.organization) push(`COALESCE(actor_organization,'') ILIKE $X`, `%${filters.organization}%`);
    if (filters.position) push(`COALESCE(actor_position,'') ILIKE $X`, `%${filters.position}%`);
    if (filters.fio) push(`COALESCE(actor_fio,'') ILIKE $X`, `%${filters.fio}%`);

    return {
      whereSql: wh.length ? `WHERE ${wh.join(' AND ')}` : '',
      args,
    };
  }

  return {
    appendAudit,
    ruAuditAction,
    ruTargetType,
    parseAuditFilters,
    buildAuditWhere,
  };
}

module.exports = {
  createAuditService,
};
