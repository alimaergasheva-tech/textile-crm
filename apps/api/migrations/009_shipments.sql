-- Этап 6 «Отгрузка»
ALTER TABLE orders ADD COLUMN paid bigint NOT NULL DEFAULT 0 CHECK (paid >= 0);   -- оплачено, минимальные единицы (счета и оплаты — после MVP)
ALTER TABLE order_items ADD COLUMN shipped int NOT NULL DEFAULT 0 CHECK (shipped >= 0);

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  order_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shipped','cancelled')),
  note text,
  shipped_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id)
);
CREATE TABLE shipment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  UNIQUE (shipment_id, order_item_id),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES order_items (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants (tenant_id, id)
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shipments','shipment_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, module, action, description) VALUES
 ('shipments.view','shipments','view','Просмотр отгрузок и документов'),
 ('shipments.create','shipments','create','Оформление и проведение отгрузок');
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code FROM roles r JOIN permissions p ON p.module = 'shipments'
 WHERE r.code IN ('owner','admin','storekeeper')
    OR (r.code IN ('sales_head','sales_manager','production_head','accountant') AND p.code = 'shipments.view')
ON CONFLICT DO NOTHING;
