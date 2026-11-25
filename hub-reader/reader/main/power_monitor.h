// Монітор світла на тій самій платі: пінг пристрою-індикатора в розетці без резерву і заряд
// зарядної станції EcoFlow з її Bluetooth-оголошення. Логіка та сама, що у прошивці ../../firmware
// (ESP32-C3, Arduino): два невдалі цикли поспіль означають «світла немає».
#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    bool enabled;         // у secrets.h задано адресу індикатора
    bool known;           // уже є перше надійне вимірювання
    bool power;           // світло є
    int failed_cycles;    // невдалих циклів поспіль
    uint32_t first_fail_ms; // коли почався перший невдалий цикл: справжній початок відключення
    uint32_t cycles;      // скільки циклів вимірювання пройшло
    bool ble_ready;       // Bluetooth запущено й станцію задано
    int soc;              // останній почутий заряд станції, % (−1 — ще не чули)
    uint32_t soc_ms;      // коли почуто
    int soc_rssi;
} power_state_t;

/** Запускає задачу вимірювання. Без INDICATOR_IP у secrets.h нічого не робить. */
void power_monitor_start(void);

/** Знімок поточного стану. */
void power_monitor_get(power_state_t *out);
