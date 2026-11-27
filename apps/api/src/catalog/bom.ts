export interface BomLine { materialId: string; sizeId: string | null; qtyPerUnit: number; wastePercent: number }
export interface RunItem { sizeId: string; qty: number }

/**
 * Потребность в материалах для партии (CAT-3): Σ qty × норма × (1 + отход/100).
 * Строка BOM с размером перекрывает общую строку для этого размера.
 */
export function calcRequirement(bom: BomLine[], items: RunItem[]): Map<string, number> {
  const need = new Map<string, number>();
  const materials = new Set(bom.map((l) => l.materialId));
  for (const m of materials) {
    const lines = bom.filter((l) => l.materialId === m);
    const general = lines.find((l) => l.sizeId === null);
    let total = 0;
    for (const it of items) {
      const line = lines.find((l) => l.sizeId === it.sizeId) ?? general;
      if (line) total += it.qty * line.qtyPerUnit * (1 + line.wastePercent / 100);
    }
    need.set(m, Math.round(total * 1000) / 1000);
  }
  return need;
}
