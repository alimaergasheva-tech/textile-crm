-- Подрядчики: передача кроя, приёмка готовых изделий с проверкой ОТК, остаток «на складе подрядчика».
CREATE TABLE contractor_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  step_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, step_id) REFERENCES production_steps (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES contractors (tenant_id, id)
);
CREATE TABLE contractor_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  step_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),                    -- привезено подрядчиком
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  good_qty int CHECK (good_qty >= 0),
  defect_qty int NOT NULL DEFAULT 0 CHECK (defect_qty >= 0),
  reason_code text,
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  FOREIGN KEY (tenant_id, step_id) REFERENCES production_steps (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES contractors (tenant_id, id)
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contractor_transfers','contractor_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO crm_app', t);
  END LOOP;
END $$;

-- Приёмка ОТК — отдельное право: бригадир (production.report) принимать работу не должен.
INSERT INTO permissions (code, module, action, description) VALUES
 ('production.qc','production','manage','Приёмка ОТК: изделия своей бригады и подрядчиков');
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
  SELECT tenant_id, id, 'production.qc' FROM roles WHERE code IN ('owner','admin','production_head','qc');
