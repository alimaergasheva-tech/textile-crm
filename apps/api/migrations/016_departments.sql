-- Этап 9.5 «Отделы и многопользовательская работа»:
-- отделы и их состав, задачи отдела со статусом, версии записей (оптимистичная блокировка),
-- мягкие замки редактирования, лента изменений для живого обновления экранов.

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  head_user_id uuid,
  telegram_chat_id bigint,                         -- групповой чат отдела для уведомлений
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, head_user_id) REFERENCES users (tenant_id, id)
);

CREATE TABLE user_departments (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  department_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (department_id, user_id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_departments_user_idx ON user_departments (tenant_id, user_id);

-- Задачи: отдел-владелец, статус, причина блокировки, версия для защиты от потери правок.
ALTER TABLE tasks
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD COLUMN department_id uuid,
  ADD COLUMN status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','done')),
  ADD COLUMN blocked_reason text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id);
UPDATE tasks SET status = 'done' WHERE done_at IS NOT NULL;
CREATE INDEX tasks_department_idx ON tasks (tenant_id, department_id, done_at);

ALTER TABLE deals ADD COLUMN version int NOT NULL DEFAULT 1;

-- Мягкие замки: «сейчас это редактирует Иван». Живут 2 минуты, продлеваются, сами истекают.
CREATE TABLE edit_locks (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  user_id uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, entity, entity_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- Лента изменений: экраны опрашивают её раз в несколько секунд и обновляют данные.
-- Работает на любом хостинге (в том числе serverless), в отличие от постоянных соединений.
CREATE TABLE realtime_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  channel text NOT NULL,                           -- tasks | deals | locks | departments | ...
  kind text NOT NULL,                              -- created | updated | moved | locked | unlocked ...
  entity text,
  entity_id uuid,
  actor_id uuid,
  payload jsonb,                                   -- только идентификаторы и коды, без персональных данных
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX realtime_events_idx ON realtime_events (tenant_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['departments','user_departments','edit_locks','realtime_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE realtime_events_id_seq TO crm_app;

INSERT INTO permissions (code, module, action, description) VALUES
 ('departments.view','departments','view','Просмотр отделов и их состава'),
 ('departments.manage','departments','manage','Создание отделов, назначение сотрудников');

-- Отделы для уже существующих фабрик (новым создаёт provisionTenant).
INSERT INTO departments (tenant_id, code, name, sort)
SELECT t.id, d.code, d.name, d.sort FROM tenants t,
 (VALUES ('sales','Продажи',1),('tech','Технологи',2),('purchasing','Закупки',3),('qc','ОТК',4),
         ('production','Производство',5),('ved','ВЭД',6),('logistics','Логистика',7),('management','Дирекция',8)) AS d(code,name,sort);

-- Новые роли: ВЭД, логистика, планировщик.
INSERT INTO roles (tenant_id, code, name, is_system)
SELECT t.id, r.code, r.name, true FROM tenants t,
 (VALUES ('ved','Специалист ВЭД'),('logistics','Логист'),('planner','Планировщик')) AS r(code, name);

-- Права: владелец и админ — всё новое; остальные — просмотр отделов.
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p.code, false FROM roles r JOIN permissions p ON p.module = 'departments'
 WHERE r.code IN ('owner','admin');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'departments.view', false FROM roles r
 WHERE r.code NOT IN ('owner','admin','foreman','brigadier');

-- Задачи для отделов, у которых их ещё не было: видят свои задачи и задачи своего отдела (own_only).
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p.code, true FROM roles r JOIN permissions p ON p.module = 'tasks'
 WHERE r.code IN ('technologist','production_head','qc','storekeeper','purchaser','ved','logistics','planner')
   AND p.action IN ('view','create','edit')
ON CONFLICT DO NOTHING;
-- Роли ВЭД и логистики: файлы, заказы и отгрузки на просмотр (полные права появятся на этапах 18–19).
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p, false FROM roles r, unnest(ARRAY['files.view','files.create','orders.view','shipments.view','warehouse.view']) p
 WHERE r.code IN ('ved','logistics')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p, false FROM roles r, unnest(ARRAY['files.view','orders.view','production.view']) p
 WHERE r.code = 'planner'
ON CONFLICT DO NOTHING;
