-- Этап 8 «Обратная связь и рекламации»
ALTER TABLE orders ADD COLUMN discount bigint NOT NULL DEFAULT 0 CHECK (discount >= 0);   -- скидки и возвраты по рекламациям, минимальные единицы

CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  shipment_id uuid,
  client_id uuid NOT NULL,
  token text NOT NULL UNIQUE,                          -- публичная ссылка для клиента
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','requested','answered')),
  request_at timestamptz NOT NULL,
  rating int CHECK (rating BETWEEN 1 AND 5),
  comment text,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)
);
CREATE INDEX feedback_due_idx ON feedback (tenant_id, request_at) WHERE status = 'scheduled';

CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  order_id uuid NOT NULL,
  client_id uuid NOT NULL,
  variant_id uuid,
  lot_info text,                                       -- партия / номер кроя из жалобы
  qty int CHECK (qty > 0),
  reason_code text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','resolved','closed')),
  assignee_id uuid REFERENCES users(id),
  due_at timestamptz NOT NULL,
  escalated_at timestamptz,
  resolution_type text CHECK (resolution_type IN ('replace','refund','discount')),
  resolution_amount bigint,
  resolution_note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants (tenant_id, id)
);
CREATE INDEX complaints_status_idx ON complaints (tenant_id, status, due_at);

CREATE TABLE suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid,                                        -- NULL = анонимно: автор не сохраняется вообще
  kind text NOT NULL DEFAULT 'suggestion' CHECK (kind IN ('problem','suggestion')),
  text text NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','seen','done')),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['feedback','complaints','suggestions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, module, action, description) VALUES
 ('feedback.view','feedback','view','Просмотр оценок, рекламаций, статистики'),
 ('feedback.create','feedback','create','Регистрация рекламаций и оценок'),
 ('feedback.manage','feedback','manage','Решение рекламаций, разбор предложений');
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code FROM roles r JOIN permissions p ON p.module = 'feedback'
 WHERE r.code IN ('owner','admin','sales_head')
    OR (r.code = 'sales_manager' AND p.code IN ('feedback.view','feedback.create'))
    OR (r.code IN ('production_head','qc','accountant') AND p.code = 'feedback.view')
ON CONFLICT DO NOTHING;

INSERT INTO reference_values (tenant_id,dictionary,code,name_ru,name_uz,name_en,name_tr,sort)
SELECT t.id, 'complaint_reason', v.code, v.ru, v.uz, v.en, v.tr, v.sort FROM tenants t, (VALUES
  ('quality','Качество','Sifat','Quality','Kalite',0),('packaging','Упаковка','Qadoqlash','Packaging','Ambalaj',1),
  ('terms','Сроки','Muddat','Lead time','Teslim süresi',2),('shortage','Недостача','Yetishmovchilik','Shortage','Eksik teslimat',3)) AS v(code,ru,uz,en,tr,sort)
ON CONFLICT DO NOTHING;
