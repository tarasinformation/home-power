#!/usr/bin/env python3
"""Надсилає зібрану прошивку на плату по Wi-Fi (ArduinoOTA) і перевіряє, що вона там лишилась.

  pio run && python3 ota_upload.py <адреса-плати>
  (адресу можна дати й змінною середовища BOARD_IP)

- бере .pio/build/esp32c3/firmware.bin поруч зі скриптом;
- пароль оновлення бере зі зв'язки ключів macOS (запис home-power-ota-password, його створює
  make_secrets.py) і передає штатному espota.py з пакета PlatformIO всередині процесу:
  у командному рядку й на екрані пароля немає;
- плата сама під'єднується до цього комп'ютера по TCP, тож брандмауер macOS може спитати
  дозвіл для python: погодитися;
- після передачі питає плату (UDP 3233), яка збірка працює. «Готово» означає, що працює саме
  надіслана збірка і плата її підтвердила. Якщо нова прошивка за 5 хв не вийшла на зв'язок,
  плата повертає попередню, і скрипт про це скаже.

Першу прошивку з оновленням по Wi-Fi записують кабелем: pio run -t upload.
"""
import hashlib
import os
import pathlib
import random
import socket
import subprocess
import sys
import time

OTA_SERVICE = "home-power-ota-password"
OTA_PORT = 3232
INFO_PORT = 3233
VERIFY_WAIT_S = 390  # плата вирішує за 5 хв (підтвердити чи відкотити) + запуск, Wi-Fi і запас
here = pathlib.Path(__file__).resolve().parent
image = here / ".pio" / "build" / "esp32c3" / "firmware.bin"
core_dir = pathlib.Path(os.environ.get("PLATFORMIO_CORE_DIR") or pathlib.Path.home() / ".platformio")
tools = core_dir / "packages" / "framework-arduinoespressif32" / "tools"


def info(address: str) -> dict:
    """Довідка плати: fw, id (мітка збірки), slot, state (pending або valid), up. Порожньо — не відповіла."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    try:
        s.connect((address, INFO_PORT))  # відповіді з інших адрес ядро відкине
        s.send(b"?")
        return dict(part.split("=", 1) for part in s.recv(200).decode().split())
    except (OSError, ValueError):
        return {}
    finally:
        s.close()


args = sys.argv[1:]
if len(args) > 1 or (args and args[0].startswith("-")):
    sys.exit(__doc__)
address = args[0] if args else os.environ.get("BOARD_IP", "")
if not address:
    sys.exit("Вкажіть адресу плати: python3 ota_upload.py <адреса-плати> (або змінна середовища BOARD_IP)")
if not image.is_file():
    sys.exit("Немає зібраної прошивки: спершу pio run")
if not (tools / "espota.py").is_file():
    sys.exit(f"Не знайдено espota.py у пакеті PlatformIO: {tools}")

r = subprocess.run(
    ["/usr/bin/security", "find-generic-password", "-s", OTA_SERVICE, "-w"], capture_output=True, text=True
)
password = r.stdout.strip()
if r.returncode != 0 or not password:
    sys.exit("У зв'язці ключів немає пароля оновлення (спершу make_secrets.py)")

data = image.read_bytes()
# Плата з іншим ключем оновлення (або зовсім без нього) після такого оновлення відкотилася б
# або стала б недосяжною для наступних оновлень. Перевіряємо до надсилання.
if hashlib.sha256(password.encode()).hexdigest().encode() not in data:
    sys.exit(
        "Зібрана прошивка не містить ключа оновлення, що відповідає паролю у зв'язці ключів. "
        "Запустіть python3 make_secrets.py --ota-only, потім pio run."
    )
want = data[0xB0:0xB8].hex()  # мітка збірки: початок SHA-256 файлу ELF, який esptool вшиває в образ

before = info(address)
if before.get("state") == "pending":
    sys.exit("Плата ще перевіряє попереднє оновлення (до 5 хв) і нового не приймає. Спробуйте за кілька хвилин.")
if before.get("id") == want:
    print(f"На платі вже працює саме ця збірка (прошивка {before.get('fw')}). Оновлювати нічого.")
    sys.exit(0)

sys.path.insert(0, str(tools))
import espota  # noqa: E402

espota.PROGRESS = True
espota.TIMEOUT = 10
print(f"Оновлюю плату {address} по Wi-Fi…", flush=True)
# Порт на цьому комп'ютері, до якого під'єднається плата: випадковий, як у самому espota.py.
code = espota.serve(address, "0.0.0.0", OTA_PORT, random.randint(10000, 60000), password, False, str(image))

# Код espota не є вердиктом: 0 буває й після відхиленого образу, 1 — після звичайного перезапуску.
# Вердикт — яка збірка працює на платі і чи вона підтверджена.
print("Перевіряю, яка прошивка працює на платі…", flush=True)
started = time.monotonic()
# Після помилки espota довго не чекаємо, якщо нова збірка так і не озвалась.
deadline = started + (VERIFY_WAIT_S if code == 0 else 45)
new_seen = False
while time.monotonic() < deadline:
    time.sleep(5)
    now = info(address)
    if not now:
        continue  # плата ще запускається або пакет загубився
    if now.get("id") != want:
        if code != 0 and not new_seen:
            sys.exit(f"Оновлення не вдалося (причина вище): на платі лишилась прошивка {now.get('fw')}.")
        sys.exit(f"Плата не прийняла нову прошивку або повернула попередню: зараз працює {now.get('fw')}.")
    if now.get("state") == "valid":
        print(f"Готово: працює прошивка {now.get('fw')} у розділі {now.get('slot')}, плата її підтвердила.")
        sys.exit(0)
    if not new_seen:
        print("Нова прошивка запустилась і чекає підтвердження (перший успішний звіт або 5 хв)…")
        new_seen = True
        deadline = started + VERIFY_WAIT_S
if new_seen:
    sys.exit(f"Нова прошивка запустилась, але за {VERIFY_WAIT_S // 60} хв плата її так і не підтвердила.")
if code != 0:
    sys.exit("Оновлення не вдалося (причина вище), і плата не відповідає на запит стану.")
sys.exit(f"Після оновлення плата {VERIFY_WAIT_S // 60} хв не відповідає на запит стану: результат невідомий.")
