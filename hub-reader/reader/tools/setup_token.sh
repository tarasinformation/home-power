#!/bin/bash
# Створює ключі плати-читача й розкладає їх по місцях, ніде не показуючи на екрані:
#   1) зв'язка ключів macOS: home-power-home-token (ключ звітів на сайт) і hub-reader-ota-key
#      (ключ оновлень по Wi-Fi); якого запису немає — генерується новий;
#   2) бойовий Convex, змінна HOME_TOKEN (пропускається з --no-convex);
#   3) файл ~/.config/esp-hub-reader/secrets/secrets.h для збірки прошивки (поза проєктом).
# Запуск:  bash tools/setup_token.sh [--no-convex]
# Повторний запуск безпечний: наявні ключі не змінюються, лише заново розкладаються.
set -euo pipefail

HOME_SERVICE="home-power-home-token"
OTA_SERVICE="hub-reader-ota-key"
WEB_DIR="$(cd "$(dirname "$0")/../../../web" && pwd)"
SECRETS_DIR="$HOME/.config/esp-hub-reader/secrets"
URL_FILE="$HOME/.config/esp-hub-reader/home-url.txt"
# Адреса маршруту /home вашого бекенда (https://<назва>.convex.site/home): змінна HOME_URL
# або один рядок у файлі ~/.config/esp-hub-reader/home-url.txt. У репозиторії її немає.
if [ -z "${HOME_URL:-}" ] && [ -f "$URL_FILE" ]; then
    HOME_URL="$(head -1 "$URL_FILE" | tr -d '[:space:]')"
fi
if [ -z "${HOME_URL:-}" ]; then
    echo "Не задано адресу сайту. Запустіть так: HOME_URL=https://<назва>.convex.site/home bash tools/setup_token.sh"
    exit 2
fi

ensure() { # $1 — назва запису у зв'язці ключів
    if security find-generic-password -s "$1" >/dev/null 2>&1; then
        echo "    запис $1 уже є, беру його"
    else
        security add-generic-password -a "$USER" -s "$1" -w "$(openssl rand -hex 32)"
        echo "    створено новий запис $1"
    fi
}

echo "1/3 Ключі у зв'язці ключів:"
ensure "$HOME_SERVICE"
ensure "$OTA_SERVICE"

if [ "${1:-}" = "--no-convex" ]; then
    echo "2/3 Convex пропущено (--no-convex)."
else
    echo "2/3 Записую ключ звітів у бойовий Convex (змінна HOME_TOKEN)…"
    (cd "$WEB_DIR" && security find-generic-password -s "$HOME_SERVICE" -w | tr -d '\n' | npx convex env set --prod HOME_TOKEN >/dev/null)
    echo "    Готово."
fi

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
umask 077
{
    echo "#pragma once"
    echo "// Створено tools/setup_token.sh. Не копіювати в проєкт і не публікувати."
    echo "#define HOME_URL \"$HOME_URL\""
    printf '#define HOME_TOKEN "%s"\n' "$(security find-generic-password -s "$HOME_SERVICE" -w | tr -d '\n')"
    printf '#define OTA_KEY "%s"\n' "$(security find-generic-password -s "$OTA_SERVICE" -w | tr -d '\n')"
} > "$SECRETS_DIR/secrets.h"
echo "3/3 Файл для прошивки створено: $SECRETS_DIR/secrets.h"
