#ifndef INCUVISION_COMM_H
#define INCUVISION_COMM_H

#include <Arduino.h>
#include "sensors.h"
#include "actuators.h"

class CommManager {
public:
    CommManager();
    void begin();
    void loop();
    
    void publishTelemetry(const SensorData& sData, const ActuatorState& aState);
    void publishStatus(const char* message);
    
    // Command Parser (handles MQTT & Serial JSON)
    void parseCommand(const char* payload);

private:
    uint32_t lastTelemetryPub;
    void setupWiFi();
    void reconnectMQTT();
    static void mqttCallback(char* topic, byte* payload, unsigned int length);
};

extern CommManager comm;

#endif // INCUVISION_COMM_H
