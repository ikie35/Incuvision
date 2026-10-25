#ifndef INCUVISION_ACTUATORS_H
#define INCUVISION_ACTUATORS_H

#include <Arduino.h>
#include "sensors.h"

enum IncubationPhase {
    PHASE_SETTING = 1,   // Days 1â€“18 (Egg turning active, 37.5Â°C)
    PHASE_HATCHING = 2   // Days 19â€“21 (No egg turning, 36.9Â°C, higher RH)
};

struct ActuatorState {
    bool heater;
    bool exhaustFan;
    bool circulationFan;
    bool eggMotor;
    bool candlingLed;
    bool alarmActive;
    bool manualOverride;
};

class ActuatorManager {
public:
    ActuatorManager();
    void begin();
    
    // Closed-loop regulation update
    void updateControl(const SensorData& data);
    
    // Manual & Direct Relay Overrides
    void setHeater(bool state);
    void setExhaustFan(bool state);
    void setEggMotor(bool state);
    void setCandlingLed(bool state);
    void setRelayByName(const char* name, bool state);
    void triggerEggTurnManual(uint32_t durationSec = 15);
    void setPhase(IncubationPhase phase);
    void setCustomSetpoints(float targetTemp, float targetRH, uint16_t maxCO2);
    void setManualOverride(bool enable) { manualOverride = enable; }
    bool isManualOverride() const { return manualOverride; }
    
    const ActuatorState& getState() const { return state; }
    IncubationPhase getPhase() const { return currentPhase; }
    float getTargetTemp() const { return targetTemp; }
    float getTargetRH() const { return targetRH; }
    uint16_t getTargetCO2() const { return targetCO2; }
    uint32_t getSecondsToNextTurn() const;

private:
    ActuatorState state;
    IncubationPhase currentPhase;
    bool manualOverride;
    
    float targetTemp;
    float targetRH;
    uint16_t targetCO2;
    
    // Heating anti-overshoot 10s burst timing
    uint32_t heaterStartTimestamp;
    bool heaterBurstActive;
    uint32_t heaterRestTimestamp;

    // Turning timing
    uint32_t lastTurnTimestamp;
    int lastTurnedHour;
    bool isTurningNow;
    uint32_t turnStartTimestamp;
    uint32_t turnDurationMs;

    void setRelay(uint8_t pin, bool active);
    void processHeating(float currentTemp);
    void processVentilation(uint16_t currentCO2, float currentO2, float currentTemp, float currentRH);
    void processEggTurning();
};

extern ActuatorManager actuators;

#endif // INCUVISION_ACTUATORS_H

