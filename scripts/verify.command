#!/bin/bash
# Автотесты API и проверка типов API, сайта и Mini App; результат в docs/verify-result.txt
cd "$(dirname "$0")/.."
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
set -a; source .env; set +a
{
echo "Запуск: $(date)"
echo "=== ТЕСТЫ ==="; pnpm --filter @textile/api test > docs/test-full.txt 2>&1; grep -n "^not ok\|^# \(tests\|pass\|fail\)" docs/test-full.txt; grep -n "^not ok" -A16 docs/test-full.txt | cut -c1-260 | head -60
echo "=== ТИПЫ API ==="; pnpm --filter @textile/api typecheck 2>&1 | tail -30
echo "=== ТИПЫ САЙТ ==="; (cd apps/web && npx tsc --noEmit 2>&1 | tail -30)
echo "=== ТИПЫ MINIAPP ==="; (cd apps/miniapp && npx tsc --noEmit 2>&1 | tail -30)
echo "=== КОНЕЦ ==="
} > docs/verify-result.txt 2>&1
