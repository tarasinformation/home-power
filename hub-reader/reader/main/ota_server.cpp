// Оновлення по Wi-Fi.
//
// Порядок: завантажувач (tools/ota_upload.py) просить у плати одноразове число GET /ota/nonce, рахує
// HMAC-SHA256(OTA_KEY, "<nonce>:<розмір>:<sha256 образу>") і надсилає образ POST /ota із заголовками
// X-Nonce, X-Sha256, X-Sign. Плата перевіряє підпис до того, як прийняти перший байт, а після запису
// звіряє SHA-256 усього образу. Сам ключ мережею не передається; без ключа ні записати прошивку,
// ні повторити перехоплений запит не вийде.
//
// Відкат: образ пишеться в неактивний розділ. Після перезапуску нова прошивка має підтвердити себе
// (ota_confirm, викликається після першого вдалого звіту на сайт зі справними показами хаба).
// Якщо за відведений час підтвердження немає, плата перезапускається, і завантажувач ESP-IDF
// повертає попередню прошивку (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE).
#include "ota_server.h"

#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <esp_app_desc.h>
#include <esp_http_server.h>
#include <esp_log.h>
#include <esp_ota_ops.h>
#include <esp_random.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>

#include "secrets.h" // OTA_KEY

static const char *TAG = "ota";

#define NONCE_TTL_MS (120 * 1000)
#define MIN_IMAGE_SIZE (256 * 1024)

static const char *s_fw_version = "";
static volatile bool s_in_progress = false;
static char s_nonce[33] = "";
static int64_t s_nonce_ms = 0;

static int64_t now_ms()
{
    return esp_timer_get_time() / 1000;
}

static void to_hex(const uint8_t *in, size_t len, char *out)
{
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[2 * i] = digits[in[i] >> 4];
        out[2 * i + 1] = digits[in[i] & 15];
    }
    out[2 * len] = 0;
}

/** Порівняння без раннього виходу: час не залежить від того, де рядки розійшлися. */
static bool same(const char *a, const char *b, size_t len)
{
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) {
        diff |= (uint8_t)a[i] ^ (uint8_t)b[i];
    }
    return diff == 0;
}

static esp_err_t reply(httpd_req_t *req, const char *status, const char *text)
{
    httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "text/plain; charset=utf-8");
    return httpd_resp_sendstr(req, text);
}

static esp_err_t info_get(httpd_req_t *req)
{
    char body[200];
    const esp_partition_t *running = esp_ota_get_running_partition();
    snprintf(body, sizeof(body),
             "{\"fw\":\"%s\",\"uptime\":%" PRId64 ",\"heap\":%u,\"heap_min\":%u,\"reset\":%d,\"slot\":\"%s\",\"pending\":%s}",
             s_fw_version, esp_timer_get_time() / 1000000, (unsigned)esp_get_free_heap_size(),
             (unsigned)esp_get_minimum_free_heap_size(), (int)esp_reset_reason(), running ? running->label : "?",
             ota_pending_verify() ? "true" : "false");
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, body);
}

static esp_err_t nonce_get(httpd_req_t *req)
{
    if (s_in_progress) {
        return reply(req, "409 Conflict", "оновлення вже триває");
    }
    uint8_t raw[16];
    esp_fill_random(raw, sizeof(raw));
    to_hex(raw, sizeof(raw), s_nonce);
    s_nonce_ms = now_ms();
    return reply(req, "200 OK", s_nonce);
}

static void restart_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(1500)); // дати відповіді дійти до завантажувача
    esp_restart();
}

static esp_err_t ota_post(httpd_req_t *req)
{
    char nonce[40] = "", sha_hex[72] = "", sign[72] = "";
    if (httpd_req_get_hdr_value_str(req, "X-Nonce", nonce, sizeof(nonce)) != ESP_OK ||
        httpd_req_get_hdr_value_str(req, "X-Sha256", sha_hex, sizeof(sha_hex)) != ESP_OK ||
        httpd_req_get_hdr_value_str(req, "X-Sign", sign, sizeof(sign)) != ESP_OK || strlen(nonce) != 32 ||
        strlen(sha_hex) != 64 || strlen(sign) != 64) {
        return reply(req, "400 Bad Request", "бракує заголовків");
    }
    // Одноразове число: має збігатися з виданим, бути свіжим і більше не використовуватись.
    const bool nonce_ok = s_nonce[0] != 0 && same(nonce, s_nonce, 32) && now_ms() - s_nonce_ms <= NONCE_TTL_MS;
    s_nonce[0] = 0;
    if (!nonce_ok || s_in_progress) {
        return reply(req, "401 Unauthorized", "число застаріло або чуже");
    }
    char message[160];
    int n = snprintf(message, sizeof(message), "%s:%u:%s", nonce, (unsigned)req->content_len, sha_hex);
    uint8_t mac[32];
    char expected[65];
    if (mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t *)OTA_KEY, strlen(OTA_KEY),
                        (const uint8_t *)message, n, mac) != 0) {
        return reply(req, "500 Internal Server Error", "hmac");
    }
    to_hex(mac, sizeof(mac), expected);
    if (!same(sign, expected, 64)) {
        ESP_LOGW(TAG, "оновлення відхилено: підпис не збігся");
        return reply(req, "401 Unauthorized", "підпис не збігся");
    }

    const esp_partition_t *target = esp_ota_get_next_update_partition(nullptr);
    if (!target || req->content_len < MIN_IMAGE_SIZE || req->content_len > target->size) {
        return reply(req, "413 Payload Too Large", "образ не вміщується в розділ або замалий");
    }
    s_in_progress = true;
    ESP_LOGW(TAG, "оновлення: %u байтів у розділ %s", (unsigned)req->content_len, target->label);
    esp_ota_handle_t handle = 0;
    esp_err_t err = esp_ota_begin(target, OTA_WITH_SEQUENTIAL_WRITES, &handle);
    if (err != ESP_OK) {
        s_in_progress = false;
        return reply(req, "500 Internal Server Error", "esp_ota_begin");
    }
    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    mbedtls_sha256_starts(&sha, 0);
    static char buf[4096];
    size_t left = req->content_len;
    const char *problem = nullptr;
    while (left > 0) {
        int got = httpd_req_recv(req, buf, left < sizeof(buf) ? left : sizeof(buf));
        if (got == HTTPD_SOCK_ERR_TIMEOUT) {
            continue;
        }
        if (got <= 0) {
            problem = "з'єднання обірвалось";
            break;
        }
        mbedtls_sha256_update(&sha, (const uint8_t *)buf, got);
        if (esp_ota_write(handle, buf, got) != ESP_OK) {
            problem = "помилка запису";
            break;
        }
        left -= got;
    }
    uint8_t digest[32];
    char digest_hex[65];
    mbedtls_sha256_finish(&sha, digest);
    mbedtls_sha256_free(&sha);
    to_hex(digest, sizeof(digest), digest_hex);
    if (!problem && !same(digest_hex, sha_hex, 64)) {
        problem = "sha256 образу не збігся";
    }
    if (problem) {
        esp_ota_abort(handle);
        s_in_progress = false;
        ESP_LOGW(TAG, "оновлення скасовано: %s", problem);
        return reply(req, "400 Bad Request", problem);
    }
    err = esp_ota_end(handle); // тут ESP-IDF ще раз перевіряє образ
    if (err == ESP_OK) {
        err = esp_ota_set_boot_partition(target);
    }
    if (err != ESP_OK) {
        s_in_progress = false;
        return reply(req, "400 Bad Request", "образ не пройшов перевірку ESP-IDF");
    }
    ESP_LOGW(TAG, "оновлення записано, перезапуск");
    reply(req, "200 OK", "ok");
    xTaskCreate(restart_task, "ota_restart", 2048, nullptr, 5, nullptr);
    return ESP_OK;
}

void ota_server_start(const char *fw_version)
{
    s_fw_version = fw_version;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = OTA_PORT;
    config.stack_size = 6144;
    config.max_uri_handlers = 4;
    config.max_open_sockets = 2;
    config.recv_wait_timeout = 15;
    config.lru_purge_enable = true;
    httpd_handle_t server = nullptr;
    if (httpd_start(&server, &config) != ESP_OK) {
        ESP_LOGE(TAG, "сервер оновлень не запустився");
        return;
    }
    static const httpd_uri_t info = {.uri = "/info", .method = HTTP_GET, .handler = info_get, .user_ctx = nullptr};
    static const httpd_uri_t nonce = {.uri = "/ota/nonce", .method = HTTP_GET, .handler = nonce_get, .user_ctx = nullptr};
    static const httpd_uri_t ota = {.uri = "/ota", .method = HTTP_POST, .handler = ota_post, .user_ctx = nullptr};
    httpd_register_uri_handler(server, &info);
    httpd_register_uri_handler(server, &nonce);
    httpd_register_uri_handler(server, &ota);
}

bool ota_in_progress(void)
{
    return s_in_progress;
}

bool ota_pending_verify(void)
{
    esp_ota_img_states_t state;
    const esp_partition_t *running = esp_ota_get_running_partition();
    return running && esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY;
}

void ota_confirm(void)
{
    if (ota_pending_verify()) {
        esp_ota_mark_app_valid_cancel_rollback();
        ESP_LOGW(TAG, "нова прошивка підтверджена");
    }
}
