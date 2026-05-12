# Инструкция по развёртыванию «Моя парковка» с нуля

## 1. Требования

- Node.js 18+.
- PostgreSQL 13+.
- Доступ к репозиторию проекта.
- Доступ к production-среде: Railway, Yandex Cloud или иной Node.js-хостинг.
- Доступ к gateway/controllers API.
- Доступ к SMTP, если нужны email-уведомления.
- Доступ к домену, DNS и SSL-сертификатам.

## 2. Получение кода

```bash
git clone <repository-url> moyaparkovka
cd moyaparkovka
git checkout <production-branch>
npm install
```

Production-версия должна быть зафиксирована в репозитории до выкладки. Запуск кода, который существует только на сервере и не отражён в Git, запрещён регламентом.

## 3. База данных

Создайте PostgreSQL-БД и задайте `DATABASE_URL` либо `PG_URL`.

Пример локальной подготовки:

```bash
createdb moyaparkovka
export DATABASE_URL=postgresql://user:password@localhost:5432/moyaparkovka
```

Схема создаётся приложением при старте через `ensureSchema()`.

## 4. Переменные окружения

Минимальный production-набор:

```env
NODE_ENV=production
DATABASE_URL=postgresql://...
SESSION_SECRET=<strong-random-secret>
DEVICE_SECRET_ENCRYPTION_KEY=<strong-random-secret>
APP_BASE_URL=https://moyaparkovka.ru
ADMIN_PHONE=<phone>
ADMIN_PIN=<temporary-strong-password>
ADMIN_FIO=Администратор
GATEWAY_BASE_URL=https://<gateway-host>
GATEWAY_KEY=<gateway-secret>
GATEWAY_SEND_DEVICE_SECRETS=false
START_PIN_TTL_HOURS=24
PIN_MIN_LENGTH=8
LOGIN_RATE_WINDOW_MS=900000
LOGIN_RATE_MAX=8
LOGIN_IP_RATE_MAX=40
LOGIN_PHONE_RATE_MAX=24
ALLOW_FILE_TRANSIT_FALLBACK=false
ALLOW_REFERENCE_DEVICE_SEED=false
ALLOW_DEMO_ARTIFACTS=false
```

`DEVICE_SECRET_ENCRYPTION_KEY` должен быть постоянным. Его потеря или замена без миграции приведёт к невозможности расшифровать сохранённые пароли устройств.

## 5. Запуск backend/frontend

В проекте backend и server-rendered frontend запускаются одним процессом Express/EJS:

```bash
npm start
```

По умолчанию приложение слушает `PORT` или `8080`.

Проверка:

```bash
curl -fsS http://127.0.0.1:8080/health
```

## 6. Production-контур

Рекомендуемая схема:

- Reverse proxy / platform ingress с HTTPS.
- Node.js приложение.
- PostgreSQL.
- Gateway/controllers API.
- SMTP-провайдер.
- Домен `moyaparkovka.ru` с DNS-записями на production endpoint.

В production запрещено:

- `DEV_MEMORY_DB=true`;
- запуск без `SESSION_SECRET`;
- запуск без `DEVICE_SECRET_ENCRYPTION_KEY`;
- автоматическое создание reference-устройств без явного `ALLOW_REFERENCE_DEVICE_SEED=true`;
- передача паролей устройств в gateway через `GATEWAY_SEND_DEVICE_SECRETS=true`.

## 7. Первичная настройка после старта

1. Откройте `/login`.
2. Войдите под `ADMIN_PHONE` / `ADMIN_PIN`.
3. Смените стартовый пароль администратора.
4. Проверьте `/admin/users`, `/admin/devices`, `/admin/zones`, `/admin/audit`.
5. Добавьте реальные устройства и зоны либо импортируйте их через БД.
6. Создайте пользователей и выдайте стартовые пароли вне email.
7. Проверьте `/health`, `/logs`, `/admin/audit`.

## 8. Проверка безопасности после развёртывания

```bash
curl -I https://moyaparkovka.ru/
curl -I https://moyaparkovka.ru/data/users.json
curl -I https://moyaparkovka.ru/.git/config
```

Ожидаемо:

- security headers присутствуют;
- `/data` и `/.git` не доступны;
- POST без CSRF получает 403;
- стартовые пароли требуют смены.
