#!/bin/bash
# Загружает проект в публичный репозиторий GitHub textile-crm. Запуск: двойной клик. Результат — docs/github-result.txt
cd "$(dirname "$0")/.."
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
REPO=textile-crm
{
echo "== проверка инструментов"
command -v git >/dev/null || { echo "ОШИБКА: нет git. Выполните в Терминале: xcode-select --install"; exit 1; }
if ! command -v gh >/dev/null; then echo "Ставлю GitHub CLI (gh)…"; brew install gh || { echo "ОШИБКА: не удалось поставить gh"; exit 1; }; fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Нужен вход в GitHub. Следуйте подсказкам: выберите GitHub.com, HTTPS, вход через браузер."
  gh auth login --hostname github.com --git-protocol https --web || { echo "ОШИБКА: вход в GitHub не выполнен"; exit 1; }
fi
USER_LOGIN=$(gh api user --jq .login)
echo "GitHub-пользователь: $USER_LOGIN"

echo "== проверка на секреты"
set -a; source .env; set +a
BAD=0
PGP="$POSTGRES_PASSWORD"; [ "$PGP" = "crm_dev_password" ] && PGP=""
for V in "$TELEGRAM_BOT_TOKEN" "$JWT_SECRET" "$PGP"; do
  [ ${#V} -ge 8 ] && grep -rIlF --exclude-dir=node_modules --exclude-dir=.git --exclude=.env -- "$V" . 2>/dev/null | grep -v "^./.env$" | grep -v "^./docs/.*-result.txt$" | grep -v "^./docs/test-full.txt$" | grep -v "^./.env.example$" | head -3 | while read -r f; do echo "НАЙДЕН СЕКРЕТ в $f"; echo x > /tmp/textile-secret-found; done
done
if [ -f /tmp/textile-secret-found ]; then rm -f /tmp/textile-secret-found; echo "ОСТАНОВЛЕНО: уберите секрет из файла и запустите снова"; exit 1; fi
echo "секретов в файлах не найдено (файл .env в репозиторий не попадёт)"

echo "== git"
[ -d .git ] || git init -b main
git config user.name >/dev/null || git config user.name "$(gh api user --jq '.name // .login')"
git config user.email >/dev/null || git config user.email "$(gh api user --jq '.id')+$USER_LOGIN@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then echo "нет новых изменений для коммита"; else
git commit -q -F - <<'MSG'
Textile CRM: CRM, склад, производство, Mini App, обратная связь, платформа

Этапы 1-9: клиенты и сделки, каталог, склад, заказы и производство, Telegram Mini App,
клиентский портал, подрядчики, обратная связь и рекламации, панель платформы, тарифы,
импорт и экспорт, тесты, файлы развёртывания и документация.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EBxNdnNv7xk26ecarunbr3
MSG
fi
echo "== GitHub"
if git remote get-url origin >/dev/null 2>&1; then git push -u origin main
else gh repo create "$REPO" --public --source=. --remote=origin --push --description "SaaS CRM, склад и производство для текстильных фабрик (аналог Битрикс24), Telegram Mini App"; fi
echo "== готово: https://github.com/$USER_LOGIN/$REPO"
} 2>&1 | tee docs/github-result.txt
