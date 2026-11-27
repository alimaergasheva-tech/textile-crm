#!/bin/bash
# Новое приглашение владельцу + кнопка бота с токеном на один вход. После привязки запустите bot-setup.command, чтобы вернуть обычную кнопку.
cd "$(dirname "$0")/.."
set -a; source .env; set +a
{
T=$(curl -s -m 10 -X POST localhost:3000/auth/login -H 'content-type: application/json' -d '{"tenant":"demo-a","email":"owner@demo-a.uz","password":"demo12345"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
U=$(curl -s -m 10 localhost:3000/users -H "authorization: Bearer $T" | tr '{' '\n' | grep '"owner@demo-a.uz"' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
K=$(curl -s -m 10 -X POST "localhost:3000/users/$U/telegram-invite" -H "authorization: Bearer $T" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -z "$K" ] && { echo "ОШИБКА: приглашение не создано"; exit 0; }
curl -s -m 15 -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setChatMenuButton" -H 'content-type: application/json' \
  -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Привязать\",\"web_app\":{\"url\":\"$MINIAPP_URL/?link=$K\"}}}"; echo
echo "Готово: в чате с ботом нажмите кнопку «Привязать»."
} 2>&1 | tee docs/link-result.txt
