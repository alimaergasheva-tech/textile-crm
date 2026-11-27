#!/bin/bash
cd "$(dirname "$0")/.."
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
{
echo "git: $(git --version 2>&1)"
echo "gh: $(gh --version 2>&1 | head -1)"
echo "--- gh auth"; gh auth status 2>&1 | sed -E 's/(Token: ).*/\1…скрыт/' | head -8
echo "--- user.name: $(git config --global user.name)  user.email: $(git config --global user.email)"
echo "--- ssh ключи: $(ls ~/.ssh/*.pub 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
echo "--- credential.helper: $(git config --global credential.helper)"
} 2>&1 | tee docs/gitcheck-result.txt
