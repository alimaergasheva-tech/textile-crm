#!/bin/bash
# Восстановление: deploy/restore.sh <db-….dump> [files-….tgz]. ПЕРЕЗАПИСЫВАЕТ данные — сначала проверьте на staging.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "${1:-}" ] || { echo "Использование: $0 db-….dump [files-….tgz]"; exit 1; }
read -r -p "Текущие данные будут заменены. Введите YES: " a; [ "$a" = "YES" ] || exit 1
docker compose -f docker-compose.prod.yml stop api
docker compose -f docker-compose.prod.yml exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$1"
[ -n "${2:-}" ] && docker compose -f docker-compose.prod.yml run --rm -T --entrypoint sh api -c 'tar -C /data -xz' < "$2"
docker compose -f docker-compose.prod.yml start api
