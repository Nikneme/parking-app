# Инвентаризация и передача контроля

Документ предназначен для заполнения при фактической передаче Программного комплекса Заказчику.

## 1. Репозиторий и кодовая база

| Параметр | Значение |
|---|---|
| Репозиторий | TBD |
| Production branch | TBD |
| Последний production commit | TBD |
| Кто имеет admin-доступ | TBD |
| Кто имеет write-доступ | TBD |
| История версий передана | Да / Нет |
| Production-версия совпадает с Git | Да / Нет |

Проверка:

```bash
git remote -v
git branch --show-current
git rev-parse HEAD
git status
```

## 2. Облачная и серверная инфраструктура

| Компонент | Провайдер/адрес | Доступ передан | Владелец Заказчика | Комментарий |
|---|---|---:|---|---|
| Yandex Cloud folder | TBD | Да / Нет | TBD |  |
| VM / container | TBD | Да / Нет | TBD |  |
| Railway service, если используется | TBD | Да / Нет | TBD |  |
| Unit/process manager | TBD | Да / Нет | TBD |  |
| Logs/monitoring | TBD | Да / Нет | TBD |  |

## 3. Домен, DNS, почта, SSL

| Ресурс | Значение | Доступ передан | Срок продления | Ответственный |
|---|---|---:|---|---|
| Домен | moyaparkovka.ru | Да / Нет | TBD | TBD |
| DNS provider | TBD | Да / Нет | TBD | TBD |
| SSL-сертификат | TBD | Да / Нет | TBD | TBD |
| Почтовый ящик | mmoyaparkovka@yandex.ru | Да / Нет | TBD | TBD |
| SMTP-доступ | TBD | Да / Нет | TBD | TBD |

## 4. База данных и backup

| Параметр | Значение |
|---|---|
| Тип БД | PostgreSQL |
| Production DSN location | Environment variables / protected secret store |
| Backup передан | Да / Нет |
| Backup file/date | TBD |
| Restore-процедура передана | Да |
| Миграции/схема описаны | Да |

Команды:

```bash
npm run db:backup
CONFIRM_RESTORE=YES npm run db:restore -- <backup.dump>
```

## 5. Переменные окружения

Секретные значения не фиксируются в документе открытым текстом. Фиксируется место хранения и ответственный.

| Переменная | Назначение | Secret | Где хранится | Ответственный |
|---|---|---:|---|---|
| NODE_ENV | Режим запуска | Нет | Platform variables | TBD |
| DATABASE_URL / PG_URL | Подключение к PostgreSQL | Да | Secret store | TBD |
| SESSION_SECRET | Подпись сессий | Да | Secret store | TBD |
| DEVICE_SECRET_ENCRYPTION_KEY | Шифрование device secrets | Да | Secret store | TBD |
| ADMIN_PHONE | Bootstrap admin login | Да | Secret store | TBD |
| ADMIN_PIN | Bootstrap admin temporary password | Да | Secret store | TBD |
| GATEWAY_BASE_URL | Gateway API URL | Нет | Platform variables | TBD |
| GATEWAY_KEY | Gateway API key | Да | Secret store | TBD |
| SMTP_HOST | SMTP host | Нет | Platform variables | TBD |
| SMTP_USER | SMTP user | Да | Secret store | TBD |
| SMTP_PASS | SMTP password | Да | Secret store | TBD |

## 6. Внешние API и сервисы

| Интеграция | Назначение | Переменные | Владелец | Ротация |
|---|---|---|---|---|
| Gateway/controllers API | Открытие устройств | GATEWAY_BASE_URL, GATEWAY_KEY | TBD | После передачи и далее по регламенту |
| SMTP | Email-уведомления | SMTP_* | TBD | После передачи и далее по регламенту |
| PostgreSQL | Хранение данных | DATABASE_URL/PG_URL | TBD | После передачи и далее по регламенту |

## 7. Контроллеры, устройства и зоны

Актуальная карта устройств должна быть экспортирована из БД/админки и приложена к акту передачи.

| Устройство | Зона | URL/IP | Auth type | Ответственный | Комментарий |
|---|---|---|---|---|---|
| TBD | TBD | TBD | none/basic/etc | TBD |  |

## 8. Административные и сервисные учётные записи

| Учётная запись | Тип | Назначение | Владелец | Ротация выполнена | Комментарий |
|---|---|---|---|---:|---|
| Bootstrap admin | App superadmin | Первичный вход | Заказчик | Да / Нет | Пароль сменить при первом входе |
| DB user | PostgreSQL | Runtime app | Заказчик | Да / Нет |  |
| Gateway key | Integration secret | Управление устройствами | Заказчик | Да / Нет |  |
| SMTP user | Mail service | Email | Заказчик | Да / Нет |  |

## 9. Автоматическая инвентаризация

Для формирования машинного inventory:

```bash
npm run ops:inventory
```

Результат создаётся в:

```text
reports/ops-inventory.json
```

Файл можно приложить к акту передачи после проверки и удаления чувствительных значений.
