#!/usr/bin/env bash
# Розгортання бекенда на продакшн-деплоймент Convex: спершу тести й перевірка типів.
# Потрібен вхід `npx convex login` (або CONVEX_DEPLOY_KEY в оточенні чи у .convex/deploy-key.local,
# файл у .gitignore). Використання: npm run deploy
# Фронт розгортається окремо: npx vercel@65.8.0 --prod
set -euo pipefail
cd "$(dirname "$0")/.."

KEY_FILE=".convex/deploy-key.local"
if [ -f "$KEY_FILE" ]; then
  # shellcheck disable=SC1090
  set -a && source "$KEY_FILE" && set +a
fi

npm test
npm run typecheck
exec npx convex deploy "$@"
