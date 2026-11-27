#!/bin/bash
# Нагрузочный тест одним кликом; результат сохраняется в docs/loadtest-result.txt
cd "$(dirname "$0")/.."
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
{ echo "Запуск: $(date)"; curl -s -m 5 localhost:3000/health; echo; node scripts/loadtest.mjs http://localhost:3000 100 30 2>&1; } | tee docs/loadtest-result.txt
echo "Готово. Окно можно закрыть."
