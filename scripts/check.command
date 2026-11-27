#!/bin/bash
# Диагностика: входит в demo-a и создаёт клиента так же, как сайт; результат в docs/check-result.txt
cd "$(dirname "$0")/.."
{
echo "Запуск: $(date)"
T=$(curl -s -m 10 -X POST localhost:3000/auth/login -H 'content-type: application/json' -d '{"tenant":"demo-a","email":"owner@demo-a.uz","password":"demo12345"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
echo "token: ${T:0:12}…"
echo "--- создать клиента"
curl -s -m 10 -w "\nHTTP %{http_code}\n" -X POST localhost:3000/clients -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"name":"Kogan kids","type":"retail","creditLimit":15000000}'
echo "--- список клиентов"
curl -s -m 10 -w "\nHTTP %{http_code}\n" "localhost:3000/clients" -H "authorization: Bearer $T" | cut -c1-400
echo "--- платформа"
curl -s -m 10 -w "\nHTTP %{http_code}\n" -X POST localhost:3000/platform/login -H 'content-type: application/json' -d '{"email":"platform@local.dev","password":"platform12345"}' | cut -c1-120
echo "--- последние строки журнала API"
tail -15 /tmp/textile-api.log
} 2>&1 | tee docs/check-result.txt
