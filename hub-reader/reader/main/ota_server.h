// Оновлення прошивки по Wi-Fi з домашньої мережі (tools/ota_upload.py) і відкат, якщо нова версія не запрацювала.
#pragma once

#include <stdbool.h>

#define OTA_PORT 8080

/** Запускає невеликий HTTP-сервер: GET /info, GET /pm (облік сну), GET /led (показ кольорів індикації), GET /ota/nonce, POST /ota. */
void ota_server_start(const char *fw_version);

/** Чи триває зараз запис нової прошивки (на цей час звіти на сайт призупиняються). */
bool ota_in_progress(void);

/** Чи ця прошивка щойно записана по Wi-Fi і ще не підтвердила, що працює. */
bool ota_pending_verify(void);

/** Підтверджує, що нова прошивка працює: після цього відкату вже не буде. */
void ota_confirm(void);
