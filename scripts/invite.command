#!/bin/bash
# Создаёт ссылку-приглашение для привязки Telegram владельца demo-a; результат в docs/invite-result.txt
cd "$(dirname "$0")/.."
{
T=$(curl -s -m 10 -X POST localhost:3000/auth/login -H 'content-type: application/json' -d '{"tenant":"demo-a","email":"owner@demo-a.uz","password":"demo12345"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
U=$(curl -s -m 10 localhost:3000/users -H "authorization: Bearer $T" | tr '{' '\n' | grep '"owner@demo-a.uz"' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
echo "user: $U"
curl -s -m 10 -X POST "localhost:3000/users/$U/telegram-invite" -H "authorization: Bearer $T"; echo
} 2>&1 | tee docs/invite-result.txt
