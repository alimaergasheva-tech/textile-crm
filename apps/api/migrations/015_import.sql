-- Право на импорт данных из CSV (клиенты, материалы, начальные остатки).
INSERT INTO permissions (code, module, action, description) VALUES
 ('data.import','data','create','Импорт клиентов, материалов и начальных остатков из CSV');
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
  SELECT tenant_id, id, 'data.import' FROM roles WHERE code IN ('owner','admin');
