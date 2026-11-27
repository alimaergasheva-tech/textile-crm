#!/bin/bash
# Ежедневная копия: база (pg_dump -Fc) + фото. Хранит 30 дней. Запуск из cron на сервере (см. docs/DEPLOY.md).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${BACKUP_DIR:-/var/backups/textile}; mkdir -p "$OUT"
D=$(date +%F-%H%M)
docker compose -f docker-compose.prod.yml exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$OUT/db-$D.dump"
docker compose -f docker-compose.prod.yml exec -T api tar -C /data -cz files > "$OUT/files-$D.tgz"
[ -s "$OUT/db-$D.dump" ] || { echo "ПУСТОЙ ДАМП БАЗЫ" >&2; exit 1; }
find "$OUT" -name 'db-*.dump' -mtime +30 -delete; find "$OUT" -name 'files-*.tgz' -mtime +30 -delete
echo "Готово: $OUT/db-$D.dump, files-$D.tgz"
