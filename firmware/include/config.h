#ifndef INCUVISION_CONFIG_H
#define INCUVISION_CONFIG_H

#include <Arduino.h>

// ==========================================
// 1. PIN DEFINITIONS (ESP32 NodeMCU-32S)
// ==========================================

// Sensors
#define PIN_DHT22            13     // DHT22 Temperature & Humidity (Single-wire)
#define PIN_I2C_SDA          21     // SCD30 CO2 + O2 + LCD I2C Data
#define PIN_I2C_SCL          22     // SCD30 CO2 + O2 + LCD I2C Clock

// Actuators (Relay Module: Active LOW)
#define PIN_RELAY_MOTOR      25     // Kinematic Egg Turning AC Motor
#define PIN_RELAY_EXHAUST    27     // 12V DC Exhaust Fan
#define PIN_RELAY_CANDLING   26     // High-Intensity Candling LED Array
#define PIN_RELAY_HEATER     14     // PTC Heating Element
// Circulation fan is continuously powered (not relay controlled)

// Relay logic polarity (Active LOW for standard ESP32 4-channel relay modules)
#define RELAY_ACTIVE_LEVEL   LOW    // LOW = Energized (ON)
#define RELAY_INACTIVE_LEVEL HIGH   // HIGH = De-energized (OFF)

// Indicators & Alarms
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
// 3. INCUBATION SETTINGS (OPERATOR OPTIMIZED)
// ==========================================
#define SETTING_START_DAY          1
#define SETTING_END_DAY            18

#define DEFAULT_TEMP_SETTING       37.5f  // °C Target center
#define DEFAULT_RH_SETTING         58.0f  // % Target center
#define DEFAULT_CO2_MAX_SETTING    5000   // ppm
#define DEFAULT_O2_MIN_SETTING     21.0f  // %

#define HATCHING_START_DAY         19
#define HATCHING_END_DAY           21

#define DEFAULT_TEMP_HATCHING      36.9f  // °C Target center
#define DEFAULT_RH_HATCHING        70.0f  // % Target center
#define DEFAULT_CO2_MAX_HATCHING   7500   // ppm
#define DEFAULT_O2_MIN_HATCHING    21.0f  // %

// Precision Hysteresis Temperature Bands (Cutoff at target to prevent residual overshoot)
#define SET_TEMP_CONTROL_LOW       37.3f  // °C (Heater turns ON below this)
#define SET_TEMP_CONTROL_HIGH      37.5f  // °C (Heater turns OFF at target)

#define HATCH_TEMP_CONTROL_LOW     36.7f  // °C (Heater turns ON below this)
#define HATCH_TEMP_CONTROL_HIGH    36.9f  // °C (Heater turns OFF at target)

// Humidity Control Bands
#define SET_HUMIDITY_LOW           56.0f  // %
#define SET_HUMIDITY_HIGH          60.0f  // % (Exhaust vents if above this)

#define HATCH_HUMIDITY_LOW         66.0f  // %
#define HATCH_HUMIDITY_HIGH        75.0f  // % (Exhaust vents if above this)

// Safety Cutoff Limits
#define CRITICAL_TEMP_MAX          38.0f  // Hard cutoff & exhaust alarm (forces revert from MANUAL to AUTO)
#define CRITICAL_TEMP_MIN          35.0f  // Alarm

// ==========================================
// 4. TIMING SETTINGS
// ==========================================
#define SENSOR_READ_INTERVAL_MS    2000UL // Read sensors every 2 sec
#define TELEMETRY_PUB_INTERVAL_MS  5000UL // Publish telemetry every 5 sec
#define WATCHDOG_TIMEOUT_S         15     // Hardware watchdog timeout
#define STARTUP_WARMUP_TIME_MS     (10UL * 60UL * 1000UL) // 10 minutes warmup

// Anti-Overshoot Heating Limit (Burst window)
#define PERSIST_TIME_MS            10000UL // 10 seconds max continuous heating to prevent thermal runaway

// Egg Turning Timing
#define DEFAULT_TURNING_INTERVAL_S 3600UL // 1 hour between turns
#define DEFAULT_TURNING_DURATION_S 15UL   // 15 seconds motor run duration
#define DEFAULT_TURNING_DURATION_MS (DEFAULT_TURNING_DURATION_S * 1000UL)
#define DEFAULT_TURNING_INTERVAL_MS (DEFAULT_TURNING_INTERVAL_S * 1000UL)

// Compatibility aliases for sensors.cpp
#define PIN_SCD30_SDA       PIN_I2C_SDA
#define PIN_SCD30_SCL       PIN_I2C_SCL
#define PIN_DFROBOT_O2_ADC  34

// ==========================================
// 5. SENSOR CALIBRATION OFFSETS
// ==========================================
#define DHT_TEMP_OFFSET_C   (+0.3f)   // +0.3°C operator calibration offset for DHT22
#define DHT_RH_OFFSET_PCT   (-5.5f)   // -5.5% RH operator calibration offset for DHT22

#endif // INCUVISION_CONFIG_H


