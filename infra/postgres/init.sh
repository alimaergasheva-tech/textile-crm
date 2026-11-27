#!/bin/bash
# Роль приложения без суперправ: на неё действует Row Level Security.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE crm_app LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO crm_app;
SQL
