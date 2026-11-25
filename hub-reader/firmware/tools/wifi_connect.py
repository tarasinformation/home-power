#!/usr/bin/env python3
"""Підключає пробну плату-читач до Wi-Fi через її консоль на вбудованому USB.

Пароль питається в терміналі без показу на екрані, нікуди не записується на Mac і не друкується:
відлуння команди з плати та будь-який рядок журналу, де трапився пароль, скрипт приховує.
Плата зберігає мережу у своїй флеш-пам'яті (NVS) і після перезапуску підключається сама.

Запуск (Python з оточення ESP-IDF, у ньому є pyserial):
    ~/.espressif/python_env/idf5.5_py3.12_env/bin/python tools/wifi_connect.py НАЗВА_МЕРЕЖІ
Необов'язковий другий аргумент — порт плати, якщо під'єднано кілька.
"""
import getpass
import glob
import sys
import time

import serial

WAIT_S = 40


def main() -> int:
    if len(sys.argv) < 2:
        print("Використання: wifi_connect.py НАЗВА_МЕРЕЖІ [ПОРТ]")
        return 2
    ssid = sys.argv[1]
    ports = [sys.argv[2]] if len(sys.argv) > 2 else sorted(glob.glob("/dev/cu.usbmodem*"))
    if len(ports) != 1:
        print(f"Очікую рівно одну плату по USB, знайдено: {ports or 'жодної'}. Вкажіть порт другим аргументом.")
        return 2
    # Перевірка без пароля: wifi_connect.py --check надсилає платі нешкідливу команду про пам'ять.
    check = ssid == "--check"
    password = "-" if check else getpass.getpass(f"Пароль мережі «{ssid}» (на екрані не показується): ")
    if not password or " " in password or " " in ssid:
        print("Порожній пароль або пробіл у назві чи паролі: консоль плати такого не прийме.")
        return 2

    ser = serial.Serial()
    ser.port = ports[0]
    ser.baudrate = 115200
    ser.timeout = 0.2
    ser.dtr = False  # не перезавантажувати плату під час відкриття порту
    ser.rts = False
    ser.open()
    # Відкриття порту на macOS зазвичай перезавантажує плату. Команда, надіслана до запуску стека Matter,
    # не виконується й назавжди блокує консоль («Failed to schedule work»), тому чекаємо на готовність.
    print("Чекаю, доки плата буде готова…")
    ready_at = time.time() + 2.0  # якщо плата не перезавантажилась і мовчить, двох секунд досить
    deadline = time.time() + 25
    seen = b""
    while time.time() < min(ready_at, deadline):
        chunk = ser.read(4096)
        if not chunk:
            continue
        seen = (seen + chunk)[-4000:]
        if b"Returned from app_main" in seen or b"app_main: heap:" in seen:
            ready_at = time.time() + 2.0  # стек запущено; ще дві секунди запасу
            seen = b""
        elif b"boot:" in seen or b"ESP-ROM" in seen:
            ready_at = deadline  # плата завантажується: чекаємо рядка про готовність
    ser.reset_input_buffer()
    ser.write(b"\r")
    time.sleep(0.3)
    if check:
        ser.write(b"matter esp diagnostics mem-dump\r")
        time.sleep(1.5)
        answer = ser.read(4096).decode("utf-8", "replace")
        ser.close()
        ok = "Current Free Memory" in answer
        print("Плата відповідає на команди." if ok else "Плата на команду не відповіла:\n" + answer[-400:])
        return 0 if ok else 1
    ser.write(f"matter esp wifi connect {ssid} {password}\r".encode())

    print(f"Команду надіслано на {ports[0]}, чекаю до {WAIT_S} с…")
    start = time.time()
    buf = b""
    ok = False
    while time.time() - start < WAIT_S and not ok:
        buf += ser.read(4096)
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            line = raw.decode("utf-8", "replace").strip()
            if not line or password in line or "wifi connect" in line:
                continue
            low = line.lower()
            if any(k in low for k in ("got ip", "sta_got_ip", "ip address changed", "connected", "disconnect", "reason", "error", "fail", "wifi:state")):
                print("  " + line[:160])
            if "sta_got_ip" in low or "got ip" in low or "ip address changed" in low:
                ok = True
    ser.close()
    if ok:
        print("Готово: плата отримала адресу в мережі.")
        return 0
    print("За відведений час плата не повідомила про отриману адресу. Перевірте назву мережі й пароль і запустіть ще раз.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
