-- Этап 18: реквизиты и данные для документов ВЭД по отгрузке (инвойс, упаковочный лист, CMR, таможенная ведомость).
CREATE TABLE export_ved (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 1,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (shipment_id),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES export_shipments (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE export_ved ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_ved FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON export_ved USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON export_ved TO crm_app;

INSERT INTO permissions (code, module, action, description) VALUES
 ('exportved.view','exportved','view','Просмотр документов ВЭД по отгрузкам'),
 ('exportved.manage','exportved','manage','Заполнять реквизиты и формировать документы ВЭД');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportved.view', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','accountant','logistics','ved');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportved.manage', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','logistics','ved');
