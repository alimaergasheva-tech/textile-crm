#!/bin/bash
# Публичный https-адрес для Mini App (Cloudflare quick tunnel, без аккаунта). Окно держать открытым.
cd "$(dirname "$0")/.."
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
if ! command -v cloudflared >/dev/null; then echo "Ставлю cloudflared…"; brew install cloudflared || { echo "ОШИБКА: не удалось поставить cloudflared" | tee docs/tunnel-result.txt; exit 1; }; fi
set -a; source .env; set +a
rm -f /tmp/cf.log
cloudflared tunnel --url http://localhost:5174 --no-autoupdate > /tmp/cf.log 2>&1 &
CF=$!
trap 'kill $CF 2>/dev/null' EXIT INT TERM
URL=""
for i in $(seq 1 40); do URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cf.log | head -1); [ -n "$URL" ] && break; sleep 1; done
[ -z "$URL" ] && { echo "ОШИБКА: адрес туннеля не получен" | tee docs/tunnel-result.txt; tail -5 /tmp/cf.log >> docs/tunnel-result.txt; exit 1; }
sed -i '' "s#^MINIAPP_URL=.*#MINIAPP_URL=$URL#" .env
R=$(curl -s -m 15 -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setChatMenuButton" -H 'content-type: application/json' \
  -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Открыть CRM\",\"web_app\":{\"url\":\"$URL\"}}}")
{ echo "Адрес Mini App: $URL"; echo "Кнопка в боте: $R"; echo "Проверка адреса: $(curl -s -o /dev/null -m 15 -w '%{http_code}' $URL)"; echo "Окно не закрывайте — иначе адрес перестанет работать."; } | tee docs/tunnel-result.txt
wait $CF
