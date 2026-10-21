#include <Arduino.h>
#include <esp_task_wdt.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "config.h"
#include "sensors.h"
#include "actuators.h"
#include "comm.h"

static LiquidCrystal_I2C lcd(0x27, 20, 4);
static bool lcdOk = false;
static unsigned long lastSensorRead = 0;

void setup() {
    Serial.begin(115200);
    delay(500);
    actuators.begin();
    sensors.begin();
    comm.begin();

    Wire.beginTransmission(0x27);
    if (Wire.endTransmission() == 0) {
        lcd = LiquidCrystal_I2C(0x27, 20, 4);
        lcdOk = true;
    } else {
        Wire.beginTransmission(0x3F);
        if (Wire.endTransmission() == 0) {
            lcd = LiquidCrystal_I2C(0x3F, 20, 4);
            lcdOk = true;
        }
    }
    if (lcdOk) {
        lcd.init();
        lcd.backlight();
        lcd.clear();
        lcd.setCursor(0, 0);
        lcd.print("IncuVision Ready");
    }

#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
    esp_task_wdt_config_t twdt = {
        .timeout_ms = WATCHDOG_TIMEOUT_S * 1000,
        .idle_core_mask = 0,
        .trigger_panic = true
    };
    if (esp_task_wdt_init(&twdt) == ESP_ERR_INVALID_STATE) {
        esp_task_wdt_reconfigure(&twdt);
    }
#else
    esp_task_wdt_init(WATCHDOG_TIMEOUT_S, true);
#endif
    esp_task_wdt_add(NULL);
}

void loop() {
    esp_task_wdt_reset();
    comm.loop();

    unsigned long now = millis();
    if (now - lastSensorRead >= SENSOR_READ_INTERVAL_MS) {
        lastSensorRead = now;

        SensorData s = sensors.readAll();
        actuators.updateControl(s);
        comm.publishTelemetry(s, actuators.getState());

        if (lcdOk) {
            char b[21];
            lcd.setCursor(0, 0);
            snprintf(b, sizeof(b), "T:%4.1fC  RH:%4.1f%%   ", s.temperature, s.humidity);
            lcd.print(b);

            lcd.setCursor(0, 1);
            snprintf(b, sizeof(b), "CO2:%4d O2:%4.1f%% ", s.co2, s.o2);
            lcd.print(b);

            lcd.setCursor(0, 2);
            snprintf(b, sizeof(b), "%-8s Tgt:%4.1fC ", 
                (actuators.getPhase() == PHASE_SETTING) ? "SETTING" : "HATCH", 
                actuators.getTargetTemp());
            lcd.print(b);

            lcd.setCursor(0, 3);
            const ActuatorState& st = actuators.getState();
            snprintf(b, sizeof(b), "Turn:%-4s Light:%-3s", 
                st.eggMotor ? "RUN " : "WAIT", 
                st.candlingLed ? "ON " : "OFF");
            lcd.print(b);
        }
    }
    delay(10);
}
