-- Этап 12: коммерческое предложение (КП) по экспортному заказу: снимок расчёта, статусы, подтверждение клиентом.
CREATE TABLE export_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  number text NOT NULL,
  rev int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','confirmed','rejected','superseded')),
  currency text NOT NULL DEFAULT 'USD',
  params jsonb NOT NULL,                       -- параметры расчёта на момент фиксации
  lines jsonb NOT NULL,                        -- по моделям: себестоимость и цена за комплект
  totals jsonb NOT NULL,
  promised_exfactory date,                     -- обещанный срок ex-factory клиенту
  valid_until date,
  notes text,
  sent_at timestamptz, sent_by uuid REFERENCES users(id),
  decided_at timestamptz, decided_note text,   -- кто и как подтвердил со стороны клиента
  confirmed_by_name text,
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number), UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES export_orders (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX export_quotes_order_idx ON export_quotes (tenant_id, order_id, rev);
-- Не более одного подтверждённого КП на заказ.
CREATE UNIQUE INDEX export_quotes_one_confirmed ON export_quotes (order_id) WHERE status = 'confirmed';

ALTER TABLE export_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_quotes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON export_quotes USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON export_quotes TO crm_app;

INSERT INTO permissions (code, module, action, description) VALUES
 ('exportquotes.view','exportquotes','view','Просмотр себестоимости и КП экспортных заказов'),
 ('exportquotes.manage','exportquotes','manage','Фиксация КП, отправка и подтверждение цены клиентом');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p, false FROM roles r, unnest(ARRAY['exportquotes.view','exportquotes.manage']) p WHERE r.code IN ('owner','admin','sales_head');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p, false FROM roles r, unnest(ARRAY['exportquotes.view','exportquotes.manage']) p WHERE r.code = 'sales_manager';
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportquotes.view', false FROM roles r WHERE r.code = 'accountant';
