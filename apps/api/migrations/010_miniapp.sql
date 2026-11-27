-- Этап 7 «Telegram Mini App»: приглашения, состав бригад, идемпотентность, очередь уведомлений
ALTER TABLE users ADD CONSTRAINT users_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE telegram_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);

CREATE TABLE brigade_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  brigade_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (brigade_id, user_id),
  FOREIGN KEY (tenant_id, brigade_id) REFERENCES brigades (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);

-- Повторная отправка одной и той же отметки (обрыв связи) возвращает прежний ответ и ничего не дублирует
CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL,
  user_id uuid,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX notifications_pending_idx ON notifications (tenant_id, next_attempt_at) WHERE status = 'pending';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['telegram_invites','brigade_members','idempotency_keys','notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE notifications_id_seq TO crm_app;

-- Роль «Бригадир»: видит производство и отмечает выполнение
INSERT INTO roles (tenant_id, code, name, is_system) SELECT id, 'brigadier', 'Бригадир', true FROM tenants;
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p FROM roles r, unnest(ARRAY['production.view','production.report']) p WHERE r.code = 'brigadier';
