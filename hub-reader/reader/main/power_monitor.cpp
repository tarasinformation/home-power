#include "power_monitor.h"

#include <atomic>
#include <cstring>

#include <esp_log.h>
#include <esp_timer.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <lwip/ip_addr.h>
#include <ping/ping_sock.h>

#include "secrets.h" // INDICATOR_IP, ECOFLOW_SN_PREFIX, ECOFLOW_SN_SUFFIX (усі необов'язкові)

#ifndef INDICATOR_IP
#define INDICATOR_IP ""
#endif
// Лише для перевірки: адреса, яку пінгувати замість справжнього індикатора (змінна середовища
// HUB_READER_TEST_INDICATOR під час збірки). З неіснуючою адресою плата має оголосити «світла немає».
#ifdef INDICATOR_IP_TEST
#undef INDICATOR_IP
#define INDICATOR_IP INDICATOR_IP_TEST
#endif
#ifndef ECOFLOW_SN_PREFIX
#define ECOFLOW_SN_PREFIX ""
#endif
#ifndef ECOFLOW_SN_SUFFIX
#define ECOFLOW_SN_SUFFIX ""
#endif

static const char *TAG = "power";

#define CYCLE_MS 20000     // період перевірки індикатора
#define PINGS_PER_CYCLE 3  // до трьох пакетів, таймаут кожного 1 с; відповів — далі не шлемо
#define FAILS_FOR_OFF 2    // стільки невдалих циклів поспіль = світла немає
#define BLE_EVERY_CYCLES 3 // станцію слухаємо раз на хвилину: заряд змінюється повільно
#define BLE_SCAN_MS 4000

static std::atomic<bool> s_known{false};
static std::atomic<bool> s_power{true};
static std::atomic<int32_t> s_failed{0};
static std::atomic<uint32_t> s_first_fail_ms{0};
static std::atomic<uint32_t> s_cycles{0};
static std::atomic<bool> s_ble_ready{false};
static std::atomic<int32_t> s_soc{-1};
static std::atomic<uint32_t> s_soc_ms{0};
static std::atomic<int32_t> s_soc_rssi{0};
static bool s_enabled = false;

static uint32_t now_ms()
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

// ---------- пінг індикатора ----------

static esp_ping_handle_t s_ping = nullptr;
static SemaphoreHandle_t s_ping_done = nullptr;
static volatile bool s_alive = false;

static void on_ping_success(esp_ping_handle_t handle, void *arg)
{
    s_alive = true;
    xSemaphoreGive(s_ping_done);
}

static void on_ping_end(esp_ping_handle_t handle, void *arg)
{
    xSemaphoreGive(s_ping_done);
}

static bool ping_setup()
{
    ip_addr_t target;
    if (!ipaddr_aton(INDICATOR_IP, &target)) {
        ESP_LOGE(TAG, "INDICATOR_IP у secrets.h некоректна");
        return false;
    }
    s_ping_done = xSemaphoreCreateBinary();
    esp_ping_config_t config = ESP_PING_DEFAULT_CONFIG();
    config.target_addr = target;
    config.count = PINGS_PER_CYCLE;
    config.interval_ms = 1000;
    config.timeout_ms = 1000;
    config.task_stack_size = 3072;
    esp_ping_callbacks_t callbacks = {};
    callbacks.on_ping_success = on_ping_success;
    callbacks.on_ping_end = on_ping_end;
    return s_ping_done && esp_ping_new_session(&config, &callbacks, &s_ping) == ESP_OK;
}

/** Один цикл: чи відповів індикатор хоча б на один із пакетів. */
static bool indicator_alive()
{
    s_alive = false;
    xSemaphoreTake(s_ping_done, 0); // прибрати сигнал, що лишився від попереднього циклу
    if (esp_ping_start(s_ping) != ESP_OK) {
        return false;
    }
    xSemaphoreTake(s_ping_done, pdMS_TO_TICKS((PINGS_PER_CYCLE + 2) * 1000));
    const bool alive = s_alive;
    if (alive) {
        esp_ping_stop(s_ping); // решту пакетів не шлемо
    }
    return alive;
}

static void measure()
{
    const uint32_t cycle_start = now_ms();
    if (indicator_alive()) {
        s_failed = 0;
        s_power = true;
        s_known = true;
    } else {
        if (s_failed == 0) {
            s_first_fail_ms = cycle_start;
        }
        s_failed++;
        if (s_failed >= FAILS_FOR_OFF) {
            s_power = false;
            s_known = true;
        }
    }
}

// ---------- заряд станції EcoFlow по Bluetooth ----------
// Станція (перевірено на DELTA 2 Max) розсилає заряд в оголошенні, без підключення й облікового запису.
// Дані виробника: код 0xB5B5, далі байт версії, 16 символів серійного номера і байт заряду у відсотках.
// Свою станцію впізнаємо за першими й останніми чотирма символами серійного номера.

#if CONFIG_BT_NIMBLE_ENABLED

#include <host/ble_hs.h>
#include <host/util/util.h>
#include <nimble/nimble_port.h>
#include <nimble/nimble_port_freertos.h>

static const bool EF_ENABLED = strlen(ECOFLOW_SN_PREFIX) == 4 && strlen(ECOFLOW_SN_SUFFIX) == 4;
static uint8_t s_own_addr_type;
static volatile bool s_heard = false;

static int on_gap_event(struct ble_gap_event *event, void *arg)
{
    if (event->type != BLE_GAP_EVENT_DISC) {
        return 0;
    }
    struct ble_hs_adv_fields fields;
    if (ble_hs_adv_parse_fields(&fields, event->disc.data, event->disc.length_data) != 0) {
        return 0;
    }
    const uint8_t *md = fields.mfg_data;
    // 2 байти коду виробника + версія + 16 символів номера + заряд
    if (md == nullptr || fields.mfg_data_len < 20 || md[0] != 0xB5 || md[1] != 0xB5) {
        return 0;
    }
    for (int i = 0; i < 4; i++) {
        if (md[3 + i] != (uint8_t)ECOFLOW_SN_PREFIX[i] || md[15 + i] != (uint8_t)ECOFLOW_SN_SUFFIX[i]) {
            return 0;
        }
    }
    if (md[19] > 100) {
        return 0;
    }
    s_soc = md[19];
    s_soc_ms = now_ms();
    s_soc_rssi = event->disc.rssi;
    s_heard = true;
    return 0;
}

static void on_ble_sync(void)
{
    if (ble_hs_util_ensure_addr(0) == 0 && ble_hs_id_infer_auto(0, &s_own_addr_type) == 0) {
        s_ble_ready = true;
    }
}

static void ble_host_task(void *arg)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static void ble_setup()
{
    if (!EF_ENABLED) {
        return; // станцію не задано: Bluetooth не запускаємо зовсім
    }
    if (nimble_port_init() != ESP_OK) {
        ESP_LOGE(TAG, "Bluetooth не запустився");
        return;
    }
    ble_hs_cfg.sync_cb = on_ble_sync;
    nimble_port_freertos_init(ble_host_task);
}

/** Слухає оголошення не довше BLE_SCAN_MS і зупиняється, щойно почуто свою станцію. */
static void listen_ecoflow()
{
    if (!s_ble_ready) {
        return;
    }
    struct ble_gap_disc_params params = {};
    params.passive = 1;           // лише слухаємо, нічого не запитуємо
    params.itvl = 160;            // 100 мс
    params.window = 80;           // 50 мс: половину часу радіо лишається для Wi-Fi
    params.filter_duplicates = 0; // чути повтори оголошень
    s_heard = false;
    if (ble_gap_disc(s_own_addr_type, BLE_SCAN_MS, &params, on_gap_event, nullptr) != 0) {
        ESP_LOGW(TAG, "сканування Bluetooth не запустилося");
        return;
    }
    const uint32_t started = now_ms();
    while (!s_heard && ble_gap_disc_active() && now_ms() - started < BLE_SCAN_MS + 500) {
        vTaskDelay(pdMS_TO_TICKS(25));
    }
    if (ble_gap_disc_active()) {
        ble_gap_disc_cancel();
    }
}

#else // без Bluetooth у збірці

static void ble_setup() {}
static void listen_ecoflow() {}

#endif // CONFIG_BT_NIMBLE_ENABLED

// ---------- задача ----------

static void power_task(void *arg)
{
    ble_setup();
    TickType_t last_wake = xTaskGetTickCount();
    for (;;) {
        const uint32_t cycle = s_cycles.fetch_add(1);
        if (cycle % BLE_EVERY_CYCLES == 1) {
            listen_ecoflow();
        }
        wifi_ap_record_t ap;
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) { // без Wi-Fi мовчання індикатора нічого не означає
            measure();
        }
        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(CYCLE_MS));
    }
}

void power_monitor_start(void)
{
    if (strlen(INDICATOR_IP) == 0) {
        return;
    }
    if (!ping_setup()) {
        return;
    }
    s_enabled = true;
    xTaskCreate(power_task, "power", 4096, nullptr, 2, nullptr);
}

void power_monitor_get(power_state_t *out)
{
    out->enabled = s_enabled;
    out->known = s_known;
    out->power = s_power;
    out->failed_cycles = s_failed;
    out->first_fail_ms = s_first_fail_ms;
    out->cycles = s_cycles;
    out->ble_ready = s_ble_ready;
    out->soc = s_soc;
    out->soc_ms = s_soc_ms;
    out->soc_rssi = s_soc_rssi;
}
