-- Этап 15: образцы 1-fit и PP по моделям экспортного заказа (отправка клиенту, AWB, решение клиента).
CREATE TABLE export_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  model_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('1fit','pp')),
  round int NOT NULL DEFAULT 1 CHECK (round >= 1),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','made','sent','delivered','approved','approved_comments','rejected')),
  planned_send date,
  made_at date, sent_at date, delivered_at date, decided_at date,
  courier text, awb text,
  client_comment text, note text,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id), UNIQUE (model_id, kind, round),
  FOREIGN KEY (tenant_id, order_id) REFERENCES export_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, model_id) REFERENCES export_models (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX export_samples_order_idx ON export_samples (tenant_id, order_id);
ALTER TABLE export_samples ENABLE ROW LEVEL SECURITY; ALTER TABLE export_samples FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON export_samples USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON export_samples TO crm_app;

INSERT INTO permissions (code, module, action, description) VALUES
 ('exportsamples.view','exportsamples','view','Просмотр образцов 1-fit и PP'),
 ('exportsamples.manage','exportsamples','manage','Вести образцы: отправка, AWB, решение клиента');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportsamples.view', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','sales_manager','technologist','production_head','qc','purchaser','accountant','logistics','planner','ved');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportsamples.manage', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','sales_manager','technologist','production_head');
