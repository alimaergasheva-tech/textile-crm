-- Клиентский портал: отдельные аккаунты клиентов (не сотрудники), заявки клиентов в заказах.
CREATE TABLE client_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  client_id uuid NOT NULL,
  name text NOT NULL,
  email text,
  password_hash text,
  telegram_id bigint,
  invite_token text UNIQUE,
  invite_expires timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, telegram_id), UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)
);
ALTER TABLE client_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_accounts USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON client_accounts TO crm_app;

-- Заказ может быть создан клиентом: остаётся черновиком («заявкой»), пока менеджер не подтвердит.
ALTER TABLE orders
  ADD COLUMN source text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','client')),
  ADD COLUMN client_account_id uuid,
  ADD FOREIGN KEY (tenant_id, client_account_id) REFERENCES client_accounts (tenant_id, id);
