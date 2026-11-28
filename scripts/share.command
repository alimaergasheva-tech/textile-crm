#!/bin/bash
# Одна публичная ссылка на сайт (Cloudflare quick tunnel, без аккаунта). Окно держать открытым.
# Перед запуском должны работать: API (порт 3000) и сайт с VITE_API_URL=/api (порт 5173) — см. команды в чате.
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
if ! command -v cloudflared >/dev/null; then echo "Ставлю cloudflared…"; brew install cloudflared || { echo "ОШИБКА: не удалось поставить cloudflared"; exit 1; }; fi
echo "Ищу адрес… (он появится ниже, строка вида https://xxxx.trycloudflare.com)"
cloudflared tunnel --url http://localhost:5173 --no-autoupdate
