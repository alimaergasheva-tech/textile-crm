-- Этап 16: финальная инспекция AQL по моделям (план выборки, дефекты, фото, итог «принято / не принято»).
CREATE TABLE export_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  model_id uuid NOT NULL,
  round int NOT NULL DEFAULT 1 CHECK (round >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  inspected_on date,
  inspector text,
  lot_qty int NOT NULL CHECK (lot_qty > 0),
  sample_size int NOT NULL,
  aql_major numeric(3,1) NOT NULL DEFAULT 2.5,
  aql_minor numeric(3,1) NOT NULL DEFAULT 4.0,
  ac_major int NOT NULL, re_major int NOT NULL, ac_minor int NOT NULL, re_minor int NOT NULL,
  notes text,
  finalized_at timestamptz, finalized_by uuid,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id), UNIQUE (model_id, round),
  FOREIGN KEY (tenant_id, order_id) REFERENCES export_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, model_id) REFERENCES export_models (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE export_inspection_defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  inspection_id uuid NOT NULL,
  defect text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical','major','minor')),
  qty int NOT NULL CHECK (qty > 0),
  note text,
  sort int NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES export_inspections (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE export_inspection_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  inspection_id uuid NOT NULL,
  caption text,
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data bytea NOT NULL,
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES export_inspections (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX export_inspections_order_idx ON export_inspections (tenant_id, order_id);
CREATE INDEX export_insp_defects_idx ON export_inspection_defects (tenant_id, inspection_id);
CREATE INDEX export_insp_photos_idx ON export_inspection_photos (tenant_id, inspection_id);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['export_inspections','export_inspection_defects','export_inspection_photos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, module, action, description) VALUES
 ('exportinspections.view','exportinspections','view','Просмотр отчётов AQL по экспортным заказам'),
 ('exportinspections.manage','exportinspections','manage','Проводить инспекцию AQL: дефекты, фото, итоговый отчёт');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportinspections.view', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','sales_manager','technologist','production_head','qc','purchaser','accountant','logistics','planner','ved');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportinspections.manage', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','production_head','qc');
