idf_component_register(SRC_DIRS          "."
                       INCLUDE_DIRS      "."
                       PRIV_INCLUDE_DIRS  "." "${ESP_MATTER_PATH}/examples/common/utils"
                       LDFRAGMENTS "linker.lf")

if(CONFIG_SPIFFS_ATTESTATION_TRUST_STORE)
    # Сховище довірених кореневих сертифікатів для справжнього хаба: лише Aqara Matter PAA #01 (папка paa_cert_hub).
    # Тестові сертифікати з прикладу лишилися в paa_cert і в цю прошивку не потрапляють.
    spiffs_create_partition_image(paa_cert ${CMAKE_SOURCE_DIR}/paa_cert_hub FLASH_IN_PROJECT)
endif()

target_compile_options(${COMPONENT_LIB} PRIVATE "-DCHIP_HAVE_CONFIG_H")
