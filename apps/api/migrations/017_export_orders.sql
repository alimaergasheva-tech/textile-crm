-- Этап 10 «Экспортный заказ»: справочники выкроек/табелей мер, полотна и фурнитуры, заказ и его модели.

CREATE TABLE patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,                              -- GKT1, GSH06 ...
  kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('tee','skirt','other')),
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code), UNIQUE (tenant_id, id)
);
CREATE TABLE pattern_measures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pattern_id uuid NOT NULL,
  sort int NOT NULL DEFAULT 0,
  name text NOT NULL,
  tolerance numeric(6,2),
  vals jsonb NOT NULL,                             -- {"122":42.5,"128":44,...}, см
  FOREIGN KEY (tenant_id, pattern_id) REFERENCES patterns (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (pattern_id, name)
);

-- Полотна для расчёта расхода: состав, плотность, цена за кг. Связь с материалом склада — по желанию.
CREATE TABLE export_fabrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  composition text,
  gsm int NOT NULL CHECK (gsm > 0),
  kind text NOT NULL DEFAULT 'main' CHECK (kind IN ('main','rib')),
  is_aop boolean NOT NULL DEFAULT false,
  price_usd_kg numeric(10,3) NOT NULL DEFAULT 0,
  supplier text,
  material_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code), UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, material_id) REFERENCES materials (tenant_id, id)
);
CREATE TABLE export_accessories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL,
  price_usd numeric(10,4) NOT NULL DEFAULT 0,
  supplier text,
  is_active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code), UNIQUE (tenant_id, id)
);

CREATE TABLE export_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  client_id uuid NOT NULL,
  deal_id uuid REFERENCES deals(id),
  brand text, collection text, po_no text,
  incoterms text NOT NULL DEFAULT 'FOB',
  currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('UZS','USD')),
  target_exfactory date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','calculated','quoted','confirmed','in_production','shipped','closed','cancelled')),
  notes text,
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number), UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)
);
CREATE INDEX export_orders_client_idx ON export_orders (tenant_id, client_id);

CREATE TABLE export_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  code text NOT NULL,                              -- SET44.01
  tee_pattern_id uuid, skirt_pattern_id uuid,
  fabric_top_id uuid, fabric_bottom_id uuid, fabric_rib_id uuid,
  size_qty jsonb NOT NULL DEFAULT '{}',            -- {"122":250,...}
  qty int NOT NULL DEFAULT 0 CHECK (qty >= 0),
  pack_size text,
  ex_factory date,
  trim_note text,
  spec jsonb NOT NULL DEFAULT '{}',                -- исходные тексты из файла: main_fabric, extra_fabric, accessories
  pattern_confirmed boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  sort int NOT NULL DEFAULT 0,
  UNIQUE (order_id, code), UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES export_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tee_pattern_id) REFERENCES patterns (tenant_id, id),
  FOREIGN KEY (tenant_id, skirt_pattern_id) REFERENCES patterns (tenant_id, id),
  FOREIGN KEY (tenant_id, fabric_top_id) REFERENCES export_fabrics (tenant_id, id),
  FOREIGN KEY (tenant_id, fabric_bottom_id) REFERENCES export_fabrics (tenant_id, id),
  FOREIGN KEY (tenant_id, fabric_rib_id) REFERENCES export_fabrics (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patterns','pattern_measures','export_fabrics','export_accessories','export_orders','export_models'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, module, action, description) VALUES
 ('exportorders.view','exportorders','view','Просмотр экспортных заказов'),
 ('exportorders.create','exportorders','create','Создание экспортных заказов, импорт файла Status'),
 ('exportorders.edit','exportorders','edit','Изменение экспортных заказов и их моделей'),
 ('exportorders.delete','exportorders','delete','Удаление экспортных заказов'),
 ('patterns.view','patterns','view','Просмотр выкроек, табелей мер, полотна и фурнитуры'),
 ('patterns.manage','patterns','manage','Импорт табелей мер, изменение полотна, фурнитуры и цен');

-- Права для существующих фабрик
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p.code, false FROM roles r JOIN permissions p ON p.module IN ('exportorders','patterns')
 WHERE r.code IN ('owner','admin');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p, false FROM roles r, unnest(ARRAY['exportorders.view','exportorders.create','exportorders.edit','patterns.view']) p
 WHERE r.code IN ('sales_head','sales_manager');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p, false FROM roles r, unnest(ARRAY['exportorders.view','exportorders.edit','patterns.view','patterns.manage']) p
 WHERE r.code = 'technologist';
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p, false FROM roles r, unnest(ARRAY['exportorders.view','patterns.view']) p
 WHERE r.code IN ('production_head','planner','purchaser','qc','ved','logistics','accountant');

-- Типовая фурнитура и упаковка (цены заполняются из котировок поставщика).
INSERT INTO export_accessories (tenant_id, code, name, unit)
SELECT t.id, a.code, a.name, a.unit FROM tenants t,
 (VALUES ('CORD','Шнур хлопок D=0,5 см','м'),('TIPS','Пластиковые наконечники шнура','шт'),('ELASTIC25','Резинка 25 мм','м'),
         ('TT-S','Термотрансфер малый (рост 98–146)','шт'),('TT-L','Термотрансфер большой (рост 152–182)','шт'),
         ('HANGTAG','Картонник / хэнгтег','шт'),('POLY30','Полибэг 30×30 см','шт'),('CARTON','Гофрокороб','шт'),('OTHER','Нитки и прочее','комплект'))
 AS a(code,name,unit);
