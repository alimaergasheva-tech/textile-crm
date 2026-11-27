#!/bin/bash
# Проверка раз в минуту из cron: при двух сбоях подряд шлёт сообщение в Telegram. Нужны HEALTH_URL, ALERT_BOT_TOKEN и ALERT_CHAT_ID в окружении.
STATE=/tmp/textile-health.fail
if curl -fsS -m 10 "${HEALTH_URL:?}/health" >/dev/null; then rm -f "$STATE"; exit 0; fi
n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE"
[ "$n" -eq 2 ] && curl -s -m 10 "https://api.telegram.org/bot${ALERT_BOT_TOKEN:?}/sendMessage" -d "chat_id=${ALERT_CHAT_ID:?}" -d "text=Textile CRM не отвечает: $HEALTH_URL/health" >/dev/null
exit 0
