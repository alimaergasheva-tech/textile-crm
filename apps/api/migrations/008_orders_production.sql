-- Этап 5 «Заказы и производство»
CREATE TABLE brigades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL, is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);
CREATE TABLE contractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL, phone text, is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  client_id uuid NOT NULL,
  deal_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','confirmed','in_production','ready','shipped','cancelled')),
  due_date date,
  currency text NOT NULL CHECK (currency IN ('UZS','USD')),
  total bigint NOT NULL DEFAULT 0,
  note text,
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, number), UNIQUE (tenant_id, deal_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, deal_id) REFERENCES deals (tenant_id, id)
);
CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  unit_price bigint NOT NULL DEFAULT 0,
  reserved int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  UNIQUE (tenant_id, id), UNIQUE (order_id, variant_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants (tenant_id, id)
);

CREATE TABLE production_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  order_id uuid NOT NULL,
  model_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','planned','in_progress','qc','stocked','closed','cancelled')),
  priority int NOT NULL DEFAULT 0,
  deadline date,
  cutting_lot_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  FOREIGN KEY (tenant_id, model_id) REFERENCES models (tenant_id, id)
);
CREATE TABLE production_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  production_order_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  planned_qty int NOT NULL CHECK (planned_qty > 0),
  done_qty int NOT NULL DEFAULT 0 CHECK (done_qty >= 0),
  defect_qty int NOT NULL DEFAULT 0 CHECK (defect_qty >= 0),
  UNIQUE (production_order_id, variant_id),
  FOREIGN KEY (tenant_id, production_order_id) REFERENCES production_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants (tenant_id, id)
);
CREATE TABLE production_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  production_order_id uuid NOT NULL,
  route_operation_id uuid,
  step int NOT NULL,
  name text NOT NULL,
  assignee_type text CHECK (assignee_type IN ('brigade','contractor')),
  brigade_id uuid,
  contractor_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done')),
  close_reason text,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id, id), UNIQUE (production_order_id, step),
  FOREIGN KEY (tenant_id, production_order_id) REFERENCES production_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brigade_id) REFERENCES brigades (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES contractors (tenant_id, id)
);
CREATE TABLE step_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  step_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, step_id) REFERENCES production_steps (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE material_consumption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  production_order_id uuid NOT NULL,
  material_id uuid NOT NULL,
  planned_qty numeric(14,3) NOT NULL,
  actual_qty numeric(14,3) NOT NULL,
  UNIQUE (production_order_id, material_id),
  FOREIGN KEY (tenant_id, production_order_id) REFERENCES production_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, material_id) REFERENCES materials (tenant_id, id)
);
CREATE TABLE defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  production_order_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  reason_code text,
  action text NOT NULL CHECK (action IN ('writeoff','rework')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, production_order_id) REFERENCES production_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants (tenant_id, id)
);
CREATE INDEX production_orders_status_idx ON production_orders (tenant_id, status);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['brigades','contractors','orders','order_items','production_orders','production_items',
                           'production_steps','step_reports','material_consumption','defects']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, module, action, description) VALUES
 ('orders.view','orders','view','Просмотр заказов'),
 ('orders.create','orders','create','Создание и подтверждение заказов'),
 ('orders.approve','orders','manage','Подтверждение заказов сверх кредитного лимита'),
 ('production.view','production','view','Просмотр производства'),
 ('production.manage','production','manage','Планирование, запуск, статусы заданий'),
 ('production.report','production','create','Отметки о выполнении, приёмка ОТК');

INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code FROM roles r JOIN permissions p ON p.module IN ('orders','production')
 WHERE r.code IN ('owner','admin')
    OR (r.code = 'sales_head' AND p.code IN ('orders.view','orders.create','orders.approve','production.view'))
    OR (r.code = 'sales_manager' AND p.code IN ('orders.view','orders.create','production.view'))
    OR (r.code = 'production_head' AND p.code IN ('orders.view','production.view','production.manage','production.report'))
    OR (r.code = 'qc' AND p.code IN ('production.view','production.report'))
    OR (r.code IN ('technologist','storekeeper','purchaser','accountant') AND p.code IN ('production.view'))
ON CONFLICT DO NOTHING;
