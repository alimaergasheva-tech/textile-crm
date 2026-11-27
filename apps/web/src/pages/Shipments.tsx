import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, openPdf } from "../api";
import { useMe, useUi } from "../state";

export function ShipmentsPage() {
  const { t } = useUi();
  const list = useQuery({ queryKey: ["shipments"], queryFn: () => api<any[]>("/shipments") });
  return (
    <div>
      <h1>{t("shipments")}</h1>
      <table>
        <thead><tr><th>{t("number")}</th><th>{t("order")}</th><th>{t("client")}</th><th>{t("status")}</th><th>{t("qty")}</th><th>{t("shipDate")}</th></tr></thead>
        <tbody>{list.data?.map((s) => <tr key={s.id}><td className="mono"><Link to={`/shipments/${s.id}`}>{s.number}</Link></td><td>{s.order_number}</td><td>{s.client}</td><td>{s.status}</td><td className="num">{s.qty}</td><td>{s.shipped_at?.slice(0, 10)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

/** Накладная и упаковочный лист: печатаются из браузера («Печать» → «Сохранить как PDF»). */
export function ShipmentView() {
  const { id } = useParams();
  const { t, lang } = useUi() as any;
  const { can } = useMe();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ["shipment", id], queryFn: () => api<any>(`/shipments/${id}`) });
  const act = useMutation({ mutationFn: (a: string) => api(`/shipments/${id}/${a}`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["shipment", id] }); qc.invalidateQueries({ queryKey: ["shipments"] }); qc.invalidateQueries({ queryKey: ["balances"] }); } });
  if (!d.data) return <p>{t("loading")}</p>;
  const s = d.data;
  return (
    <div>
      <div className="no-print">
        <h1>{s.number} · {s.status}</h1>
        {s.status === "draft" && can("shipments.create") && <button onClick={() => act.mutate("ship")}>{t("shipNow")}</button>}{" "}
        {s.status === "draft" && can("shipments.create") && <button onClick={() => act.mutate("cancel")}>{t("cancelIt")}</button>}{" "}
        <button onClick={() => openPdf(`/shipments/${id}/pdf?lang=${lang ?? "ru"}`)}>PDF</button>{" "}
        <button onClick={() => window.print()}>{t("printIt")}</button>
        {act.isError && <p className="err">{(act.error as Error).message}</p>}
      </div>
      <h2>{t("invoice")} {s.number}</h2>
      <p>{s.factory} → {s.client} · {t("order")} {s.order_number} · {(s.shipped_at ?? s.created_at).slice(0, 10)}</p>
      <table>
        <thead><tr><th>SKU</th><th>{t("name")}</th><th>{t("color")}</th><th>{t("size")}</th><th>{t("qty")}</th><th>{t("price")}</th><th>{t("amount")}</th></tr></thead>
        <tbody>{s.items.map((i: any) => <tr key={i.id}><td>{i.sku}</td><td>{i.model_name}</td><td>{i.color}</td><td>{i.size}</td><td className="num">{i.qty}</td><td className="num">{i.unit_price}</td><td className="num">{i.qty * i.unit_price}</td></tr>)}</tbody>
        <tfoot><tr><td colSpan={4}>{t("total")}</td><td className="num">{s.totalQty}</td><td></td><td className="num">{s.totalAmount} {s.currency}</td></tr></tfoot>
      </table>
      <h2 style={{ pageBreakBefore: "always" }}>{t("packingList")} {s.number}</h2>
      <table>
        <thead><tr><th>SKU</th><th>{t("barcode")}</th><th>{t("qty")}</th></tr></thead>
        <tbody>{s.items.map((i: any) => <tr key={i.id}><td>{i.sku}</td><td className="mono">{i.barcode}</td><td className="num">{i.qty}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
