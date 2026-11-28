/** Образцы 1-fit и PP: статус выводится из заполненных дат и решения клиента. */
export type Decision = "approved" | "approved_comments" | "rejected";
export type SampleStatus = "planned" | "made" | "sent" | "delivered" | Decision;
export interface SampleFields { madeAt?: string | null; sentAt?: string | null; deliveredAt?: string | null; decision?: Decision | null }

export function deriveStatus(f: SampleFields): SampleStatus {
  if (f.decision) return f.decision;
  if (f.deliveredAt) return "delivered";
  if (f.sentAt) return "sent";
  if (f.madeAt) return "made";
  return "planned";
}
/** Ошибка последовательности дат (или null). */
export function checkDates(f: SampleFields & { decidedAt?: string | null }): string | null {
  const seq: [string, string | null | undefined][] = [["пошива", f.madeAt], ["отправки", f.sentAt], ["доставки", f.deliveredAt], ["решения клиента", f.decidedAt]];
  const set = seq.filter(([, v]) => v);
  for (let i = 1; i < set.length; i++) if ((set[i][1] as string) < (set[i - 1][1] as string)) return `Дата ${set[i][0]} раньше даты ${set[i - 1][0]}`;
  if (f.sentAt && !f.madeAt) return "Нельзя отправить образец, который не отмечен как сшитый";
  if (f.decision && !f.sentAt) return "Решение клиента возможно только после отправки образца";
  return null;
}
export const isApproved = (s: string) => s === "approved" || s === "approved_comments";
/** Нужен ли новый круг: клиент не принял образец. */
export const needsNewRound = (s: string) => s === "rejected" || s === "approved_comments";
