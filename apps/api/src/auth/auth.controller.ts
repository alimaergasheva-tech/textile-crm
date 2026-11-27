import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { z } from "zod";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service.ts";
import { Public, AuthUser } from "../rbac/rbac.ts";
import { config } from "../config.ts";

const LoginDto = z.object({ tenant: z.string().min(1), email: z.string().email(), password: z.string().min(1) });
const COOKIE = "refresh_token";
const cookieOpts = { httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production",
  path: "/auth", maxAge: config.refreshTtlDays * 86400_000 };

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private auth: AuthService) {}

  @Public() @Post("login") @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const d = LoginDto.parse(body);
    const t = await this.auth.login(d.tenant, d.email, d.password, req.ip);
    res.cookie(COOKIE, t.refreshToken, cookieOpts);
    return { accessToken: t.accessToken };
  }

  @Public() @Post("telegram") @HttpCode(200)
  telegram(@Body() body: unknown, @Req() req: Request) {
    const d = z.object({ tenant: z.string().min(1), initData: z.string().min(1) }).parse(body);
    return this.auth.telegramLogin(d.tenant, d.initData, req.ip);
  }

  @Public() @Post("telegram/link") @HttpCode(200)
  telegramLink(@Body() body: unknown, @Req() req: Request) {
    const d = z.object({ tenant: z.string().min(1), initData: z.string().min(1), token: z.string().min(8) }).parse(body);
    return this.auth.telegramLink(d.tenant, d.initData, d.token, req.ip);
  }

  @Public() @Post("refresh") @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const t = await this.auth.refresh(String(req.cookies?.[COOKIE] ?? ""));
    res.cookie(COOKIE, t.refreshToken, cookieOpts);
    return { accessToken: t.accessToken };
  }

  @Public() @Post("logout") @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: "/auth" });
  }

  @Get("me")
  me(@Req() req: Request & { user: AuthUser }) {
    return { id: req.user.id, tenantId: req.user.tenantId, permissions: [...req.user.perms.keys()] };
  }
}
