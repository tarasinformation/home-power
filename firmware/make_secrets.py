#!/usr/bin/env python3
"""Створює include/secrets.h для прошивки, нічого секретного не друкуючи.

  python3 make_secrets.py https://<назва>.convex.site

- назву мережі, адресу індикатора й номер станції запитує з клавіатури,
  пароль Wi-Fi — теж, але символи не показуються;
- ключ плати бере зі зв'язки ключів macOS (запис home-power-device-token);
- кореневий сертифікат GTS Root R4 бере із системного сховища macOS.

Файл secrets.h у .gitignore.
"""
import getpass
import pathlib
import re
import subprocess
import sys

ROOT_CA_NAME = "GTS Root R4"  # ним підписано ланцюжок *.convex.site (перевірено 14.11.2026)
here = pathlib.Path(__file__).resolve().parent
target = here / "include" / "secrets.h"


def run(*cmd: str) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def c_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


if len(sys.argv) != 2 or not re.fullmatch(r"https://[a-z0-9-]+\.convex\.site", sys.argv[1]):
    sys.exit("Вкажіть адресу HTTP-дій Convex: python3 make_secrets.py https://<назва>.convex.site")
url = sys.argv[1]

token = run("security", "find-generic-password", "-s", "home-power-device-token", "-w").strip()
pem = run(
    "security", "find-certificate", "-c", ROOT_CA_NAME, "-p",
    "/System/Library/Keychains/SystemRootCertificates.keychain",
).strip()
if not token or "BEGIN CERTIFICATE" not in pem:
    sys.exit("Не знайдено ключ плати у зв'язці ключів або кореневий сертифікат у системі")

ssid = input("Назва мережі Wi-Fi (2,4 ГГц): ").strip()
password = getpass.getpass(f"Пароль Wi-Fi мережі {ssid} (символи не показуються): ")
if not ssid or not password:
    sys.exit("Порожня назва або пароль, файл не створено")
indicator = input("IP-адреса пристрою-індикатора (у розетці без резерву): ").strip()
if not re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", indicator):
    sys.exit("Некоректна IP-адреса")
sn = input("Серійний номер EcoFlow (Enter — без станції): ").strip().upper()
ef_prefix, ef_suffix = (sn[:4], sn[-4:]) if len(sn) >= 8 else ("", "")

ca_lines = " \\\n".join(f'    "{line}\\n"' for line in pem.splitlines())
out = f"""// Створено make_secrets.py. Файл містить секрети: не показувати й нікуди не надсилати.
#pragma once

#define WIFI_SSID "{c_string(ssid)}"
#define WIFI_PASSWORD "{c_string(password)}"

#define INDICATOR_IP "{indicator}"

#define REPORT_URL_BASE "{url}"
#define DEVICE_TOKEN "{c_string(token)}"

#define ECOFLOW_SN_PREFIX "{ef_prefix}"
#define ECOFLOW_SN_SUFFIX "{ef_suffix}"

// {ROOT_CA_NAME}
#define ROOT_CA_PEM \\
{ca_lines}
"""
target.write_text(out, encoding="utf-8")
target.chmod(0o600)
print(f"Готово: {target.name} створено (мережа {ssid}, довжина пароля {len(password)}, сертифікат {ROOT_CA_NAME}).")
