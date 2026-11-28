-- Этап 14: закупки по экспортному заказу — полотно у Узтекс, фурнитура у Eren Textile (расход берётся из расчёта).
CREATE TABLE export_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fabric','trims')),
  supplier text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','confirmed','in_production','shipped','received','cancelled')),
  currency text NOT NULL DEFAULT 'USD',
  expected_date date,
  sent_at timestamptz, confirmed_at timestamptz, received_at timestamptz,
  payment_note text, note text,
  total_usd numeric(14,2) NOT NULL DEFAULT 0,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES export_orders (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE export_purchase_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  purchase_id uuid NOT NULL,
  item_code text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL,
  qty numeric(14,3) NOT NULL CHECK (qty > 0),
  price_usd numeric(12,4) NOT NULL DEFAULT 0 CHECK (price_usd >= 0),
  total_usd numeric(14,2) NOT NULL DEFAULT 0,
  sort int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_id) REFERENCES export_purchases (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX export_purchases_order_idx ON export_purchases (tenant_id, order_id);
CREATE INDEX export_purchase_lines_idx ON export_purchase_lines (tenant_id, purchase_id);

ALTER TABLE export_purchases ENABLE ROW LEVEL SECURITY;      ALTER TABLE export_purchases FORCE ROW LEVEL SECURITY;
ALTER TABLE export_purchase_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE export_purchase_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON export_purchases USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON export_purchase_lines USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON export_purchases, export_purchase_lines TO crm_app;

INSERT INTO permissions (code, module, action, description) VALUES
 ('exportpurchases.view','exportpurchases','view','Просмотр закупок по экспортным заказам'),
 ('exportpurchases.manage','exportpurchases','manage','Формировать заказы поставщикам и менять их статусы');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportpurchases.view', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','sales_manager','technologist','production_head','qc','purchaser','accountant','logistics','planner');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportpurchases.manage', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','purchaser');
