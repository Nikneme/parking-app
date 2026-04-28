# Parking GIT (Node.js + PostgreSQL)

## Документы команды

Если вы только подключились к проекту, удобнее читать в таком порядке:

1. [docs/team-guide.md](/Users/maksimglazyrin/Documents/New%20project/pr/docs/team-guide.md) - что уже изменили, почему, что считается важным и куда идет продукт.
2. [docs/architecture-map.md](/Users/maksimglazyrin/Documents/New%20project/pr/docs/architecture-map.md) - карта ролей, доменов и целевых модулей.
3. [docs/release-notes-for-team.md](/Users/maksimglazyrin/Documents/New%20project/pr/docs/release-notes-for-team.md) - практические заметки по замене архивной версии, запуску и разворачиванию.
4. [docs/product-language.md](/Users/maksimglazyrin/Documents/New%20project/pr/docs/product-language.md) - словарь интерфейса и язык продукта.

## Railway (самый быстрый способ)
1) Залей проект в GitHub.
2) Railway → New Project → Deploy from GitHub Repo.
3) Railway → Add Plugin → PostgreSQL.
4) В сервисе **Web** → Variables:
   - `DATABASE_URL` (обычно Railway добавляет сам после подключения Postgres)
   - `SESSION_SECRET` (обязательный длинный случайный текст)
   - `ADMIN_PHONE`, `ADMIN_PIN`, `ADMIN_FIO` для первичного администратора
   - `DISPATCHER_PHONE=+7 936 004-67-42` для кнопки связи арендатора с диспетчером
5) Web → Settings → Start Command: `npm start` (по умолчанию)
6) Web → Networking → Domain → Generate Domain.

Приложение само создаст таблицы в БД и создаст первичного админа только если заданы `ADMIN_PHONE` и `ADMIN_PIN`.

## Локально
```bash
npm i
cp .env.example .env
# заполнить DATABASE_URL, SESSION_SECRET, ADMIN_PHONE, ADMIN_PIN
npm start
```
Открой: http://localhost:8080

Для проверки без PostgreSQL можно запустить временное in-memory хранилище. Данные живут только до остановки процесса:

```bash
DEV_MEMORY_DB=true SESSION_SECRET=replace-with-secret ADMIN_PHONE=79000000000 ADMIN_PIN=RuntimeAdmin1234 GATEWAY_BASE_URL=http://127.0.0.1:9090 GATEWAY_KEY=dev-gateway-key PORT=18080 node server.js
```

Без `DEV_MEMORY_DB=true` приложению нужен `DATABASE_URL` или `PG_URL`. Если база недоступна, сервер не стартует: это защищает от "полуживого" запуска без пользователей, журналов и сессий.

PIN/пароли пользователей хранятся как `scrypt`-хеш. Старые открытые PIN автоматически перехешируются после успешного входа.
Пароли не отправляются в приветственном письме по умолчанию. Для старого поведения нужно явно задать `MAIL_INCLUDE_PASSWORD=true`.

## Передача доступа новым пользователям
1) Администратор создает пользователя в разделе **Люди**.
2) Если поле "Пароль" пустое, система генерирует временный пароль, сохраняет его только как `scrypt`-хеш и показывает администратору один раз.
3) Если задан email, письмо отправляется пользователю. По умолчанию пароль в письме не раскрывается: пользователь видит, что пароль нужно получить у администратора.
4) Если нужно отправлять пароль прямо в письме, явно включите `MAIL_INCLUDE_PASSWORD=true`, но это менее безопасный режим.
5) При сбросе пароля новый временный пароль также показывается администратору один раз.

## Обновление существующего сервера
1) Сделайте бэкап текущей базы PostgreSQL.
2) Замените код приложения, не копируя `node_modules`, `.env`, `data`, `public/data`, `.DS_Store`, `devices.json`.
3) На сервере выполните `npm ci`.
4) Проверьте переменные окружения: `DATABASE_URL`/`PG_URL`, `SESSION_SECRET`, `ADMIN_PHONE`, `ADMIN_PIN`, `APP_BASE_URL`, `GATEWAY_BASE_URL`, `GATEWAY_KEY`, `DISPATCHER_PHONE`.
5) Запустите `npm start`. Миграции таблиц выполняются автоматически при старте.
6) После старта проверьте `/health`, вход администратора, открытие тестового устройства и журнал транзита.

## Эмуляция сценариев
Без PostgreSQL и без реального оборудования можно проверить основные сценарии:

```bash
node scripts/emulate-scenarios.js
```

Скрипт использует локальные тестовые данные и моделирует вход пользователей, права по зонам, открытие устройства, запрет доступа и запись журнала.
Это полезная логическая проверка сценариев, но не полноценный production end-to-end тест реального auth/mail/gateway контура.

Для запуска приложения с эмулятором шлюза:

```bash
GATEWAY_KEY=dev-gateway-key node scripts/mock-gateway.js
GATEWAY_BASE_URL=http://127.0.0.1:9090 GATEWAY_KEY=dev-gateway-key SESSION_SECRET=replace-with-secret DATABASE_URL=postgresql://... node server.js
```
