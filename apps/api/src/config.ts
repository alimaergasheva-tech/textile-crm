const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Не задана переменная окружения ${k} (см. .env.example)`);
  return v;
};
export const config = {
  /** APP_DATABASE_URL, а если не задан — адрес DATABASE_URL с пользователем crm_app и паролем APP_DB_PASSWORD (Railway). */
  appDatabaseUrl: (): string => {
    if (process.env.APP_DATABASE_URL) return process.env.APP_DATABASE_URL;
    const admin = process.env.DATABASE_URL, pw = process.env.APP_DB_PASSWORD;
    if (admin && pw) { const u = new URL(admin); u.username = "crm_app"; u.password = pw; return u.toString(); }
    return need("APP_DATABASE_URL");
  },
  jwtSecret: () => need("JWT_SECRET"),
  platformDatabaseUrl: () => process.env.PLATFORM_DATABASE_URL ?? need("DATABASE_URL"),
  clientSecret: () => `${need("JWT_SECRET")}:client`,
  platformSecret: () => `${need("JWT_SECRET")}:platform`,
  botToken: () => process.env.TELEGRAM_BOT_TOKEN ?? "",
  botUsername: () => process.env.TELEGRAM_BOT_USERNAME ?? "",
  accessTtlSec: 15 * 60,
  refreshTtlDays: 30,
  // S3 нужен только для старого пути presign-upload; фото брака и рекламаций хранятся на диске (FILES_DIR)
  s3: () => ({
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    accessKey: process.env.S3_ACCESS_KEY ?? "unused",
    secretKey: process.env.S3_SECRET_KEY ?? "unused",
    bucket: process.env.S3_BUCKET ?? "textile",
  }),
};
