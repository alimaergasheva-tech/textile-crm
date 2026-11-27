# SPEC: техническая спецификация SaaS CRM для текстильных фабрик

Версия от 23.11.2026

## 1. Архитектура и стек

Один модульный монолит (не микросервисы): проще разрабатывать и поддерживать, хватает для десятков фабрик. Модули внутри монолита общаются только через явные интерфейсы, чтобы потом можно было выделить часть.

| Компонент | Технология | Зачем |
| --- | --- | --- |
| Веб-клиент (офис) | React + TypeScript, Vite, TanStack Query | Канбан, таблицы, карточки, дашборды |
| Telegram Mini App | React + Telegram WebApp SDK, общая кодовая база UI-компонентов | Цех, склад, менеджеры, клиенты |
| API | NestJS (Node.js, TypeScript), REST + OpenAPI | Единый вход для веба, Mini App и будущей 1С |
| Реальное время | WebSocket (Socket.IO) | Обновление досок и статусов без перезагрузки |
| База данных | PostgreSQL + Row Level Security | Надёжные транзакции, изоляция фабрик |
| Очереди и кэш | Redis + BullMQ | Уведомления, фоновые задачи, сессии |
| Файлы и фото | S3-совместимое хранилище (MinIO или облако) | Фото брака, каталога, документы |
| Telegram-бот | grammY или Telegraf в том же монолите | Уведомления, кнопка входа в Mini App |
| Поиск | PostgreSQL full-text (pg_trgm); отдельный поисковик только если понадобится | Поиск по артикулу, клиенту, заказу |
| Деплой | Docker Compose на старте, затем Kubernetes при росте | Простой запуск, масштабирование позже |

Репозиторий — один монорепо: `apps/web`, `apps/miniapp`, `apps/api`, `packages/ui`, `packages/shared` (типы и валидация общие для всех). Модули API: `auth`, `tenants`, `crm`, `catalog`, `warehouse`, `production`, `feedback`, `notifications`, `files`, `audit`.

## 2. Мультитенантность, авторизация, права

**Изоляция фабрик (SAAS-1).** Одна общая база, в каждой таблице данных есть `tenant_id`. В PostgreSQL включён Row Level Security: правило `tenant_id = current_setting('app.tenant_id')`. API на каждый запрос устанавливает это значение из токена, а не из запроса. Тест: пользователь фабрики A ни при каком запросе не получает строки фабрики B. Панель владельца платформы работает под отдельной ролью БД и пишет в журнал каждый вход «от имени фабрики».

**Вход.**
- Веб: логин + пароль (хеш argon2), короткий access JWT (15 мин) + refresh-токен в httpOnly cookie.
- Mini App: проверка подписи `initData` на сервере (HMAC по токену бота), потом тот же JWT. Привязка Telegram-аккаунта к пользователю — по одноразовой ссылке-приглашению от руководителя.
- Клиенты фабрики входят в Mini App по приглашению менеджера и видят только свои данные.

**Права (RBAC).** Таблицы `roles` и `permissions`; право = `модуль.действие` (например `warehouse.write`, `finance.cost.read`). Проверка на уровне API через декоратор на каждом эндпоинте; дополнительно ограничение «только свои записи» (менеджер — свои сделки, бригадир — свои задания). Себестоимость и закупочные цены не отдаются в ответе без этого права.

**Журнал действий (`audit_log`).** Кто, когда, что, было → стало (JSON) для заказов, цен, движений склада, прав и входов; записи не редактируются и не удаляются.

## 3. Схема базы данных

Во всех таблицах кроме `tenants`: `id` (UUID), `tenant_id`, `created_at`, `updated_at`, `created_by`, `deleted_at` (мягкое удаление), `external_id` (для 1С). Деньги — целые числа в минимальных единицах (тийин/центы) + `currency`; количества — `numeric(14,3)`. Ниже основные поля; служебные опущены.

| Таблица | Ключевые поля | Связи |
| --- | --- | --- |
| tenants | name, plan, status, limits, locale, currencies | — |
| users, roles, role_permissions, user_roles | login, password_hash, telegram_id, lang, is_active | users → roles (многие ко многим) |
| audit_log | actor_id, entity, entity_id, action, before, after | — |
| clients, contacts | name, type, price_list_id, credit_limit, address, tax_id | contacts → clients |
| leads | source_id, name, phone, status, owner_id | lead → client |
| pipeline_stages, deals | stage_id, client_id, amount, currency, owner_id, lost_reason_id | deal → client, stage |
| tasks, interactions | entity, entity_id, due_at, assignee_id, type, text | к любой сущности CRM |
| models | code, name, collection, season, category, fabric_composition | models → variants |
| size_grids, sizes, size_runs, size_run_items | name; size_id, qty в ряде | model → size_grid |
| variants | model_id, size_id, color_id, sku, barcode | один SKU на размер × цвет |
| materials | type (ткань, фурнитура, упаковка), unit, name, min_stock | — |
| bom_lines | model_id, material_id, qty_per_unit, size_id (необязательно), waste_percent | model → material |
| routes, route_operations | model_id, step, name, norm_minutes, piece_rate | model → операции |
| price_lists, prices | price_list_id, variant_id, amount, currency | variant → price |
| warehouses, locations | type (сырьё, НЗП, готовая), name | warehouse → locations |
| fabric_lots, fabric_rolls | material_id, color, width, density, length_or_weight, supplier_id | lot → rolls |
| stock_movements | type, variant_id/material_id/roll_id, qty, from_location, to_location, doc_type, doc_id | единственный источник остатков |
| reservations | order_item_id, variant_id, qty, status | order_item → variant |
| orders, order_items | client_id, deal_id, status, due_date, currency, total; item: variant_id, qty | order → deal |
| production_orders | order_id, model_id, status, priority, deadline, cutting_lot_code | order → prod. order |
| production_items | production_order_id, variant_id, planned_qty, done_qty | — |
| production_steps | production_order_id, route_operation_id, assignee_type, brigade_id/contractor_id, started_at, finished_at | step → operation |
| step_reports | step_id, user_id, qty, reported_at | отметки бригадира |
| brigades, brigade_members, contractors | name, leader_id, type | — |
| defects | step_id, variant_id, qty, reason_id, photo_ids, inspector_id | к партии и этапу |
| shipments, shipment_items | order_id, status, doc_number, shipped_at | shipment → order |
| feedback, complaints, complaint_reasons | rating, comment; complaint: order_id, variant_id, status, resolution_type, due_at | complaint → order, defect |
| notifications, notification_rules | channel, recipient_id, template, status; rule: event, condition | — |
| files | key, mime, size, entity, entity_id | к любой сущности |
| reference_values | kind, code, ru_name, uz_name | справочники фабрики |

**Индексы:** (`tenant_id`, `created_at`) на всех; уникальные (`tenant_id`, `sku`) и (`tenant_id`, `barcode`); (`tenant_id`, `status`, `due_date`) на заказах и заданиях; по движениям — (`tenant_id`, `variant_id`, `created_at`).

## 4. Бизнес-логика

Всё, что меняет остатки или статусы, выполняется в одной транзакции БД и пишется в `audit_log`.

### Остатки (WH-2, WH-4)
- Остаток = сумма `stock_movements` по позиции и ячейке; для скорости есть материализованная таблица `stock_balances`, которая обновляется в той же транзакции, что и движение. Ночная задача сверяет баланс с суммой движений.
- Отрицательный остаток запрещён (проверка `CHECK` + блокировка строки `SELECT ... FOR UPDATE`).
- Доступно = остаток − активные резервы.

### Заказ и резерв (PRD-1, CRM-6)
1. Сделка «Выиграна» → заказ со строками (вариант × количество; размерный ряд раскрывается в строки).
2. Проверка кредитного лимита клиента (долг + сумма заказа ≤ лимит); при превышении заказ ждёт подтверждения руководителя.
3. По каждой строке: `reserve = min(нужно, доступно)`; разница `shortage = нужно − reserve`.
4. Если `shortage > 0`, создаётся `production_order` на разницу; строки партии группируются по модели.
5. Отмена заказа снимает резерв; частичная отгрузка уменьшает резерв и создаёт расход.

### BOM и материалы (CAT-3, PRD-3)
- Потребность материала = Σ по строкам партии (`planned_qty × qty_per_unit × (1 + waste_percent/100)`); строка BOM с `size_id` перекрывает общую для этого размера.
- При запуске партии материалы резервируются; при раскрое списываются рулоны и фиксируется факт расхода; отклонение от нормы показывается в отчёте.
- Для ткани расчёт в единицах рулона (м или кг) с переводом плотность/ширина.

### Производство (PRD-2, PRD-5, PRD-6)
- Статусы задания: черновик → запланировано → в работе → ОТК → на складе → закрыто (любой → отменено). Переходы — конечный автомат в коде, другие переходы отклоняются.
- Этап закрывается, когда сумма `step_reports.qty` достигла плана или начальник закрыл вручную с причиной. Перевыполнение плана не допускается без подтверждения.
- Приёмка ОТК: годные изделия идут на склад готовой продукции (движение НЗП → готовая); брак фиксируется в `defects` и либо списывается, либо уходит на переделку.
- Подрядчик: передача кроя движением на локацию подрядчика; приёмка готовых — обратным движением через ОТК; разница по количеству — в акт расхождений.

### Рекламации (FB-2..FB-4)
- Статусы: новая → в работе → решена → закрыта. Решение «замена» создаёт новую строку заказа, «возврат» — движение прихода, «скидка» — корректировку долга клиента (поле «скидка» в заказе).
- Срок ответа `due_at` = создание + 48 часов; задача «эскалация» по просрочке. Оценка запрашивается через день после отгрузки (настраиваемо).

### Валюты
- Цена и сумма хранятся в валюте заказа; курс фиксируется в момент подтверждения и больше не меняется. Курс вводится вручную руководителем фабрики (без автоподтягивания в MVP).

## 5. API

REST, префикс `/api/v1`, JSON, описание в OpenAPI. Все списки: `?page&limit&sort&q` + фильтры; ответ `{data, meta:{total,page}}`; ошибки `{code, message, details}`. Изменяющие запросы одновременно имеют заголовок `Idempotency-Key` (важно для Mini App на слабом интернете, чтобы повтор не создавал дубль).

| Модуль | Эндпоинты |
| --- | --- |
| auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/telegram` (initData), `POST /invites`, `POST /invites/:code/accept` |
| users | `GET/POST /users`, `PATCH /users/:id`, `GET/POST /roles`, `PUT /roles/:id/permissions` |
| tenants (владелец платформы) | `GET/POST /admin/tenants`, `PATCH /admin/tenants/:id`, `POST /admin/tenants/:id/impersonate` |
| crm | `/leads`, `/clients`, `/contacts`, `/deals` (+ `PATCH /deals/:id/stage`, `POST /deals/:id/win`, `POST /deals/:id/lose`), `/tasks`, `/interactions`, `/quotes` (+ `GET /quotes/:id/pdf`) |
| catalog | `/models`, `/models/:id/variants`, `/size-grids`, `/size-runs`, `/models/:id/bom`, `/models/:id/route`, `/price-lists`, `/prices`, `GET /catalog/availability` |
| warehouse | `/warehouses`, `/locations`, `/materials`, `/fabric-lots`, `POST /stock/receipts`, `/stock/issues`, `/stock/transfers`, `/stock/writeoffs`, `GET /stock/balances`, `/stock/movements`, `POST /stock/inventory`, `POST /stock/scan` |
| orders | `/orders`, `POST /orders/from-deal/:dealId`, `POST /orders/:id/confirm`, `/orders/:id/cancel`, `GET /orders/:id/availability`, `/shipments`, `POST /shipments/:id/ship` |
| production | `/production-orders`, `POST /production-orders/:id/plan`, `/start`, `/steps/:id/report`, `/steps/:id/close`, `/brigades`, `/contractors`, `POST /contractors/:id/transfer`, `/receive`, `/defects`, `GET /production/board`, `/production/load` |
| feedback | `POST /feedback`, `GET /feedback`, `/complaints`, `PATCH /complaints/:id/status`, `POST /complaints/:id/resolve`, `GET /feedback/stats`, `POST /suggestions` |
| notifications | `GET /notifications`, `POST /notifications/:id/read`, `/notification-rules` |
| files | `POST /files/presign`, `POST /files/:id/confirm`, `GET /files/:id/url` |
| reference | `GET/POST /reference/:kind` (причины брака, источники лидов, причины проигрыша) |
| export | `GET /export/:entity.xlsx`, `POST /import/:entity` |
| audit | `GET /audit?entity&entity_id` |

Реальное время: WebSocket-каналы `deals`, `production-board`, `notifications`, изолированные по фабрике.

## 6. Экраны

### Веб (офис)
| Экран | Что на нём |
| --- | --- |
| Вход, выбор языка RU/UZ | Логин, восстановление пароля |
| Главная (дашборд) | Заказы в работе, просрочки, воронка, остатки ниже минимума, открытые рекламации |
| Лиды / Сделки | Канбан и список, фильтры, карточка сделки с таймлайном |
| Клиенты | Список, карточка: контакты, реквизиты, заказы, долг, рекламации, таймлайн |
| Каталог | Модели, матрица вариантов, модель: BOM, маршрут, цены, фото |
| КП | Подбор позиций матрицей размеров, наличие, скидка, экспорт PDF |
| Заказы | Список, карточка: позиции, резерв, производство, отгрузки, оплаты, журнал |
| Склад | Остатки по складам и ячейкам, движения, партии ткани, инвентаризация, минимальные остатки |
| Доска производства | Канбан по этапам, загрузка бригад, календарь, просрочки |
| Производственное задание | Позиции, этапы, исполнители, расход материалов vs норма, брак |
| Обратная связь | Оценки, рекламации со статусами и сроками, предложения сотрудников, статистика |
| Настройки | Пользователи и роли, этапы, справочники, курсы, автоправила, брендинг, приглашения в Telegram |
| Панель владельца платформы | Фабрики, тарифы, лимиты, блокировка, вход для поддержки |

### Telegram Mini App
| Роль | Экраны |
| --- | --- |
| Бригадир | Мои задания → задание → «Сделано N» (крупные кнопки «+1 / +5 / +10» и ввод числа) → «Брак» (причина, фото); скан партии; моя зарплата |
| ОТК | Очередь на приёмку → «Принять» / «Брак» с фото и причиной |
| Кладовщик | Приёмка, отгрузка по заказу, перемещение, инвентаризация; всё через сканер штрихкодов |
| Менеджер | Мои сделки и задачи, «Новый лид» за 3 поля, каталог с наличием, «Отправить КП» |
| Подрядчик | Переданный крой, приёмка готовых с количеством |
| Клиент | Каталог → заказ матрицей размеров → статус и сроки → долг и документы → оценка и рекламация |
| Все роли | «Сообщить о проблеме / предложить улучшение» (можно анонимно), уведомления, язык RU/UZ |

**Правила UX для Mini App:** крупные кнопки (от 44 px), максимум 3 нажатия до действия, тема Telegram, очередь неотправленных отметок при обрыве связи с повтором после восстановления (по `Idempotency-Key`), каждый экран из раздела открывается ≤ 1 сек.

## 7. Уведомления, фоновые задачи, тесты, деплой

**Уведомления.** Событие в системе → правило из `notification_rules` → задача в очереди → отправка в Telegram и в ленту внутри системы. Шаблоны на RU и UZ; повтор при ошибке до 5 раз с нарастающей паузой; лимит отправки с учётом ограничений Telegram.

**События MVP:** новый лид, сделка без движения N дней, смена статуса заказа, новое производственное задание бригаде, просрочка дедлайна, брак выше N%, остаток ниже минимума, новая рекламация, просроченный ответ по рекламации.

**Фоновые задачи (BullMQ).** Рассылка уведомлений; проверка просрочек каждые 15 минут; запрос оценки через день после отгрузки; ночная сверка остатков с движениями; бэкап базы раз в сутки; очистка неподтверждённых загрузок файлов.

**Тесты.**
- Модульные: остатки и резервы, расчёт потребности по BOM, переходы статусов, кредитный лимит, валюты.
- Интеграционные: полный сценарий из критериев приёмки PRD; изоляция фабрик (вариант A не видит B через API и базу); права ролей; повтор запроса с одним `Idempotency-Key`.
- Нагрузочные: 100 одновременных пользователей на одну фабрику и 5 фабрик, списки на 10 000 записей.
- Демо-данные (seed): 2 фабрики, по 10 моделей, 30 клиентов, 20 заказов, материалы и остатки.

**Деплой.** Три среды: local (Docker Compose), staging, production. CI: линтер, типы, тесты, сборка образов. Миграции базы — только вперёд и обратно совместимые. Мониторинг: журналы, ошибки (Sentry), метрики и алерты по доступности. Хостинг и расположение серверов — открытый вопрос из PRD.
