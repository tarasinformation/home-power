// Монітор світла на ESP32-C3.
// Плата стоїть на резервному живленні поруч із роутером. Кожні 20 с вона перевіряє, чи відповідає
// на ping пристрій-індикатор у розетці без резерву (наприклад, бойлер чи підсилювач Wi-Fi):
// мовчить індикатор — немає світла. Стан плата надсилає в HTTP-дію Convex:
// POST https://<назва>.convex.site/report. Додатково слухає Bluetooth-оголошення зарядної
// станції EcoFlow і надсилає її заряд (необов'язково).
//
// Оновлення по Wi-Fi (необов'язково): ArduinoOTA з паролем, запуск — ota_upload.py. Нова прошивка
// мусить за 5 хвилин вийти на зв'язок, інакше плата сама повертає попередню.
//
// Налаштування й секрети — у include/secrets.h (див. secrets.example.h і make_secrets.py).

#include <Arduino.h>
#include <ArduinoOTA.h>
#include <BLEAdvertisedDevice.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <ESP32Ping.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>
#include <esp_ota_ops.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>

#include "secrets.h"

#ifndef ECOFLOW_SN_PREFIX
#define ECOFLOW_SN_PREFIX "" // порожньо — станцію не слухаємо
#endif
#ifndef ECOFLOW_SN_SUFFIX
#define ECOFLOW_SN_SUFFIX ""
#endif
#ifndef OTA_PASSWORD_SHA256
#define OTA_PASSWORD_SHA256 "" // порожньо — оновлення по Wi-Fi вимкнено
#endif

static const char *FW_VERSION = "0.6.1";
static IPAddress target; // адреса індикатора з INDICATOR_IP у secrets.h
static const uint32_t CYCLE_MS = 20000;           // період перевірки
// Звіт надсилається одразу при зміні стану світла чи заряду станції, а без змін — раз на хвилину.
// Так сервер отримує втричі менше запитів, а про відключення дізнається так само швидко.
static const uint32_t HEARTBEAT_MS = 60000;
static const int PINGS_PER_CYCLE = 3;
static const int FAILS_FOR_OFF = 2;               // стільки невдалих циклів поспіль = світла немає
static const uint32_t WIFI_REBOOT_MS = 10UL * 60 * 1000;
static const uint32_t REPORT_REBOOT_MS = 30UL * 60 * 1000;
// Сторожовий таймер: найдовший чесний прохід циклу (Wi-Fi 20 с, Bluetooth 4,5 с, ping 3 с, звіт
// із мертвим інтернетом до ~45 с) значно коротший. Довший крок треба годувати явно.
static const uint32_t WDT_TIMEOUT_MS = 180000;
static const uint32_t TLS_HANDSHAKE_SEC = 15; // типові 120 с тримали б цикл дві хвилини
static bool wdtOn = false;

// Оновлення по Wi-Fi. У secrets.h лежить SHA-256 пароля (64 малі шістнадцяткові символи): саме він
// є ключем оновлення. Без нього або з некоректним значенням порт оновлення не відкривається зовсім:
// ArduinoOTA з порожнім паролем приймала б прошивку від будь-кого в мережі.
static const char *OTA_HASH = OTA_PASSWORD_SHA256;
static bool otaEnabled = false; // хеш у secrets.h коректний
static bool otaReady = false;   // ArduinoOTA слухає порт 3232
// Після оновлення по Wi-Fi завантажувач чекає підтвердження нового образу: будь-яке перезавантаження
// до підтвердження повертає попередню прошивку. Підтверджуємо самі, коли прошивка довела, що працює.
static bool pendingVerify = false;
static bool rollbackFailed = false;
static const uint32_t VERIFY_DEADLINE_MS = 5UL * 60 * 1000;
// Довідка для ota_upload.py: на будь-який пакет UDP плата відповідає версією, міткою збірки й станом
// образу (без секретів). Так скрипт бачить, чи нова прошивка справді лишилась, чи плата відкотилась.
static const uint16_t INFO_PORT = 3233;
static WiFiUDP infoUdp;
static bool infoReady = false;

// Ядро Arduino підтверджує новий образ ще до setup(). Цей хук ядра відкладає підтвердження,
// щоб його робила confirmOrRollback().
extern "C" bool verifyRollbackLater() {
    return true;
}

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
static volatile bool efHeard = false; // свою станцію почуто в поточному скануванні

static void service(uint32_t ms = 0);

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
        efHeard = true;
    }
};

// Слухає оголошення не довше BLE_SCAN_SEC і зупиняється, щойно почуто свою станцію:
// приймач Bluetooth працює частки секунди, а не всі 4 с.
static void listenEcoflow() {
    if (!EF_ENABLED || !BLEDevice::getInitialized()) return;
    BLEScan *scan = BLEDevice::getScan();
    if (!scan) return;
    efHeard = false;
    if (!scan->start(BLE_SCAN_SEC, nullptr, false)) { // три аргументи: сканування не блокує цикл
        Serial.println("EcoFlow: сканування не запустилося");
        return;
    }
    const uint32_t t0 = millis();
    while (!efHeard && scan->isScanning() && millis() - t0 < BLE_SCAN_SEC * 1000UL + 500) service(25);
    scan->stop();
    scan->clearResults(); // список почутих сусідніх пристроїв звільняємо до TLS, а не через хвилину
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

static bool validOtaHash(const char *hash) {
    if (strlen(hash) != 64) return false;
    for (; *hash; hash++) {
        // лише малі літери: espota рахує хеш саме так, а плата порівнює рядки як є
        if (!((*hash >= '0' && *hash <= '9') || (*hash >= 'a' && *hash <= 'f'))) return false;
    }
    return true;
}

static void setupOta() {
    if (!otaEnabled || otaReady) return;
    ArduinoOTA.setPasswordHash(OTA_HASH);
    ArduinoOTA.setMdnsEnabled(false); // плату шукаємо за адресою, зайвий мовець у мережі не потрібен
    ArduinoOTA.onStart([] {
        Serial.println("OTA: приймаю оновлення");
        if (BLEDevice::getInitialized()) { // getScan() без запущеного Bluetooth повертає nullptr
            if (BLEScan *scan = BLEDevice::getScan()) scan->stop();
        }
    });
    // Передача образу триває довше за звичайний цикл: годуємо сторожовий таймер із кожним блоком.
    ArduinoOTA.onProgress([](unsigned, unsigned) {
        if (wdtOn) esp_task_wdt_reset();
    });
    ArduinoOTA.onError([](ota_error_t error) { Serial.printf("OTA: помилка %u\n", (unsigned)error); });
    ArduinoOTA.begin();
    // begin() нічого не повертає, а при невдачі з портом мовчки виходить. Ім'я вузла ядро призначає
    // лише після успішного відкриття порту (самі ми його не задаємо) — за ним і видно результат.
    otaReady = ArduinoOTA.getHostname().length() > 0;
    Serial.println(otaReady ? "OTA: чекаю оновлень по Wi-Fi" : "OTA: порт оновлення відкрити не вдалося, спробую ще");
}

// Відкриває порти довідки й оновлення. Невдалу спробу повторює наступний цикл.
static void openPorts() {
    if (otaEnabled && !infoReady) infoReady = infoUdp.begin(INFO_PORT);
    if (!pendingVerify) setupOta(); // для непідтвердженого образу порт відкриє confirmOrRollback()
}

// Порожній пакет UDP (його шле, наприклад, сканер портів) ядро не вичитує: parsePacket() бачить
// нуль байтів і до читання не доходить. Кілька таких пакетів заповнюють чергу сокета, і порт глухне
// до перезавантаження. Закриття сокета чергу звільняє, тому раз на 10 хв порти відкриваємо заново.
// Якщо це збіглося з початком оновлення, ota_upload.py досить запустити ще раз.
static void reopenPorts() {
    if (!otaReady || pendingVerify) return;
    ArduinoOTA.end();
    ArduinoOTA.begin();                        // пароль і обробники зберігаються
    infoReady = infoUdp.begin(INFO_PORT);      // begin() сам закриває попередній сокет
}

static void handleInfo() {
    if (!infoReady || !infoUdp.parsePacket()) return;
    // Мітка збірки: перші 8 байтів SHA-256 файлу ELF, ті самі, що у firmware.bin за зсувом 0xB0.
    const uint8_t *id = esp_app_get_description()->app_elf_sha256;
    infoUdp.beginPacket(infoUdp.remoteIP(), infoUdp.remotePort());
    // temp: температура кристала процесора (вбудований датчик), а не корпусу плати.
    infoUdp.printf("fw=%s id=%02x%02x%02x%02x%02x%02x%02x%02x slot=%s state=%s up=%lu temp=%.1f", FW_VERSION, id[0],
                   id[1], id[2], id[3], id[4], id[5], id[6], id[7], esp_ota_get_running_partition()->label,
                   pendingVerify ? "pending" : "valid", (unsigned long)(esp_timer_get_time() / 1000000),
                   temperatureRead());
    infoUdp.endPacket();
    infoUdp.clear();
}

// Усі паузи циклу — лише через це: оновлення по Wi-Fi обслуговується кожні 25 мс.
// Прийняте оновлення виконується тут до кінця і перезавантажує плату.
static void service(uint32_t ms) {
    const uint32_t t0 = millis();
    do {
        // Поки новий образ не підтверджено, наступне оновлення не приймаємо: відкочуватися було б нікуди.
        if (otaReady && !pendingVerify) {
            ArduinoOTA.handle(); // обробляє пакет: запрошення або перевірку пароля
            ArduinoOTA.handle(); // пароль щойно прийнято — оновлення починається одразу, а не після звіту
        }
        handleInfo();
        if (ms) delay(25);
    } while (millis() - t0 < ms);
}

// Підтверджує новий образ, коли він довів, що досяжний: Wi-Fi є, порт оновлення відкрито і звіт
// пройшов (або минуло 5 хв без інтернету, але плата в мережі). Не вийшов на зв'язок за 5 хв або
// зібраний без пароля оновлення — повертаємо попередню прошивку.
static void confirmOrRollback() {
    if (!pendingVerify) return;
    const bool late = millis() > VERIFY_DEADLINE_MS;
    if (WiFi.status() == WL_CONNECTED && otaEnabled && (sentOnce || late)) {
        setupOta(); // до підтвердження: якщо тут щось зависне чи впаде, завантажувач зробить відкат
        if (otaReady) {
            const esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
            if (err == ESP_OK) {
                pendingVerify = false;
                Serial.println("OTA: нову прошивку підтверджено");
            } else {
                Serial.printf("OTA: не вдалося підтвердити прошивку (%d)\n", (int)err);
            }
            return;
        }
        // Порт оновлення не відкрився: образ не підтверджуємо, наступний цикл спробує ще раз.
    }
    if (late && !rollbackFailed) {
        Serial.println("OTA: нова прошивка за 5 хв не вийшла на зв'язок, повертаю попередню");
        delay(200);
        const esp_err_t err = esp_ota_mark_app_invalid_rollback_and_reboot();
        // Сюди доходимо, лише якщо повертатися нікуди (немає іншого справного образу).
        rollbackFailed = true;
        Serial.printf("OTA: відкат неможливий (%d)\n", (int)err);
    }
}

static void connectWifi() {
    if (WiFi.status() == WL_CONNECTED) return;
    Serial.println("Wi-Fi: підключаюся");
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    const uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) service(250);
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("Wi-Fi: %s, %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else {
        Serial.println("Wi-Fi: не вдалося");
    }
}

// Оновлює power за результатом одного циклу. Повертає true, коли стан уже можна повідомляти.
static bool measure() {
    const uint32_t cycleStart = millis();
    // По одному пакету: відповів — далі не шлемо (бібліотека з кількома пакетами завжди робить
    // паузи по 1 с, навіть після відповіді); мовчить — пробуємо ще, таймаут кожного 1 с.
    bool alive = false;
    for (int i = 0; i < PINGS_PER_CYCLE && !alive; i++) {
        alive = Ping.ping(target, 1);
        service();
    }
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
    client.setHandshakeTimeout(TLS_HANDSHAKE_SEC);
    const uint32_t t0 = millis();
    HTTPClient http;
    http.setTimeout(8000);
    if (!http.begin(client, String(REPORT_URL_BASE) + "/report")) return false;
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
    // "ago": скільки секунд тому зник перший ping. Сервер записує початок відключення цим часом,
    // бо саме відключення плата оголошує лише після FAILS_FOR_OFF невдалих циклів.
    const unsigned long ago = power ? 0 : (unsigned long)((millis() - firstFailMs) / 1000);
    // Час роботи — з 64-бітного таймера: millis() обнуляється кожні 49,7 доби.
    const unsigned long uptime = (unsigned long)(esp_timer_get_time() / 1000000);
    char body[240];
    int len = snprintf(body, sizeof(body), "{\"power\":%s,\"rssi\":%d,\"uptime\":%lu,\"fw\":\"%s\",\"ago\":%lu",
                       power ? "true" : "false", WiFi.RSSI(), uptime, FW_VERSION, ago);
    // Заряд станції EcoFlow: лише якщо почуто недавно. "socAge" — скільки секунд тому.
    if (soc >= 0 && millis() - socMs < SOC_MAX_AGE_MS) {
        len += snprintf(body + len, sizeof(body) - len, ",\"soc\":%d,\"socAge\":%lu,\"socRssi\":%d", soc,
                        (unsigned long)((millis() - socMs) / 1000), socRssi);
    }
    snprintf(body + len, sizeof(body) - len, "}");
    const int code = http.POST(body);
    http.end();
    Serial.printf("Звіт: HTTP %d за %lu мс\n", code, (unsigned long)(millis() - t0));
    return code == 200;
}

void setup() {
    // 80 МГц замість 160: менше споживання й нагріву. Нижче не можна: 40 МГц і менше беруться
    // з кварцу, а не з PLL, і ламають Wi-Fi та Bluetooth.
    const bool cpuOk = setCpuFrequencyMhz(80);
    Serial.begin(115200);
    delay(500);
    Serial.printf("\nМонітор світла, прошивка %s, процесор %lu МГц%s\n", FW_VERSION,
                  (unsigned long)getCpuFrequencyMhz(), cpuOk ? "" : " (80 МГц встановити не вдалося)");

    // Сторожовий таймер ядра вже запущено на 5 с без задач: розтягуємо його і підписуємо loop().
    // Зависання будь-де в циклі закінчується перезавантаженням, а для непідтвердженого образу — відкатом.
    const esp_task_wdt_config_t wdt = {.timeout_ms = WDT_TIMEOUT_MS, .idle_core_mask = 0, .trigger_panic = true};
    if (esp_task_wdt_reconfigure(&wdt) == ESP_OK) {
        enableLoopWDT();
        wdtOn = true;
    } else {
        Serial.println("Сторожовий таймер: налаштувати не вдалося, працюю без нього");
    }

    esp_ota_img_states_t state;
    pendingVerify = esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) == ESP_OK &&
                    state == ESP_OTA_IMG_PENDING_VERIFY;
    if (pendingVerify) Serial.println("OTA: новий образ чекає підтвердження");
    otaEnabled = validOtaHash(OTA_HASH);
    if (!otaEnabled) {
        Serial.println(strlen(OTA_HASH) ? "OTA: OTA_PASSWORD_SHA256 у secrets.h некоректний, оновлення по Wi-Fi вимкнено"
                                        : "OTA: оновлення по Wi-Fi вимкнено (немає OTA_PASSWORD_SHA256)");
    }

    if (!target.fromString(INDICATOR_IP)) Serial.println("INDICATOR_IP у secrets.h некоректна");
    connectWifi();
    // Bluetooth запускаємо, лише коли станцію задано: без неї його радіо тільки гріє плату.
    if (EF_ENABLED && BLEDevice::init("")) {
        BLEScan *scan = BLEDevice::getScan();
        scan->setAdvertisedDeviceCallbacks(new EcoflowListener(), true); // true: чути повтори оголошень
        scan->setActiveScan(false); // лише слухаємо, нічого не запитуємо
        scan->setInterval(160);     // 100 мс
        scan->setWindow(80);        // 50 мс: половину часу радіо лишається для Wi-Fi
    }
    // Після connectWifi(): сокетам потрібен запущений мережевий стек.
    openPorts();
    lastWifiOk = lastReportOk = millis();
}

// Цикл не спить одним довгим delay(): між перевірками він повертається кожні 25 мс,
// щоб оновлення по Wi-Fi не чекало до 20 с (espota чекає відповіді лише 10 с).
void loop() {
    static uint32_t cycleStart = 0, lastBeatCycle = 0, cycles = 0;
    service(); // також запускає щойно авторизоване оновлення до довгих кроків
    if (cycles && millis() - cycleStart < CYCLE_MS) {
        delay(25);
        return;
    }
    cycleStart = millis();
    cycles++;

    connectWifi();
    openPorts(); // зазвичай нічого не робить: порти відкрито ще в setup()
    if (cycles % 30 == 0) reopenPorts(); // раз на 10 хв (30 циклів по 20 с)
    // Станцію слухаємо раз на хвилину (кожен третій цикл): заряд змінюється повільно і придатний 5 хв.
    if (cycles % 3 == 1) listenEcoflow();
    service();

    if (WiFi.status() == WL_CONNECTED) {
        lastWifiOk = millis();
        if (measure()) {
            // Пульс рахуємо від початку циклу, а не від кінця звіту: інакше довгий звіт зсував би його з 60 на 80 с.
            const bool due = !sentOnce || power != sentPower || soc != sentSoc ||
                             cycleStart - lastBeatCycle >= HEARTBEAT_MS - CYCLE_MS / 2;
            if (due && report()) {
                lastReportOk = millis();
                lastBeatCycle = cycleStart;
                sentOnce = true;
                sentPower = power;
                sentSoc = soc;
            }
        }
    }

    confirmOrRollback();

    // Самовідновлення: якщо довго немає Wi-Fi або звіти не проходять, перезавантажитися.
    if (millis() - lastWifiOk > WIFI_REBOOT_MS || millis() - lastReportOk > REPORT_REBOOT_MS) {
        Serial.println("Довго без зв'язку, перезавантажуюся");
        delay(200);
        ESP.restart();
    }
}
