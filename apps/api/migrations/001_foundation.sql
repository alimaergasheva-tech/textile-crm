-- Фундамент: фабрики (tenants), пользователи, роли и права, журнал, справочники, файлы.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Текущая фабрика берётся из настройки сессии app.tenant_id (её ставит API в начале транзакции).
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  default_locale text NOT NULL DEFAULT 'ru' CHECK (default_locale IN ('ru','uz')),
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  password_hash text,
  full_name text NOT NULL,
  telegram_id bigint,
  locale text NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru','uz')),
  is_active boolean NOT NULL DEFAULT true,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, telegram_id)
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, code)
);

-- Права вида «module.action», например deals.view. Общий справочник платформы.
CREATE TABLE permissions (
  code text PRIMARY KEY,
  module text NOT NULL,
  action text NOT NULL CHECK (action IN ('view','create','edit','delete','export','manage')),
  description text
);

CREATE TABLE role_permissions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code),
  own_only boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE user_roles (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid,
  entity text NOT NULL,
  entity_id text,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity, entity_id);
CREATE INDEX audit_log_time_idx ON audit_log (tenant_id, created_at DESC);

CREATE TABLE reference_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  dictionary text NOT NULL,            -- lead_source, loss_reason, defect_reason, ...
  code text NOT NULL,
  name_ru text NOT NULL,
  name_uz text,
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, dictionary, code)
);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  storage_key text NOT NULL,
  original_name text NOT NULL,
  mime text,
  size_bytes bigint,
  entity text,
  entity_id text,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_entity_idx ON files (tenant_id, entity, entity_id);

-- Row Level Security: у каждой таблицы с tenant_id видны и меняются только строки текущей фабрики.
-- FORCE нужен, чтобы политика действовала и на владельца таблицы.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','roles','role_permissions','user_roles','audit_log','reference_values','files']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- Журнал только дополняется: приложению запрещены UPDATE и DELETE.
-- Права роли приложения (crm_app создаётся в infra/postgres/init.sh).
GRANT USAGE ON SCHEMA public TO crm_app;
GRANT SELECT ON tenants, permissions TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, roles, role_permissions, user_roles, reference_values, files TO crm_app;
GRANT SELECT, INSERT ON audit_log TO crm_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO crm_app;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO crm_app;
