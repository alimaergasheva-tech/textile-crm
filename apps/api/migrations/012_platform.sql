-- Этап 9: панель владельца платформы, тарифы и лимиты, внешние ID и экспорт.
ALTER TABLE tenants
  ADD COLUMN plan text NOT NULL DEFAULT 'start',
  ADD COLUMN max_users int NOT NULL DEFAULT 10,
  ADD COLUMN max_storage_mb int NOT NULL DEFAULT 1024,
  ADD COLUMN paid_until date,
  ADD COLUMN blocked_reason text;

-- Администраторы платформы и их журнал. Роль приложения (crm_app) к этим таблицам доступа не имеет.
CREATE TABLE platform_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_audit (
  id bigserial PRIMARY KEY,
  admin_id uuid REFERENCES platform_admins(id),
  tenant_id uuid REFERENCES tenants(id),
  action text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Внешние ID для интеграции с 1С (clients, models, materials уже имеют external_id)
ALTER TABLE orders ADD COLUMN external_id text;
ALTER TABLE shipments ADD COLUMN external_id text;
CREATE UNIQUE INDEX clients_ext_uq ON clients (tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX models_ext_uq ON models (tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX materials_ext_uq ON materials (tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX orders_ext_uq ON orders (tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX shipments_ext_uq ON shipments (tenant_id, external_id) WHERE external_id IS NOT NULL;

INSERT INTO permissions (code, module, action, description) VALUES
 ('data.export','data','export','Выгрузка данных и внешние ID для интеграции');
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
  SELECT tenant_id, id, 'data.export' FROM roles WHERE code IN ('owner','admin');
