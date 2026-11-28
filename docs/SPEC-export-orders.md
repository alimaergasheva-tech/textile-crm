# SPEC — Модуль «Экспортный заказ» (textile-crm)

> Стек наследуется от textile-crm (API, PostgreSQL/Neon, web на Vercel, Telegram Mini App). Названия таблиц ниже — логические; сверить с существующей схемой (clients, deals, products/BOM, warehouse, production, defects) и переиспользовать, не дублировать.

## 1. Модель данных (новые таблицы)
```
export_orders(id, deal_id→deals, client_id→clients, brand, collection, po_no, incoterms='FOB',
  currency='USD', target_exfactory date, status, total_qty, created_by, created_at)
export_models(id, order_id, code 'SET44.01', tee_pattern_id, skirt_pattern_id,
  fabric_top_id, fabric_bottom_id, fabric_rib_id null, trim_note, qty, size_ratio jsonb,
  photo_url, pattern_confirmed bool)
patterns(id, code 'GKT1', kind 'tee|skirt', version_date, notes)
pattern_measures(id, pattern_id, name, tolerance, values jsonb {"122":42.5,...})
fabrics(id, code, name, composition, gsm, price_usd_kg, kind 'main|rib|aop', supplier_id)
accessories(id, code, name, unit, price_usd, supplier_id)
calc_versions(id, order_id, version, params jsonb {waste_main,waste_rib,rib_width,margin,cmt,capacity,...},
  fabric_total jsonb, acc_total jsonb, cost jsonb, created_by, created_at, is_approved)
calc_fabric_lines(id, calc_id, model_id, part 'top|bottom|rib', fabric_id, kg_per_pc jsonb, qty jsonb, total_kg, override_kg_per_pc null)
calc_acc_lines(id, calc_id, model_id, accessory_id, qty, cost)
quotes(id, order_id, calc_id, version, price_per_set, total, lead_time_days, valid_until, status 'draft|sent|confirmed|rejected', confirmed_at, confirmation_file)
purchase_orders(id, order_id, supplier_id, kind 'fabric|accessory', status, currency, total, eta, doc_urls)
purchase_order_lines(id, po_id, fabric_id|accessory_id, qty, unit, price)
receipts(id, po_id, qty_fact, shrinkage_pct, gsm_fact, shade_note, inspector_id, date)
plan_tasks(id, order_id, no, stage, title, owner_role, duration_wd, predecessors int[], start, finish,
  actual_start, actual_finish, pct, lag_wd)
samples(id, model_id, kind '1fit|pp', version, planned_ready, ready_at, sent_at, carrier, awb,
  received_at, status, approved_at, client_comment, photo_urls)
inspections(id, order_id, model_id, aql_major=2.5, aql_critical=0, lot_size, code_letter, sample_n, ac, re,
  inspector_id, date, found_critical, found_major, found_minor, result 'pass|fail', summary, pdf_url)
inspection_checks(id, inspection_id, check_name, result 'ok|remark|fail|na', comment)
inspection_measures(id, inspection_id, point, size, spec, tol, values jsonb, result)
inspection_defects(id, inspection_id, category 'critical|major|minor|general', description, qty, size, photo_urls)
shipments(id, order_id, cartons, packing_list jsonb, awb_bl, status, shipped_at)
```

## 2. Алгоритмы
### 2.1 Площадь кроя (см²) на изделие по размеру
- GKT1 / GKT19: `(chest + hem)/2 × (front_len + back_len) + (sleeve_top + sleeve_bottom) × sleeve_len`
- GKT11 (укороченная): `(chest + hem)/2 × (front_len + back_len) × (1 + sleeve_allowance)`
- GSH06: `2×(lower_len×lower_hem + upper_len×upper_hem + shorts_len×hip) + yoke_len × 2 × cut_width`
- GSH04: `2×hip×side_len + 2×belt_h×belt_stretched + (R_top+R_bot)/2×R_len + (L_top+L_bot)/2×L_len`
- Рибана: GKT1 `2×½ планки`; GKT19 `длина канта`; ширина полосы = параметр.
### 2.2 Расход
`kg_pc = area_cm2 × gsm / 1e7 × (1+waste)`; `kg_total = Σ_size kg_pc × qty × ratio`; метры = `kg×1000/(gsm×width_m)`.
Если задан `override_kg_per_pc` (норма раскладки) — берётся он.
### 2.3 Фурнитура
- GSH06: шнур и резинка по таблице размеров (см), 2 наконечника на шнур. GSH04: резинка = 2×собранный пояс + 2 см; бантик — длина по параметру.
- Термотрансфер: малый для 122–146, большой для 152–158 (PDF VTEME). Картонник, полибэг, короба = qty × (1+запас) (короб: qty / комплектов в коробке).
### 2.4 Цена
`cost = fabric + accessories + other + CMT`; `price = cost / (1 − margin)`; логистика — отдельно.
### 2.5 План (Gantt)
`start = WORKDAY(max(finish предшественников), +1)`, `finish = WORKDAY(start, duration−1)`; пошив: `ceil(total_sets / capacity)`.
Критический путь — цепочка предшественников с нулевым запасом; отставание = `target_exfactory − finish(last)`.
### 2.6 AQL (ISO 2859-1, уровень II, одноступенчатый, нормальный)
| Партия | Код | n | Ac/Re (AQL 2.5) |
|---|---|---|---|
| 151–280 | G | 32 | 2/3 |
| 281–500 | H | 50 | 3/4 |
| 501–1 200 | J | 80 | 5/6 |
| 1 201–3 200 | K | 125 | 7/8 |
| 3 201–10 000 | L | 200 | 10/11 |
| 10 001–35 000 | M | 315 | 14/15 |
| 35 001–150 000 | N | 500 | 21/22 |
Решение: `critical>0 → FAIL`; `major ≤ Ac → PASS`, иначе FAIL. Выборка распределяется по размерам пропорционально долям сетки. Для партий < 151 — справочник стандарта (расширить).

## 3. Шаблон плана (23 задачи по умолчанию)
| № | Задача | Дн. | Предш. |
|---|---|---|---|
| 1 | Получение запроса, ТЗ, табели | 1 | — |
| 2 | Черновой расчёт расхода | 2 | 1 |
| 3 | Запрос цен Узтекс / Eren | 3 | 2 |
| 4 | Себестоимость, сроки, КП | 2 | 3 |
| 5 | Подтверждение цены и сроков клиентом | 3 | 4 |
| 6 | Финальный расход (раскладки) | 3 | 5 |
| 7 | Заказ полотна Узтекс | 2 | 6 |
| 8 | Заказ фурнитуры Eren | 2 | 6 |
| 9 | 1-fit образцы | 7 | 5 |
| 10 | Отправка 1-fit в США | 5 | 9 |
| 11 | Подтверждение 1-fit | 4 | 10 |
| 12 | Производство полотна Узтекс | 20 | 7 |
| 13 | Доставка полотна | 3 | 12 |
| 14 | Фурнитура Eren (произв. + доставка) | 15 | 8 |
| 15 | Входной контроль | 2 | 13,14 |
| 16 | PP образцы | 5 | 11,15 |
| 17 | Отправка PP в США | 5 | 16 |
| 18 | Подтверждение PP | 4 | 17 |
| 19 | Раскрой | 5 | 18 |
| 20 | Пошив | авто | 19 |
| 21 | Термотрансфер, финишинг, упаковка | 5 | 20 |
| 22 | Инспекция AQL 2.5 + отчёт | 2 | 21 |
| 23 | Отгрузка в США | 3 | 22 |
Шаблон редактируем на заказ; сохранение как «шаблон процесса».

## 4. API (REST, префикс /api/export)
- `POST /orders` (из лида), `GET /orders/:id`, `PATCH /orders/:id`
- `POST /orders/:id/import-status` (xlsx), `POST /patterns/import` (xlsx табелей)
- `GET/POST /orders/:id/models`
- `POST /orders/:id/calc` → создаёт версию расчёта; `GET /calc/:id`, `GET /calc/:id/export.xlsx`, `POST /calc/:id/approve`
- `POST /orders/:id/quotes`, `POST /quotes/:id/send|confirm`
- `GET /orders/:id/plan`, `POST /orders/:id/plan/recalc`, `PATCH /plan/tasks/:id`
- `POST /orders/:id/purchase-orders` (из сводки расчёта), `PATCH /purchase-orders/:id`, `POST /purchase-orders/:id/receipt`
- `GET/POST /models/:id/samples`, `PATCH /samples/:id` (отправка/AWB/получение/статус), `POST /samples/:id/client-response`
- `POST /orders/:id/inspections`, `POST /inspections/:id/defects` (multipart, фото), `POST /inspections/:id/finalize` → PDF
- `POST /orders/:id/shipments`
Права: по ролям; клиент — только свой заказ (КП, образцы, отчёт AQL).

## 5. Экраны (web + Mini App)
1. **Заказ** — шапка, воронка этапов, вкладки: Модели, Расчёт, КП, Gantt, Закупки, Образцы, Производство, AQL, Отгрузка, Файлы, История.
2. **Модели** — таблица 10 моделей, импорт Status, подтверждение выкроек.
3. **Расчёт** — параметры (отход, маржа, CMT, мощность), таблицы расхода по моделям/размерам, сводка Узтекс, фурнитура Eren, себестоимость; кнопка «Создать КП».
4. **Gantt** — полосы по неделям/дням, зависимости, красные задачи при опоздании, «что если».
5. **Образцы** — таблица модель×(1-fit, PP) со статус-чипами; форма отправки (дата, AWB, перевозчик); кнопка клиента «Одобрить/Комментарий».
6. **AQL (Mini App)** — выбор модели → план выборки → чек-лист → замеры → дефекты с фото с камеры → итог PASS/FAIL → PDF.
7. **Клиентский портал** — КП, статусы, образцы, отчёты AQL.

## 6. Уведомления
Telegram: подтверждение цены; PO создан/отправлен; полотно/фурнитура получены; образец отправлен (с AWB); образец одобрен/отклонён; задача просрочена >1 дня; отчёт AQL готов (ссылка на PDF).

## 7. Отчёт AQL (PDF)
Шапка (клиент, PO, модель, дата, инспектор), параметры выборки (партия, n, Ac/Re), итог PASS/FAIL, чек-лист, таблица замеров с допусками, дефекты с фото (по 2 в ряд, подпись, категория), заключение, подписи. Логотип Export Product, нумерация страниц.

## 8. Тесты (минимум)
- Импорт Status-файла из этого заказа: 10 моделей, 35 000 комплектов (при 3 500).
- Расчёт: итог полотна 5 214 кг (расчётный, без запаса) на исходных параметрах; расхождение с xlsx-моделью < 1%.
- Gantt: последняя задача 08.04.2027 при старте 30.11.2026 и мощности 1 500 комплектов/день.
- AQL: партия 3 500 → код L, n=200, Ac=10, Re=11.
- Права: клиент не видит себестоимость и маржу.

---
# Дополнение v2 (SPEC): многопользовательность, оповещения, ВЭД, логистика

## 9. Одновременная работа
- Нагрузочная цель: 10 одновременных пользователей на заказ (рабочий запас 30 на фабрику); p95 API < 500 мс на чтение.
- Оптимистичная блокировка: во всех изменяемых таблицах поле `version int`; `PATCH` принимает `If-Match: version`; при несовпадении — `409` и показ различий.
- Мягкие замки редактирования для расчёта и инспекции: `edit_locks(entity, entity_id, user_id, expires_at)` (TTL 2 мин, продление heartbeat).
- Realtime: SSE/WebSocket-канал `order:{id}`; события `task.updated`, `sample.updated`, `plan.recalculated`, `comment.created`.
- Хостинг: учитывать ограничения serverless (Vercel) для постоянных соединений — для realtime использовать SSE с переподключением или внешний сервис (Pusher/Ably/Supabase Realtime) либо отдельный Node-сервис. Подключения к Neon — через pooler.

## 10. Отделы и роли
Таблицы: `departments(id, code, name, head_user_id, telegram_chat_id)`, `user_departments(user_id, department_id)`. Расширить `plan_tasks`: `department_id`, `assignee_id`, `status 'todo|in_progress|blocked|done'`, `delay_reason_id`, `notify_state jsonb`.
Права: действия по этапам разрешены своему отделу; остальным — чтение и комментарии; директор — всё.

## 11. Оповещения о просрочках
- Задание планировщика (cron каждые 15 мин + пересчёт при событии): для каждой незавершённой задачи вычислить `delay_days = max(0, today − finish)` и `due_in = finish − today`.
- Правила (таблица `notification_rules`, редактируемая):
  | Условие | Кому | Канал |
  |---|---|---|
  | due_in = 1 | исполнитель | Telegram |
  | delay_days ≥ 1 | исполнитель + руководитель отдела | Telegram + CRM |
  | delay_days ≥ 3 или критический путь | + директор + владельцы зависимых задач | Telegram + CRM |
  | пересчёт сдвигает Ex-factory | директор, менеджер, ВЭД, логистика | Telegram |
- Идемпотентность: `notifications(id, task_id, rule_id, user_id, level, sent_at)` — одно уведомление уровня на задачу; повтор — по эскалации.
- Утренняя сводка по отделу (08:30 Asia/Tashkent): просрочено / на сегодня / блокирует других.
- Telegram: личные сообщения + групповой чат отдела (`departments.telegram_chat_id`), кнопки «Принято», «Указать причину», «Перенести срок» (с согласованием).

## 12. Модуль ВЭД
```
ved_documents(id, order_id, shipment_id, doc_type 'packing_list|invoice|cmr|gtd|st1|other',
  number, issued_at, status 'draft|review|signed|sent', file_url, version, data jsonb, owner_id)
hs_codes(id, product_group, hs_code, description)            -- коды ТН ВЭД по группам (футболка, юбка-шорты, комплект)
ved_templates(id, doc_type, template_file, fields jsonb)
shipment_packages(id, shipment_id, carton_no, model_id, size, qty, net_kg, gross_kg, dims_cm, volume_m3)
```
Генерация:
- **Packing List** — из `shipment_packages`: короб №, модель, размер, шт, нетто/брутто, габариты, м³; итоги.
- **Invoice** — из подтверждённой цены КП: позиции по моделям, цена FOB, сумма, Incoterms, реквизиты сторон.
- **CMR** — из заявки логистики (перевозчик, водитель, номер ТС, пункт загрузки/разгрузки, места, вес, объём).
- **ГТД** — коды ТН ВЭД, статистическая стоимость, вес, количество; вводится/проверяется ВЭД, прикладывается подписанный файл.
- **СТ-1** — данные о происхождении и инвойс; статус выдачи/получения.
Контроль: `shipment.can_close = все обязательные документы в статусе signed/sent`; иначе API возвращает 422 со списком недостающих.
API: `GET/POST /shipments/:id/documents`, `POST /documents/:id/generate`, `PATCH /documents/:id` (статус, файл), `GET /shipments/:id/checklist`.

## 13. Логистика и расчёт м³
```
vehicle_types(id, name, volume_m3, max_payload_kg)        -- напр. тент 82 м³
carton_specs(id, model_group, l_cm, w_cm, h_cm, units_per_carton, gross_kg)
freight_bookings(id, shipment_id, carrier, vehicle_type_id, vehicles_qty, load_at, route, cost, currency,
  plate_no, driver, status 'request|confirmed|assigned|loaded|in_transit|delivered', awb_or_cmr_no)
```
Расчёт: `cartons = ceil(qty / units_per_carton)`; `volume_m3 = Σ cartons × l×w×h / 1e6 × (1 + pallet_gap)`; `weight = Σ cartons × gross_kg`; `vehicles = ceil(max(volume_m3 / vehicle.volume_m3, weight / vehicle.max_payload))`.
API: `POST /shipments/:id/freight/calc`, `POST /shipments/:id/freight/booking`, `PATCH /freight/:id`. После назначения ТС реквизиты автоматически попадают в CMR.

## 14. Новые тесты
- 10 одновременных пользователей меняют разные задачи одного заказа: потерь данных нет; одновременная правка одной карточки даёт 409.
- Просрочка задачи на 1/3 дня вызывает уведомления согласно правилам и без дублей.
- Закрытие отгрузки без ГТД или СТ-1 → 422.
- Для 35 000 комплектов, 40 шт в коробе и коробе 60×40×40 см: 880 коробов (с запасом 3%) ≈ 93 м³ с запасом укладки 10% → 2 машины по 82 м³ (параметры редактируемы).
