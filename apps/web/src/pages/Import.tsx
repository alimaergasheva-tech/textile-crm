import { useState } from "react";
import { api } from "../api";
import { useUi } from "../state";

const TEMPLATES: Record<string, { title: string; csv: string; hint: string }> = {
  clients: { title: "Клиенты", hint: "Обязательно: название. Лимит — в суммах (сум или $). Повторная загрузка обновляет клиента с тем же названием или внешним ID.",
    csv: "название;тип;тип цены;инн;адрес;телефон;контакт;кредитный лимит;валюта;внешний id\nООО Пример;опт;опт;123456789;Ташкент, ул. Навои 1;+998901234567;Иванов И.;50000000;UZS;K-0001\n" },
  materials: { title: "Материалы", hint: "Тип: ткань, подкладка, нитки, фурнитура, упаковка. Единица: м, кг, шт, рулон, комплект, бобина. Повтор обновляет материал с тем же кодом.",
    csv: "код;название;тип;ед;мин. остаток;внешний id\nFAB-COT;Хлопок 180 г;ткань;м;500;M-001\nTHR-001;Нитки белые;нитки;бобина;20;M-002\n" },
  stock: { title: "Начальные остатки", hint: "Готовая продукция — по артикулу варианта; сырьё — по коду материала (ткань принимается рулонами на складе). Загружается один раз на позицию.",
    csv: "артикул;код материала;количество;ячейка\nH-002-RED-S;;120;\n;THR-001;40;\n" },
};

async function readText(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  const utf = new TextDecoder("utf-8").decode(buf);
  return utf.includes("�") ? new TextDecoder("windows-1251").decode(buf) : utf; // Excel в Windows сохраняет CSV в cp1251
}

/** Импорт из CSV: Excel → «Сохранить как CSV». Сначала проверка без записи, потом загрузка. */
export function ImportPage() {
  const { t } = useUi();
  const [entity, setEntity] = useState("clients");
  const [csv, setCsv] = useState(""); const [name, setName] = useState("");
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setErr(""); setBusy(true);
    try { setRes(await api(`/import/${entity}`, { method: "POST", body: JSON.stringify({ csv, dryRun }) })); }
    catch (e) { setErr((e as Error).message); setRes(null); } finally { setBusy(false); }
  };
  const tpl = TEMPLATES[entity];
  const download = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + tpl.csv], { type: "text/csv" })); a.download = `${entity}-шаблон.csv`; a.click(); };
  return (
    <div>
      <h1>{t("importData")}</h1>
      <p>
        <select value={entity} onChange={(e) => { setEntity(e.target.value); setRes(null); setCsv(""); setName(""); }}>
          {Object.entries(TEMPLATES).map(([k, v]) => <option key={k} value={k}>{v.title}</option>)}</select>{" "}
        <button onClick={download}>Шаблон CSV</button>
      </p>
      <p className="muted">{tpl.hint}</p>
      <p><input type="file" accept=".csv,text/csv,.txt" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await readText(f)); setName(f.name); setRes(null); setErr(""); } }} />
        {name && <span className="muted"> {name}</span>}</p>
      <p><button disabled={!csv || busy} onClick={() => run(true)}>Проверить</button>{" "}
        <button disabled={!res || res.errorCount > 0 || res.applied || !res.dryRun || busy} onClick={() => run(false)}>Загрузить</button></p>
      {err && <p className="err">{err}</p>}
      {res && <div>
        <p><b>{res.applied ? "Загружено" : res.errorCount ? "Есть ошибки — ничего не загружено" : "Проверка пройдена"}</b>:
          {" "}строк {res.rows}, новых {res.created}, обновится {res.updated}{res.errorCount ? `, ошибок ${res.errorCount}` : ""}</p>
        {!!res.ignoredColumns?.length && <p className="muted">Не распознаны и пропущены колонки: {res.ignoredColumns.join(", ")}</p>}
        {!!res.errors?.length && <table><thead><tr><th>Строка</th><th>Ошибка</th></tr></thead>
          <tbody>{res.errors.map((x: any, i: number) => <tr key={i}><td className="num">{x.row}</td><td className="err">{x.message}</td></tr>)}</tbody></table>}
      </div>}
    </div>
  );
}
