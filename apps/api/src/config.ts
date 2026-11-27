const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Не задана переменная окружения ${k} (см. .env.example)`);
  return v;
};
export const config = {
  appDatabaseUrl: () => need("APP_DATABASE_URL"),
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
