'use strict';

function digitsOnly(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function formatPhoneRu(phoneLike) {
  const digits = digitsOnly(phoneLike);
  if (!digits) return '';

  let normalized = digits;
  if (digits.length === 10) normalized = `7${digits}`;
  else if (digits.length === 11 && digits.startsWith('8')) normalized = `7${digits.slice(1)}`;

  if (normalized.length === 11 && normalized.startsWith('7')) {
    return `+7 ${normalized.slice(1, 4)} ${normalized.slice(4, 7)}-${normalized.slice(7, 9)}-${normalized.slice(9, 11)}`;
  }

  return phoneLike ? String(phoneLike).trim() : digits;
}

function parseZonesInput(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseListInput(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join('\n') : String(value);
  return Array.from(new Set(
    raw
      .split(/[\n,;]+/g)
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  ));
}

function normalizeTenantProfile(source = {}) {
  const parking_floors = parseListInput(source.parking_floors);
  const parking_groups = parseListInput(source.parking_groups);
  const parking_spots = parseListInput(source.parking_spots);
  const preferred_routes = parseListInput(source.preferred_routes);
  return {
    parking_floors,
    parking_groups,
    parking_spots,
    preferred_routes,
    has_profile: !!(parking_floors.length || parking_groups.length || parking_spots.length || preferred_routes.length),
  };
}

function buildTenantProfileSummary(profileLike = {}) {
  const profile = normalizeTenantProfile(profileLike);
  const bits = [];
  if (profile.parking_floors.length) bits.push(`этажи: ${profile.parking_floors.join(', ')}`);
  if (profile.parking_groups.length) bits.push(`группы: ${profile.parking_groups.join(', ')}`);
  if (profile.parking_spots.length) bits.push(`места: ${profile.parking_spots.join(', ')}`);
  if (profile.preferred_routes.length) bits.push(`маршруты: ${profile.preferred_routes.join(', ')}`);
  return bits.join(' • ');
}

function applyAdminUserZoneLimit(actor, zoneIds) {
  const clean = Array.from(new Set(parseZonesInput(zoneIds)));
  if (!actor || actor.role !== 'admin' || actor.is_is_admin === true) return clean;
  if (actor.assignable_zones === undefined || actor.assignable_zones === null) return clean;
  const allowed = new Set(parseZonesInput(actor.assignable_zones));
  return clean.filter((zoneId) => allowed.has(zoneId));
}

function mapSessionUser(userRow = {}) {
  const tenantProfile = normalizeTenantProfile(userRow);
  return {
    id: userRow.id,
    fio: userRow.fio,
    phone: userRow.phone,
    organization: userRow.organization,
    position: userRow.position,
    role: (userRow.role === 'dispatcher' ? 'dispatcher' : (userRow.role || 'user')),
    is_is_admin: !!userRow.is_is_admin,
    zones: Array.isArray(userRow.zones) ? userRow.zones : [],
    assignable_zones: userRow.assignable_zones == null ? null : (Array.isArray(userRow.assignable_zones) ? userRow.assignable_zones : []),
    is_tenant_contact: !!userRow.is_tenant_contact,
    parking_floors: tenantProfile.parking_floors,
    parking_groups: tenantProfile.parking_groups,
    parking_spots: tenantProfile.parking_spots,
    preferred_routes: tenantProfile.preferred_routes,
    tenant_profile: tenantProfile,
    is_active: userRow.is_active !== false,
  };
}

function mapAdminUser(userRow = {}) {
  const sessionUser = mapSessionUser(userRow);
  return {
    ...sessionUser,
    email: userRow.email,
    pin_is_set: !!userRow.pin,
    tenant_profile_summary: buildTenantProfileSummary(sessionUser.tenant_profile),
  };
}

function buildDashboardSupportContact(usersMap, configuredDispatcherPhone = '') {
  const users = Object.values(usersMap || {}).filter((item) => item && item.is_active !== false);
  const candidate = users.find((item) => item.is_tenant_contact && digitsOnly(item.phone))
    || users.find((item) => item.role === 'dispatcher' && digitsOnly(item.phone))
    || users.find((item) => item.role === 'admin' && item.is_is_admin !== true && digitsOnly(item.phone))
    || users.find((item) => item.role === 'admin' && digitsOnly(item.phone));

  const configuredDigits = digitsOnly(configuredDispatcherPhone);
  const digits = candidate ? digitsOnly(candidate.phone) : configuredDigits;
  if (!digits) return null;

  const telDigits = digits.length === 11 && digits.startsWith('8')
    ? `7${digits.slice(1)}`
    : (digits.length === 10 ? `7${digits}` : digits);

  const roleLabel = candidate
    ? (candidate.role === 'dispatcher' ? 'Диспетчер' : 'Администратор')
    : 'Диспетчер';

  return {
    role: candidate?.role || 'dispatcher',
    role_label: roleLabel,
    name: candidate?.fio || roleLabel,
    phone: digits,
    phone_display: formatPhoneRu(digits),
    tel_href: `tel:+${telDigits}`,
  };
}

module.exports = {
  applyAdminUserZoneLimit,
  buildDashboardSupportContact,
  buildTenantProfileSummary,
  digitsOnly,
  formatPhoneRu,
  mapAdminUser,
  mapSessionUser,
  normalizeTenantProfile,
  parseListInput,
  parseZonesInput,
};
