#ifndef INCUVISION_CONFIG_H
#define INCUVISION_CONFIG_H

#include <Arduino.h>

// ==========================================
// 1. PIN DEFINITIONS (ESP32 NodeMCU-32S)
// ==========================================

// Sensors
#define PIN_DHT22             4     // DHT22 Temperature & Humidity (Single-wire)
#define PIN_SCD30_SDA        21     // SCD30 CO2 I2C Data
#define PIN_SCD30_SCL        22     // SCD30 CO2 I2C Clock
#define PIN_DFROBOT_O2_ADC   34     // DFRobot Oxygen Analog Input (ADC1_CH6)

// Actuators (Relay Module: Active LOW)
#define PIN_RELAY_HEATER     18     // PTC Heating Element
#define PIN_RELAY_EXHAUST    19     // 12V DC Exhaust Fan
#define PIN_RELAY_CIRCULATE  23     // AC Internal Circulation Fan
#define PIN_RELAY_MOTOR      25     // Kinematic Egg Turning AC Motor
#define PIN_RELAY_CANDLING   26     // High-Intensity Candling LED Array

// Indicators & Alarms
#define PIN_BUZZER           27     // Warning Buzzer / Alarm
#define PIN_STATUS_LED        2     // On-board Status LED (GPIO 2)

// ==========================================
// 2. NETWORK & MQTT CONFIGURATION
// ==========================================
#define WIFI_SSID            "IncuVision_AP"
#define WIFI_PASSWORD        "incubator2026"
#define MQTT_BROKER_IP       "192.168.4.1"   // IP of Raspberry Pi 5
#define MQTT_BROKER_PORT     1883
#define MQTT_CLIENT_ID       "IncuVision_ESP32"

// MQTT Topics
#define TOPIC_TELEMETRY      "incuvision/telemetry"
#define TOPIC_COMMANDS       "incuvision/commands"
#define TOPIC_STATUS         "incuvision/status"
#define TOPIC_SETPOINTS      "incuvision/setpoints"

// ==========================================
// 3. DEFAULT INCUBATION SETPOINTS
// ==========================================
// Setting Phase (Days 1–18)
#define DEFAULT_TEMP_SETTING       37.5f  // °C
#define DEFAULT_RH_SETTING         58.0f  // %
#define DEFAULT_CO2_MAX_SETTING    5000   // ppm (0.5%)
#define DEFAULT_O2_MIN_SETTING     20.5f  // %
#define DEFAULT_TURNING_INTERVAL_S 3600   // 60 minutes
#define DEFAULT_TURNING_DURATION_S 15     // 15 seconds motor run duration

// Hatching Phase (Days 19–21)
#define DEFAULT_TEMP_HATCHING      36.9f  // °C
#define DEFAULT_RH_HATCHING        70.0f  // % (66-75%)
#define DEFAULT_CO2_MAX_HATCHING   7500   // ppm (0.75%)

// Safety Limits
#define CRITICAL_TEMP_MAX          39.5f  // Hard cutoff & alarm
#define CRITICAL_TEMP_MIN          35.0f  // Alarm

// ==========================================
// 4. TIMING & INTERVALS (ms)
// ==========================================
#define SENSOR_READ_INTERVAL_MS    2000   // Read sensors every 2 sec
#define TELEMETRY_PUB_INTERVAL_MS  5000   // Publish MQTT telemetry every 5 sec
#define WATCHDOG_TIMEOUT_S         15     // Hardware watchdog timeout

#endif // INCUVISION_CONFIG_H
