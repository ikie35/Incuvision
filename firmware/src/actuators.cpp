#include "actuators.h"
#include "config.h"

ActuatorManager actuators;

ActuatorManager::ActuatorManager() {
    state = {false, false, false, false, false, false, false};
    currentPhase = PHASE_SETTING;
    manualOverride = false;
    targetTemp = DEFAULT_TEMP_SETTING;
    targetRH = DEFAULT_RH_SETTING;
    targetCO2 = DEFAULT_CO2_MAX_SETTING;
    
    lastTurnTimestamp = 0;
    isTurningNow = false;
    turnStartTimestamp = 0;
    turnDurationMs = DEFAULT_TURNING_DURATION_S * 1000;
}

void ActuatorManager::begin() {
    Serial.println("[ACTUATORS] Initializing Relay GPIO outputs...");
    pinMode(PIN_RELAY_HEATER, OUTPUT);
    pinMode(PIN_RELAY_EXHAUST, OUTPUT);
    pinMode(PIN_RELAY_CIRCULATE, OUTPUT);
    pinMode(PIN_RELAY_MOTOR, OUTPUT);
    pinMode(PIN_RELAY_CANDLING, OUTPUT);
    pinMode(PIN_BUZZER, OUTPUT);
    pinMode(PIN_STATUS_LED, OUTPUT);

    // Relays are Active LOW: turn all OFF initially (HIGH = OFF)
    setRelay(PIN_RELAY_HEATER, false);
    setRelay(PIN_RELAY_EXHAUST, false);
    setRelay(PIN_RELAY_CIRCULATE, true);  // Circulation fan runs continuously by default
    setRelay(PIN_RELAY_MOTOR, false);
    setRelay(PIN_RELAY_CANDLING, false);
    
    digitalWrite(PIN_BUZZER, LOW);
    digitalWrite(PIN_STATUS_LED, HIGH);

    lastTurnTimestamp = millis();
}

void ActuatorManager::setRelay(uint8_t pin, bool active) {
    // Active LOW relay boards: LOW = Energized (ON), HIGH = De-energized (OFF)
    digitalWrite(pin, active ? LOW : HIGH);
}

void ActuatorManager::processHeating(float currentTemp) {
    // Critical Overheat Hard Failsafe
    if (currentTemp >= CRITICAL_TEMP_MAX) {
        setRelay(PIN_RELAY_HEATER, false);
        state.heater = false;
        
        // Turn ON Exhaust Fan immediately to vent excess heat
        setRelay(PIN_RELAY_EXHAUST, true);
        state.exhaustFan = true;

        // Sound emergency alarm
        digitalWrite(PIN_BUZZER, HIGH);
        state.alarmActive = true;
        return;
    }

    // Critical Under-temperature Alarm
    if (currentTemp <= CRITICAL_TEMP_MIN && currentTemp > 5.0f) {
        digitalWrite(PIN_BUZZER, HIGH);
        state.alarmActive = true;
    } else {
        digitalWrite(PIN_BUZZER, LOW);
        state.alarmActive = false;
    }

    // Precision Hysteresis Thermal Controller (0.15°C Deadband)
    const float HYSTERESIS = 0.15f;
    if (currentTemp < (targetTemp - HYSTERESIS)) {
        setRelay(PIN_RELAY_HEATER, true);
        state.heater = true;
    } else if (currentTemp >= targetTemp) {
        setRelay(PIN_RELAY_HEATER, false);
        state.heater = false;
    }
}

void ActuatorManager::processVentilation(uint16_t currentCO2, float currentO2, float currentTemp) {
    // If exhaust fan is already forced ON due to overheat, do not turn off
    if (currentTemp >= CRITICAL_TEMP_MAX) {
        setRelay(PIN_RELAY_EXHAUST, true);
        state.exhaustFan = true;
        return;
    }

    // Ventilation triggers:
    // 1. CO2 exceeds threshold (> 5000 ppm in Setting, > 7500 ppm in Hatching)
    // 2. O2 drops below 20.5%
    // 3. Mild over-temperature (> targetTemp + 0.5°C)
    bool needVentilation = (currentCO2 > targetCO2) || 
                           (currentO2 > 0.0f && currentO2 < DEFAULT_O2_MIN_SETTING) ||
                           (currentTemp > (targetTemp + 0.5f));

    if (needVentilation) {
        setRelay(PIN_RELAY_EXHAUST, true);
        state.exhaustFan = true;
    } else {
        setRelay(PIN_RELAY_EXHAUST, false);
        state.exhaustFan = false;
    }
}

void ActuatorManager::processEggTurning() {
    // In Hatching Phase (Days 19-21), egg turning is strictly disabled
    if (currentPhase == PHASE_HATCHING) {
        if (isTurningNow) {
            setRelay(PIN_RELAY_MOTOR, false);
            isTurningNow = false;
            state.eggMotor = false;
        }
        return;
    }

    uint32_t now = millis();

    // Check if active turning duration has elapsed
    if (isTurningNow) {
        if (now - turnStartTimestamp >= turnDurationMs) {
            setRelay(PIN_RELAY_MOTOR, false);
            isTurningNow = false;
            state.eggMotor = false;
            lastTurnTimestamp = now;
            Serial.println("[ACTUATORS] Egg turning cycle complete.");
        }
        return;
    }

    // Check if interval has elapsed (Hourly 45° tilt)
    if (now - lastTurnTimestamp >= (DEFAULT_TURNING_INTERVAL_S * 1000UL)) {
        Serial.println("[ACTUATORS] Triggering hourly egg turning cycle...");
        triggerEggTurnManual(DEFAULT_TURNING_DURATION_S);
    }
}

void ActuatorManager::updateControl(const SensorData& data) {
    // Always keep circulation fan running for uniform temperature
    setRelay(PIN_RELAY_CIRCULATE, true);
    state.circulationFan = true;

    // In manual override mode, do not let automatic loops overwrite relay states
    if (manualOverride) {
        return;
    }

    if (data.temperature > 5.0f && data.temperature < 60.0f) {
        processHeating(data.temperature);
    }
    
    processVentilation(data.co2, data.o2, data.temperature);
    processEggTurning();
}

void ActuatorManager::setHeater(bool active) {
    setRelay(PIN_RELAY_HEATER, active);
    state.heater = active;
    Serial.printf("[ACTUATORS] PTC Heater relay: %s\n", active ? "ON" : "OFF");
}

void ActuatorManager::setExhaustFan(bool active) {
    setRelay(PIN_RELAY_EXHAUST, active);
    state.exhaustFan = active;
    Serial.printf("[ACTUATORS] Exhaust Fan relay: %s\n", active ? "ON" : "OFF");
}

void ActuatorManager::setEggMotor(bool active) {
    setRelay(PIN_RELAY_MOTOR, active);
    state.eggMotor = active;
    isTurningNow = active;
    if (active) turnStartTimestamp = millis();
    Serial.printf("[ACTUATORS] Egg Turner relay: %s\n", active ? "ON" : "OFF");
}

void ActuatorManager::setCandlingLed(bool active) {
    setRelay(PIN_RELAY_CANDLING, active);
    state.candlingLed = active;
    Serial.printf("[ACTUATORS] Candling LED array: %s\n", active ? "ON" : "OFF");
}

void ActuatorManager::setRelayByName(const char* name, bool active) {
    if (strcmp(name, "heater") == 0) {
        setHeater(active);
    } else if (strcmp(name, "exhaust") == 0 || strcmp(name, "fan") == 0) {
        setExhaustFan(active);
    } else if (strcmp(name, "motor") == 0 || strcmp(name, "turner") == 0) {
        setEggMotor(active);
    } else if (strcmp(name, "candling") == 0 || strcmp(name, "led") == 0) {
        setCandlingLed(active);
    } else if (strcmp(name, "circulate") == 0) {
        setRelay(PIN_RELAY_CIRCULATE, active);
        state.circulationFan = active;
    } else {
        Serial.printf("[ACTUATORS] Unknown relay identifier: %s\n", name);
    }
}

void ActuatorManager::triggerEggTurnManual(uint32_t durationSec) {
    turnDurationMs = durationSec * 1000;
    turnStartTimestamp = millis();
    isTurningNow = true;
    setRelay(PIN_RELAY_MOTOR, true);
    state.eggMotor = true;
    Serial.printf("[ACTUATORS] Egg turning motor activated for %u seconds.\n", durationSec);
}

void ActuatorManager::setPhase(IncubationPhase phase) {
    currentPhase = phase;
    if (phase == PHASE_SETTING) {
        targetTemp = DEFAULT_TEMP_SETTING;
        targetRH = DEFAULT_RH_SETTING;
        targetCO2 = DEFAULT_CO2_MAX_SETTING;
        Serial.println("[ACTUATORS] Phase set to: SETTING (Days 1–18)");
    } else {
        targetTemp = DEFAULT_TEMP_HATCHING;
        targetRH = DEFAULT_RH_HATCHING;
        targetCO2 = DEFAULT_CO2_MAX_HATCHING;
        // Stop turning immediately
        setRelay(PIN_RELAY_MOTOR, false);
        isTurningNow = false;
        state.eggMotor = false;
        Serial.println("[ACTUATORS] Phase set to: HATCHING (Days 19–21)");
    }
}

void ActuatorManager::setCustomSetpoints(float temp, float rh, uint16_t co2) {
    if (temp > 30.0f && temp < 40.0f) targetTemp = temp;
    if (rh > 30.0f && rh < 95.0f) targetRH = rh;
    if (co2 >= 1000 && co2 <= 10000) targetCO2 = co2;
    Serial.printf("[ACTUATORS] Custom setpoints applied: Temp=%.1f°C, RH=%.1f%%, CO2=%u ppm\n", targetTemp, targetRH, targetCO2);
}
