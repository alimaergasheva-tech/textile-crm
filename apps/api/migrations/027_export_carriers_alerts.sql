-- Этап 20: справочник перевозчиков со ставками; журнал отправленных напоминаний о просрочках (чтобы не слать одно и то же дважды в сутки).
CREATE TABLE export_carriers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  contact text, phone text, email text,
  rate_per_truck numeric(12,2) CHECK (rate_per_truck IS NULL OR rate_per_truck >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','UZS','EUR')),
  transit_days int CHECK (transit_days IS NULL OR transit_days > 0),
  route text, note text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);
CREATE TABLE export_alert_log (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  alert_key text NOT NULL,
  day date NOT NULL,
  PRIMARY KEY (tenant_id, alert_key, day)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['export_carriers','export_alert_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;
