// Зразок. Скопіюйте у secrets.h поруч і заповніть (або запустіть make_secrets.py).
// Файл secrets.h у репозиторій не потрапляє (.gitignore) і нікому не надсилається.
#pragma once

#define WIFI_SSID "назва-вашої-мережі"
#define WIFI_PASSWORD "пароль-вашої-мережі"

// Пристрій-індикатор у розетці БЕЗ резервного живлення, який відповідає на ping:
// бойлер чи інша техніка з Wi-Fi, підсилювач Wi-Fi тощо. Варто закріпити за ним адресу на роутері.
#define INDICATOR_IP "192.168.1.50"

// Адреса HTTP-дій продакшн-деплоймента Convex без шляху: https://<назва>.convex.site
// (саме .convex.site, не .convex.cloud). Плата надсилає сигнал на <адреса>/report.
#define REPORT_URL_BASE "https://<назва>.convex.site"
// Той самий рядок, що у змінній середовища DEVICE_TOKEN деплоймента Convex.
#define DEVICE_TOKEN "довгий-випадковий-рядок"

// Необов'язково: зарядна станція EcoFlow. Перші й останні 4 символи її серійного номера
// (є в імені Bluetooth-пристрою EF-…, у застосунку й на наліпці). Порожньо — станцію не слухаємо.
#define ECOFLOW_SN_PREFIX ""
#define ECOFLOW_SN_SUFFIX ""

// Кореневий сертифікат сайту <назва>.convex.site у форматі PEM (make_secrets.py бере його з macOS).
#define ROOT_CA_PEM \
    "-----BEGIN CERTIFICATE-----\n" \
    "...\n" \
    "-----END CERTIFICATE-----\n"
