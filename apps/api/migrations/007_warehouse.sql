-- Этап 4 «Склад». Остатки считаются только из движений (stock_movements); stock_balances — их быстрая копия,
-- которая меняется в той же транзакции. Минус запрещён самой базой (CHECK qty >= 0).
CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('raw','wip','finished')),   -- сырьё / незавершённое производство / готовая продукция
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);
CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  warehouse_id uuid NOT NULL,
  code text NOT NULL,
  name text,
  UNIQUE (tenant_id, id), UNIQUE (warehouse_id, code),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id)
);

CREATE TABLE fabric_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  material_id uuid NOT NULL,
  lot_number text NOT NULL,
  color_name text,
  shade text,                         -- оттенок партии
  width_cm numeric(7,2),
  density_gsm numeric(7,2),
  supplier text,
  note text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, material_id, lot_number),
  FOREIGN KEY (tenant_id, material_id) REFERENCES materials (tenant_id, id)
);
CREATE TABLE fabric_rolls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  lot_id uuid NOT NULL,
  roll_no text NOT NULL,
  qty_initial numeric(14,3) NOT NULL CHECK (qty_initial > 0),
  qty_remaining numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_remaining >= 0),
  barcode text NOT NULL,
  location_id uuid,
  UNIQUE (tenant_id, id), UNIQUE (lot_id, roll_no), UNIQUE (tenant_id, barcode),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES fabric_lots (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);

CREATE TABLE stock_movements (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type text NOT NULL CHECK (type IN ('receipt','return','issue','transfer_out','transfer_in','writeoff','inventory_adjust')),
  material_id uuid,
  variant_id uuid,
  lot_id uuid,
  roll_id uuid,
  location_id uuid NOT NULL,
  qty numeric(14,3) NOT NULL CHECK (qty <> 0),      -- со знаком: приход +, расход −
  doc_type text,
  doc_id uuid,
  comment text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((material_id IS NULL) <> (variant_id IS NULL)),
  FOREIGN KEY (tenant_id, material_id) REFERENCES materials (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants (tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES fabric_lots (tenant_id, id),
  FOREIGN KEY (tenant_id, roll_id) REFERENCES fabric_rolls (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX stock_movements_time_idx ON stock_movements (tenant_id, created_at DESC);
CREATE INDEX stock_movements_material_idx ON stock_movements (tenant_id, material_id);
CREATE INDEX stock_movements_variant_idx ON stock_movements (tenant_id, variant_id);
CREATE INDEX stock_movements_doc_idx ON stock_movements (tenant_id, doc_type, doc_id);

CREATE TABLE stock_balances (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  location_id uuid NOT NULL,
  material_id uuid,
  variant_id uuid,
  lot_id uuid,
  -- Ключи без NULL для уникальности (NULL в обычном UNIQUE считается разными значениями)
  k_material uuid GENERATED ALWAYS AS (COALESCE(material_id, '00000000-0000-0000-0000-000000000000')) STORED,
  k_variant  uuid GENERATED ALWAYS AS (COALESCE(variant_id,  '00000000-0000-0000-0000-000000000000')) STORED,
  k_lot      uuid GENERATED ALWAYS AS (COALESCE(lot_id,      '00000000-0000-0000-0000-000000000000')) STORED,
  qty numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, location_id, k_material, k_variant, k_lot),
  CHECK ((material_id IS NULL) <> (variant_id IS NULL)),
  FOREIGN KEY (tenant_id, material_id) REFERENCES materials (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants (tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES fabric_lots (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX stock_balances_variant_idx ON stock_balances (tenant_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX stock_balances_material_idx ON stock_balances (tenant_id, material_id) WHERE material_id IS NOT NULL;

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  variant_id uuid NOT NULL,
  qty numeric(14,3) NOT NULL CHECK (qty > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','fulfilled')),
  ref_type text,                         -- например order_item (этап 5)
  ref_id uuid,
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants (tenant_id, id)
);
CREATE INDEX reservations_variant_idx ON reservations (tenant_id, variant_id) WHERE status = 'active';

CREATE TABLE inventory_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  warehouse_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id)
);
CREATE TABLE inventory_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL,
  location_id uuid NOT NULL,
  material_id uuid,
  variant_id uuid,
  lot_id uuid,
  roll_id uuid,
  qty_system numeric(14,3) NOT NULL,     -- на момент начала
  qty_counted numeric(14,3),             -- NULL = ещё не пересчитано
  CHECK ((material_id IS NULL) <> (variant_id IS NULL)),
  FOREIGN KEY (tenant_id, session_id) REFERENCES inventory_sessions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX inventory_lines_session_idx ON inventory_lines (session_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouses','locations','fabric_lots','fabric_rolls','stock_movements','stock_balances',
                           'reservations','inventory_sessions','inventory_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;
-- Журнал движений только дополняется: приложению нельзя менять и удалять движения.
REVOKE UPDATE, DELETE ON stock_movements FROM crm_app;
GRANT USAGE, SELECT ON SEQUENCE stock_movements_id_seq TO crm_app;

INSERT INTO permissions (code, module, action, description) VALUES
 ('warehouse.view','warehouse','view','Просмотр остатков и движений'),
 ('warehouse.write','warehouse','create','Приход, расход, перемещение, списание, резервы'),
 ('warehouse.inventory','warehouse','edit','Инвентаризация'),
 ('warehouse.manage','warehouse','manage','Склады, ячейки, сверка баланса');

-- Три склада по умолчанию для существующих фабрик (новым создаёт provisionTenant)
INSERT INTO warehouses (tenant_id, name, kind)
SELECT t.id, w.name, w.kind FROM tenants t,
  (VALUES ('Склад сырья','raw'),('Цех (незавершённое производство)','wip'),('Склад готовой продукции','finished')) AS w(name, kind);
INSERT INTO locations (tenant_id, warehouse_id, code, name) SELECT tenant_id, id, 'MAIN', 'Основная' FROM warehouses;

INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code FROM roles r JOIN permissions p ON p.module = 'warehouse'
 WHERE r.code IN ('owner','admin','storekeeper')
    OR (r.code IN ('production_head') AND p.code IN ('warehouse.view','warehouse.write'))
    OR (r.code IN ('purchaser','accountant','sales_head','sales_manager','technologist','qc') AND p.code = 'warehouse.view')
ON CONFLICT DO NOTHING;
