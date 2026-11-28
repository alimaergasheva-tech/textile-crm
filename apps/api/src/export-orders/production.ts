/** Выпуск по моделям: цепочка раскрой → пошив → упаковка и отгрузки. */
export type Stage = "cut" | "sew" | "pack";
export interface Totals { cut: number; sew: number; pack: number }
export const STAGE_ORDER: Stage[] = ["cut", "sew", "pack"];
/** Допустимый перерасход раскроя к заказу (запас на брак), доля. */
export const CUT_TOLERANCE = 0.05;

/** Проверка новых данных выпуска: пошив не больше раскроя, упаковка не больше пошива, раскрой не больше заказа + 5%. Возвращает текст ошибки или null. */
export function checkProduction(cur: Totals, stage: Stage, add: number, orderQty: number): string | null {
  const next = { ...cur, [stage]: cur[stage] + add };
  if (next.cut > Math.floor(orderQty * (1 + CUT_TOLERANCE))) return `Раскрой ${next.cut} превышает заказ ${orderQty} более чем на ${CUT_TOLERANCE * 100}%`;
  if (next.sew > next.cut) return `Пошив ${next.sew} не может превышать раскрой ${next.cut}`;
  if (next.pack > next.sew) return `Упаковка ${next.pack} не может превышать пошив ${next.sew}`;
  return null;
}
/** Удаление записи не должно нарушать цепочку (после удаления пошив ≤ раскрой, упаковка ≤ пошива, отгружено ≤ упаковано). */
export function checkRemoval(cur: Totals, stage: Stage, qty: number, shipped: number): string | null {
  const next = { ...cur, [stage]: cur[stage] - qty };
  if (next.sew > next.cut) return "После удаления пошив превысит раскрой — сначала удалите записи пошива";
  if (next.pack > next.sew) return "После удаления упаковка превысит пошив — сначала удалите записи упаковки";
  if (shipped > next.pack) return "Эта упаковка уже отгружена — удалить нельзя";
  return null;
}
export const pct = (done: number, total: number) => (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);

export const SHIP_STATUSES = ["planned", "loaded", "in_transit", "delivered", "cancelled"] as const;
export type ShipStatus = (typeof SHIP_STATUSES)[number];
const NEXT: Record<ShipStatus, ShipStatus[]> = { planned: ["loaded", "cancelled"], loaded: ["in_transit", "cancelled"], in_transit: ["delivered"], delivered: [], cancelled: [] };
export const canShip = (from: ShipStatus, to: ShipStatus) => NEXT[from]?.includes(to) ?? false;
/** Сколько ещё можно отгрузить по модели: упаковано минус уже отгружено (без отменённых). */
export const shippable = (packed: number, shipped: number) => Math.max(0, packed - shipped);
