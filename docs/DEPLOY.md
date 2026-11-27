# Развёртывание на сервере (этап 9.5)

Один сервер, всё в Docker: база PostgreSQL, API, сайт и Mini App за Caddy (HTTPS выпускается автоматически). Файлы: `Dockerfile`, `docker-compose.prod.yml`, `deploy/Caddyfile`, `.env.production.example`, скрипты `deploy/*.sh`.

> Эти файлы подготовлены, но на реальном сервере я их не запускал: первый запуск делайте сначала на staging (см. «Проверка после запуска»).

## Что нужно
- **Сервер:** Ubuntu 22.04/24.04, 2 vCPU, 4 ГБ RAM, диск 40 ГБ+ (для пилота одной фабрики достаточно). Открыты порты 80 и 443, остальные закрыты (`ufw allow 80,443,22/tcp`).
- **Домен** (например `crm.example.uz`) и три A-записи на IP сервера: `app.crm.example.uz` (сайт), `m.crm.example.uz` (Mini App), `api.crm.example.uz` (API).
- **Telegram-бот** из BotFather (токен и username).

## Первый запуск
1. Установить Docker: `curl -fsSL https://get.docker.com | sh`.
2. Скопировать проект на сервер (`git clone` или `rsync` без `node_modules`, `.env`, `apps/api/data`).
3. `cp .env.production.example .env` и заполнить: `DOMAIN`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` (разные длинные пароли), `JWT_SECRET` (`openssl rand -base64 48`), токен и username бота, `PLATFORM_ADMIN_EMAIL` и `PLATFORM_ADMIN_PASSWORD`. Файл `.env` не коммитить и никому не пересылать.
4. `docker compose -f docker-compose.prod.yml up -d --build`. При старте API сам применяет миграции и создаёт администратора платформы.
5. Подождать 1–2 минуты (выпуск сертификатов), открыть `https://app.<DOMAIN>/platform`, войти администратором платформы и **сразу сменить пароль**; создать фабрику-клиента (кнопка в панели).
6. Кнопка бота: в BotFather или через API (`setChatMenuButton`) указать адрес `https://m.<DOMAIN>`. Для приглашения сотрудников используется страница «Бригады» / «Пользователи» на сайте.

## Проверка после запуска
- `curl https://api.<DOMAIN>/health` → `{"ok":true}`.
- Войти в сайт, создать клиента, открыть Mini App из бота, привязать Telegram по приглашению.
- Прогнать сквозной тест на пустой тестовой фабрике: `node scripts/e2e.mjs https://api.<DOMAIN>` (по умолчанию входит в `demo-a`; для тестовой фабрики задайте `E2E_TENANT`, `E2E_EMAIL`, `E2E_PASSWORD`; нужна фабрика с моделью, маршрутом и ценой) и нагрузочный: `node scripts/loadtest.mjs https://api.<DOMAIN> 50 60`.
- Загрузить фото брака к тестовому заданию, перезапустить `docker compose ... restart api` и убедиться, что фото осталось (хранится в томе `files`).

## Резервные копии (обязательно до пилота)
```
# раз в сутки в 03:00 и проверка доступности раз в минуту
(crontab -l; echo '0 3 * * * /opt/textile/deploy/backup.sh >> /var/log/textile-backup.log 2>&1') | crontab -
(crontab -l; echo '* * * * * HEALTH_URL=https://api.<DOMAIN> ALERT_BOT_TOKEN=<токен> ALERT_CHAT_ID=<id чата> /opt/textile/deploy/healthcheck.sh') | crontab -
```
Копии лежат в `/var/backups/textile` (база и фото, хранятся 30 дней) — **дополнительно копируйте их на другой сервер или в облако**: копия на том же диске не спасёт при его потере. Восстановление: `deploy/restore.sh db-….dump files-….tgz` (перезаписывает данные). Раз в месяц проверяйте восстановление на staging.

## Обновление версии
1. `git pull` (или залить новые файлы), затем `deploy/backup.sh`.
2. `docker compose -f docker-compose.prod.yml up -d --build` — миграции применятся при старте API; перерыв около минуты.
3. Проверить `/health`, прогнать e2e на тестовой фабрике.
4. Откат: миграции только вперёд; при проблеме — вернуть прежний код и восстановить дамп, сделанный на шаге 1.

## Известные ограничения
- Один сервер без отказоустойчивости: при его потере восстановление — из копии (часы, не минуты).
- Фото на диске сервера; при росте объёма вынесите том на отдельный диск или перейдите на S3.
- Журналы контейнеров: `docker compose -f docker-compose.prod.yml logs -f api`. Sentry и мониторинг метрик не подключены (см. `docs/OPERATIONS.md`).
