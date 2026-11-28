-- Этап 19: упаковка (штук в коробке, размеры и вес короба) по моделям для расчёта объёма и числа машин.
CREATE TABLE export_pack_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  model_id uuid NOT NULL,
  pcs_per_carton int NOT NULL CHECK (pcs_per_carton > 0),
  carton_l_cm numeric(6,1) NOT NULL CHECK (carton_l_cm > 0),
  carton_w_cm numeric(6,1) NOT NULL CHECK (carton_w_cm > 0),
  carton_h_cm numeric(6,1) NOT NULL CHECK (carton_h_cm > 0),
  carton_kg numeric(7,2) NOT NULL CHECK (carton_kg > 0),
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (model_id),
  FOREIGN KEY (tenant_id, model_id) REFERENCES export_models (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE export_pack_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_pack_specs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON export_pack_specs USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON export_pack_specs TO crm_app;

INSERT INTO permissions (code, module, action, description) VALUES
 ('exportlogistics.view','exportlogistics','view','Просмотр логистического расчёта: объём, вес, число машин'),
 ('exportlogistics.manage','exportlogistics','manage','Задавать упаковку моделей и параметры машин');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportlogistics.view', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','production_head','accountant','logistics','planner','ved');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportlogistics.manage', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','logistics');
