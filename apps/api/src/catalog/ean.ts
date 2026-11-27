/** Внутренний EAN-13: префикс 20 (зарезервирован для внутреннего использования) + 10 цифр номера + контрольная цифра. */
export function ean13(seq: number): string {
  const body = "20" + String(seq).padStart(10, "0");
  if (body.length !== 12) throw new Error("Номер штрихкода слишком велик");
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body + ((10 - (sum % 10)) % 10);
}
