# Шаблон акта / отчёта приёмки выполнения Приложения № 1

## 1. Общие сведения

| Поле | Значение |
|---|---|
| Проект | «Моя парковка» |
| Домен | moyaparkovka.ru |
| Дата проверки | TBD |
| Представитель Заказчика | TBD |
| Представитель Исполнителя | TBD |
| Production commit/tag | TBD |

## 2. Промежуточная фиксация по этапам

| Этап | Выполнено | Материалы переданы | Риски устранены | Остаток |
|---|---:|---|---|---|
| 1. Передача контроля | Да / Частично / Нет | Репозиторий, инфраструктура, домен, БД | Единоличное владение снижено | TBD |
| 2. Безопасность | Да / Частично / Нет | Код, конфигурация, отчёт hardening | PIN, CSRF, перебор, публичные данные | TBD |
| 3. Документация | Да / Частично / Нет | deployment, update, backup, architecture | Устная зависимость снижена | TBD |
| 4. Регламенты | Да / Частично / Нет | backup/update/access regulations | Эксплуатация формализована | TBD |
| 5. Инвентаризация | Да / Частично / Нет | inventory, handover register | Карта зависимостей создана | TBD |

## 3. Проверки безопасности

| Проверка | Ожидаемый результат | Фактический результат |
|---|---|---|
| PIN хранится как хэш | Нет открытого PIN в `public.users.pin` | TBD |
| Первый вход | Перенаправление на `/change-password` | TBD |
| POST без CSRF | 403 | TBD |
| `/data/users.json` | 404 | TBD |
| `/.git/config` | 404/403 | TBD |
| Rate limiting | Блокировка серии ошибок | TBD |
| Audit | События входа/ошибок/изменений видны | TBD |
| Device secret | Пароль хранится зашифрованным | TBD |
| Production demo seed | Reference-устройства не создаются автоматически | TBD |

## 4. Эксплуатационные проверки

| Проверка | Команда/маршрут | Результат |
|---|---|---|
| Health | `/health` | TBD |
| Smoke | `npm run smoke:runtime` | TBD |
| Inventory | `npm run ops:inventory` | TBD |
| Backup | `npm run db:backup` | TBD |
| Restore test | `CONFIRM_RESTORE=YES npm run db:restore -- <file>` | TBD |

## 5. Переданные материалы

- Git repository access: Да / Нет.
- Production branch/commit: Да / Нет.
- Infrastructure access: Да / Нет.
- Domain/DNS/SSL access: Да / Нет.
- Mailbox/SMTP access: Да / Нет.
- PostgreSQL access: Да / Нет.
- Current DB backup: Да / Нет.
- Env variable register: Да / Нет.
- Admin/service access register: Да / Нет.
- Documentation package: Да / Нет.

## 6. Решение

По результатам проверки Стороны фиксируют:

- мероприятия выполнены полностью / частично;
- замечания: TBD;
- срок устранения замечаний: TBD;
- ответственное лицо: TBD.

## 7. Подписи

| Сторона | ФИО | Подпись | Дата |
|---|---|---|---|
| Заказчик | TBD |  |  |
| Исполнитель | TBD |  |  |
