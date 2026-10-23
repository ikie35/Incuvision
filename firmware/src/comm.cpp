#include "comm.h"
#include "config.h"
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

static WiFiClient espClient;
static PubSubClient mqttClient(espClient);

CommManager comm;

CommManager::CommManager() {
    lastTelemetryPub = 0;
}

void CommManager::begin() {
    Serial.println("[COMM] Setting up Wi-Fi and MQTT client...");
    setupWiFi();
    mqttClient.setServer(MQTT_BROKER_IP, MQTT_BROKER_PORT);
    mqttClient.setCallback(CommManager::mqttCallback);
}

void CommManager::setupWiFi() {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.printf("[COMM] Connecting to Wi-Fi: %s", WIFI_SSID);

    uint8_t retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 20) {
        delay(500);
        Serial.print(".");
        retries++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\n[COMM] Wi-Fi Connected! IP Address: %s\n", WiFi.localIP().toString().c_str());
    } else {
        Serial.println("\n[COMM] Wi-Fi connection timed out. Serial fallback active.");
    }
}

void CommManager::reconnectMQTT() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    if (!mqttClient.connected()) {
        Serial.print("[COMM] Attempting MQTT connection to ");
        Serial.print(MQTT_BROKER_IP);
        Serial.print("...");

        if (mqttClient.connect(MQTT_CLIENT_ID)) {
            Serial.println(" CONNECTED!");
            mqttClient.subscribe(TOPIC_COMMANDS);
            mqttClient.subscribe(TOPIC_SETPOINTS);
            publishStatus("ESP32_ONLINE");
        } else {
            Serial.printf(" FAILED (rc=%d). Will retry in next cycle.\n", mqttClient.state());
        }
    }
}

void CommManager::loop() {
    if (WiFi.status() == WL_CONNECTED) {
        if (!mqttClient.connected()) {
            static uint32_t lastReconnectAttempt = 0;
            if (millis() - lastReconnectAttempt > 5000) {
                lastReconnectAttempt = millis();
                reconnectMQTT();
            }
        } else {
            mqttClient.loop();
        }
    }

    // Check for incoming commands over Serial port (USB fallback)
    if (Serial.available()) {
        String line = Serial.readStringUntil('\n');
        line.trim();
        if (line.length() > 0) {
            parseCommand(line.c_str());
        }
    }
}

void CommManager::publishTelemetry(const SensorData& sData, const ActuatorState& aState) {
    uint32_t now = millis();
    if (now - lastTelemetryPub < TELEMETRY_PUB_INTERVAL_MS) {
        return;
    }
    lastTelemetryPub = now;

    // Create JSON document
    StaticJsonDocument<512> doc;
    doc["uptime"] = now / 1000;
    doc["temp"] = serialized(String(sData.temperature, 2));
    doc["rh"] = serialized(String(sData.humidity, 1));
    doc["co2"] = sData.co2;
    doc["o2"] = serialized(String(sData.o2, 2));
    
    JsonObject act = doc.createNestedObject("actuators");
    act["heater"] = aState.heater;
    act["exhaust"] = aState.exhaustFan;
    act["circulate"] = aState.circulationFan;
    act["motor"] = aState.eggMotor;
    act["candling"] = aState.candlingLed;
    act["alarm"] = aState.alarmActive;
    act["manual"] = aState.manualOverride;

    doc["phase"] = (actuators.getPhase() == PHASE_SETTING) ? "SETTING" : "HATCHING";
    doc["target_temp"] = serialized(String(actuators.getTargetTemp(), 2));
    doc["target_rh"] = serialized(String(actuators.getTargetRH(), 1));
    doc["target_co2"] = actuators.getTargetCO2();
    doc["next_turn_seconds"] = actuators.getSecondsToNextTurn();

    char buffer[512];
    serializeJson(doc, buffer);

    // Send via Serial (always active)
    Serial.printf("[TELEMETRY] %s\n", buffer);

    // Send via MQTT if connected
    if (mqttClient.connected()) {
        mqttClient.publish(TOPIC_TELEMETRY, buffer);
    }
}

void CommManager::publishStatus(const char* message) {
    if (mqttClient.connected()) {
        mqttClient.publish(TOPIC_STATUS, message);
    }
    Serial.printf("[STATUS] %s\n", message);
}

void CommManager::parseCommand(const char* payload) {
    // 1. Try parsing JSON format first
    StaticJsonDocument<256> doc;
    DeserializationError error = deserializeJson(doc, payload);

    if (!error && doc.containsKey("cmd")) {
        const char* cmd = doc["cmd"];
        Serial.printf("[COMM] Received command: %s\n", cmd);

        if (strcmp(cmd, "SET_RELAY") == 0) {
            const char* act = doc["actuator"] | "";
            bool st = doc["state"] | false;
            actuators.setManualOverride(true);
            actuators.setRelayByName(act, st);
            publishStatus("RELAY_UPDATED");
        }
        else if (strcmp(cmd, "SET_MODE") == 0) {
            const char* mode = doc["mode"] | "AUTO";
            bool manual = (strcmp(mode, "MANUAL") == 0 || strcmp(mode, "manual") == 0);
            actuators.setManualOverride(manual);
            publishStatus(manual ? "MODE_MANUAL" : "MODE_AUTO");
        }
        else if (strcmp(cmd, "CANDLING_ON") == 0 || strcmp(cmd, "START_CANDLING") == 0) {
            actuators.setCandlingLed(true);
            publishStatus("CANDLING_LIGHT_READY");
        } 
        else if (strcmp(cmd, "CANDLING_OFF") == 0 || strcmp(cmd, "STOP_CANDLING") == 0) {
            actuators.setCandlingLed(false);
            publishStatus("CANDLING_LIGHT_OFF");
        }
        else if (strcmp(cmd, "TURN_EGGS") == 0) {
            uint32_t dur = doc["duration"] | 15;
            actuators.triggerEggTurnManual(dur);
            publishStatus("EGG_TURNING_TRIGGERED");
        }
        else if (strcmp(cmd, "SET_PHASE") == 0) {
            const char* phaseStr = doc["phase"] | "SETTING";
            actuators.setManualOverride(false);
            if (strcmp(phaseStr, "HATCHING") == 0) {
                actuators.setPhase(PHASE_HATCHING);
            } else {
                actuators.setPhase(PHASE_SETTING);
            }
            publishStatus("PHASE_UPDATED");
        }
        else if (strcmp(cmd, "SET_DAY") == 0) {
            int d = doc["day"] | 1;
            actuators.setManualOverride(false);
            if (d >= 19) {
                actuators.setPhase(PHASE_HATCHING);
            } else {
                actuators.setPhase(PHASE_SETTING);
            }
            publishStatus("DAY_UPDATED");
        }
        else if (strcmp(cmd, "SET_SETPOINTS") == 0) {
            actuators.setManualOverride(false);
            float t = doc["temp"] | actuators.getTargetTemp();
            float rh = doc["rh"] | actuators.getTargetRH();
            uint16_t co2 = doc["co2"] | actuators.getTargetCO2();
            actuators.setCustomSetpoints(t, rh, co2);
            publishStatus("SETPOINTS_UPDATED");
        }
        return;
    }

    // 2. Plain-text command fallback (sent over USB Serial or raw MQTT)
    String line = String(payload);
    line.trim();
    line.toUpperCase();
    Serial.printf("[COMM] Plain-text command fallback: %s\n", line.c_str());

    if (line == "HEATER ON") {
        actuators.setManualOverride(true);
        actuators.setHeater(true);
        publishStatus("RELAY_UPDATED");
    } else if (line == "HEATER OFF") {
        actuators.setManualOverride(true);
        actuators.setHeater(false);
        publishStatus("RELAY_UPDATED");
    } else if (line == "EXHAUST ON" || line == "FAN ON") {
        actuators.setManualOverride(true);
        actuators.setExhaustFan(true);
        publishStatus("RELAY_UPDATED");
    } else if (line == "EXHAUST OFF" || line == "FAN OFF") {
        actuators.setManualOverride(true);
        actuators.setExhaustFan(false);
        publishStatus("RELAY_UPDATED");
    } else if (line == "TURN ON") {
        actuators.setManualOverride(true);
        actuators.setEggMotor(true);
        publishStatus("RELAY_UPDATED");
    } else if (line == "TURN OFF") {
        actuators.setManualOverride(true);
        actuators.setEggMotor(false);
        publishStatus("RELAY_UPDATED");
    } else if (line == "LED ON") {
        actuators.setCandlingLed(true);
        publishStatus("CANDLING_LIGHT_READY");
    } else if (line == "LED OFF") {
        actuators.setCandlingLed(false);
        publishStatus("CANDLING_LIGHT_OFF");
    } else if (line == "MODE MANUAL" || line == "MANUAL") {
        actuators.setManualOverride(true);
        publishStatus("MODE_MANUAL");
    } else if (line == "MODE AUTO" || line == "AUTO") {
        actuators.setManualOverride(false);
        publishStatus("MODE_AUTO");
    } else if (line.startsWith("DAY ")) {
        int d = line.substring(4).toInt();
        if (d >= 19) {
            actuators.setPhase(PHASE_HATCHING);
        } else if (d >= 1) {
            actuators.setPhase(PHASE_SETTING);
        }
        publishStatus("PHASE_UPDATED");
    } else {
        Serial.printf("[COMM] Unrecognized command: %s\n", line.c_str());
    }
}

void CommManager::mqttCallback(char* topic, byte* payload, unsigned int length) {
    char message[256];
    if (length >= sizeof(message)) {
        length = sizeof(message) - 1;
    }
    memcpy(message, payload, length);
    message[length] = '\0';

    comm.parseCommand(message);
}

