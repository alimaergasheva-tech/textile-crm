#!/bin/bash
# Сквозной тест цикла на запущенном API; результат в docs/e2e-result.txt
cd "$(dirname "$0")/.."
{ echo "Запуск: $(date)"; node scripts/e2e.mjs http://localhost:3000; } 2>&1 | tee docs/e2e-result.txt
