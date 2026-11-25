#include "hub_subscription.h"

#include <esp_log.h>
#include <esp_matter_controller_client.h>

static const char *TAG = "hub_sub";

// Стільки разів поспіль стек сам пробує відновити підписку (з дедалі довшими паузами);
// далі вона завершується, і нову створює задача звітів.
static const uint8_t MAX_RESUBSCRIBE_RETRIES = 4;

hub_subscription::hub_subscription(uint64_t node_id,
                                   chip::Platform::ScopedMemoryBufferWithSize<chip::app::AttributePathParams> &&paths,
                                   uint16_t min_interval_s, uint16_t max_interval_s, attribute_cb_t on_attribute,
                                   state_cb_t on_state)
    : m_node_id(node_id)
    , m_min_interval_s(min_interval_s)
    , m_max_interval_s(max_interval_s)
    , m_buffered(*this)
    , m_paths(std::move(paths))
    , m_connected_cb(on_connected, this)
    , m_failure_cb(on_connect_failure, this)
    , m_on_attribute(on_attribute)
    , m_on_state(on_state)
{
}

void hub_subscription::fail()
{
    state_cb_t on_state = m_on_state;
    chip::Platform::Delete(this);
    if (on_state) {
        on_state(false);
    }
}

esp_err_t hub_subscription::start()
{
    auto &controller = esp_matter::controller::matter_controller_client::get_instance();
    if (controller.get_commissioner()->GetConnectedDevice(m_node_id, &m_connected_cb, &m_failure_cb) == CHIP_NO_ERROR) {
        return ESP_OK;
    }
    fail();
    return ESP_FAIL;
}

void hub_subscription::on_connected(void *context, chip::Messaging::ExchangeManager &exchange_mgr,
                                    const chip::SessionHandle &session)
{
    hub_subscription *self = static_cast<hub_subscription *>(context);
    chip::OperationalDeviceProxy device(&exchange_mgr, session);
    // keep_subscription = false: попередні підписки цієї плати на вузлі закриваються;
    // auto_resubscribe = true: після обриву стек пробує відновити сам (OnResubscriptionNeeded).
    esp_err_t err = esp_matter::client::interaction::subscribe::send_request(
        &device, self->m_paths.Get(), self->m_paths.AllocatedSize(), nullptr, 0, self->m_min_interval_s,
        self->m_max_interval_s, false, true, self->m_buffered);
    if (err != ESP_OK) {
        self->fail();
    }
}

void hub_subscription::on_connect_failure(void *context, const chip::ScopedNodeId &peer, CHIP_ERROR error)
{
    ESP_LOGW(TAG, "з'єднання з вузлом не вдалося: %" CHIP_ERROR_FORMAT, error.Format());
    static_cast<hub_subscription *>(context)->fail();
}

void hub_subscription::OnAttributeData(const chip::app::ConcreteDataAttributePath &path, chip::TLV::TLVReader *data,
                                       const chip::app::StatusIB &status)
{
    if (status.ToChipError() != CHIP_NO_ERROR || data == nullptr) {
        return;
    }
    if (m_on_attribute) {
        m_on_attribute(path, data);
    }
}

void hub_subscription::OnError(CHIP_ERROR error)
{
    ESP_LOGW(TAG, "помилка підписки: %" CHIP_ERROR_FORMAT, error.Format());
}

void hub_subscription::OnSubscriptionEstablished(chip::SubscriptionId id)
{
    m_retries = 0;
    if (m_on_state) {
        m_on_state(true);
    }
}

CHIP_ERROR hub_subscription::OnResubscriptionNeeded(chip::app::ReadClient *client, CHIP_ERROR cause)
{
    if (++m_retries > MAX_RESUBSCRIBE_RETRIES) {
        return cause; // підписка завершиться через OnDone
    }
    return client->DefaultResubscribePolicy(cause);
}

void hub_subscription::OnDone(chip::app::ReadClient *client)
{
    // Сам ReadClient звільняє обгортка esp_matter одразу після цього виклику.
    fail();
}
