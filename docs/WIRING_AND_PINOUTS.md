# IncuVision: Complete Wiring & Pinout Guide

This document specifies the exact hardware connections, GPIO pin assignments, power distribution, and relay wiring for the IncuVision incubation and vision system.

---

## 1. System Pinout Mapping

### ESP32 (Master Environmental Controller - 38-pin NodeMCU-32S / WROOM-32)

| Component | Signal / Function | ESP32 GPIO Pin | Protocol / Type | Voltage / Notes |
| :--- | :--- | :--- | :--- | :--- |
| **DHT22 Sensor** | Data Out | `GPIO 4` | Single-Wire Digital | 3.3V (Pull-up 10kΩ to 3.3V) |
| **SCD30 Sensor ($\text{CO}_2$)** | `SDA` | `GPIO 21` | $\text{I}^2\text{C}$ Data | 3.3V |
| **SCD30 Sensor ($\text{CO}_2$)** | `SCL` | `GPIO 22` | $\text{I}^2\text{C}$ Clock | 3.3V |
| **DFRobot $\text{O}_2$ Sensor** | Analog Voltage / $\text{I}^2\text{C}$ | `GPIO 34` (ADC1_CH6) | Analog (0–3.3V) / $\text{I}^2\text{C}$ | 3.3V |
| **PTC Heater Relay** | Control Signal IN1 | `GPIO 18` | Digital Output (Active LOW) | 5V Opto-isolated Relay |
| **12V Exhaust Fan Relay** | Control Signal IN2 | `GPIO 19` | Digital Output (Active LOW) | 5V Opto-isolated Relay |
| **AC Circulation Fan Relay** | Control Signal IN3 | `GPIO 23` | Digital Output (Active LOW) | 5V Opto-isolated Relay |
| **Egg Turning Motor Relay** | Control Signal IN4 | `GPIO 25` | Digital Output (Active LOW) | 5V Opto-isolated Relay |
| **LED Candling Array Relay** | Control Signal IN5 / Ext | `GPIO 26` | Digital Output (Active LOW) | 5V Opto-isolated Relay / MOSFET |
| **Buzzer / Alarm** | Audible Warning | `GPIO 27` | Digital Output (Active HIGH) | 3.3V / 5V Piezo Buzzer |
| **Hardware Emergency Cutoff** | Limit Switch / Safety | `GPIO 35` | Digital Input (Pull-down) | 3.3V |

---

### Raspberry Pi 5 (Vision Engine & Master Coordinator)

| Component | Interface / Port | Pinout / Port | Description |
| :--- | :--- | :--- | :--- |
| **Pi Camera Module 3** | CSI (CAM/DISP0 or CAM1) | 15-pin / 22-pin FPC | High-res 12MP autofocus camera overhead 56-egg tray |
| **20x4 LCD Screen ($\text{I}^2\text{C}$)** | $\text{I}^2\text{C}$ Data (`SDA`) | Physical Pin 3 (`GPIO 2`) | 3.3V / 5V ($I^2C$ backpack address `0x27` or `0x3F`) |
| **20x4 LCD Screen ($\text{I}^2\text{C}$)** | $\text{I}^2\text{C}$ Clock (`SCL`) | Physical Pin 5 (`GPIO 3`) | 3.3V / 5V |
| **Power Supply** | USB-C 5V / 5A (27W) | USB-C Port | Official Pi 5 Power Delivery PSU |
| **ESP32 Communication** | Wi-Fi (MQTT) / USB-Serial | Built-in Wi-Fi / USB Port | Wireless MQTT or `/dev/ttyUSB0` @ 115200 baud |

---

## 2. Power Distribution & Safety

```
                     +---------------------------------------+
                     |        Mains AC Supply (220V / 110V)  |
                     +---+-------------------------------+---+
                         |                               |
             +-----------v-----------+       +-----------v-----------+
             | 12V 5A DC Power Supply|       |   AC Appliances (Relays)
             +-----------+-----------+       |   - AC Circulation Fan|
                         |                   |   - AC Egg Turning Motor
         +---------------+---------------+   |   - PTC Heater Elements
         |                               |   +-----------------------+
 +-------v-------+               +-------v-------+
 | 5V 3A Buck    |               | 12V Actuators |
 | Converter     |               | - 12V Exhaust |
 +-------+-------+               |   Fan         |
         |                       | - High-Power  |
         |                       |   LED Array   |
         |                       +---------------+
+--------+--------+
|                 |
v                 v
ESP32 (VIN/5V)   5V 4/8-Channel Opto-Relay Module
```

> [!CAUTION]
> **Thermal Safety**: Always wire a physical **thermal cutoff bimetallic switch (rated at 42°C)** in series with the PTC heater AC line. If both software and relay fail closed, the thermal fuse will physically disconnect the heater power to prevent egg damage or fire hazard.
