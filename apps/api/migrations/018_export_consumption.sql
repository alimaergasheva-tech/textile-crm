-- Этап 11: параметры расчёта расхода хранятся в заказе; добавлены позиции фурнитуры «резинка 35 мм» и «шнурок-бантик».
ALTER TABLE export_orders ADD COLUMN calc_params jsonb NOT NULL DEFAULT '{}';

INSERT INTO export_accessories (tenant_id, code, name, unit)
SELECT t.id, a.code, a.name, a.unit FROM tenants t,
 (VALUES ('ELASTIC35','Резинка 35 мм','м'),('BOW','Шнурок-бантик из кулирки D=0,5 см','м')) AS a(code,name,unit)
ON CONFLICT (tenant_id, code) DO NOTHING;
