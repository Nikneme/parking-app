# Railway deploy

## Required services

1. Web service from this repository.
2. PostgreSQL service in the same Railway project.

## Web service variables

Set these in Railway > Web service > Variables:

```env
NODE_ENV=production
SESSION_SECRET=replace-with-a-long-random-secret
DATABASE_URL=${{Postgres.DATABASE_URL}}
PGSSL=true
ADMIN_PHONE=79000000000
ADMIN_PIN=replace-with-strong-admin-password
ADMIN_FIO=Администратор
DISPATCHER_PHONE=+7 936 004-67-42
APP_BASE_URL=https://your-generated-domain.up.railway.app
GATEWAY_BASE_URL=https://your-gateway-domain.example
GATEWAY_KEY=replace-with-real-gateway-key
GATEWAY_TIMEOUT_MS=7000
GATEWAY_SEND_DEVICE_SECRETS=false
ALLOW_FILE_TRANSIT_FALLBACK=false
MAIL_INCLUDE_PASSWORD=false
```

Do not set `DEV_MEMORY_DB=true` on Railway production.

## Start command

```bash
npm start
```

## Healthcheck

```text
/health
```

## After deploy

1. Generate public domain in Railway > Web service > Settings/Networking.
2. Update `APP_BASE_URL` to the generated domain.
3. Open `/health`.
4. Log in with `ADMIN_PHONE` and `ADMIN_PIN`.
5. Create a test tenant.
6. Test one safe device through the gateway.
7. Check the transit log and CSV export.
