# Security hardening 4.2-4.9

## 4.2. Стартовые доступы и первичный вход
- Действующие PIN/пароли больше не отправляются по email: приветственное письмо содержит только логин и инструкцию получить временный пароль у администратора отдельным каналом.
- Для новых, сброшенных и bootstrap-административных паролей включается `must_change_pin=true`.
- До смены временного пароля пользователь не получает доступ к рабочим маршрутам и API; доступна только страница `/change-password` и выход.
- Срок действия стартового пароля задается `START_PIN_TTL_HOURS`.
- Legacy PIN в открытом виде после успешной проверки перехешируется и принудительно помечается к смене.

## 4.3. Защита от перебора
- Вход ограничивается по трем областям: IP+телефон, IP и телефон.
- Настройки: `LOGIN_RATE_WINDOW_MS`, `LOGIN_RATE_MAX`, `LOGIN_IP_RATE_MAX`, `LOGIN_PHONE_RATE_MAX`.
- После превышения лимита возвращается `429` и заголовок `Retry-After`.
- Неудачные входы и срабатывания rate limit пишутся в audit как `login_failed` и `login_rate_limited`.
- Сообщение об ошибке входа унифицировано, чтобы не раскрывать наличие телефона в базе.

## 4.4. CSRF-защита
- Все `POST`/`PUT`/`PATCH`/`DELETE` требуют `_csrf` или `X-CSRF-Token`.
- Формы администрирования, logout, логин и API-открытие устройств используют CSRF-токен.
- Smoke-тест проверяет отклонение запроса с неверным CSRF.

## 4.5. Публичные директории и лишние данные
- `/data`, `/public/data`, `/.git`, `/__MACOSX` закрыты ответом `404`.
- Static-раздача настроена с `dotfiles: 'deny'`, `index: false`, `redirect: false`.
- Финальный архив собирается без `node_modules`, `.git`, `.DS_Store`, `data`, `public/data`, локальных `.bak`, `*.zip`, `*.tar.gz`, `tree.txt`.

## 4.6. Учётные данные устройств и внешних интеграций
- Логины/пароли из URL устройств выносятся в отдельные поля; URL очищается от embedded credentials.
- Пароли устройств в БД сохраняются в формате `enc:v1:gcm:*` через AES-256-GCM.
- Ключ шифрования задается `DEVICE_SECRET_ENCRYPTION_KEY`; при отсутствии используется `SESSION_SECRET`.
- В audit пароли устройств не пишутся.
- Передача device password в gateway запрещена в production через `GATEWAY_SEND_DEVICE_SECRETS=true`.

## 4.7. Тестовые и демонстрационные артефакты
- Production-архив очищается от локальных, тестовых и архивных артефактов.
- DEV in-memory режим остается только для локального запуска через явный `DEV_MEMORY_DB=true`.
- При отсутствии PostgreSQL production-запуск не продолжается без явного override.

## 4.8. Дефолтные администраторы и критичные доступы
- Bootstrap admin создается только из `ADMIN_PHONE`/`ADMIN_PIN`, без hard-coded пароля.
- Новый bootstrap admin обязан сменить стартовый пароль при первом входе.
- Суперпользователи видны в разделе администрирования; сброс пароля помечает доступ как временный и требует смены.

## 4.9. Базовый hardening
- `X-Powered-By` отключен.
- Включены `X-Content-Type-Options`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, `Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`.
- В production включается HSTS.
- Cookie сессии: `httpOnly`, `sameSite=lax`, `secure` в production.
- Сессии хранятся в PostgreSQL при наличии `DATABASE_URL`/`PG_URL`.

## Проверка
Выполнена runtime-проверка:

```bash
DEV_MEMORY_DB=true SESSION_SECRET=replace-with-very-secret DEVICE_SECRET_ENCRYPTION_KEY=replace-with-device-secret ADMIN_PHONE=79000000000 ADMIN_PIN=RuntimeAdmin1234 GATEWAY_BASE_URL=http://127.0.0.1:9090 GATEWAY_KEY=dev-gateway-key PORT=18080 node server.js
GATEWAY_KEY=dev-gateway-key PORT=9090 node scripts/mock-gateway.js
node scripts/runtime-smoke.js
```

Результат: все шаги smoke-теста пройдены, включая CSRF, обязательную смену временного пароля, dashboard, gateway open, logs и admin zones.

## Дополнение: закрытие полного ТЗ

Помимо пунктов 4.2-4.9, пакет дополнен материалами для этапов передачи контроля, эксплуатационной упаковки, регламентов, инвентаризации и приёмки:

- `docs/tz-compliance-report.md`;
- `docs/deployment.md`;
- `docs/update-rollback.md`;
- `docs/backup-recovery.md`;
- `docs/operations-regulations.md`;
- `docs/inventory-and-handover.md`;
- `docs/acceptance-act-template.md`.

В код добавлены дополнительные production-защиты:

- `DEV_MEMORY_DB=true` запрещён в production;
- reference-устройства не создаются автоматически в production;
- `DEVICE_SECRET_ENCRYPTION_KEY` обязателен в production;
- demo/mock-скрипты заблокированы в production без `ALLOW_DEMO_ARTIFACTS=true`;
- добавлены `npm run ops:inventory`, `npm run db:backup`, `npm run db:restore`.
