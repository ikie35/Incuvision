#ifndef INCUVISION_ACTUATORS_H
#define INCUVISION_ACTUATORS_H

#include <Arduino.h>
#include "sensors.h"

enum IncubationPhase {
    PHASE_SETTING = 1,   // Days 1–18 (Egg turning active, 37.5°C)
    PHASE_HATCHING = 2   // Days 19–21 (No egg turning, 36.9°C, higher RH)
};

struct ActuatorState {
    bool heater;
    bool exhaustFan;
    bool circulationFan;
    bool eggMotor;
    bool candlingLed;
    bool alarmActive;
};

class ActuatorManager {
public:
    ActuatorManager();
    void begin();
    
    // Closed-loop regulation update
    void updateControl(const SensorData& data);
    
    // Manual & Trigger Overrides
    void setCandlingLed(bool state);
    void triggerEggTurnManual(uint32_t durationSec = 15);
    void setPhase(IncubationPhase phase);
    void setCustomSetpoints(float targetTemp, float targetRH, uint16_t maxCO2);
    
    const ActuatorState& getState() const { return state; }
    IncubationPhase getPhase() const { return currentPhase; }
    float getTargetTemp() const { return targetTemp; }
    float getTargetRH() const { return targetRH; }
    uint16_t getTargetCO2() const { return targetCO2; }

private:
    ActuatorState state;
    IncubationPhase currentPhase;
    
    float targetTemp;
    float targetRH;
    uint16_t targetCO2;
    
    // Turning timing
    uint32_t lastTurnTimestamp;
    bool isTurningNow;
    uint32_t turnStartTimestamp;
    uint32_t turnDurationMs;

    void setRelay(uint8_t pin, bool active);
    void processHeating(float currentTemp);
    void processVentilation(uint16_t currentCO2, float currentO2, float currentTemp);
    void processEggTurning();
};

extern ActuatorManager actuators;

#endif // INCUVISION_ACTUATORS_H
