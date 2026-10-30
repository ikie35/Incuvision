#include "actuators.h"
#include "config.h"
#include <time.h>

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
    lastTurnedHour = -1;
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

    // Dynamic precision hysteresis (Temperature Priority):
    // lowThreshold  = targetTemp - 0.15°C (Heater turns ON below this)
    // highThreshold = targetTemp          (Heater turns OFF once target is reached)
    float lowThreshold  = targetTemp - 0.15f;
    float highThreshold = targetTemp;

    // 2. High threshold cutoff: shut OFF immediately once target temperature is reached
    if (currentTemp >= highThreshold) {
        if (state.heater) {
            setRelay(PIN_RELAY_HEATER, false);
            state.heater = false;
            heaterBurstActive = false;
            Serial.printf("[ACTUATORS] Target reached (%.2f C >= %.2f C). Heater OFF.\n", currentTemp, highThreshold);
        }
        return;
    }

    // 3. Strict Temperature Priority: whenever below target thresholds, ensure heater is ON until targetTemp is reached
    if (currentTemp < lowThreshold || (state.heater && currentTemp < highThreshold)) {
        if (!state.heater) {
            setRelay(PIN_RELAY_HEATER, true);
            state.heater = true;
            heaterBurstActive = true;
            Serial.printf("[ACTUATORS] Temp (%.2f C) < Low (%.2f C). Heater ON until %.2f C.\n", currentTemp, lowThreshold, highThreshold);
        }
    }
}

void ActuatorManager::processVentilation(uint16_t currentCO2, float currentO2, float currentTemp, float currentRH) {
    // CO2 sensor is malfunctioning / unreliable; disregard currentCO2 in actuator decisions
    (void)currentCO2;

    // 1. Critical Overheat Hard Failsafe: always force exhaust ON if overheating
    if (currentTemp >= CRITICAL_TEMP_MAX) {
        setRelay(PIN_RELAY_EXHAUST, true);
        state.exhaustFan = true;
        return;
    }

    // 2. STRICT TEMPERATURE PRIORITY INTERLOCK:
    // If temperature is anywhere below targetTemp OR the PTC heater is actively heating,
    // NEVER run the exhaust fan for humidity or O2—preserve 100% of chamber heat until targetTemp is reached!
    if (currentTemp < targetTemp || state.heater) {
        if (state.exhaustFan) {
            setRelay(PIN_RELAY_EXHAUST, false);
            state.exhaustFan = false;
        }
        return;
    }

    float maxRH = (currentPhase == PHASE_SETTING) ? (targetRH + 7.0f) : (targetRH + 5.0f);
    float o2Min = (currentPhase == PHASE_SETTING) ? DEFAULT_O2_MIN_SETTING : DEFAULT_O2_MIN_HATCHING;

    // Ventilation triggers (only evaluated when currentTemp >= targetTemp and heater is OFF):
    // a) Over-temperature venting (>= targetTemp + 0.3°C)
    // b) Normal ventilation (O2 < min, RH > max)
    bool criticalVent = (currentTemp >= (targetTemp + 0.3f));
    bool normalVent = (
        (currentO2 > 0.0f && currentO2 < o2Min) ||
        (currentRH > maxRH)
    );

    bool needVentilation = criticalVent || normalVent;

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

    // Top-of-the-hour turning check via NTP wall clock
    time_t nowSec = time(nullptr);
    if (nowSec > 100000) {
        struct tm timeinfo;
        if (localtime_r(&nowSec, &timeinfo)) {
            if (timeinfo.tm_min == 0 && lastTurnedHour != timeinfo.tm_hour) {
                lastTurnedHour = timeinfo.tm_hour;
                Serial.printf("[ACTUATORS] Top of the hour (%02d:00): Triggering hourly egg turning cycle...\n", timeinfo.tm_hour);
                triggerEggTurnManual(DEFAULT_TURNING_DURATION_S);
                return;
            }
        }
    } else {
        // Fallback to interval timer if NTP is not yet synchronized
        if (now - lastTurnTimestamp >= (DEFAULT_TURNING_INTERVAL_S * 1000UL)) {
            Serial.println("[ACTUATORS] Triggering hourly egg turning cycle (interval fallback)...");
            triggerEggTurnManual(DEFAULT_TURNING_DURATION_S);
        }
    }
}

void ActuatorManager::updateControl(const SensorData& data) {
    // Circulation fan is continuously powered on 12V/AC rail
    state.circulationFan = true;

    // Process egg turning duration monitoring regardless of manual override
    processEggTurning();

    // Critical Overheat Safety Watchdog for Manual Override:
    // If the system is in manual mode but temperature reaches critical level (>= CRITICAL_TEMP_MAX or >= 38.0°C),
    // immediately force-revert to AUTOMATIC mode, kill heater, and engage exhaust ventilation!
    if (manualOverride) {
        if (data.temperature >= CRITICAL_TEMP_MAX || (data.temperature >= 38.0f && data.temperature < 60.0f)) {
            Serial.printf("[SAFETY] Critical temperature reached (%.2f C) during manual override! Force-reverting to AUTOMATIC mode.\n", data.temperature);
            manualOverride = false;
            state.manualOverride = false;
        } else {
            return;
        }
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
    Serial.printf("[ACTUATORS] Egg turning motor activated for %lu seconds.\n", (unsigned long)durationSec);
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

    time_t nowSec = time(nullptr);
    if (nowSec > 100000) {
        struct tm timeinfo;
        if (localtime_r(&nowSec, &timeinfo)) {
            uint32_t secIntoHour = timeinfo.tm_min * 60 + timeinfo.tm_sec;
            return (secIntoHour >= 3600) ? 0 : (3600 - secIntoHour);
        }
    }

    // Fallback if clock not synced
    uint32_t elapsed = (millis() - lastTurnTimestamp) / 1000UL;
    if (elapsed >= DEFAULT_TURNING_INTERVAL_S) return 0;
    return DEFAULT_TURNING_INTERVAL_S - elapsed;
}
