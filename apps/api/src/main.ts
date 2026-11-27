import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { ZodError } from "zod";
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { AppModule } from "./app.module.ts";

@Catch(ZodError)
class ZodFilter implements ExceptionFilter {
  catch(e: ZodError, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(400).json({ statusCode: 400, error: "validation", message: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), issues: e.issues });
  }
}

const app = await NestFactory.create(AppModule);
(app as any).useBodyParser?.("json", { limit: "12mb" });
(app as any).set?.("trust proxy", true); // за Caddy: настоящий IP клиента в журнале и в ограничении попыток входа
app.use(cookieParser());
app.useGlobalFilters(new ZodFilter());
app.enableCors({ origin: [...(process.env.WEB_ORIGIN ?? "http://localhost:5173").split(","), "http://localhost:5174", ...(process.env.MINIAPP_ORIGIN ? process.env.MINIAPP_ORIGIN.split(",") : [])], credentials: true });
await app.listen(Number(process.env.PORT ?? 3000));
console.log(`API: http://localhost:${process.env.PORT ?? 3000}`);
