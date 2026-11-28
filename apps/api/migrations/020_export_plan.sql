-- Этап 13: план-график (Gantt) по экспортному заказу, факт выполнения и ежедневные уведомления об опозданиях.
ALTER TABLE export_orders ADD COLUMN plan_start date;

CREATE TABLE export_plan_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  seq int NOT NULL,                              -- номер в плане (на него ссылаются предшественники)
  stage text NOT NULL,
  name text NOT NULL,
  department_code text,                          -- отдел-исполнитель (departments.code)
  party text,                                    -- внешний исполнитель: Клиент, Узтекс, Eren Textile
  duration_days int NOT NULL CHECK (duration_days >= 1),
  predecessors int[] NOT NULL DEFAULT '{}',
  planned_start date, planned_end date,
  baseline_start date, baseline_end date,        -- первоначальный план (для расчёта сдвига)
  actual_start date, actual_end date,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','done')),
  note text,
  notified_on date,                              -- когда последний раз отправлено уведомление об опоздании
  version int NOT NULL DEFAULT 1,
  UNIQUE (order_id, seq), UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES export_orders (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX export_plan_late_idx ON export_plan_tasks (tenant_id, planned_end) WHERE status <> 'done';

ALTER TABLE export_plan_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_plan_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON export_plan_tasks USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON export_plan_tasks TO crm_app;

INSERT INTO permissions (code, module, action, description) VALUES
 ('exportplan.update','exportplan','edit','Отмечать выполнение этапов плана своего отдела'),
 ('exportplan.manage','exportplan','manage','Создавать и пересчитывать план-график, менять этапы любых отделов');
-- Отмечать свои этапы могут все, у кого есть доступ к заказам; управляют планом руководство, продажи, планировщик и начальник производства.
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportplan.update', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','sales_manager','technologist','production_head','qc','purchaser','ved','logistics','planner');
INSERT INTO role_permissions (tenant_id, role_id, permission_code, own_only)
SELECT r.tenant_id, r.id, 'exportplan.manage', false FROM roles r
 WHERE r.code IN ('owner','admin','sales_head','production_head','planner');
