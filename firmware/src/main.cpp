#include <Arduino.h>
#include <esp_task_wdt.h>
#include "config.h"
#include "sensors.h"
#include "actuators.h"
#include "comm.h"

// Task Timing Counters
static unsigned long lastSensorRead = 0;

void setup() {
    // 1. Initialize High-Speed Serial Monitor
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n==================================================");
    Serial.println("   INCUVISION: ESP32 Environmental Controller     ");
    Serial.println("   Firmware Version 1.0.0 (Smart Egg Incubator)  ");
    Serial.println("==================================================");

    // 2. Initialize Actuators & Relays (Safe default states)
    actuators.begin();

    // 3. Initialize Sensors (DHT22, SCD30 CO2, DFRobot O2)
    sensors.begin();

    // 4. Initialize Network & MQTT Communication
    comm.begin();

    // 5. Initialize Hardware Watchdog (15s timeout)
    esp_task_wdt_init(WATCHDOG_TIMEOUT_S, true);
    esp_task_wdt_add(NULL); // Add current loop thread to watchdog monitoring

    Serial.println("[SYSTEM] Setup completed successfully. Entering main control loop.\n");
}

void loop() {
    // Reset watchdog timer
    esp_task_wdt_reset();

    // 1. Handle Communication (MQTT keepalive & command parsing)
    comm.loop();

    // 2. Periodic Sensor Acquisition & Closed-Loop Control
    unsigned long currentMillis = millis();
    if (currentMillis - lastSensorRead >= SENSOR_READ_INTERVAL_MS) {
        lastSensorRead = currentMillis;

        // Read all environmental sensors
        SensorData sData = sensors.readAll();

        // Update heating, ventilation, and turning control loops
        actuators.updateControl(sData);

        // Publish live telemetry over MQTT & Serial
        comm.publishTelemetry(sData, actuators.getState());
    }

    // Small yield to allow ESP32 FreeRTOS background tasks
    delay(10);
}
