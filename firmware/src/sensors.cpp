#include "sensors.h"
#include "config.h"
#include <Wire.h>
#include <DHT.h>
#include <SparkFun_SCD30_Arduino_Library.h>
#include <DFRobot_OxygenSensor.h>

static DHT dht(PIN_DHT22, DHT22);
static SCD30 scd30;
static DFRobot_OxygenSensor oxygen;

SensorManager sensors;

SensorManager::SensorManager() {
    currentData = {0.0f, 0.0f, 0, 0.0f, false, false, false};
}

bool SensorManager::begin() {
    Serial.println("[SENSORS] Initializing I2C bus and sensors...");
    Wire.begin(PIN_SCD30_SDA, PIN_SCD30_SCL);

    // Initialize DHT22
    dht.begin();
    Serial.println("[SENSORS] DHT22 initialized.");

    // Initialize SCD30
    if (scd30.begin(Wire)) {
        scd30.setMeasurementInterval(2); // 2 seconds
        scd30.setAutoSelfCalibration(true);
        Serial.println("[SENSORS] SCD30 CO2 sensor detected and ready.");
        currentData.scd30_valid = true;
    } else {
        Serial.println("[SENSORS] WARNING: SCD30 not detected on I2C bus!");
        currentData.scd30_valid = false;
    }

    // Initialize Oxygen Sensor (I2C or fallback to Analog ADC)
    if (oxygen.begin(ADDRESS_3)) {
        Serial.println("[SENSORS] DFRobot I2C Oxygen sensor initialized.");
        currentData.o2_valid = true;
    } else {
        Serial.println("[SENSORS] Oxygen sensor I2C not found; using GPIO 34 Analog ADC mode.");
        pinMode(PIN_DFROBOT_O2_ADC, INPUT);
        analogReadResolution(12); // ESP32 12-bit ADC
        currentData.o2_valid = true;
    }

    return true;
}

void SensorManager::readDHT22() {
    float h = dht.readHumidity();
    float t = dht.readTemperature();

    if (isnan(h) || isnan(t)) {
        currentData.dht_valid = false;
    } else {
        currentData.dht_valid = true;
        currentData.temperature = t;
        currentData.humidity = h;
    }
}

void SensorManager::readSCD30() {
    if (!currentData.scd30_valid) {
        // Try reconnecting periodically
        if (scd30.begin(Wire)) {
            currentData.scd30_valid = true;
        }
        return;
    }

    if (scd30.dataAvailable()) {
        currentData.co2 = scd30.getCO2();
        // If DHT22 fails, fallback to SCD30's integrated temp/humidity
        if (!currentData.dht_valid) {
            currentData.temperature = scd30.getTemperature();
            currentData.humidity = scd30.getHumidity();
        }
    }
}

void SensorManager::readOxygen() {
    // Attempt reading via DFRobot library first
    float o2Val = oxygen.getOxygenData(10);
    if (o2Val > 0.0f && o2Val <= 30.0f) {
        currentData.o2 = o2Val;
        currentData.o2_valid = true;
        return;
    }

    // Analog ADC Fallback on GPIO 34 (0-3.3V mapping)
    int rawAdc = analogRead(PIN_DFROBOT_O2_ADC);
    float voltage = (rawAdc / 4095.0f) * 3.3f;
    // DFRobot standard calibration: ~1.0V to 2.0V represents 0-25% O2
    float estimatedO2 = (voltage / 2.0f) * 20.9f;
    if (estimatedO2 < 0.0f) estimatedO2 = 0.0f;
    if (estimatedO2 > 25.0f) estimatedO2 = 25.0f;

    currentData.o2 = estimatedO2;
    currentData.o2_valid = true;
}

SensorData SensorManager::readAll() {
    readDHT22();
    readSCD30();
    readOxygen();
    return currentData;
}
