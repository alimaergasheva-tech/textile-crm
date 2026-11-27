#!/bin/bash
# Проверяет, что docker-compose.prod.yml корректен (без запуска). Результат в docs/docker-result.txt
cd "$(dirname "$0")/.."
{
echo "docker: $(docker --version 2>&1 | head -1)"
DOMAIN=crm.test POSTGRES_PASSWORD=x APP_DB_PASSWORD=y JWT_SECRET=z docker compose -f docker-compose.prod.yml config --quiet 2>&1 && echo "compose: OK"
} 2>&1 | tee docs/docker-result.txt
