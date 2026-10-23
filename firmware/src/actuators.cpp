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
    
    heaterStartTimestamp = 0;
    heaterBurstActive = false;
    heaterRestTimestamp = 0;

    lastTurnTimestamp = 0;
    isTurningNow = false;
    turnStartTimestamp = 0;
    turnDurationMs = DEFAULT_TURNING_DURATION_S * 1000;
}

void ActuatorManager::begin() {
    Serial.println("[ACTUATORS] Initializing Relay GPIO outputs...");
    pinMode(PIN_RELAY_HEATER, OUTPUT);
    pinMode(PIN_RELAY_EXHAUST, OUTPUT);
    pinMode(PIN_RELAY_MOTOR, OUTPUT);
    pinMode(PIN_RELAY_CANDLING, OUTPUT);
    pinMode(PIN_STATUS_LED, OUTPUT);

    // Relays are Active LOW: turn all OFF initially (HIGH = OFF)
    setRelay(PIN_RELAY_HEATER, false);
    setRelay(PIN_RELAY_EXHAUST, false);
    setRelay(PIN_RELAY_MOTOR, false);
    setRelay(PIN_RELAY_CANDLING, false);
    
    digitalWrite(PIN_STATUS_LED, HIGH);

    lastTurnTimestamp = millis();
}

void ActuatorManager::setRelay(uint8_t pin, bool active) {
    // Active LOW relay boards: LOW = Energized (ON), HIGH = De-energized (OFF)
    digitalWrite(pin, active ? RELAY_ACTIVE_LEVEL : RELAY_INACTIVE_LEVEL);
}

void ActuatorManager::processHeating(float currentTemp) {
    // 1. Critical Overheat Hard Failsafe
    if (currentTemp >= CRITICAL_TEMP_MAX) {
        setRelay(PIN_RELAY_HEATER, false);
        state.heater = false;
        heaterBurstActive = false;
        
        // Turn ON Exhaust Fan immediately to vent excess heat
        setRelay(PIN_RELAY_EXHAUST, true);
        state.exhaustFan = true;
        state.alarmActive = true;
        return;
    }

    // Critical Under-temperature Alarm
    if (currentTemp <= CRITICAL_TEMP_MIN && currentTemp > 5.0f) {
        state.alarmActive = true;
    } else {
        state.alarmActive = false;
    }

    // Dynamic precision hysteresis: heat when below targetTemp (with tiny 0.05°C buffer), cutoff at targetTemp + 0.2°C
    float lowThreshold  = targetTemp - 0.05f;
    float highThreshold = targetTemp + 0.2f;

    uint32_t now = millis();

    // 2. High threshold cutoff: shut OFF immediately once temperature hits high band
    if (currentTemp >= highThreshold) {
        if (state.heater) {
            setRelay(PIN_RELAY_HEATER, false);
            state.heater = false;
            heaterBurstActive = false;
            heaterRestTimestamp = now;
        }
        return;
    }

    // 3. 10-second persist heating burst (prevents thermal runaway / overshoot)
    if (heaterBurstActive) {
        if (now - heaterStartTimestamp >= PERSIST_TIME_MS) {
            // Cut off heater after 10 seconds to allow the fan to circulate the heat
            setRelay(PIN_RELAY_HEATER, false);
            state.heater = false;
            heaterBurstActive = false;
            heaterRestTimestamp = now;
            Serial.println("[ACTUATORS] 10s Heat burst elapsed. Pausing for circulation dissipation.");
        }
        return;
    }

    // 4. Low threshold trigger: activate heater if temperature is below low limit and rested
    if (currentTemp < lowThreshold) {
        const uint32_t MIN_REST_TIME_MS = 5000UL; // 5s rest between bursts for sensor stabilization
        if (now - heaterRestTimestamp >= MIN_REST_TIME_MS) {
            setRelay(PIN_RELAY_HEATER, true);
            state.heater = true;
            heaterBurstActive = true;
            heaterStartTimestamp = now;
            Serial.printf("[ACTUATORS] Temp (%.2f C) < Low (%.2f C). Heating for up to 10s...\n", currentTemp, lowThreshold);
        }
    }
}

void ActuatorManager::processVentilation(uint16_t currentCO2, float currentO2, float currentTemp, float currentRH) {
    // If exhaust fan is already forced ON due to overheat, do not turn off
    if (currentTemp >= CRITICAL_TEMP_MAX) {
        setRelay(PIN_RELAY_EXHAUST, true);
        state.exhaustFan = true;
        return;
    }

    float maxRH = (currentPhase == PHASE_SETTING) ? (targetRH + 2.0f) : (targetRH + 5.0f);

    // Ventilation triggers:
    // 1. CO2 exceeds threshold (> 5000 ppm in Setting, > 7500 ppm in Hatching)
    // 2. O2 drops below 21.0%
    // 3. Mild over-temperature (> targetTemp + 0.5°C)
    // 4. Relative humidity exceeds high target (> 60% in Setting, > 75% in Hatching)
    bool needVentilation = (currentCO2 > targetCO2) || 
                           (currentO2 > 0.0f && currentO2 < DEFAULT_O2_MIN_SETTING) ||
                           (currentTemp > (targetTemp + 0.5f)) ||
                           (currentRH > maxRH);

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

    // Check if active turning duration has elapsed (always runs to prevent motor burn)
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

    // In manual override mode, do not automatically trigger hourly cycle
    if (manualOverride) {
        return;
    }

    // Check if interval has elapsed (Hourly 45° tilt)
    if (now - lastTurnTimestamp >= (DEFAULT_TURNING_INTERVAL_S * 1000UL)) {
        Serial.println("[ACTUATORS] Triggering hourly egg turning cycle...");
        triggerEggTurnManual(DEFAULT_TURNING_DURATION_S);
    }
}

void ActuatorManager::updateControl(const SensorData& data) {
    // Circulation fan is continuously powered on 12V/AC rail
    state.circulationFan = true;

    // Process egg turning duration monitoring regardless of manual override
    processEggTurning();

    // In manual override mode, do not let automatic loops overwrite heater/exhaust states
    if (manualOverride) {
        return;
    }

    if (data.temperature > 5.0f && data.temperature < 60.0f) {
        processHeating(data.temperature);
    }
    
    processVentilation(data.co2, data.o2, data.temperature, data.humidity);
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
    } else {
        Serial.printf("[ACTUATORS] Unknown relay identifier: %s\n", name);
    }
}

void ActuatorManager::triggerEggTurnManual(uint32_t durationSec) {
    if (currentPhase == PHASE_HATCHING) {
        Serial.println("[ACTUATORS] Egg turning blocked: In HATCHING phase.");
        return;
    }
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
        Serial.println("[ACTUATORS] Phase set to: SETTING (Days 1â€“18)");
    } else {
        targetTemp = DEFAULT_TEMP_HATCHING;
        targetRH = DEFAULT_RH_HATCHING;
        targetCO2 = DEFAULT_CO2_MAX_HATCHING;
        // Stop turning immediately
        setRelay(PIN_RELAY_MOTOR, false);
        isTurningNow = false;
        state.eggMotor = false;
        Serial.println("[ACTUATORS] Phase set to: HATCHING (Days 19â€“21)");
    }
}

void ActuatorManager::setCustomSetpoints(float temp, float rh, uint16_t co2) {
    if (temp > 30.0f && temp < 40.0f) targetTemp = temp;
    if (rh > 30.0f && rh < 95.0f) targetRH = rh;
    if (co2 >= 1000 && co2 <= 10000) targetCO2 = co2;
    Serial.printf("[ACTUATORS] Custom setpoints applied: Temp=%.1fÂ°C, RH=%.1f%%, CO2=%u ppm\n", targetTemp, targetRH, targetCO2);
}

uint32_t ActuatorManager::getSecondsToNextTurn() const {
    if (currentPhase == PHASE_HATCHING) return 0;
    if (isTurningNow) return 0;
    uint32_t elapsed = (millis() - lastTurnTimestamp) / 1000UL;
    if (elapsed >= DEFAULT_TURNING_INTERVAL_S) return 0;
    return DEFAULT_TURNING_INTERVAL_S - elapsed;
}
