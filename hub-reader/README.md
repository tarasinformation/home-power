# Плата-читач хаба: температура з розумного дому на сайті

Необов'язкова друга плата до «Світла вдома». ESP32-C6 стає ще одним контролером Matter на хабі розумного дому, підписується на температуру й вологість датчика за хабом і надсилає їх на сайт (`POST /home`). Працює сама, без комп'ютера, без Home Assistant і без хмари виробника хаба.

*English summary is at the end.*

```
датчик (Zigbee) ─▶ хаб із мостом Matter ──локальна мережа──▶ ESP32-C6 ──HTTPS──▶ Convex ─▶ сайт
                   (перевірено: Aqara Hub M3)                підписка,          картка «Температура вдома»
                                                             лише читання
```

## Стан і чесні обмеження

- Перевірено на одній платі ESP32-C6 (4 МБ флеш, без PSRAM) з Aqara Hub M3, ESP-IDF v5.5.5 і esp-matter `release/v1.5`. Espressif сама перевіряє роль контролера лише на ESP32-S3; ESP32-C3 теж запускається, але вільної пам'яті в неї вдвічі менше (близько 94 КБ проти 199 КБ на C6).
- Перевірено на залізі: сполучення з хабом, підписка, звіти по HTTPS одночасно з підпискою, відновлення підписки після короткого обриву, оновлення по Wi-Fi і відкат на попередню прошивку.
- Не перевірено: тривала робота (тижні), довгий обрив хаба, зникнення Wi-Fi, спрацювання сторожового таймера, журнал по USB разом із легким сном.
- **Права на хабі.** Плата, яка сама додає хаб, отримує у своїй «фабриці» права адміністратора, тобто технічно може керувати пристроями хаба, зокрема замками. Тому одразу після сполучення їх треба знизити до «лише перегляд» (крок 5 нижче): це один запис зі службової консолі. На Aqara Hub M3 перевірено, що після цього хаб відхиляє і запис прав, і команди пристроям, а читання й підписка працюють. Бойова прошивка, крім того, не має ні коду команд, ні консолі. Ключі лежать у флеш-пам'яті плати відкрито: хто має плату в руках, може їх зчитати.

## Що тут лежить

| Шлях | Що це |
|---|---|
| `firmware/` | Службова прошивка: приклад `examples/controller` з esp-matter з консоллю на вбудованому USB. Потрібна один раз, щоб підключити плату до Wi-Fi і сполучити з хабом. `tools/wifi_connect.py`, `tools/hub_pair.py` вводять пароль і код сполучення, не показуючи їх |
| `reader/` | Бойова прошивка: підписка (`hub_subscription`), звіти на сайт, оновлення по Wi-Fi з відкатом (`ota_server`), сторожовий таймер. `tools/setup_token.sh` готує ключі, `tools/ota_upload.py` оновлює плату |

Мережа Wi-Fi, ключі Matter і сполучення з хабом лежать у розділі `nvs` плати; він стоїть на тому самому місці в обох таблицях розділів, тому переживає перехід зі службової прошивки на бойову й назад.

## Як зібрати й запустити

Потрібні ESP-IDF v5.5.5 і esp-matter `release/v1.5` (встановлення описане в документації esp-matter). У кожному новому терміналі:

```bash
export IDF_CCACHE_ENABLE=1
source ~/Developer/esp/esp-idf/export.sh && source ~/Developer/esp/esp-matter/export.sh
```

Папки збірки й згенеровані `sdkconfig` тримайте поза репозиторієм (у прикладах `~/.config/esp-hub-reader/`): зібраний образ містить ключі.

**Правило: змінили будь-яке налаштування `sdkconfig` — збирайте в новій папці збірки.** Бібліотека CHIP збирається окремо й при зміні налаштувань у тій самій папці не перезбирається.

1. **Службова прошивка** (кабелем):
   ```bash
   cd firmware
   idf.py -B ~/.config/esp-hub-reader/build-service -D SDKCONFIG=~/.config/esp-hub-reader/sdkconfig.service \
     -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32c6;sdkconfig.defaults.nobt;sdkconfig.defaults.usbconsole;sdkconfig.defaults.hub" \
     set-target esp32c6 build
   idf.py -B ~/.config/esp-hub-reader/build-service -D SDKCONFIG=~/.config/esp-hub-reader/sdkconfig.service -p /dev/cu.usbmodemXXXX flash
   ```
2. **Wi-Fi:** `python tools/wifi_connect.py НАЗВА_МЕРЕЖІ` (Python з оточення ESP-IDF, у ньому є pyserial). Пароль питається без показу; плата зберігає мережу у своїй пам'яті.
3. **Кореневий сертифікат виробника хаба.** Службова прошивка довіряє лише сертифікатам із `firmware/paa_cert_hub/`. Там лежить `Aqara Matter PAA #01` (SHA-256 `8ab1dc34a8dfd91824b5fb7b7213a419da689c5004cfb8746f4f724ae0bb5845`, звірено з реєстром DCL у листопаді 2026). Для іншого хаба покладіть туди сертифікат його виробника у форматі `.der` (не більше п'яти файлів). Якщо сертифікат не той, плата відмовить у сполученні й надрукує ідентифікатор потрібного.
4. **Сполучення з хабом:** `python tools/hub_pair.py`. Дочекайтеся «Плата готова», згенеруйте в застосунку хаба код сполучення Matter і введіть його. Хаб стає вузлом 2.
5. **Права «лише перегляд».** Поки на платі службова прошивка, надішліть у її консоль (наприклад, через `tools/console_daemon.py`: він пише журнал у файл і шле платі рядки з файла команд):
   ```
   matter esp controller write-attr 2 0 31 0 "{\"0:ARR-OBJ\":[{\"1:U8\": 1, \"2:U8\": 2, \"3:ARR-U64\": [112233], \"4:NULL\": null}]}"
   ```
   Це замінює запис «адміністратор» (рівень 5) для вузла плати (112233) записом «перегляд» (рівень 1). Перевірка: `matter esp controller read-attr 2 0 31 0` тепер має завершитися відмовою `IM:0x0000057E`, а читання температури (`read-attr 2 <ендпоінт> 0x0402 0`) — працювати. Повернути права після цього можна лише заново: прибрати плату в застосунку хаба й сполучити ще раз.
6. **Ключі:** `HOME_URL=https://<назва>.convex.site/home bash reader/tools/setup_token.sh`. Створює у зв'язці ключів macOS ключ звітів і ключ оновлень, записує `HOME_TOKEN` у бойовий Convex і кладе `secrets.h` у `~/.config/esp-hub-reader/secrets/`. Значення ніде не друкуються.
7. **Бойова прошивка** (перший раз кабелем, бо змінюється таблиця розділів):
   ```bash
   cd reader
   idf.py -B ~/.config/esp-hub-reader/build-reader -D SDKCONFIG=~/.config/esp-hub-reader/sdkconfig.reader \
     -D SDKCONFIG_DEFAULTS="../firmware/sdkconfig.defaults;../firmware/sdkconfig.defaults.esp32c6;../firmware/sdkconfig.defaults.nobt;sdkconfig.defaults.reader" \
     set-target esp32c6 build
   idf.py -B ~/.config/esp-hub-reader/build-reader -D SDKCONFIG=~/.config/esp-hub-reader/sdkconfig.reader -p /dev/cu.usbmodemXXXX flash
   ```
   Папки збірки називайте `build-reader…`: `ota_upload.py` без другого аргументу бере найсвіжіший образ із них. Без `erase-flash`: він стер би Wi-Fi і сполучення з хабом.
8. **Далі оновлення по Wi-Fi:** `python3 reader/tools/ota_upload.py АДРЕСА_ПЛАТИ`. Закріпіть за платою адресу на роутері (статична DHCP-ліза).

## Як працює бойова прошивка

- **Підписка** лише на `MeasuredValue` кластерів вимірювання температури (`0x0402`) і вологості (`0x0405`) на будь-якому ендпоінті хаба, інтервал 5–60 с. Після обриву стек відновлює її сам; якщо не вдалося, прошивка створює нову з паузами від 15 с до 5 хв.
- **Звіти:** повний раз на 5 хв; позачерговий, коли температура змінилася на 0,5 °C або вологість на 3 %, але не частіше ніж раз на хвилину. Це близько 17 тис. викликів Convex на місяць.
- **Стабільність:** задача звітів під сторожовим таймером (90 с); перезапуск після 15 хв без Wi-Fi, 30 хв без хаба або 30 хв без вдалого звіту. У кожному звіті плата передає причину останнього перезапуску й найнижчу позначку вільної пам'яті; сайт показує версію прошивки й відколи плата працює.
- **Оновлення по Wi-Fi:** невеликий HTTP-сервер на порту 8080. Завантажувач бере в плати одноразове число й підписує ним розмір і SHA-256 образу (HMAC-SHA256); сам ключ мережею не передається. Після запису плата звіряє SHA-256. Нова прошивка має підтвердити себе першим вдалим звітом зі справними показами; якщо за 10 хв цього не сталося, плата перезапускається, і завантажувач ESP-IDF повертає попередню прошивку. `GET /info` віддає версію, час роботи, пам'ять і активний розділ; `GET /pm` — облік сну.
- **Енергія:** процесор 80 МГц, радіо спить між маяками роутера, журнал лише попереджень. З версії 0.3 увімкнено автоматичний легкий сон: за лічильником самої плати (`GET /pm`) вона спить близько 80 % часу, звіти й підписка при цьому працюють. Перші 20 с після ввімкнення плата не спить. Задум — щоб комп'ютер устиг розпізнати її по USB і сон лишався забороненим, доки кабель під'єднано (`CONFIG_USJ_NO_AUTO_LS_ON_CONNECTION`); чи це працює, не перевірено: після оновлення по Wi-Fi порт USB на комп'ютері не з'явився. Якщо плата спить і порту немає, для запису кабелем увійдіть у завантажувач кнопками: тримайте BOOT, натисніть RESET.
- **Розмір:** образ близько 1,4 МБ у розділі 1,81 МБ. Власний клас підписки замість `subscribe_command` з esp-matter прибрав з образу друк усіх кластерів (близько 0,5 МБ).

## Походження коду

`firmware/` і службові файли `reader/main/linker.lf`, `matter_project_config.h` походять із прикладу `examples/controller` репозиторію [esp-matter](https://github.com/espressif/esp-matter) (Apache-2.0). Тестові сертифікати в `firmware/paa_cert/` звідти ж; сертифікат Aqara — з [connectedhomeip](https://github.com/project-chip/connectedhomeip/tree/master/credentials/production/paa-root-certs).

## English summary

An optional second board for this project: an ESP32-C6 acts as a Matter controller, subscribes to temperature and humidity of a sensor behind a Matter bridge (tested with Aqara Hub M3) and posts readings to the site's `POST /home` endpoint. `firmware/` is the stock esp-matter controller example used once for Wi-Fi setup and pairing; `reader/` is the production firmware with a subscription watchdog, signed over-the-air updates with rollback, and no console or command code. Built with ESP-IDF v5.5.5 and esp-matter `release/v1.5`. Caveat: right after pairing the board holds administrator rights on the hub's fabric; step 5 reduces its ACL entry to View with one console command (verified on Aqara Hub M3: ACL writes and device commands are then rejected, reads and subscriptions keep working).
