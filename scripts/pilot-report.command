#!/bin/bash
# Отчёт пилота по фабрике (по умолчанию demo-a, 7 дней). Для другой: SLUG=moya-fabrika DAYS=14 ./pilot-report.command
cd "$(dirname "$0")/.."
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
set -a; source .env; set +a
S=${SLUG:-demo-a}
pnpm --filter @textile/api exec tsx src/pilot-report.ts "$S" "${DAYS:-7}" 2>&1 | tee "docs/pilot-report-$S.txt"
