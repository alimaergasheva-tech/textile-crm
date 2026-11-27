#!/bin/bash
# Проверяет бота из .env и, если задан MINIAPP_URL (https), ставит кнопку Mini App. Результат в docs/bot-result.txt
cd "$(dirname "$0")/.."
{
set -a; source .env; set +a
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then echo "ОШИБКА: в .env пуст TELEGRAM_BOT_TOKEN (токен из BotFather)"; exit 0; fi
echo "--- getMe"
R=$(curl -s -m 15 "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"); echo "$R" | sed 's/"id":[0-9]*,//'
U=$(echo "$R" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
[ -z "$U" ] && { echo "ОШИБКА: токен не принят Telegram"; exit 0; }
[ "$TELEGRAM_BOT_USERNAME" != "$U" ] && echo "ВНИМАНИЕ: в .env TELEGRAM_BOT_USERNAME должен быть: $U"
echo "--- кнопка Mini App"
case "$MINIAPP_URL" in
  https://*) curl -s -m 15 -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setChatMenuButton" -H 'content-type: application/json' \
    -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Открыть CRM\",\"web_app\":{\"url\":\"$MINIAPP_URL\"}}}"; echo;;
  *) echo "MINIAPP_URL не задан или не https — кнопка не ставилась (уведомления работают и без неё)";;
esac
echo "Готово. Перезапустите start.command, чтобы API начал рассылку уведомлений."
} 2>&1 | tee docs/bot-result.txt
