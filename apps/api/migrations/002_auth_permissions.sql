-- Refresh-токены: хранится только хеш; токен выдаётся в виде "<tenant_id>.<случайная строка>".
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refresh_tokens
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO crm_app;

-- Каталог прав платформы (module.action). Новые модули добавляют свои права своими миграциями.
INSERT INTO permissions (code, module, action, description) VALUES
 ('users.view','users','view','Просмотр пользователей'),
 ('users.create','users','create','Создание пользователей'),
 ('users.edit','users','edit','Изменение пользователей'),
 ('users.delete','users','delete','Деактивация пользователей'),
 ('roles.view','roles','view','Просмотр ролей'),
 ('roles.manage','roles','manage','Настройка ролей и прав'),
 ('settings.view','settings','view','Просмотр справочников и настроек'),
 ('settings.manage','settings','manage','Изменение справочников и настроек'),
 ('audit.view','audit','view','Просмотр журнала действий'),
 ('files.view','files','view','Просмотр файлов'),
 ('files.create','files','create','Загрузка файлов');
