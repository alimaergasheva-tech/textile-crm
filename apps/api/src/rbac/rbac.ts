import { SetMetadata } from "@nestjs/common";

export const PERMISSION_KEY = "permission";
export const Public = () => SetMetadata("public", true);
/** Требует право вида module.action. */
export const RequirePermission = (code: string) => SetMetadata(PERMISSION_KEY, code);

export interface AuthUser {
  id: string;
  tenantId: string;
  /** код права → только свои записи */
  perms: Map<string, boolean>;
}

/** true, если право выдано только на свои записи. */
export const isOwnOnly = (u: AuthUser, code: string): boolean => u.perms.get(code) === true;
