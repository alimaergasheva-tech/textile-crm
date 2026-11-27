export type Locale = "ru" | "uz";
export type Currency = "UZS" | "USD";
/** Деньги всегда в минимальных единицах (целые числа) с валютой. */
export interface Money { amount: bigint | number; currency: Currency }
