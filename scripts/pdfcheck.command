#!/bin/bash
cd "$(dirname "$0")/.."
{
T=$(curl -s -m 10 -X POST localhost:3000/auth/login -H 'content-type: application/json' -d '{"tenant":"demo-a","email":"owner@demo-a.uz","password":"demo12345"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
S=$(curl -s -m 10 localhost:3000/shipments -H "authorization: Bearer $T" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "shipment: $S"
curl -s -m 20 -o /dev/null -w "HTTP %{http_code}\n" "localhost:3000/shipments/$S/pdf" -H "authorization: Bearer $T"
tail -25 /tmp/textile-api.log
} 2>&1 | tee docs/pdfcheck-result.txt
