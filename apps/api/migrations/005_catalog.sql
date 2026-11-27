-- Этап 3 «Каталог»: размерные сетки, цвета, модели, варианты (SKU), материалы, BOM, маршрут, прайсы, КП.
-- Все ссылки между таблицами фабрики — составные (tenant_id, id): защита от связей между фабриками.

CREATE TABLE size_grids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);
CREATE TABLE sizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  grid_id uuid NOT NULL,
  label text NOT NULL,
  sort int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id), UNIQUE (grid_id, label),
  FOREIGN KEY (tenant_id, grid_id) REFERENCES size_grids (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE colors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name_ru text NOT NULL,
  name_uz text,
  hex text,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);

CREATE TABLE models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  collection text,
  season text,
  category text,
  fabric_composition text,
  care text,
  description text,
  size_grid_id uuid,
  photo_file_id uuid REFERENCES files(id),
  is_active boolean NOT NULL DEFAULT true,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, size_grid_id) REFERENCES size_grids (tenant_id, id)
);

CREATE SEQUENCE barcode_seq;
CREATE TABLE variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  model_id uuid NOT NULL,
  size_id uuid NOT NULL,
  color_id uuid NOT NULL,
  sku text NOT NULL,
  barcode text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  external_id text,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, sku), UNIQUE (tenant_id, barcode),
  UNIQUE (tenant_id, model_id, size_id, color_id),
  FOREIGN KEY (tenant_id, model_id) REFERENCES models (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, size_id) REFERENCES sizes (tenant_id, id),
  FOREIGN KEY (tenant_id, color_id) REFERENCES colors (tenant_id, id)
);

CREATE TABLE materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('fabric','lining','thread','trim','packaging')),
  unit text NOT NULL CHECK (unit IN ('m','kg','pcs','roll','set','spool')),
  min_stock numeric(14,3) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  external_id text,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);

CREATE TABLE bom_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  model_id uuid NOT NULL,
  material_id uuid NOT NULL,
  size_id uuid,                                   -- NULL = норма для всех размеров; иначе перекрывает её
  qty_per_unit numeric(12,4) NOT NULL CHECK (qty_per_unit >= 0),
  waste_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (waste_percent >= 0 AND waste_percent < 100),
  note text,
  UNIQUE (tenant_id, model_id, material_id, size_id),
  FOREIGN KEY (tenant_id, model_id) REFERENCES models (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, material_id) REFERENCES materials (tenant_id, id),
  FOREIGN KEY (tenant_id, size_id) REFERENCES sizes (tenant_id, id)
);
-- UNIQUE с NULL не ловит дубли общих норм, поэтому отдельный индекс.
CREATE UNIQUE INDEX bom_general_uq ON bom_lines (tenant_id, model_id, material_id) WHERE size_id IS NULL;

CREATE TABLE route_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  model_id uuid NOT NULL,
  step int NOT NULL,
  name text NOT NULL,
  norm_minutes numeric(8,2) NOT NULL DEFAULT 0 CHECK (norm_minutes >= 0),
  piece_rate bigint NOT NULL DEFAULT 0 CHECK (piece_rate >= 0),   -- расценка за единицу, минимальные единицы
  currency text NOT NULL DEFAULT 'UZS' CHECK (currency IN ('UZS','USD')),
  UNIQUE (tenant_id, model_id, step),
  FOREIGN KEY (tenant_id, model_id) REFERENCES models (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  price_type text NOT NULL CHECK (price_type IN ('retail','wholesale','large_wholesale')),
  currency text NOT NULL CHECK (currency IN ('UZS','USD')),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);
-- Цена задаётся на модель (размеры одной модели стоят одинаково); отклонение от SPEC: там было на вариант.
CREATE TABLE prices (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  price_list_id uuid NOT NULL,
  model_id uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (price_list_id, model_id),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, model_id) REFERENCES models (tenant_id, id) ON DELETE CASCADE
);

-- Для ссылки из КП на сделку нужна уникальность (tenant_id, id)
ALTER TABLE deals ADD CONSTRAINT deals_tenant_id_uq UNIQUE (tenant_id, id);
CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  client_id uuid NOT NULL,
  deal_id uuid,
  currency text NOT NULL CHECK (currency IN ('UZS','USD')),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  valid_until date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected')),
  total bigint NOT NULL DEFAULT 0,
  owner_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, deal_id) REFERENCES deals (tenant_id, id)
);
CREATE TABLE quote_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  quote_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  unit_price bigint NOT NULL CHECK (unit_price >= 0),     -- цена на момент КП
  UNIQUE (quote_id, variant_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants (tenant_id, id)
);
CREATE INDEX models_tenant_idx ON models (tenant_id, lower(name));
CREATE INDEX variants_model_idx ON variants (model_id);
CREATE INDEX quotes_client_idx ON quotes (tenant_id, client_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['size_grids','sizes','colors','models','variants','materials','bom_lines',
                           'route_operations','price_lists','prices','quotes','quote_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE barcode_seq TO crm_app;

INSERT INTO permissions (code, module, action, description) VALUES
 ('models.view','models','view','Просмотр каталога моделей'),
 ('models.create','models','create','Создание моделей и вариантов'),
 ('models.edit','models','edit','Изменение моделей, BOM, маршрута'),
 ('models.delete','models','delete','Удаление моделей'),
 ('materials.view','materials','view','Просмотр материалов'),
 ('materials.create','materials','create','Создание материалов'),
 ('materials.edit','materials','edit','Изменение материалов'),
 ('pricing.view','pricing','view','Просмотр прайс-листов'),
 ('pricing.edit','pricing','edit','Изменение прайс-листов'),
 ('quotes.view','quotes','view','Просмотр коммерческих предложений'),
 ('quotes.create','quotes','create','Создание КП'),
 ('quotes.edit','quotes','edit','Изменение КП');

-- Стартовая сетка и права для существующих фабрик (новым создаёт provisionTenant).
INSERT INTO size_grids (tenant_id, name) SELECT id, 'S–XXL' FROM tenants;
INSERT INTO sizes (tenant_id, grid_id, label, sort)
SELECT g.tenant_id, g.id, s.label, s.sort FROM size_grids g,
  (VALUES ('S',1),('M',2),('L',3),('XL',4),('XXL',5)) AS s(label, sort) WHERE g.name = 'S–XXL';

INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, p.code, (r.code = 'sales_manager' AND p.module = 'quotes')
  FROM roles r JOIN permissions p ON p.module IN ('models','materials','pricing','quotes')
 WHERE (r.code IN ('owner','admin'))
    OR (r.code = 'technologist' AND p.module IN ('models','materials') AND p.action <> 'delete')
    OR (r.code IN ('sales_head','sales_manager') AND ((p.module IN ('models','materials','pricing') AND p.action = 'view') OR p.module = 'quotes'))
    OR (r.code IN ('production_head','storekeeper','purchaser') AND p.module IN ('models','materials') AND p.action = 'view')
ON CONFLICT DO NOTHING;
