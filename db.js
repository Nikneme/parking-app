const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_URL || '';
const USE_DEV_DB = String(process.env.DEV_MEMORY_DB || '').toLowerCase() === 'true';
const DATABASE_URL_CONFIGURED = !!DATABASE_URL;

let dbQuery;
let ensureSchema;

if (USE_DEV_DB) {
  ({ dbQuery, ensureSchema } = require('./dev-db'));
  console.warn('DEV_MEMORY_DB is active: PostgreSQL is not configured, using in-memory development storage.');
} else {
  const { Pool } = require('pg');

  // Railway/Render/Heroku часто требуют SSL.
  // Чтобы не ловить ошибки сертификата — используем rejectUnauthorized:false.
  const useSSL =
    String(process.env.PGSSL || '').toLowerCase() === 'true' ||
    /sslmode=require/i.test(DATABASE_URL);

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  });

  dbQuery = function dbQuery(text, params) {
    return pool.query(text, params);
  };

  ensureSchema = async function ensureSchema() {
  // 1) Создаём таблицы, если их ещё нет
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS public.users (
      id TEXT PRIMARY KEY,
      fio TEXT,
      phone TEXT,
      pin TEXT,
      role TEXT DEFAULT 'user',
      is_is_admin BOOLEAN DEFAULT FALSE,
            organization TEXT,
      position TEXT,
      zones TEXT[] NOT NULL DEFAULT '{}'::text[],
      assignable_zones TEXT[],
      is_tenant_contact BOOLEAN DEFAULT FALSE,
      parking_floors TEXT[] NOT NULL DEFAULT '{}'::text[],
      parking_groups TEXT[] NOT NULL DEFAULT '{}'::text[],
      parking_spots TEXT[] NOT NULL DEFAULT '{}'::text[],
      preferred_routes TEXT[] NOT NULL DEFAULT '{}'::text[],
      is_active BOOLEAN DEFAULT TRUE,
      must_change_pin BOOLEAN DEFAULT FALSE,
      pin_created_at TIMESTAMPTZ,
      pin_changed_at TIMESTAMPTZ,
      pin_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS public.zones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      sort INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS public.devices (
      id TEXT PRIMARY KEY,
      name TEXT,
      zone_id TEXT,
      zone TEXT,
      type TEXT,
      method TEXT,
      url TEXT,
      ip TEXT,
      relay TEXT,
      params JSONB,
      auth_type TEXT DEFAULT 'none',
      username TEXT,
      password TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      sort INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS public.transit_logs (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      user_id TEXT,
      user_phone TEXT,
      user_fio TEXT,
      device_id TEXT,
      device_name TEXT,
      zone_id TEXT,
      action TEXT,
      success BOOLEAN DEFAULT TRUE,
      details JSONB,
      ip TEXT,
      ua TEXT
    );
  `);

  // Transit journal (UI: "Журнал транзита")
  // Used by /logs, /logs.csv and /logs/clear
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS public.transit_events (
      id BIGSERIAL PRIMARY KEY,
      datetime TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      point TEXT,
      event TEXT,
      source TEXT,
      result TEXT,
      session TEXT,
      request_id TEXT,
      details JSONB
    );
  `);

  // Helpful index for recent-first queries
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_transit_events_datetime_desc ON public.transit_events(datetime DESC);`);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS public.audit (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      actor_id TEXT,
      actor_phone TEXT,
      actor_fio TEXT,
      action TEXT,
      target_type TEXT,
      target_id TEXT,
      -- старые поля (если проект раньше так назывался)
      object_type TEXT,
      object_id TEXT,
      details JSONB,
      ip TEXT,
      ua TEXT
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS public.sessions (
      sid TEXT PRIMARY KEY,
      sess JSONB NOT NULL,
      expires TIMESTAMPTZ NOT NULL
    );
  `);

  // 2) МИГРАЦИИ: добавляем недостающие колонки в существующих таблицах
  // users
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS fio TEXT;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email TEXT;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pin TEXT;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role TEXT;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_is_admin BOOLEAN;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS organization TEXT;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS position TEXT;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS zones TEXT[];`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS assignable_zones TEXT[];`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_tenant_contact BOOLEAN;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS parking_floors TEXT[];`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS parking_groups TEXT[];`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS parking_spots TEXT[];`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS preferred_routes TEXT[];`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_active BOOLEAN;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS must_change_pin BOOLEAN;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pin_created_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pin_changed_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pin_expires_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`);

  // migrate zones jsonb -> text[] (if needed)
  try {
    const zt = await dbQuery(
      `SELECT data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='zones'
       LIMIT 1`
    );
    if (zt.rows.length) {
      const { data_type, udt_name } = zt.rows[0];
      const isJsonb = data_type === 'jsonb' || udt_name === 'jsonb';
      if (isJsonb) {
        await dbQuery(`
          ALTER TABLE public.users
          ALTER COLUMN zones TYPE TEXT[]
          USING (
            CASE
              WHEN zones IS NULL THEN '{}'::text[]
              WHEN jsonb_typeof(zones)='array' THEN (
                SELECT COALESCE(array_agg(value), '{}'::text[])
                FROM jsonb_array_elements_text(zones) AS t(value)
              )
              ELSE '{}'::text[]
            END
          );
        `);
      }
    }
  } catch (e) {
    console.warn('⚠️ zones type check/migrate failed:', e?.message || e);
  }

  try {
    const azt = await dbQuery(
      `SELECT data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='assignable_zones'
       LIMIT 1`
    );
    if (azt.rows.length) {
      const { data_type, udt_name } = azt.rows[0];
      const isJsonb = data_type === 'jsonb' || udt_name === 'jsonb';
      if (isJsonb) {
        await dbQuery(`
          ALTER TABLE public.users
          ALTER COLUMN assignable_zones TYPE TEXT[]
          USING (
            CASE
              WHEN assignable_zones IS NULL THEN NULL
              WHEN jsonb_typeof(assignable_zones)='array' THEN (
                SELECT COALESCE(array_agg(value), '{}'::text[])
                FROM jsonb_array_elements_text(assignable_zones) AS t(value)
              )
              ELSE NULL
            END
          );
        `);
      }
    }
  } catch (e) {
    console.warn('⚠️ assignable_zones type check/migrate failed:', e?.message || e);
  }

  await dbQuery(`ALTER TABLE public.users ALTER COLUMN role SET DEFAULT 'user';`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN is_is_admin SET DEFAULT FALSE;`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN is_tenant_contact SET DEFAULT FALSE;`);
  await dbQuery(`UPDATE public.users SET is_is_admin = COALESCE(is_is_admin, FALSE) WHERE is_is_admin IS NULL;`);
  await dbQuery(`UPDATE public.users SET is_tenant_contact = COALESCE(is_tenant_contact, FALSE) WHERE is_tenant_contact IS NULL;`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN zones SET DEFAULT '{}'::text[];`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN parking_floors SET DEFAULT '{}'::text[];`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN parking_groups SET DEFAULT '{}'::text[];`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN parking_spots SET DEFAULT '{}'::text[];`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN preferred_routes SET DEFAULT '{}'::text[];`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN is_active SET DEFAULT TRUE;`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN must_change_pin SET DEFAULT FALSE;`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN created_at SET DEFAULT NOW();`);
  await dbQuery(`ALTER TABLE public.users ALTER COLUMN updated_at SET DEFAULT NOW();`);
  await dbQuery(`UPDATE public.users SET role = COALESCE(role,'user') WHERE role IS NULL;`);
  await dbQuery(`UPDATE public.users SET zones = COALESCE(zones,'{}'::text[]) WHERE zones IS NULL;`);
  await dbQuery(`UPDATE public.users SET parking_floors = COALESCE(parking_floors,'{}'::text[]) WHERE parking_floors IS NULL;`);
  await dbQuery(`UPDATE public.users SET parking_groups = COALESCE(parking_groups,'{}'::text[]) WHERE parking_groups IS NULL;`);
  await dbQuery(`UPDATE public.users SET parking_spots = COALESCE(parking_spots,'{}'::text[]) WHERE parking_spots IS NULL;`);
  await dbQuery(`UPDATE public.users SET preferred_routes = COALESCE(preferred_routes,'{}'::text[]) WHERE preferred_routes IS NULL;`);
  await dbQuery(`UPDATE public.users SET is_active = COALESCE(is_active, TRUE) WHERE is_active IS NULL;`);
  await dbQuery(`UPDATE public.users SET must_change_pin = COALESCE(must_change_pin, FALSE) WHERE must_change_pin IS NULL;`);
  await dbQuery(`UPDATE public.users SET pin_changed_at = COALESCE(pin_changed_at, updated_at, created_at, NOW()) WHERE pin_changed_at IS NULL AND COALESCE(must_change_pin, FALSE) = FALSE AND pin IS NOT NULL;`);
  await dbQuery(`UPDATE public.users SET must_change_pin = TRUE, pin_created_at = COALESCE(pin_created_at, NOW()), pin_expires_at = COALESCE(pin_expires_at, NOW() + INTERVAL '24 hours') WHERE pin IS NOT NULL AND pin NOT LIKE 'pin:v1:scrypt:%';`);
  await dbQuery(`UPDATE public.users SET created_at = COALESCE(created_at, NOW()) WHERE created_at IS NULL;`);
  await dbQuery(`UPDATE public.users SET updated_at = COALESCE(updated_at, NOW()) WHERE updated_at IS NULL;`);


  // zones
  await dbQuery(`ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS name TEXT;`);
  await dbQuery(`ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS description TEXT;`);
  await dbQuery(`ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS sort INT;`);
  await dbQuery(`ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS is_active BOOLEAN;`);
  await dbQuery(`ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.zones ALTER COLUMN sort SET DEFAULT 0;`);
  await dbQuery(`ALTER TABLE public.zones ALTER COLUMN is_active SET DEFAULT TRUE;`);
  await dbQuery(`ALTER TABLE public.zones ALTER COLUMN created_at SET DEFAULT NOW();`);
  await dbQuery(`ALTER TABLE public.zones ALTER COLUMN updated_at SET DEFAULT NOW();`);
  await dbQuery(`UPDATE public.zones SET sort = COALESCE(sort, 0) WHERE sort IS NULL;`);
  await dbQuery(`UPDATE public.zones SET is_active = COALESCE(is_active, TRUE) WHERE is_active IS NULL;`);
  await dbQuery(`UPDATE public.zones SET created_at = COALESCE(created_at, NOW()) WHERE created_at IS NULL;`);
  await dbQuery(`UPDATE public.zones SET updated_at = COALESCE(updated_at, NOW()) WHERE updated_at IS NULL;`);

  // devices
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS name TEXT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS zone_id TEXT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS zone TEXT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS type TEXT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS method TEXT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS url TEXT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS ip TEXT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS relay TEXT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS params JSONB;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS auth_type TEXT DEFAULT 'none';`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS username TEXT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS password TEXT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS enabled BOOLEAN;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS sort INT;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS is_active BOOLEAN;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.devices ALTER COLUMN enabled SET DEFAULT TRUE;`);
  await dbQuery(`ALTER TABLE public.devices ALTER COLUMN sort SET DEFAULT 0;`);
  await dbQuery(`ALTER TABLE public.devices ALTER COLUMN is_active SET DEFAULT TRUE;`);
  await dbQuery(`ALTER TABLE public.devices ALTER COLUMN created_at SET DEFAULT NOW();`);
  await dbQuery(`ALTER TABLE public.devices ALTER COLUMN updated_at SET DEFAULT NOW();`);
  await dbQuery(`UPDATE public.devices SET enabled = COALESCE(enabled, TRUE) WHERE enabled IS NULL;`);
  await dbQuery(`UPDATE public.devices SET sort = COALESCE(sort, 0) WHERE sort IS NULL;`);
  await dbQuery(`UPDATE public.devices SET is_active = COALESCE(is_active, TRUE) WHERE is_active IS NULL;`);
  await dbQuery(`UPDATE public.devices SET created_at = COALESCE(created_at, NOW()) WHERE created_at IS NULL;`);
  await dbQuery(`UPDATE public.devices SET updated_at = COALESCE(updated_at, NOW()) WHERE updated_at IS NULL;`);
  // Совместимость: если раньше была колонка zone (текст), заполняем zone_id
  await dbQuery(
    `UPDATE public.devices SET zone_id = COALESCE(zone_id, zone) WHERE zone_id IS NULL AND zone IS NOT NULL;`
  );

  // transit_logs
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS ts TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS user_id TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS user_phone TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS user_fio TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS user_organization TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS user_position TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS device_id TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS device_name TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS zone_id TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS action TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS success BOOLEAN;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS details JSONB;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS ip TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ADD COLUMN IF NOT EXISTS ua TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_logs ALTER COLUMN ts SET DEFAULT NOW();`);
  await dbQuery(`ALTER TABLE public.transit_logs ALTER COLUMN success SET DEFAULT TRUE;`);
  await dbQuery(`UPDATE public.transit_logs SET ts = COALESCE(ts, NOW()) WHERE ts IS NULL;`);
  await dbQuery(`UPDATE public.transit_logs SET success = COALESCE(success, TRUE) WHERE success IS NULL;`);

  // transit_events (journal)
  await dbQuery(`CREATE TABLE IF NOT EXISTS public.transit_events (id BIGSERIAL PRIMARY KEY);`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS datetime TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS point TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS event TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS source TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS result TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS session TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS request_id TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS details JSONB;`);
  // Кто сделал действие (для UI "Журнал транзита")
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS actor_id TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS actor_phone TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS actor_fio TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS actor_organization TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ADD COLUMN IF NOT EXISTS actor_position TEXT;`);
  await dbQuery(`ALTER TABLE public.transit_events ALTER COLUMN datetime SET DEFAULT NOW();`);
  await dbQuery(`UPDATE public.transit_events SET datetime = COALESCE(datetime, NOW()) WHERE datetime IS NULL;`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_transit_events_session ON public.transit_events (session);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_transit_events_request_id ON public.transit_events (request_id);`);

  // Подтянуть старые записи (если раньше писали только source)
  await dbQuery(
    `UPDATE public.transit_events
     SET actor_phone = COALESCE(actor_phone, source)
     WHERE actor_phone IS NULL AND source IS NOT NULL;`
  );
  await dbQuery(
    `UPDATE public.transit_events te
     SET actor_id = u.id,
         actor_fio = COALESCE(te.actor_fio, u.fio),
         actor_organization = COALESCE(te.actor_organization, u.organization),
         actor_position = COALESCE(te.actor_position, u.position)
     FROM public.users u
     WHERE regexp_replace(coalesce(u.phone,''), '[^0-9]', '', 'g') = regexp_replace(coalesce(te.actor_phone, te.source,''), '[^0-9]', '', 'g');`
  );

  // audit
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS ts TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS actor_id TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS actor_phone TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS actor_fio TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS actor_organization TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS actor_position TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS action TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS target_type TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS target_id TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS object_type TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS object_id TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS details JSONB;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS ip TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ADD COLUMN IF NOT EXISTS ua TEXT;`);
  await dbQuery(`ALTER TABLE public.audit ALTER COLUMN ts SET DEFAULT NOW();`);
  await dbQuery(`UPDATE public.audit SET ts = COALESCE(ts, NOW()) WHERE ts IS NULL;`);
  // Совместимость: если раньше писали в object_type/object_id
  await dbQuery(
    `UPDATE public.audit SET target_type = COALESCE(target_type, object_type), target_id = COALESCE(target_id, object_id)
     WHERE target_type IS NULL OR target_id IS NULL;`
  );

  // Индексы (безопасно: IF NOT EXISTS)
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS users_phone_digits_idx
     ON public.users (regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'));`
  );
  await dbQuery(`CREATE INDEX IF NOT EXISTS devices_zone_id_idx ON public.devices (zone_id);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS transit_logs_ts_idx ON public.transit_logs (ts DESC);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS audit_ts_idx ON public.audit (ts DESC);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS users_pin_expires_idx ON public.users (pin_expires_at);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS sessions_expires_idx ON public.sessions (expires);`);
  };
}

module.exports = {
  dbQuery,
  ensureSchema,
  isDevDb: USE_DEV_DB,
  databaseUrlConfigured: DATABASE_URL_CONFIGURED,
};
