# Адреса сайту й ключ плати лежать поза проєктом: файл створює tools/make_secrets.py.
# Для перевірки збірки без справжнього ключа задайте змінну середовища HUB_READER_SECRETS_DIR.
set(SECRETS_DIR "$ENV{HOME}/.config/esp-hub-reader/secrets")
if(DEFINED ENV{HUB_READER_SECRETS_DIR})
    set(SECRETS_DIR "$ENV{HUB_READER_SECRETS_DIR}")
endif()
if(NOT CMAKE_BUILD_EARLY_EXPANSION AND NOT EXISTS "${SECRETS_DIR}/secrets.h")
    message(FATAL_ERROR "Немає ${SECRETS_DIR}/secrets.h. Створіть його: python3 tools/make_secrets.py")
endif()

idf_component_register(SRC_DIRS          "."
                       INCLUDE_DIRS      "." "${SECRETS_DIR}"
                       LDFRAGMENTS "linker.lf")

if(CONFIG_SPIFFS_ATTESTATION_TRUST_STORE)
    # Той самий розділ довірених сертифікатів, що й у службовій прошивці: лише Aqara Matter PAA #01.
    spiffs_create_partition_image(paa_cert ${CMAKE_SOURCE_DIR}/../firmware/paa_cert_hub FLASH_IN_PROJECT)
endif()

target_compile_options(${COMPONENT_LIB} PRIVATE "-DCHIP_HAVE_CONFIG_H")

# Перевірочні збірки (у звичайній роботі ці змінні середовища не задаються):
#   HUB_READER_TEST_INDICATOR — адреса замість справжнього індикатора світла;
#   HUB_READER_FW_VERSION — інша позначка версії, щоб відрізнити перевірочний образ.
if(DEFINED ENV{HUB_READER_TEST_INDICATOR})
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "INDICATOR_IP_TEST=\"$ENV{HUB_READER_TEST_INDICATOR}\"")
endif()
if(DEFINED ENV{HUB_READER_FW_VERSION})
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "FW_VERSION=\"$ENV{HUB_READER_FW_VERSION}\"")
endif()
