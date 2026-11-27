import { createHmac, timingSafeEqual } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";

export interface TgUser { id: number; first_name?: string; last_name?: string; username?: string }
export interface InitData { user: TgUser; startParam?: string }

/**
 * Проверка подписи Telegram Mini App (initData): HMAC-SHA256 от строки параметров, ключ — HMAC("WebAppData", токен бота).
 * Данные старше суток отклоняются.
 */
export function verifyInitData(initData: string, botToken: string, now = Date.now()): InitData {
  if (!botToken) throw new UnauthorizedException("Бот не настроен: задайте TELEGRAM_BOT_TOKEN");
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new UnauthorizedException("Нет подписи");
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = createHmac("sha256", secret).update(check).digest("hex");
  const a = Buffer.from(calc, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException("Неверная подпись");
  const authDate = Number(params.get("auth_date"));
  if (!authDate || now / 1000 - authDate > 86400) throw new UnauthorizedException("Данные входа устарели");
  const user = JSON.parse(params.get("user") ?? "null") as TgUser | null;
  if (!user?.id) throw new UnauthorizedException("Нет пользователя");
  return { user, startParam: params.get("start_param") ?? undefined };
}

/** Для тестов: подписывает данные так же, как Telegram. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
