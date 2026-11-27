# Выкладка: Railway (API + база) и Vercel (сайт + Mini App)

Vercel хостит только статику, поэтому API, Postgres, ночные задачи и очередь уведомлений Telegram живут в Railway.
Схема: `Vercel (web)` и `Vercel (Mini App)` → `Railway (API)` → `Railway (Postgres + том с фото)`.
Вариант «всё на своём сервере» описан в `docs/DEPLOY.md`.

## 1. Railway: база и API
1. railway.com → New Project → **Deploy PostgreSQL**.
2. В том же проекте: **New → GitHub Repo → textile-crm**. Railway сам возьмёт `railway.json` и `Dockerfile.api`.
3. Сервис API → **Variables**:
   | Переменная | Значение |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (ссылка на сервис базы) |
   | `APP_DB_PASSWORD` | длинная случайная строка (`openssl rand -base64 32`); роль `crm_app` создаётся при старте |
   | `JWT_SECRET` | `openssl rand -base64 48` |
   | `WEB_ORIGIN` | адрес сайта на Vercel, например `https://textile-crm-web.vercel.app` |
   | `MINIAPP_ORIGIN` | адрес Mini App на Vercel |
   | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | из BotFather (токен вводите только в Railway) |
   | `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` | первый вход в панель платформы; потом смените пароль |
4. Сервис API → **Settings → Volumes → New Volume**, путь `/data/files` (там лежат фото брака и рекламаций).
5. **Settings → Networking → Generate Domain**: получится адрес вида `https://textile-api.up.railway.app`. Проверка: `<адрес>/health` отвечает `{"ok":true}`.

## 2. Vercel: сайт и Mini App (два проекта из одного репозитория)
Для каждого: vercel.com → Add New → Project → импорт `textile-crm`.

| Проект | Root Directory | Environment Variables |
|---|---|---|
| сайт | `apps/web` | `VITE_API_URL` = адрес API из Railway |
| Mini App | `apps/miniapp` | `VITE_API_URL` = адрес API из Railway |

Настройки сборки уже лежат в `apps/*/vercel.json`. Опция «Include source files outside of the Root Directory» должна быть включена (по умолчанию так).
После первой выкладки вернитесь в Railway и впишите настоящие адреса Vercel в `WEB_ORIGIN` и `MINIAPP_ORIGIN` (без `/` на конце), иначе браузер заблокирует запросы (CORS). Сервис перезапустится сам.

## 3. Бот
В локальном `.env` поставьте `MINIAPP_URL=<адрес Mini App на Vercel>` и дважды щёлкните `scripts/bot-setup.command`: кнопка «Открыть CRM» начнёт вести на постоянный адрес вместо временного туннеля.
Очередь уведомлений бота работает в API, поэтому локальный API с тем же токеном лучше остановить, иначе два процесса будут отвечать боту.

## 4. Первый вход и фабрики
Панель платформы: `<адрес сайта>/platform` (вход — `PLATFORM_ADMIN_EMAIL` и пароль). Там создаётся фабрика и её владелец.
Импорт данных: меню «Импорт» (`docs/DEPLOY.md`, раздел про CSV).

## Ограничения
- Фото лежат на томе Railway: включите бэкап тома и делайте `pg_dump` базы (`docs/OPERATIONS.md`).
- Бесплатного тарифа Railway обычно не хватает для боевой работы: смотрите актуальные лимиты на railway.com/pricing.
