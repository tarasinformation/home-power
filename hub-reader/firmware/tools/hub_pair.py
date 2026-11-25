#!/usr/bin/env python3
"""Сполучає пробну плату-читач із хабом Aqara через консоль плати на вбудованому USB.

Код сполучення питається в терміналі без показу на екрані. Він одноразовий, нікуди не записується
на Mac і не друкується: відлуння команди й будь-який рядок, де трапився код, скрипт приховує.
У журнал (~/.config/esp-hub-reader/hub-pair.log) потрапляють лише рядки про перебіг сполучення.

Порядок: 1) запустити скрипт і дочекатися рядка «Плата готова»; 2) в Aqara Home згенерувати код
сполучення Matter для хаба; 3) ввести код тут. Плата додає хаб як вузол 2.

Запуск (Python з оточення ESP-IDF, у ньому є pyserial):
    ~/.espressif/python_env/idf5.5_py3.12_env/bin/python tools/hub_pair.py
Необов'язковий аргумент — порт плати, якщо під'єднано кілька.
"""
import getpass
import glob
import os
import sys
import time

import serial

NODE_ID = 2
BOOT_WAIT_S = 45
PAIR_WAIT_S = 150
LOG_PATH = os.path.expanduser("~/.config/esp-hub-reader/hub-pair.log")
SHOW = ("commissioning", "attestation", "paa", "pai", "dac", "certificat", "pase", "case session established",
        "error", "fail", "timeout", "pairing_command")


def main() -> int:
    ports = [sys.argv[1]] if len(sys.argv) > 1 else sorted(glob.glob("/dev/cu.usbmodem*"))
    if len(ports) != 1:
        print(f"Очікую рівно одну плату по USB, знайдено: {ports or 'жодної'}. Вкажіть порт аргументом.")
        return 2

    ser = serial.Serial()
    ser.port = ports[0]
    ser.baudrate = 115200
    ser.timeout = 0.2
    ser.dtr = False
    ser.rts = False
    ser.open()
    # Відкриття порту перезавантажує плату: чекаємо, доки вона знову отримає адресу в Wi-Fi.
    print("Чекаю, доки плата завантажиться й підключиться до Wi-Fi…")
    deadline = time.time() + BOOT_WAIT_S
    seen = b""
    online = False
    while time.time() < deadline and not online:
        seen = (seen + ser.read(4096))[-8000:]
        online = b"IP_EVENT_STA_GOT_IP" in seen
    if not online:
        ser.close()
        print("Плата не повідомила про адресу в Wi-Fi. Спершу підключіть її: tools/wifi_connect.py НАЗВА_МЕРЕЖІ")
        return 1
    time.sleep(3)
    print("Плата готова. Тепер згенеруйте код сполучення в Aqara Home (хаб M3 → Matter / інші екосистеми).")

    code = getpass.getpass("Код сполучення (лише цифри, на екрані не показується): ")
    code = "".join(ch for ch in code if ch.isdigit())
    if len(code) not in (11, 21):
        ser.close()
        print(f"У коді має бути 11 або 21 цифра, введено {len(code)}. Нічого не надіслано.")
        return 2

    ser.reset_input_buffer()
    ser.write(b"\r")
    time.sleep(0.3)
    ser.write(f"matter esp controller pairing code {NODE_ID} {code}\r".encode())
    print(f"Команду надіслано, чекаю до {PAIR_WAIT_S} с…")

    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    start = time.time()
    buf = b""
    result = None
    with open(LOG_PATH, "a", encoding="utf-8") as log:
        log.write(f"\n=== сполучення з хабом, {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        while time.time() - start < PAIR_WAIT_S and result is None:
            buf += ser.read(4096)
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("utf-8", "replace").strip()
                low = line.lower()
                if not line or code in line or "pairing code" in low or "chip[em]" in low:
                    continue
                is_error = line.startswith("E (")
                if not is_error and not any(key in low for key in SHOW):
                    continue
                log.write(line[:300] + "\n")
                if is_error or "next step" in low or "error" in low or "fail" in low or "attestation" in low:
                    print("  " + line[:170])
                if "commissioning success" in low or ("commissioning complete" in low and "success" in low):
                    result = True
                elif "commissioning failure" in low or "commissioning failed" in low or "pairing failure" in low:
                    result = False
        log.write(f"=== результат: {result} ===\n")
    ser.close()
    if result:
        print("Готово: плата додала хаб (вузол 2). Скажіть про це Claude; код більше не потрібен.")
        return 0
    if result is False:
        print("Сполучення не вдалося. Перебіг записано в ~/.config/esp-hub-reader/hub-pair.log (без коду).")
        return 1
    print("За відведений час сполучення не завершилося. Перебіг записано в ~/.config/esp-hub-reader/hub-pair.log (без коду).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
