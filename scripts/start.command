#!/bin/bash
# Запуск всего: база, API, сайт и открытие браузера. Остановка: Ctrl+C или закрыть окно.
cd "$(dirname "$0")/.."
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
brew services start postgresql@16 >/dev/null 2>&1
set -a; source .env; set +a
pnpm install --silent >/tmp/textile-install.log 2>&1 || { echo "Ошибка установки пакетов, см. /tmp/textile-install.log"; cat /tmp/textile-install.log; exit 1; }
pnpm db:migrate >/tmp/textile-migrate.log 2>&1 || { echo "Ошибка миграций, см. /tmp/textile-migrate.log"; cat /tmp/textile-migrate.log; exit 1; }

pnpm --filter @textile/api db:seed >/tmp/textile-seed.log 2>&1 && pnpm --filter @textile/api db:seed-demo >>/tmp/textile-seed.log 2>&1 && pnpm --filter @textile/api db:seed-stock >>/tmp/textile-seed.log 2>&1 && pnpm --filter @textile/api db:seed-platform >>/tmp/textile-seed.log 2>&1 || { echo "Ошибка демо-данных, см. /tmp/textile-seed.log"; cat /tmp/textile-seed.log; }

pnpm --filter @textile/api dev > /tmp/textile-api.log 2>&1 &
API=$!
pnpm --filter @textile/web dev > /tmp/textile-web.log 2>&1 &
WEB=$!
pnpm --filter @textile/miniapp dev > /tmp/textile-mini.log 2>&1 &
MINI=$!
trap 'kill $API $WEB $MINI 2>/dev/null; exit 0' INT TERM EXIT

echo "Запускаю… (журналы: /tmp/textile-api.log, /tmp/textile-web.log)"
for i in $(seq 1 60); do
  curl -s -o /dev/null localhost:5173 && curl -s -o /dev/null localhost:3000 && break
  sleep 1
done
open http://localhost:5173
echo "Открыто: http://localhost:5173  (вход: demo-a / owner@demo-a.uz / demo12345)"
echo "Панель платформы: http://localhost:5173/platform  (platform@local.dev / platform12345)"
echo "Mini App для проверки в браузере: http://localhost:5174/?t=demo-a"
echo "Чтобы остановить, нажмите Ctrl+C или закройте это окно."
wait
