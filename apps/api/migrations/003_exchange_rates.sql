-- Курс сум за 1 USD по датам. Для документов курс фиксируется на момент подтверждения.
CREATE TABLE exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  valid_from date NOT NULL,
  uzs_per_usd numeric(14,2) NOT NULL CHECK (uzs_per_usd > 0),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, valid_from)
);
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exchange_rates
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON exchange_rates TO crm_app;
