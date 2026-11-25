#!/usr/bin/env python3
"""Оновлює прошивку плати-читача по Wi-Fi з домашньої мережі.

    python3 tools/ota_upload.py АДРЕСА_ПЛАТИ [ФАЙЛ_ПРОШИВКИ]

Ключ оновлень береться зі зв'язки ключів macOS (запис hub-reader-ota-key) і мережею не передається:
плата видає одноразове число, скрипт підписує ним розмір і SHA-256 образу (HMAC-SHA256).
Після запису плата перезапускається; скрипт чекає, доки нова прошивка підтвердить себе
(перший вдалий звіт на сайт), і каже, чи вона лишилась, чи плата відкотилась на попередню.
Потрібна лише стандартна бібліотека Python 3.
"""
import glob
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

PORT = 8080
KEYCHAIN_SERVICE = "hub-reader-ota-key"
BUILDS_GLOB = os.path.expanduser("~/.config/esp-hub-reader/build-reader*/hub_reader.bin")
CONFIRM_WAIT_S = 240


def get(url: str, timeout: float = 5) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read().decode()


def info(base: str):
    try:
        return json.loads(get(f"{base}/info", timeout=3))
    except (OSError, ValueError):
        return None


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    base = f"http://{sys.argv[1]}:{PORT}"
    if len(sys.argv) > 2:
        path = sys.argv[2]
    else:
        # Без другого аргументу береться найсвіжіший зібраний образ (папки build-reader*).
        builds = sorted(glob.glob(BUILDS_GLOB), key=os.path.getmtime)
        if not builds:
            print(f"Не знайшов зібраного образу ({BUILDS_GLOB}). Вкажіть файл другим аргументом.")
            return 2
        path = builds[-1]
    with open(path, "rb") as f:
        image = f.read()
    key = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                         capture_output=True, text=True)
    if key.returncode != 0 or not key.stdout.strip():
        print(f"У зв'язці ключів немає запису {KEYCHAIN_SERVICE}. Створіть його: bash tools/setup_token.sh --no-convex")
        return 2
    secret = key.stdout.strip().encode()

    before = info(base)
    if not before:
        print(f"Плата не відповідає на {base}/info. Перевірте адресу й чи вона в мережі.")
        return 1
    print(f"Зараз на платі: прошивка {before['fw']}, розділ {before['slot']}, працює {before['uptime']} с.")

    digest = hashlib.sha256(image).hexdigest()
    nonce = get(f"{base}/ota/nonce").strip()
    sign = hmac.new(secret, f"{nonce}:{len(image)}:{digest}".encode(), hashlib.sha256).hexdigest()
    request = urllib.request.Request(f"{base}/ota", data=image, method="POST", headers={
        "Content-Type": "application/octet-stream",
        "X-Nonce": nonce,
        "X-Sha256": digest,
        "X-Sign": sign,
    })
    print(f"Надсилаю {len(image)} байтів ({os.path.basename(path)})…")
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=240) as response:
            answer = response.read().decode()
    except urllib.error.HTTPError as error:
        print(f"Плата відхилила оновлення: HTTP {error.code}, {error.read().decode(errors='replace')}")
        return 1
    except OSError as error:
        print(f"Не вдалося надіслати: {error}")
        return 1
    print(f"Плата прийняла образ за {time.time() - started:.0f} с ({answer}). Чекаю на перезапуск і підтвердження…")

    deadline = time.time() + CONFIRM_WAIT_S
    seen_new_boot = False
    while time.time() < deadline:
        time.sleep(3)
        now = info(base)
        if not now:
            continue
        if not seen_new_boot and now["uptime"] < before["uptime"] + (time.time() - started) - 5:
            seen_new_boot = True
            print(f"  плата перезапустилась: прошивка {now['fw']}, розділ {now['slot']}"
                  f"{', чекає підтвердження' if now['pending'] else ''}")
        if seen_new_boot and not now["pending"]:
            if now["slot"] != before["slot"]:
                print(f"Готово: працює нова прошивка {now['fw']} (розділ {now['slot']}), вона підтвердила себе.")
                return 0
            print(f"Плата відкотилась на попередню прошивку {now['fw']} (розділ {now['slot']}): нова не підтвердила себе.")
            return 1
    print("За відведений час підтвердження не дочекався. Перевірте плату: GET /info.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
