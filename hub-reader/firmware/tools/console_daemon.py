"""Тримає порт плати відкритим: пише її журнал у файл і надсилає команди, які дописують у файл команд.

Використання: python console_daemon.py ПОРТ ЖУРНАЛ ФАЙЛ_КОМАНД СЕКУНД
Рядок "QUIT" у файлі команд завершує роботу.
"""
import sys
import time

import serial

port, log_path, cmd_path, seconds = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
open(cmd_path, "a").close()
ser = serial.Serial()
ser.port = port
ser.baudrate = 115200
ser.timeout = 0.2
ser.dtr = False
ser.rts = False
ser.open()
start = time.time()
offset = 0
errors = 0
with open(log_path, "ab", buffering=0) as log:
    log.write(f"\n=== daemon start {time.strftime('%H:%M:%S')} ===\n".encode())
    while time.time() - start < seconds:
        try:
            chunk = ser.read(4096)
            errors = 0
        except (serial.SerialException, OSError) as error:
            errors += 1
            if errors == 1:
                log.write(f"\n=== {time.strftime('%H:%M:%S')} порт недоступний: {error} ===\n".encode())
            if errors > 30:  # плату від'єднали: завершуємо, а не пишемо помилки дві доби
                log.write(f"\n=== {time.strftime('%H:%M:%S')} плата не повернулась, журнал завершено ===\n".encode())
                sys.exit(0)
            time.sleep(1)
            try:
                ser.close()
                ser.open()
            except (serial.SerialException, OSError):
                pass
            continue
        if chunk:
            log.write(chunk)
        with open(cmd_path) as f:
            f.seek(offset)
            data = f.read()
        if data.endswith("\n"):
            offset += len(data.encode())
            for line in data.splitlines():
                line = line.strip()
                if not line:
                    continue
                if line == "QUIT":
                    log.write(b"\n=== daemon quit ===\n")
                    ser.close()
                    sys.exit(0)
                log.write(f"\n>>> [{time.strftime('%H:%M:%S')}] {line}\n".encode())
                ser.write(line.encode() + b"\r")
ser.close()
