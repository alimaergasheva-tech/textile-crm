-- Этап 2 «CRM»: клиенты, контакты, лиды, воронка, сделки, задачи, история общения.
CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  type text NOT NULL DEFAULT 'wholesale' CHECK (type IN ('wholesale','corporate','retail','distributor')),
  price_type text NOT NULL DEFAULT 'wholesale' CHECK (price_type IN ('retail','wholesale','large_wholesale')),
  segment text,
  tax_id text,
  address text,
  delivery_addresses jsonb NOT NULL DEFAULT '[]',
  credit_limit bigint NOT NULL DEFAULT 0,          -- в минимальных единицах, валюта ниже
  credit_currency text NOT NULL DEFAULT 'UZS' CHECK (credit_currency IN ('UZS','USD')),
  owner_id uuid REFERENCES users(id),
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX clients_owner_idx ON clients (tenant_id, owner_id);
CREATE INDEX clients_name_idx ON clients (tenant_id, lower(name));

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  client_id uuid NOT NULL,
  name text NOT NULL,
  position text,
  phone text,
  email text,
  is_primary boolean NOT NULL DEFAULT false,
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX contacts_client_idx ON contacts (client_id);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  company text,
  phone text,
  email text,
  source_code text NOT NULL,                       -- обязателен (CRM-1), значение справочника lead_source
  note text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_work','converted','rejected')),
  owner_id uuid REFERENCES users(id),
  client_id uuid REFERENCES clients(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_owner_idx ON leads (tenant_id, owner_id, status);

CREATE TABLE pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  sort int NOT NULL DEFAULT 0,
  kind text NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id)
);

CREATE TABLE deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL,
  client_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  amount bigint NOT NULL DEFAULT 0,                -- минимальные единицы
  currency text NOT NULL DEFAULT 'UZS' CHECK (currency IN ('UZS','USD')),
  owner_id uuid REFERENCES users(id),
  lead_id uuid REFERENCES leads(id),
  expected_close date,
  lost_reason_code text,
  closed_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- Составные ключи: сделка не может ссылаться на клиента или этап другой фабрики
  -- (обычный внешний ключ проверяется в обход RLS).
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES pipeline_stages (tenant_id, id)
);
CREATE INDEX deals_stage_idx ON deals (tenant_id, stage_id);
CREATE INDEX deals_owner_idx ON deals (tenant_id, owner_id);
CREATE INDEX deals_client_idx ON deals (client_id);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL,
  due_at timestamptz,
  assignee_id uuid REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  entity text,                                     -- client | deal | lead
  entity_id uuid,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_assignee_idx ON tasks (tenant_id, assignee_id, done_at);
CREATE INDEX tasks_entity_idx ON tasks (tenant_id, entity, entity_id);

CREATE TABLE interactions (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('call','message','meeting','note','stage_change','system')),
  text text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interactions_entity_idx ON interactions (tenant_id, entity, entity_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients','contacts','leads','pipeline_stages','deals','tasks','interactions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE interactions_id_seq TO crm_app;

INSERT INTO permissions (code, module, action, description) VALUES
 ('clients.view','clients','view','Просмотр клиентов'),
 ('clients.create','clients','create','Создание клиентов'),
 ('clients.edit','clients','edit','Изменение клиентов'),
 ('clients.delete','clients','delete','Удаление клиентов'),
 ('leads.view','leads','view','Просмотр лидов'),
 ('leads.create','leads','create','Создание лидов'),
 ('leads.edit','leads','edit','Изменение лидов'),
 ('deals.view','deals','view','Просмотр сделок'),
 ('deals.create','deals','create','Создание сделок'),
 ('deals.edit','deals','edit','Изменение сделок, перенос по этапам'),
 ('deals.delete','deals','delete','Удаление сделок'),
 ('tasks.view','tasks','view','Просмотр задач'),
 ('tasks.create','tasks','create','Создание задач'),
 ('tasks.edit','tasks','edit','Изменение и закрытие задач');

-- Стартовая воронка для уже существующих фабрик (новым создаёт provisionTenant).
INSERT INTO pipeline_stages (tenant_id, name, sort, kind)
SELECT t.id, s.name, s.sort, s.kind FROM tenants t,
 (VALUES ('Квалификация',1,'open'),('Каталог / образцы',2,'open'),('Коммерческое предложение',3,'open'),
         ('Согласование цены и сроков',4,'open'),('Выиграна',5,'won'),('Проиграна',6,'lost')) AS s(name,sort,kind);

-- Права для существующих фабрик: директор, админ, руководитель продаж — всё; менеджер — только свои.
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p.code,
       (r.code = 'sales_manager' AND p.module IN ('clients','leads','deals','tasks'))
  FROM roles r JOIN permissions p ON p.module IN ('clients','leads','deals','tasks')
 WHERE r.code IN ('owner','admin','sales_head','sales_manager')
   AND NOT (r.code = 'sales_manager' AND p.action = 'delete')
ON CONFLICT DO NOTHING;
