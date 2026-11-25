// Плата-читач хаба Aqara: контролер Matter, який підписується на температуру й вологість із хаба
// і надсилає їх на сайт «Світло вдома» (POST /home, контракт v1).
//
// Плата лише читає: консолі CHIP у цій збірці немає, коду команд і запису атрибутів теж.
// Сполучення з хабом (вузол HUB_NODE_ID) і мережа Wi-Fi вже лежать у NVS плати: їх туди кладе
// службова прошивка з папки ../firmware (консоль, tools/wifi_connect.py, tools/hub_pair.py).
// Адреса сайту й ключі — у secrets.h поза проєктом (tools/setup_token.sh).
//
// Стабільність: одна задача стежить за підпискою і звітами під сторожовим таймером; якщо довго немає
// Wi-Fi, хаба або вдалих звітів, плата перезапускається сама. Оновлення по Wi-Fi з відкатом — ota_server.cpp.

#include <atomic>
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <esp_crt_bundle.h>
#include <esp_err.h>
#include <esp_heap_caps.h>
#include <esp_http_client.h>
#include <esp_log.h>
#include <esp_pm.h>
#include <esp_random.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <nvs_flash.h>

#include <esp_matter.h>
#include <esp_matter_controller_client.h>

#include <app/ConcreteAttributePath.h>
#include <app/data-model/Decode.h>
#include <app/data-model/Nullable.h>
#include <platform/PlatformManager.h>

#include "hub_subscription.h"
#include "ota_server.h"
#include "power_monitor.h"
#include "secrets.h" // HOME_URL, HOME_TOKEN, OTA_KEY; для монітора світла ще REPORT_URL, DEVICE_TOKEN, INDICATOR_IP

static const char *TAG = "hub_reader";

#ifndef FW_VERSION
#define FW_VERSION "0.4.1"
#endif
#define HUB_NODE_ID 2 // номер, під яким плата додала хаб (tools/hub_pair.py)

// Автоматичний легкий сон процесора між подіями (з версії 0.3.0). Радіо при цьому прокидається
// на маяки роутера, тож вхідні повідомлення хаба й запити оновлення доходять, лише з невеликою затримкою.
// Поки плата під'єднана по USB до комп'ютера, сон не вмикається (CONFIG_USJ_NO_AUTO_LS_ON_CONNECTION).
// Скільки часу плата справді спить, показує GET /pm.
#define LIGHT_SLEEP 1
#define AWAKE_AFTER_BOOT_MS (20 * 1000)

// Кластери Matter: вимірювання температури й відносної вологості; атрибут 0 — MeasuredValue (у сотих).
#define CLUSTER_TEMPERATURE 0x0402
#define CLUSTER_HUMIDITY 0x0405
#define ATTR_MEASURED_VALUE 0x0000
#define WILDCARD_ENDPOINT 0xFFFF

#define NONE INT32_MIN

// Монітор світла (power_monitor.cpp): 0 — «тінь», плата лише міряє й показує результат у GET /info;
// 1 — сама надсилає стан світла й заряд станції на POST /report замість окремої плати-монітора.
// Вмикати 1 лише тоді, коли стару плату-монітор вимкнено: два джерела звітів заважали б одне одному.
#ifndef POWER_REPORT
#define POWER_REPORT 0
#endif
#define POWER_HEARTBEAT_MS (60 * 1000)      // без змін звіт про світло раз на хвилину
#define SOC_MAX_AGE_MS (5 * 60 * 1000)      // старіший заряд станції не надсилаємо

#define SUB_MIN_INTERVAL_S 5
#define SUB_MAX_INTERVAL_S 60
#define SUB_BACKOFF_START_MS (15 * 1000)
#define SUB_BACKOFF_MAX_MS (5 * 60 * 1000)
#define FIRST_REPORT_WAIT_MS (20 * 1000) // стільки чекаємо перших показів після появи мережі
#define FULL_EVERY_MS (5 * 60 * 1000)    // повний знімок як «пульс»
#define DELTA_MIN_GAP_MS (60 * 1000)     // позачергові звіти не частіше
#define RETRY_GAP_MS (30 * 1000)         // пауза після невдалого звіту
#define JUMP_TEMP 50                     // 0,5 °C
#define JUMP_HUM 300                     // 3 %

// Запобіжні перезапуски: якщо щось зависло так, що саме не відновлюється.
#define RESTART_WITHOUT_WIFI_MS (15 * 60 * 1000)
#define RESTART_WITHOUT_HUB_MS (30 * 60 * 1000)
#define RESTART_WITHOUT_REPORT_MS (30 * 60 * 1000)
// Нова прошивка після оновлення по Wi-Fi має підтвердити себе за цей час, інакше відкат.
// OTA_TEST_NEVER_CONFIRM (задається лише для перевірки відкату) збирає прошивку, яка себе
// не підтверджує ніколи й здається за півтори хвилини.
#ifdef OTA_TEST_NEVER_CONFIRM
#define OTA_CONFIRM_WITHIN_MS (90 * 1000)
#else
#define OTA_CONFIRM_WITHIN_MS (10 * 60 * 1000)
#endif

// Спільний стан: пишуть зворотні виклики Matter (задача CHIP), читає задача звітів.
static std::atomic<bool> s_online{false};     // плата отримувала адресу в Wi-Fi
static std::atomic<bool> s_sub_active{false}; // підписка створена або створюється
static std::atomic<bool> s_hub_ok{false};     // після останньої підписки вже приходили покази
static std::atomic<int32_t> s_temp{NONE};     // сирі значення, як у Matter
static std::atomic<int32_t> s_hum{NONE};
static std::atomic<int32_t> s_temp_ep{0};
static std::atomic<int32_t> s_hum_ep{0};
static TaskHandle_t s_reporter = nullptr;

static uint32_t now_ms()
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

static void wake_reporter()
{
    if (s_reporter) {
        xTaskNotifyGive(s_reporter);
    }
}

static void restart(const char *why)
{
    printf("hub_reader: перезапуск: %s\n", why);
    fflush(stdout);
    esp_restart();
}

// ---------- підписка на хаб ----------

// Якщо датчиків кілька, беремо той, що відповів першим, і тримаємося його.
static void store(std::atomic<int32_t> &value, std::atomic<int32_t> &endpoint, uint16_t from_endpoint, int32_t raw)
{
    int32_t current = endpoint.load();
    if (current != 0 && current != from_endpoint) {
        return;
    }
    endpoint.store(from_endpoint);
    value.store(raw);
}

static void on_attribute(const chip::app::ConcreteDataAttributePath &path, chip::TLV::TLVReader *data)
{
    if (path.mAttributeId != ATTR_MEASURED_VALUE) {
        return;
    }
    chip::TLV::TLVReader reader;
    reader.Init(*data);
    if (path.mClusterId == CLUSTER_TEMPERATURE) {
        chip::app::DataModel::Nullable<int16_t> v;
        if (chip::app::DataModel::Decode(reader, v) != CHIP_NO_ERROR) {
            return;
        }
        store(s_temp, s_temp_ep, path.mEndpointId, v.IsNull() ? NONE : v.Value());
    } else if (path.mClusterId == CLUSTER_HUMIDITY) {
        chip::app::DataModel::Nullable<uint16_t> v;
        if (chip::app::DataModel::Decode(reader, v) != CHIP_NO_ERROR) {
            return;
        }
        store(s_hum, s_hum_ep, path.mEndpointId, v.IsNull() ? NONE : v.Value());
    } else {
        return;
    }
    s_hub_ok = true;
    wake_reporter();
}

static void on_subscription_state(bool alive)
{
    if (alive) {
        return; // «хаб на зв'язку» вважаємо з першого показу, а не з рукостискання
    }
    ESP_LOGW(TAG, "підписка завершилась, створимо нову");
    s_sub_active = false;
    s_hub_ok = false;
    wake_reporter();
}

// Виконується в задачі CHIP (PlatformMgr().ScheduleWork), тож замок стека вже взято.
static void start_subscription(intptr_t arg)
{
    chip::Platform::ScopedMemoryBufferWithSize<chip::app::AttributePathParams> paths;
    paths.Alloc(2);
    if (!paths.Get()) {
        s_sub_active = false;
        return;
    }
    paths[0] = chip::app::AttributePathParams(WILDCARD_ENDPOINT, CLUSTER_TEMPERATURE, ATTR_MEASURED_VALUE);
    paths[1] = chip::app::AttributePathParams(WILDCARD_ENDPOINT, CLUSTER_HUMIDITY, ATTR_MEASURED_VALUE);
    hub_subscription *subscription = chip::Platform::New<hub_subscription>(
        HUB_NODE_ID, std::move(paths), SUB_MIN_INTERVAL_S, SUB_MAX_INTERVAL_S, on_attribute, on_subscription_state);
    if (!subscription) {
        s_sub_active = false;
        return;
    }
    subscription->start(); // у разі помилки сама повідомить через on_subscription_state(false)
}

// ---------- звіт на сайт ----------

struct response_t {
    char text[160];
    int len;
};

static esp_err_t on_http_event(esp_http_client_event_t *event)
{
    if (event->event_id == HTTP_EVENT_ON_DATA && event->user_data) {
        response_t *response = (response_t *)event->user_data;
        int room = (int)sizeof(response->text) - 1 - response->len;
        int take = event->data_len < room ? event->data_len : room;
        if (take > 0) {
            memcpy(response->text + response->len, event->data, take);
            response->len += take;
            response->text[response->len] = 0;
        }
    }
    return ESP_OK;
}

/** Надсилає тіло звіту на `url` з ключем `bearer`. Повертає код HTTP або -1, якщо з'єднатися не вдалося. */
static int post_json(const char *url, const char *bearer, const char *body, response_t *response)
{
    response->len = 0;
    response->text[0] = 0;
    esp_http_client_config_t config = {};
    config.url = url;
    config.method = HTTP_METHOD_POST;
    config.timeout_ms = 15000;
    config.crt_bundle_attach = esp_crt_bundle_attach;
    config.event_handler = on_http_event;
    config.user_data = response;
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        return -1;
    }
    esp_http_client_set_header(client, "Authorization", bearer);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body, strlen(body));
    esp_err_t err = esp_http_client_perform(client);
    int status = err == ESP_OK ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);
    return status;
}

static bool wifi_associated(int *rssi)
{
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) != ESP_OK) {
        return false;
    }
    if (rssi) {
        *rssi = ap.rssi;
    }
    return true;
}

static int build_report(char *out, size_t size, const char *kind, uint32_t boot, uint32_t seq, bool hub, int32_t temp,
                        int32_t hum)
{
    char rssi[12] = "null";
    int level = 0;
    if (wifi_associated(&level)) {
        snprintf(rssi, sizeof(rssi), "%d", level);
    }
    // rst — причина останнього перезапуску (esp_reset_reason), heap — найнижча позначка вільної пам'яті від старту.
    int n = snprintf(out, size,
                     "{\"v\":1,\"kind\":\"%s\",\"boot\":%" PRIu32 ",\"seq\":%" PRIu32 ",\"uptime\":%" PRIu32
                     ",\"fw\":\"" FW_VERSION "\",\"rssi\":%s,\"rst\":%d,\"heap\":%u,\"hub\":%s,\"d\":[",
                     kind, boot, seq, (uint32_t)(esp_timer_get_time() / 1000000), rssi, (int)esp_reset_reason(),
                     (unsigned)esp_get_minimum_free_heap_size(), hub ? "true" : "false");
    bool comma = false;
    // Без підписки значення не надсилаємо: сервер лишає останні відомі з їхнім часом.
    if (hub && temp != NONE) {
        n += snprintf(out + n, size - n, "{\"ep\":%" PRId32 ",\"k\":\"temp\",\"temp\":%" PRId32 "}", s_temp_ep.load(), temp);
        comma = true;
    }
    if (hub && hum != NONE) {
        n += snprintf(out + n, size - n, "%s{\"ep\":%" PRId32 ",\"k\":\"hum\",\"hum\":%" PRId32 "}", comma ? "," : "",
                      s_hum_ep.load(), hum);
    }
    n += snprintf(out + n, size - n, "]}");
    return n;
}

// Одна задача стежить і за підпискою, і за звітами: уся повільна робота (HTTPS) тут, а не у викликах Matter.
static void reporter_task(void *arg)
{
    const uint32_t boot = esp_random();
    const uint32_t started = now_ms();
    uint32_t seq = 0;
    uint32_t online_since = 0;
    uint32_t next_subscribe = 0;
    uint32_t backoff = SUB_BACKOFF_START_MS;
    uint32_t wifi_seen = started;
    uint32_t hub_seen = started;
    uint32_t report_ok = started;
    uint32_t last_full = 0;
    uint32_t last_attempt = 0;
    bool was_online = false;
    bool sent_any = false;
    bool attempted = false;
    bool want_full = true;
    int32_t sent_temp = NONE;
    int32_t sent_hum = NONE;
    static char body[448];
    static response_t response;
#if POWER_REPORT
    static char pw_body[256];
    bool pw_sent_once = false;
    bool pw_sent_power = true;
    bool pw_attempted = false;
    int pw_sent_soc = -1;
    uint32_t pw_last_beat = 0;
    uint32_t pw_last_attempt = 0;
#endif

    esp_task_wdt_add(nullptr); // якщо ця задача зависне довше за CONFIG_ESP_TASK_WDT_TIMEOUT_S, плата перезапуститься

    for (;;) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
        esp_task_wdt_reset();
        const uint32_t now = now_ms();

        // Запобіжники. Кожен лічить час від останнього «все гаразд» у своїй ланці.
        if (wifi_associated(nullptr)) {
            wifi_seen = now;
        } else if (now - wifi_seen > RESTART_WITHOUT_WIFI_MS) {
            restart("15 хв без Wi-Fi");
        }
        if (ota_pending_verify() && now - started > OTA_CONFIRM_WITHIN_MS) {
            restart("нова прошивка не підтвердила себе, відкат");
        }
        if (!s_online || ota_in_progress()) {
            hub_seen = now; // без мережі чи під час оновлення хаб і сайт не винні
            report_ok = now;
            continue;
        }
        if (!was_online) {
            was_online = true;
            online_since = now;
            next_subscribe = now + 3000;
        }

        // Підписка: якщо її немає, створюємо знову з паузами 15 с → 30 с → … → 5 хв.
        const bool hub = s_hub_ok;
        if (hub) {
            backoff = SUB_BACKOFF_START_MS;
            hub_seen = now;
        } else if (now - hub_seen > RESTART_WITHOUT_HUB_MS) {
            restart("пів години без підписки на хаб");
        }
        if (!s_sub_active && (int32_t)(now - next_subscribe) >= 0) {
            s_sub_active = true;
            next_subscribe = now + backoff;
            backoff = backoff * 2 > SUB_BACKOFF_MAX_MS ? SUB_BACKOFF_MAX_MS : backoff * 2;
            chip::DeviceLayer::PlatformMgr().ScheduleWork(start_subscription, 0);
        }
        if (now - report_ok > RESTART_WITHOUT_REPORT_MS) {
            restart("пів години без вдалого звіту на сайт");
        }

#if POWER_REPORT
        // Звіт про світло: одразу при зміні стану світла чи заряду станції, без змін — раз на хвилину.
        // Іде тією самою задачею, що й звіт клімату: два шифровані з'єднання водночас не відкриваються.
        {
            power_state_t ps;
            power_monitor_get(&ps);
            const bool due = ps.enabled && ps.known &&
                             (!pw_sent_once || ps.power != pw_sent_power || ps.soc != pw_sent_soc ||
                              now - pw_last_beat >= POWER_HEARTBEAT_MS);
            if (due && (!pw_attempted || now - pw_last_attempt >= 5000)) {
                int level = 0;
                const bool has_rssi = wifi_associated(&level);
                // "ago": скільки секунд тому зник перший ping. Сервер записує початок відключення цим часом,
                // бо саме відключення оголошується лише після двох невдалих циклів.
                const uint32_t ago = ps.power ? 0 : (now - ps.first_fail_ms) / 1000;
                int n = snprintf(pw_body, sizeof(pw_body),
                                 "{\"power\":%s,\"rssi\":%d,\"uptime\":%" PRIu32 ",\"fw\":\"" FW_VERSION "\",\"ago\":%" PRIu32,
                                 ps.power ? "true" : "false", has_rssi ? level : 0,
                                 (uint32_t)(esp_timer_get_time() / 1000000), ago);
                if (ps.soc >= 0 && now - ps.soc_ms < SOC_MAX_AGE_MS) {
                    n += snprintf(pw_body + n, sizeof(pw_body) - n, ",\"soc\":%d,\"socAge\":%" PRIu32 ",\"socRssi\":%d",
                                  ps.soc, (now - ps.soc_ms) / 1000, ps.soc_rssi);
                }
                snprintf(pw_body + n, sizeof(pw_body) - n, "}");
                pw_attempted = true;
                pw_last_attempt = now;
                const int status = post_json(REPORT_URL, "Bearer " DEVICE_TOKEN, pw_body, &response);
                esp_task_wdt_reset();
                printf("hub_reader: світло %s, заряд %d%%: HTTP %d\n", ps.power ? "є" : "немає", ps.soc, status);
                if (status == 200) {
                    pw_sent_once = true;
                    pw_sent_power = ps.power;
                    pw_sent_soc = ps.soc;
                    pw_last_beat = now;
                    report_ok = now_ms();
                }
            }
        }
#endif // POWER_REPORT

        // Звіт: повний на старті, раз на 5 хв і на вимогу сервера; позачерговий — коли покази стрибнули.
        const int32_t temp = s_temp;
        const int32_t hum = s_hum;
        if (!sent_any && (!hub || temp == NONE || hum == NONE) && now - online_since < FIRST_REPORT_WAIT_MS) {
            continue; // даємо підписці час принести і температуру, і вологість (вони приходять окремими записами)
        }
        if (attempted && now - last_attempt < (sent_any ? 5000u : RETRY_GAP_MS)) {
            continue;
        }
        const bool full_due = want_full || !sent_any || now - last_full >= FULL_EVERY_MS;
        const bool temp_jump = temp != NONE && (sent_temp == NONE || abs(temp - sent_temp) >= JUMP_TEMP);
        const bool hum_jump = hum != NONE && (sent_hum == NONE || abs(hum - sent_hum) >= JUMP_HUM);
        const bool jump = hub && (temp_jump || hum_jump) && now - last_attempt >= DELTA_MIN_GAP_MS;
        if (!full_due && !jump) {
            continue;
        }

        build_report(body, sizeof(body), full_due ? "full" : "delta", boot, ++seq, hub, temp, hum);
        attempted = true;
        last_attempt = now;
        const int status = post_json(HOME_URL, "Bearer " HOME_TOKEN, body, &response);
        esp_task_wdt_reset();
        // printf, а не ESP_LOG: журнал у цій збірці обрізано до попереджень, а цей рядок потрібен завжди.
        printf("hub_reader: звіт %s №%" PRIu32 ": HTTP %d, хаб %s, темп %" PRId32 ", волог %" PRId32 ", купа %u (мін %u)\n",
               full_due ? "full" : "delta", seq, status, hub ? "так" : "ні", temp == NONE ? -1 : temp,
               hum == NONE ? -1 : hum, (unsigned)esp_get_free_heap_size(), (unsigned)esp_get_minimum_free_heap_size());
        if (status == 200) {
            sent_any = true;
            report_ok = now_ms();
            if (full_due) {
                last_full = now;
            }
            if (hub) {
                sent_temp = temp;
                sent_hum = hum;
            }
            want_full = strstr(response.text, "\"full\":true") != nullptr;
            // Уся ланка працює (Wi-Fi, хаб, сайт): після оновлення по Wi-Fi це і є підтвердження нової прошивки.
#ifndef OTA_TEST_NEVER_CONFIRM
            if (hub && temp != NONE) {
                ota_confirm();
            }
#endif
        } else {
            sent_any = false; // наступна спроба — повний знімок через RETRY_GAP_MS
        }
    }
}

// ---------- запуск ----------

static void app_event_cb(const ChipDeviceEvent *event, intptr_t arg)
{
    if (event->Type == chip::DeviceLayer::DeviceEventType::kESPSystemEvent &&
        event->Platform.ESPSystemEvent.Base == IP_EVENT &&
        event->Platform.ESPSystemEvent.Id == IP_EVENT_STA_GOT_IP) {
        s_online = true;
        wake_reporter();
    }
}

extern "C" void app_main()
{
    nvs_flash_init();
    printf("hub_reader: плата-читач хаба, прошивка " FW_VERSION ", причина запуску %d%s\n", (int)esp_reset_reason(),
           ota_pending_verify() ? ", нова прошивка чекає підтвердження" : "");

#if CONFIG_PM_ENABLE
    // Частота процесора 80 МГц; автоматичний легкий сон — прапорець LIGHT_SLEEP.
    esp_pm_config_t pm = {};
    pm.max_freq_mhz = 80;
    pm.min_freq_mhz = 80;
    pm.light_sleep_enable = LIGHT_SLEEP;
    esp_pm_configure(&pm);
#if LIGHT_SLEEP
    // Перші секунди після запуску не спимо: запас, щоб комп'ютер, якщо плата під'єднана до нього кабелем,
    // устиг розпізнати її по USB. Далі сон заборонений, доки кабель під'єднано
    // (CONFIG_USJ_NO_AUTO_LS_ON_CONNECTION), а на зарядці починається після цієї паузи.
    // На кабелі до комп'ютера прошивку зі сном ще не перевіряли: чи потрібна ця пауза, невідомо.
    static esp_pm_lock_handle_t awake_after_boot;
    if (esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "after_boot", &awake_after_boot) == ESP_OK) {
        esp_pm_lock_acquire(awake_after_boot);
        esp_timer_create_args_t timer_args = {};
        timer_args.callback = [](void *lock) { esp_pm_lock_release((esp_pm_lock_handle_t)lock); };
        timer_args.arg = awake_after_boot;
        timer_args.name = "after_boot";
        esp_timer_handle_t timer;
        if (esp_timer_create(&timer_args, &timer) == ESP_OK) {
            esp_timer_start_once(timer, AWAKE_AFTER_BOOT_MS * 1000ULL);
        }
    }
#endif
#endif

    xTaskCreate(reporter_task, "reporter", 10240, nullptr, 3, &s_reporter);

    esp_err_t err = esp_matter::start(app_event_cb);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Matter не запустився: %d", err);
        abort();
    }
    {
        // Ті самі параметри контролера, що й у службовій прошивці: фабрика й ключі в NVS прив'язані до них.
        esp_matter::lock::ScopedChipStackLock lock(portMAX_DELAY);
        esp_matter::controller::matter_controller_client::get_instance().init(112233, 1, 5580);
        esp_matter::controller::matter_controller_client::get_instance().setup_commissioner();
    }
    ota_server_start(FW_VERSION);
    power_monitor_start();
}
