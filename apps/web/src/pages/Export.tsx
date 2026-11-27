import { useState } from "react";
import { api, downloadFile } from "../api";
import { useUi } from "../state";

const ENTITIES = ["clients", "models", "materials", "orders", "shipments"] as const;

/** Выгрузка данных в CSV/JSON и привязка внешних ID (код из 1С) — задел под интеграцию. */
export function ExportPage() {
  const { t } = useUi();
  const [err, setErr] = useState("");
  const [f, setF] = useState({ entity: "clients", id: "", externalId: "" });
  const [ok, setOk] = useState(false);
  const dl = (e: string, fmt: "csv" | "json") => downloadFile(`/export/${e}?format=${fmt}`, `${e}.${fmt}`).catch((x) => setErr(String(x.message)));
  return (
    <div>
      <h1>{t("exportData")}</h1>
      <table>
        <tbody>{ENTITIES.map((e) => <tr key={e}><td>{e}</td><td><button onClick={() => dl(e, "csv")}>CSV</button> <button onClick={() => dl(e, "json")}>JSON</button></td></tr>)}</tbody>
      </table>
      {err && <p className="err">{err}</p>}
      <h2>{t("externalId")}</h2>
      <form className="inline" onSubmit={async (e) => {
        e.preventDefault(); setErr(""); setOk(false);
        try { await api(`/export/${f.entity}/${f.id}/external-id`, { method: "PUT", body: JSON.stringify({ externalId: f.externalId || null }) }); setOk(true); }
        catch (x) { setErr((x as Error).message); }
      }}>
        <select value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })}>{ENTITIES.map((e) => <option key={e}>{e}</option>)}</select>
        <input required placeholder="id (uuid из выгрузки)" style={{ minWidth: 300 }} value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} />
        <input placeholder={t("externalId")} value={f.externalId} onChange={(e) => setF({ ...f, externalId: e.target.value })} />
        <button type="submit">{t("save")}</button>{ok && <span> ✓</span>}
      </form>
    </div>
  );
}
