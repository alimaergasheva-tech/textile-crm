#!/bin/bash
# Коммитит все изменения и отправляет в GitHub. Результат: docs/github-result.txt
cd "$(dirname "$0")/.." || exit 1
OUT=docs/github-result.txt
{
  echo "== $(date '+%Y-%m-%d %H:%M')"
  git add -A
  if git diff --cached --quiet; then echo "нечего коммитить"; else
    git commit -q -F - <<'MSG'
Этикетки EAN-13, конфиги Railway и Vercel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EBxNdnNv7xk26ecarunbr3
MSG
    git log --oneline -1
  fi
  git push 2>&1 | tail -3
  echo "== готово: https://github.com/alimaergasheva-tech/textile-crm"
} 2>&1 | tee "$OUT"
