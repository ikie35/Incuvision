#ifndef INCUVISION_SENSORS_H
#define INCUVISION_SENSORS_H

#include <Arduino.h>

struct SensorData {
    float temperature;   // Filtered Temperature (°C)
    float humidity;      // Relative Humidity (%)
    uint16_t co2;        // CO2 concentration (ppm)
    float o2;            // Oxygen concentration (%)
    bool dht_valid;
    bool scd30_valid;
    bool o2_valid;
};

class SensorManager {
public:
    SensorManager();
    bool begin();
    SensorData readAll();
    const SensorData& getLastData() const { return currentData; }

private:
    SensorData currentData;
    void readDHT22();
    void readSCD30();
    void readOxygen();
};

extern SensorManager sensors;

#endif // INCUVISION_SENSORS_H
