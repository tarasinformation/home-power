#!/usr/bin/env python3
"""Створює include/secrets.h для прошивки, нічого секретного не друкуючи.

  python3 make_secrets.py https://<назва>.convex.site
  python3 make_secrets.py --ota-only

- назву мережі, адресу індикатора й номер станції запитує з клавіатури,
  пароль Wi-Fi — теж, але символи не показуються;
- ключ плати бере зі зв'язки ключів macOS (запис home-power-device-token);
- кореневий сертифікат GTS Root R4 бере із системного сховища macOS;
- пароль оновлення по Wi-Fi створює випадковим один раз і тримає у зв'язці ключів
  (запис home-power-ota-password, його читає ota_upload.py). У secrets.h потрапляє SHA-256
  пароля: саме цей хеш є ключем оновлення, тож secrets.h і зібрана прошивка — такі самі секрети.

--ota-only нічого не питає: у наявний secrets.h лише додає (або оновлює) рядок
OTA_PASSWORD_SHA256, решта файлу лишається як є.
--new-ota-password дозволяє створити новий пароль оновлення, коли у зв'язці ключів його немає,
а в secrets.h хеш уже є (після цього прошивку треба один раз записати кабелем).

Файл secrets.h у .gitignore.
"""
import getpass
import hashlib
import os
import pathlib
import re
import secrets
import subprocess
import sys

ROOT_CA_NAME = "GTS Root R4"  # ним підписано ланцюжок *.convex.site (перевірено 14.11.2026)
OTA_SERVICE = "home-power-ota-password"
OTA_DEFINE = re.compile(r"^#define OTA_PASSWORD_SHA256\b.*$", re.M)
here = pathlib.Path(__file__).resolve().parent
target = here / "include" / "secrets.h"


def run(*cmd: str) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def c_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def keychain_get(service: str) -> str:
    r = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", service, "-w"], capture_output=True, text=True
    )
    if r.returncode == 0:
        return r.stdout.strip()
    if r.returncode == 44:  # запису справді немає
        return ""
    # Заблокована зв'язка чи відмова в доступі — не «запису немає»: новий пароль створювати не можна.
    sys.exit(f"Зв'язка ключів недоступна (код {r.returncode}); нічого не змінюю")


def keychain_add(service: str, value: str) -> None:
    # Через стандартний ввід, щоб значення не було видно у списку процесів.
    # Без -U: наявний запис не перезаписується.
    command = f'add-generic-password -s "{service}" -a "home-power" -w "{value}"\n'
    subprocess.run(["/usr/bin/security", "-i"], input=command, text=True, capture_output=True)
    if keychain_get(service) != value:
        sys.exit("Зв'язка ключів не зберегла пароль оновлення; нічого не змінюю")


def ota_hash(have_hash: bool) -> tuple[str, bool]:
    """SHA-256 пароля оновлення і позначка, чи пароль щойно створено."""
    password = keychain_get(OTA_SERVICE)
    created = False
    if not password:
        if have_hash and "--new-ota-password" not in flags:
            sys.exit(
                "У зв'язці ключів немає пароля оновлення, а в secrets.h уже є його хеш: плата, ймовірно, "
                "чекає старий пароль. Новий створюю лише з параметром --new-ota-password "
                "(після цього прошивку треба один раз записати кабелем)."
            )
        password = "-"
        while password.startswith("-"):  # щоб security не сприйняла значення за параметр
            password = secrets.token_urlsafe(24)
        keychain_add(OTA_SERVICE, password)
        created = True
    # hexdigest дає малі літери — саме такий рядок рахує espota і чекає прошивка
    return hashlib.sha256(password.encode()).hexdigest(), created


def write_secrets(text: str) -> None:
    # Спершу поруч, потім заміна одним кроком: збій посередині не зіпсує наявний файл.
    tmp = target.with_name(target.name + ".tmp")
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
        f.write(text)
    tmp.chmod(0o600)
    os.replace(tmp, target)


def ota_note(created: bool) -> str:
    note = f"пароль оновлення по Wi-Fi у зв'язці ключів (запис {OTA_SERVICE})"
    if created:
        note += ", створено щойно: прошивку з ним треба один раз записати кабелем"
    return note


flags = {a for a in sys.argv[1:] if a.startswith("--")}
args = [a for a in sys.argv[1:] if not a.startswith("--")]
ota_only = "--ota-only" in flags
if flags - {"--ota-only", "--new-ota-password"} or (ota_only and args):
    sys.exit(__doc__)
existing = target.read_text(encoding="utf-8") if target.exists() else ""

if ota_only:
    if not existing:
        sys.exit("Немає include/secrets.h: спершу python3 make_secrets.py https://<назва>.convex.site")
    digest, created = ota_hash(bool(OTA_DEFINE.search(existing)))
    line = f'#define OTA_PASSWORD_SHA256 "{digest}"'
    if OTA_DEFINE.search(existing):
        updated = OTA_DEFINE.sub(lambda _: line, existing)
    else:
        comment = "// Оновлення по Wi-Fi: SHA-256 пароля, він і є ключем оновлення"
        updated = existing.rstrip("\n") + f"\n\n{comment}\n{line}\n"
    write_secrets(updated)
    print(f"Готово: у {target.name} змінено лише OTA_PASSWORD_SHA256 ({ota_note(created)}).")
    sys.exit(0)

if len(args) != 1 or not re.fullmatch(r"https://[a-z0-9-]+\.convex\.site", args[0]):
    sys.exit("Вкажіть адресу HTTP-дій Convex: python3 make_secrets.py https://<назва>.convex.site")
url = args[0]

token = run("security", "find-generic-password", "-s", "home-power-device-token", "-w").strip()
pem = run(
    "security", "find-certificate", "-c", ROOT_CA_NAME, "-p",
    "/System/Library/Keychains/SystemRootCertificates.keychain",
).strip()
if not token or "BEGIN CERTIFICATE" not in pem:
    sys.exit("Не знайдено ключ плати у зв'язці ключів або кореневий сертифікат у системі")
# До запитань: якщо з паролем оновлення щось не так, відповіді не доведеться вводити вдруге.
ota_digest, ota_created = ota_hash(bool(OTA_DEFINE.search(existing)))

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

// Оновлення по Wi-Fi: SHA-256 пароля, він і є ключем оновлення
#define OTA_PASSWORD_SHA256 "{ota_digest}"

// {ROOT_CA_NAME}
#define ROOT_CA_PEM \\
{ca_lines}
"""
write_secrets(out)
print(
    f"Готово: {target.name} створено (мережа {ssid}, довжина пароля {len(password)}, сертифікат {ROOT_CA_NAME}, "
    f"{ota_note(ota_created)})."
)
