// Індикація стану світлодіодом WS2812. Що означають кольори — у status_led.h.
//
// Енергія й сон: поки все гаразд, задача спить без таймера і процесор через неї не прокидається.
// Передавач RMT вмикається лише на час самої посилки (десятки мікросекунд), бо ввімкнений він
// тримає замок керування живленням і не дав би процесору спати. Між посилками лінія даних низька,
// і на час сну вона лишається керованою (gpio_sleep_sel_dis): у цій збірці решта контактів на час сну
// від'єднується (CONFIG_PM_SLP_DISABLE_GPIO), а «плаваюча» лінія даних могла б засвітити світлодіод сама.
#include "status_led.h"

#include <atomic>

#include <driver/gpio.h>
#include <driver/rmt_tx.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "ota_server.h"

static const char *TAG = "led";

#define LED_GPIO GPIO_NUM_8
#define RMT_HZ 10000000 // крок 0,1 мкс

#define BOOT_MAX_MS (90 * 1000) // довше «запуск» не показуємо: далі видно причину
#define BOOT_ON_MS 300
#define BOOT_OFF_MS 1700
#define FLASH_MS 30
#define FLASH_GAP_MS 300
#define ISSUE_PERIOD_MS (10 * 1000)
#define DEMO_STEP_MS 1000

struct rgb_t {
    uint8_t r, g, b;
};

// Яскравість навмисно низька (зі 255): сталі кольори ледь світять, короткі спалахи трохи яскравіші.
static const rgb_t OFF = {0, 0, 0};
static const rgb_t WHITE = {14, 14, 14};
static const rgb_t CYAN = {0, 14, 14};
static const rgb_t YELLOW = {70, 45, 0};
static const rgb_t BLUE = {0, 0, 90};
static const rgb_t RED = {90, 0, 0};
static const rgb_t VIOLET = {55, 0, 80};

static const struct {
    uint32_t issue;
    rgb_t color;
} ISSUE_COLORS[] = {
    {LED_NO_WIFI, YELLOW},
    {LED_NO_HUB, BLUE},
    {LED_NO_SERVER, RED},
    {LED_NO_POWER, VIOLET},
};

static rmt_channel_handle_t s_channel = nullptr;
static rmt_encoder_handle_t s_encoder = nullptr;
static TaskHandle_t s_task = nullptr;
static std::atomic<uint32_t> s_issues{0};
static std::atomic<bool> s_booting{true};
static std::atomic<bool> s_demo{false};
// Світлодіод живиться незалежно від процесора й пам'ятає колір: після перезапуску плати він міг лишитися
// ввімкненим. Тому на старті вважаємо, що світить, і перше «вимкнути» справді надсилаємо.
static bool s_lit = true;

static void show(const rgb_t &color)
{
    const bool lit = color.r || color.g || color.b;
    if (!lit && !s_lit) {
        return;
    }
    const uint8_t grb[3] = {color.g, color.r, color.b}; // WS2812 чекає зелений, червоний, синій
    rmt_transmit_config_t tx = {};
    if (rmt_enable(s_channel) != ESP_OK) {
        return;
    }
    if (rmt_transmit(s_channel, s_encoder, grb, sizeof(grb), &tx) == ESP_OK) {
        rmt_tx_wait_all_done(s_channel, 100);
    }
    rmt_disable(s_channel);
    s_lit = lit;
}

/** Пауза, яку перериває зміна стану. */
static void pause_ms(uint32_t ms)
{
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(ms));
}

static void wake()
{
    if (s_task) {
        xTaskNotifyGive(s_task);
    }
}

static void led_task(void *arg)
{
    for (;;) {
        if (s_demo.exchange(false)) {
            static const rgb_t all[] = {WHITE, YELLOW, BLUE, RED, VIOLET, CYAN};
            for (const rgb_t &color : all) {
                show(color);
                vTaskDelay(pdMS_TO_TICKS(DEMO_STEP_MS));
                show(OFF);
                vTaskDelay(pdMS_TO_TICKS(FLASH_GAP_MS));
            }
            continue;
        }
        if (ota_in_progress()) {
            show(CYAN);
            pause_ms(2000);
            continue;
        }
        if (s_booting && esp_timer_get_time() / 1000 < BOOT_MAX_MS) {
            show(WHITE);
            vTaskDelay(pdMS_TO_TICKS(BOOT_ON_MS));
            show(OFF);
            pause_ms(BOOT_OFF_MS);
            continue;
        }
        const uint32_t issues = s_issues;
        if (!issues) {
            show(OFF);
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY); // усе гаразд: спимо, доки щось не зміниться
            continue;
        }
        for (const auto &entry : ISSUE_COLORS) {
            if (issues & entry.issue) {
                show(entry.color);
                vTaskDelay(pdMS_TO_TICKS(FLASH_MS));
                show(OFF);
                vTaskDelay(pdMS_TO_TICKS(FLASH_GAP_MS));
            }
        }
        pause_ms(ISSUE_PERIOD_MS);
    }
}

void status_led_start(void)
{
    rmt_tx_channel_config_t channel = {};
    channel.gpio_num = LED_GPIO;
    channel.clk_src = RMT_CLK_SRC_DEFAULT;
    channel.resolution_hz = RMT_HZ;
    channel.mem_block_symbols = 48;
    channel.trans_queue_depth = 1;
    if (rmt_new_tx_channel(&channel, &s_channel) != ESP_OK) {
        ESP_LOGW(TAG, "передавач не запустився, працюємо без індикації");
        return;
    }
    // Біти WS2812: «0» — 0,3 мкс високий і 0,9 мкс низький, «1» — навпаки; старший біт першим.
    rmt_bytes_encoder_config_t encoder = {};
    encoder.bit0.level0 = 1;
    encoder.bit0.duration0 = 3;
    encoder.bit0.level1 = 0;
    encoder.bit0.duration1 = 9;
    encoder.bit1.level0 = 1;
    encoder.bit1.duration0 = 9;
    encoder.bit1.level1 = 0;
    encoder.bit1.duration1 = 3;
    encoder.flags.msb_first = 1;
    if (rmt_new_bytes_encoder(&encoder, &s_encoder) != ESP_OK) {
        ESP_LOGW(TAG, "кодувальник не запустився, працюємо без індикації");
        return;
    }
    gpio_sleep_sel_dis(LED_GPIO); // на час сну контакт лишається виходом із низьким рівнем
    if (xTaskCreate(led_task, "led", 3072, nullptr, 2, &s_task) != pdPASS) {
        s_task = nullptr;
    }
}

void status_led_set(uint32_t issues)
{
    if (s_issues.exchange(issues) != issues) {
        wake();
    }
}

void status_led_booted(void)
{
    if (s_booting.exchange(false)) {
        wake();
    }
}

void status_led_refresh(void)
{
    wake();
}

void status_led_demo(void)
{
    s_demo = true;
    wake();
}
