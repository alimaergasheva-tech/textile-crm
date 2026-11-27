#!/bin/bash
# Установка и первый запуск на Mac без Docker: PostgreSQL через Homebrew, база, миграции, тесты, демо-данные.
# Можно запускать повторно: уже сделанное пропускается.
set -e
cd "$(dirname "$0")/.."

if ! command -v brew >/dev/null 2>&1; then
  echo "Не найден Homebrew. Установите его командой с сайта https://brew.sh, откройте новое окно Терминала и запустите скрипт снова."
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Устанавливаю pnpm…"; npm install -g pnpm || sudo npm install -g pnpm
fi

echo "1/6 PostgreSQL…"
brew list postgresql@16 >/dev/null 2>&1 || brew install postgresql@16
brew services start postgresql@16 >/dev/null
export PATH="/opt/homebrew/opt/postgresql@16/bin:/usr/local/opt/postgresql@16/bin:$PATH"
for i in $(seq 1 30); do pg_isready -q && break; sleep 1; done
pg_isready -q || { echo "PostgreSQL не запустился"; exit 1; }

echo "2/6 База и роли…"
psql postgres -qtAc "SELECT 1 FROM pg_roles WHERE rolname='crm'" | grep -q 1 || \
  psql postgres -qc "CREATE ROLE crm LOGIN SUPERUSER PASSWORD 'crm_dev_password'"
psql postgres -qtAc "SELECT 1 FROM pg_database WHERE datname='crm'" | grep -q 1 || \
  psql postgres -qc "CREATE DATABASE crm OWNER crm"
psql postgres -qtAc "SELECT 1 FROM pg_roles WHERE rolname='crm_app'" | grep -q 1 || \
  psql postgres -qc "CREATE ROLE crm_app LOGIN PASSWORD 'crm_app_dev_password' NOSUPERUSER NOBYPASSRLS"
psql postgres -qc "GRANT CONNECT ON DATABASE crm TO crm_app"

echo "3/6 Настройки и пакеты…"
[ -f .env ] || cp .env.example .env
set -a; source .env; set +a
pnpm install

echo "4/6 Миграции…"
pnpm db:migrate

echo "5/6 Проверка изоляции фабрик…"
pnpm test:rls

echo "6/6 Демо-данные…"
pnpm --filter @textile/api db:seed

cat <<MSG

Готово. Запуск:
  Окно 1 (API):   cd $(pwd) && set -a && source .env && set +a && pnpm --filter @textile/api dev
  Окно 2 (сайт):  cd $(pwd) && pnpm --filter @textile/web dev
Откройте http://localhost:5173  Вход: фабрика demo-a, owner@demo-a.uz, пароль demo12345
MSG
