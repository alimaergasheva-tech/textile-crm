-- Этап 17: выпуск по моделям (раскрой / пошив / упаковка), отгрузки в США, права.
CREATE TABLE export_production_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  model_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('cut','sew','pack')),
  day date NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  note text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES export_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, model_id) REFERENCES export_models (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX export_prodlog_model_idx ON export_production_log (tenant_id, model_id, stage);

CREATE TABLE export_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  number text NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','loaded','in_transit','delivered','cancelled')),
  carrier text, plate text, cmr_no text, destination text NOT NULL DEFAULT 'USA',
  loading_date date, eta date, delivered_on date,
  volume_m3 numeric(8,2), weight_kg numeric(10,1), cartons int,
  note text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES export_orders (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE export_shipment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid NOT NULL,
  model_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  cartons int,
  UNIQUE (shipment_id, model_id),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES export_shipments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, model_id) REFERENCES export_models (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX export_shipments_order_idx ON export_shipments (tenant_id, order_id);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['export_production_log','export_shipments','export_shipment_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, module, action, description) VALUES
 ('exportproduction.view','exportproduction','view','Просмотр выпуска по экспортным заказам'),
 ('exportproduction.manage','exportproduction','manage','Вносить выпуск: раскрой, пошив, упаковка'),
 ('exportshipments.view','exportshipments','view','Просмотр отгрузок по экспортным заказам'),
 ('exportshipments.manage','exportshipments','manage','Оформлять отгрузки: машина, объём, статусы');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p, false FROM roles r, unnest(ARRAY['exportproduction.view','exportshipments.view']) p
 WHERE r.code IN ('owner','admin','sales_head','sales_manager','technologist','production_head','qc','purchaser','accountant','logistics','planner','ved');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportproduction.manage', false FROM roles r WHERE r.code IN ('owner','admin','production_head','planner');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportshipments.manage', false FROM roles r WHERE r.code IN ('owner','admin','sales_head','logistics','ved');
