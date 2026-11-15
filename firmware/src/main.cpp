// Монітор світла на ESP32-C3.
// Плата стоїть на резервному живленні поруч із роутером. Кожні 20 с вона перевіряє, чи відповідає
// на ping пристрій-індикатор у розетці без резерву (наприклад, бойлер чи підсилювач Wi-Fi):
// мовчить індикатор — немає світла. Стан плата надсилає в HTTP-дію Convex:
// POST https://<назва>.convex.site/report. Додатково слухає Bluetooth-оголошення зарядної
// станції EcoFlow і надсилає її заряд (необов'язково).
//
// Налаштування й секрети — у include/secrets.h (див. secrets.example.h і make_secrets.py).

#include <Arduino.h>
#include <BLEAdvertisedDevice.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <ESP32Ping.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "secrets.h"

#ifndef ECOFLOW_SN_PREFIX
#define ECOFLOW_SN_PREFIX "" // порожньо — станцію не слухаємо
#endif
#ifndef ECOFLOW_SN_SUFFIX
#define ECOFLOW_SN_SUFFIX ""
#endif

static const char *FW_VERSION = "0.5";
static IPAddress target; // адреса індикатора з INDICATOR_IP у secrets.h
static const uint32_t CYCLE_MS = 20000;           // період перевірки
// Звіт надсилається одразу при зміні стану світла чи заряду станції, а без змін — раз на хвилину.
// Так сервер отримує втричі менше запитів, а про відключення дізнається так само швидко.
static const uint32_t HEARTBEAT_MS = 60000;
static const int PINGS_PER_CYCLE = 3;
static const int FAILS_FOR_OFF = 2;               // стільки невдалих циклів поспіль = світла немає
static const uint32_t WIFI_REBOOT_MS = 10UL * 60 * 1000;
static const uint32_t REPORT_REBOOT_MS = 30UL * 60 * 1000;

// Зарядна станція EcoFlow (перевірено на DELTA 2 Max) розсилає свій заряд у Bluetooth-оголошенні,
// без підключення й облікового запису. Дані виробника: код 0xB5B5, далі байт версії, 16 символів
// серійного номера і байт заряду у відсотках (звірено з екраном станції).
// Свою станцію впізнаємо за першими й останніми чотирма символами серійного номера (secrets.h).
static const char *EF_SN_PREFIX = ECOFLOW_SN_PREFIX;
static const char *EF_SN_SUFFIX = ECOFLOW_SN_SUFFIX;
static const bool EF_ENABLED = strlen(ECOFLOW_SN_PREFIX) == 4 && strlen(ECOFLOW_SN_SUFFIX) == 4;
static const int BLE_SCAN_SEC = 4;
static const uint32_t SOC_MAX_AGE_MS = 5UL * 60 * 1000; // старіший заряд не надсилаємо

static int soc = -1;        // останній почутий заряд, %
static uint32_t socMs = 0;  // коли почуто
static int socRssi = 0;

class EcoflowListener : public BLEAdvertisedDeviceCallbacks {
    void onResult(BLEAdvertisedDevice dev) override {
        if (!dev.haveManufacturerData()) return;
        auto md = dev.getManufacturerData();
        // 2 байти коду виробника + версія + 16 символів номера + заряд
        if (md.length() < 20 || (uint8_t)md[0] != 0xB5 || (uint8_t)md[1] != 0xB5) return;
        for (int i = 0; i < 4; i++) {
            if (md[3 + i] != EF_SN_PREFIX[i] || md[15 + i] != EF_SN_SUFFIX[i]) return;
        }
        const int value = (uint8_t)md[19];
        if (value > 100) return;
        soc = value;
        socMs = millis();
        socRssi = dev.getRSSI();
    }
};

static void listenEcoflow() {
    if (!EF_ENABLED) return;
    BLEScan *scan = BLEDevice::getScan();
    scan->start(BLE_SCAN_SEC, false);
    scan->clearResults();
    if (soc >= 0) {
        Serial.printf("EcoFlow: заряд %d%%, почуто %lu с тому, %d dBm\n", soc,
                      (unsigned long)((millis() - socMs) / 1000), socRssi);
    } else {
        Serial.println("EcoFlow: станцію не чути");
    }
}

static int failedCycles = 0;
static bool known = false; // чи вже є перше надійне вимірювання
static bool power = true;
static uint32_t firstFailMs = 0; // коли почався перший невдалий цикл: справжній початок відключення
static uint32_t lastWifiOk = 0;
static uint32_t lastReportOk = 0;
static bool sentOnce = false; // чи вже був хоч один успішний звіт
static bool sentPower = true; // що було в останньому успішному звіті
static int sentSoc = -1;

static void connectWifi() {
    if (WiFi.status() == WL_CONNECTED) return;
    Serial.println("Wi-Fi: підключаюся");
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    const uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(250);
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("Wi-Fi: %s, %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else {
        Serial.println("Wi-Fi: не вдалося");
    }
}

// Оновлює power за результатом одного циклу. Повертає true, коли стан уже можна повідомляти.
static bool measure() {
    const uint32_t cycleStart = millis();
    const bool alive = Ping.ping(target, PINGS_PER_CYCLE);
    if (alive) {
        failedCycles = 0;
        power = true;
        known = true;
    } else {
        if (failedCycles == 0) firstFailMs = cycleStart;
        failedCycles++;
        if (failedCycles >= FAILS_FOR_OFF) {
            power = false;
            known = true;
        }
    }
    Serial.printf("Індикатор: %s, невдалих циклів %d, світло: %s\n", alive ? "відповідає" : "мовчить", failedCycles,
                  !known ? "ще невідомо" : power ? "є" : "немає");
    return known;
}

static bool report() {
    WiFiClientSecure client;
    client.setCACert(ROOT_CA_PEM);
    HTTPClient http;
    http.setTimeout(8000);
    if (!http.begin(client, String(REPORT_URL_BASE) + "/report")) return false;
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
    // "ago": скільки секунд тому зник перший ping. Сервер записує початок відключення цим часом,
    // бо саме відключення плата оголошує лише після FAILS_FOR_OFF невдалих циклів.
    const unsigned long ago = power ? 0 : (unsigned long)((millis() - firstFailMs) / 1000);
    char body[240];
    int len = snprintf(body, sizeof(body), "{\"power\":%s,\"rssi\":%d,\"uptime\":%lu,\"fw\":\"%s\",\"ago\":%lu",
                       power ? "true" : "false", WiFi.RSSI(), (unsigned long)(millis() / 1000), FW_VERSION, ago);
    // Заряд станції EcoFlow: лише якщо почуто недавно. "socAge" — скільки секунд тому.
    if (soc >= 0 && millis() - socMs < SOC_MAX_AGE_MS) {
        len += snprintf(body + len, sizeof(body) - len, ",\"soc\":%d,\"socAge\":%lu,\"socRssi\":%d", soc,
                        (unsigned long)((millis() - socMs) / 1000), socRssi);
    }
    snprintf(body + len, sizeof(body) - len, "}");
    const int code = http.POST(body);
    http.end();
    Serial.printf("Звіт: HTTP %d\n", code);
    return code == 200;
}

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.printf("\nМонітор світла, прошивка %s\n", FW_VERSION);
    if (!target.fromString(INDICATOR_IP)) Serial.println("INDICATOR_IP у secrets.h некоректна");
    connectWifi();
    BLEDevice::init("");
    BLEScan *scan = BLEDevice::getScan();
    scan->setAdvertisedDeviceCallbacks(new EcoflowListener(), true); // true: чути повтори оголошень
    scan->setActiveScan(false); // лише слухаємо, нічого не запитуємо
    scan->setInterval(160);     // 100 мс
    scan->setWindow(80);        // 50 мс: половину часу радіо лишається для Wi-Fi
    lastWifiOk = lastReportOk = millis();
}

void loop() {
    const uint32_t started = millis();
    connectWifi();
    listenEcoflow();

    if (WiFi.status() == WL_CONNECTED) {
        lastWifiOk = millis();
        if (measure()) {
            // 2 с запасу: цикл триває рівно CYCLE_MS, а три цикли мають вкластися в хвилину.
            const bool due = !sentOnce || power != sentPower || soc != sentSoc ||
                             millis() - lastReportOk >= HEARTBEAT_MS - 2000;
            if (due && report()) {
                lastReportOk = millis();
                sentOnce = true;
                sentPower = power;
                sentSoc = soc;
            }
        }
    }

    // Самовідновлення: якщо довго немає Wi-Fi або звіти не проходять, перезавантажитися.
    if (millis() - lastWifiOk > WIFI_REBOOT_MS || millis() - lastReportOk > REPORT_REBOOT_MS) {
        Serial.println("Довго без зв'язку, перезавантажуюся");
        delay(200);
        ESP.restart();
    }

    const uint32_t spent = millis() - started;
    if (spent < CYCLE_MS) delay(CYCLE_MS - spent);
}
