// Підписка на атрибути вузла Matter без журналу значень.
//
// Клас повторює esp_matter::controller::subscribe_command, але не викликає DataModelLogger:
// той тягне в образ розбір і друк усіх кластерів (сотні кілобайтів), а нам потрібні два числа.
// Об'єкт створюється через chip::Platform::New і видаляє себе сам, коли підписка завершилась
// або з'єднатися не вдалося. Усі методи викликаються в задачі CHIP.
#pragma once

#include <app/BufferedReadCallback.h>
#include <app/ReadClient.h>
#include <esp_err.h>
#include <esp_matter.h>
#include <esp_matter_client.h>
#include <lib/support/ScopedBuffer.h>

class hub_subscription : public chip::app::ReadClient::Callback {
public:
    using attribute_cb_t = void (*)(const chip::app::ConcreteDataAttributePath &path, chip::TLV::TLVReader *data);
    /** alive = true: підписку встановлено; false: вона завершилась або не вдалася (об'єкт уже видалено). */
    using state_cb_t = void (*)(bool alive);

    hub_subscription(uint64_t node_id,
                     chip::Platform::ScopedMemoryBufferWithSize<chip::app::AttributePathParams> &&paths,
                     uint16_t min_interval_s, uint16_t max_interval_s, attribute_cb_t on_attribute, state_cb_t on_state);

    /** Починає з'єднання й підписку. У разі помилки повертає її, і об'єкт уже видалено. */
    esp_err_t start();

    void OnAttributeData(const chip::app::ConcreteDataAttributePath &path, chip::TLV::TLVReader *data,
                         const chip::app::StatusIB &status) override;
    void OnError(CHIP_ERROR error) override;
    void OnDeallocatePaths(chip::app::ReadPrepareParams &&params) override {} // шляхи належать цьому об'єкту
    void OnDone(chip::app::ReadClient *client) override;
    void OnSubscriptionEstablished(chip::SubscriptionId id) override;
    CHIP_ERROR OnResubscriptionNeeded(chip::app::ReadClient *client, CHIP_ERROR cause) override;

private:
    static void on_connected(void *context, chip::Messaging::ExchangeManager &exchange_mgr,
                             const chip::SessionHandle &session);
    static void on_connect_failure(void *context, const chip::ScopedNodeId &peer, CHIP_ERROR error);
    void fail();

    uint64_t m_node_id;
    uint16_t m_min_interval_s;
    uint16_t m_max_interval_s;
    uint8_t m_retries = 0;
    chip::app::BufferedReadCallback m_buffered;
    chip::Platform::ScopedMemoryBufferWithSize<chip::app::AttributePathParams> m_paths;
    chip::Callback::Callback<chip::OnDeviceConnected> m_connected_cb;
    chip::Callback::Callback<chip::OnDeviceConnectionFailure> m_failure_cb;
    attribute_cb_t m_on_attribute;
    state_cb_t m_on_state;
};
