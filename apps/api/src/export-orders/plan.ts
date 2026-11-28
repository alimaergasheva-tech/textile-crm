/** Планирование по рабочим дням (пн–пт). Праздники пока не учитываются. */
const DAY = 86400_000;
export const toDate = (s: string): Date => new Date(s + "T00:00:00Z");
export const fmt = (d: Date): string => d.toISOString().slice(0, 10);
const isWork = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
export const nextWorkday = (d: Date): Date => { let x = new Date(d); while (!isWork(x)) x = new Date(+x + DAY); return x; };
/** День, следующий за d, который является рабочим. */
export const afterDay = (d: Date): Date => nextWorkday(new Date(+d + DAY));
/** Дата, отстоящая от начала на (n−1) рабочих дней: окончание задачи длительностью n дней, начатой в start. */
export const endFrom = (start: Date, n: number): Date => { let x = nextWorkday(start); for (let i = 1; i < n; i++) x = afterDay(x); return x; };
export const workdaysBetween = (a: Date, b: Date): number => { // сколько рабочих дней от a (искл.) до b (вкл.), отрицательное, если b раньше
  if (+a === +b) return 0;
  const [lo, hi, sign] = +a < +b ? [a, b, 1] : [b, a, -1];
  let n = 0; for (let x = new Date(+lo + DAY); +x <= +hi; x = new Date(+x + DAY)) if (isWork(x)) n++;
  return n * sign;
};

export interface TemplateTask { seq: number; stage: string; name: string; dept: string | null; party: string | null; days: number | "sewing"; pred: number[] }
/** Типовой план экспортного заказа (23 этапа модели SET44 + ВЭД и бронирование машины). Длительности можно менять в заказе. */
export const TEMPLATE: TemplateTask[] = [
  { seq: 1, stage: "1. Лид", name: "Получение запроса: цена и сроки, образцы, табели мер", dept: "sales", party: null, days: 1, pred: [] },
  { seq: 2, stage: "2. Расчёт", name: "Черновой расчёт расхода полотна и фурнитуры по моделям", dept: "tech", party: null, days: 2, pred: [1] },
  { seq: 3, stage: "2. Расчёт", name: "Запрос цен: полотно — Узтекс, фурнитура — Eren Textile", dept: "purchasing", party: null, days: 3, pred: [2] },
  { seq: 4, stage: "2. Расчёт", name: "Себестоимость, сроки, КП клиенту", dept: "sales", party: null, days: 2, pred: [3] },
  { seq: 5, stage: "3. Подтверждение", name: "Подтверждение цены и сроков клиентом", dept: "sales", party: "Клиент", days: 3, pred: [4] },
  { seq: 6, stage: "4. Закупки", name: "Финальный расход полотна и фурнитуры (раскладки)", dept: "tech", party: null, days: 3, pred: [5] },
  { seq: 7, stage: "4. Закупки", name: "Заказ полотна — Узтекс (договор, предоплата)", dept: "purchasing", party: null, days: 2, pred: [6] },
  { seq: 8, stage: "4. Закупки", name: "Заказ фурнитуры — Eren Textile (Турция)", dept: "purchasing", party: null, days: 2, pred: [6] },
  { seq: 9, stage: "5. Образцы", name: "1-fit образцы по моделям", dept: "production", party: null, days: 7, pred: [5] },
  { seq: 10, stage: "5. Образцы", name: "Отправка 1-fit клиенту (курьер, запись AWB)", dept: "sales", party: null, days: 5, pred: [9] },
  { seq: 11, stage: "5. Образцы", name: "Подтверждение 1-fit клиентом (комментарии)", dept: "sales", party: "Клиент", days: 4, pred: [10] },
  { seq: 12, stage: "4. Закупки", name: "Производство полотна Узтекс (вязка, крашение, AOP)", dept: "purchasing", party: "Узтекс", days: 20, pred: [7] },
  { seq: 13, stage: "4. Закупки", name: "Доставка полотна на фабрику", dept: "logistics", party: null, days: 3, pred: [12] },
  { seq: 14, stage: "4. Закупки", name: "Производство и поставка фурнитуры Eren (Турция → фабрика)", dept: "purchasing", party: "Eren Textile", days: 15, pred: [8] },
  { seq: 15, stage: "4. Закупки", name: "Входной контроль полотна и фурнитуры (усадка, плотность, тон)", dept: "qc", party: null, days: 2, pred: [13, 14] },
  { seq: 16, stage: "5. Образцы", name: "Предпроизводственные образцы (PP) из партии полотна", dept: "production", party: null, days: 5, pred: [11, 15] },
  { seq: 17, stage: "5. Образцы", name: "Отправка PP клиенту (курьер, запись AWB)", dept: "sales", party: null, days: 5, pred: [16] },
  { seq: 18, stage: "5. Образцы", name: "Подтверждение PP клиентом", dept: "sales", party: "Клиент", days: 4, pred: [17] },
  { seq: 19, stage: "6. Производство", name: "Раскрой", dept: "production", party: null, days: 5, pred: [18] },
  { seq: 20, stage: "6. Производство", name: "Пошив (по мощности цеха)", dept: "production", party: null, days: "sewing", pred: [19] },
  { seq: 21, stage: "6. Производство", name: "Термотрансфер, финишинг, упаковка в полибэги", dept: "production", party: null, days: 5, pred: [20] },
  { seq: 22, stage: "7. Контроль", name: "Финальная инспекция AQL 2.5 + отчёт с фото", dept: "qc", party: null, days: 2, pred: [21] },
  { seq: 23, stage: "8. Отгрузка", name: "ВЭД: пакет документов (инвойс, упаковочный лист, CMR, ГТД, СТ-1)", dept: "ved", party: null, days: 4, pred: [21] },
  { seq: 24, stage: "8. Отгрузка", name: "Бронирование машины под объём (м³) и подача под загрузку", dept: "logistics", party: null, days: 2, pred: [21] },
  { seq: 25, stage: "8. Отгрузка", name: "Отгрузка в США (загрузка, документы клиенту)", dept: "logistics", party: null, days: 3, pred: [22, 23, 24] },
];

export interface PlanTask {
  seq: number; days: number; pred: number[]; status: "todo" | "in_progress" | "blocked" | "done";
  actualStart?: string | null; actualEnd?: string | null;
}
export interface Scheduled { seq: number; start: string; end: string }

/**
 * Пересчёт плана. Выполненные этапы заканчиваются в фактическую дату, начатые не раньше факта, а этап, который не закончен,
 * не может заканчиваться раньше сегодняшнего дня (иначе опоздание «пропадало» бы из плана). Следующие этапы сдвигаются автоматически.
 */
export function schedule(tasks: PlanTask[], startDate: string, today: string): Scheduled[] {
  const bySeq = new Map(tasks.map((t) => [t.seq, t]));
  const out = new Map<number, Scheduled>();
  const visiting = new Set<number>();
  const calc = (t: PlanTask): Scheduled => {
    const hit = out.get(t.seq); if (hit) return hit;
    if (visiting.has(t.seq)) throw new Error(`Цикл в предшественниках этапа ${t.seq}`);
    visiting.add(t.seq);
    let start = t.pred.length ? afterDay(new Date(Math.max(...t.pred.map((p) => {
      const pt = bySeq.get(p); if (!pt) throw new Error(`Нет этапа-предшественника ${p} у этапа ${t.seq}`);
      return +toDate(calc(pt).end);
    })))) : nextWorkday(toDate(startDate));
    if (t.actualStart) start = nextWorkday(toDate(t.actualStart));
    let end: Date;
    if (t.status === "done" && t.actualEnd) end = toDate(t.actualEnd);
    else { end = endFrom(start, t.days); if (+end < +toDate(today)) end = nextWorkday(toDate(today)); }
    if (+end < +start) end = start;
    const r = { seq: t.seq, start: fmt(start), end: fmt(end) };
    out.set(t.seq, r); visiting.delete(t.seq);
    return r;
  };
  tasks.forEach(calc);
  return tasks.map((t) => out.get(t.seq)!);
}

/** Сколько календарных дней просрочен этап: срок прошёл, а этап не завершён. 0 — не просрочен. */
export const lateDays = (plannedEnd: string, status: string, today: string): number =>
  status === "done" ? 0 : Math.max(0, Math.round((+toDate(today) - +toDate(plannedEnd)) / DAY));
