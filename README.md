# IncuVision: Smart Chicken Egg Incubator

An automated chicken egg incubation system featuring real-time environmental control ($\text{Temperature}, \text{Humidity}, \text{CO}_2, \text{O}_2$), automated mechanical egg turning, and a YOLOv8s-based multi-egg candling vision system.

Based on the research paper: *IncuVision: A Smart Chicken Egg Incubator with Automated Environmental Control and YOLOv8-Integrated Multi-Egg Candling System*.

---

## 📁 Repository Structure

```
IncuVision/
├── docs/                         # Schematics, pinouts, and setup guides
│   ├── WIRING_AND_PINOUTS.md     # Detailed hardware schematic & pin assignments
│   └── SYSTEM_SETUP_GUIDE.md     # Step-by-step setup & execution manual
├── firmware/                     # ESP32 C++ / Arduino Firmware
│   ├── platformio.ini           # PlatformIO project configuration
│   ├── include/
│   │   ├── config.h             # Pinouts, Wi-Fi/MQTT config, setpoints & safety limits
│   │   ├── sensors.h            # DHT22, SCD30 (CO2), DFRobot (O2) interfaces
│   │   ├── actuators.h          # Relays (Heater, Fans, Motor, Candling LED)
│   │   └── comm.h               # MQTT & Serial JSON messaging protocol
│   └── src/
│       ├── main.cpp             # Main loop & hardware watchdog
│       ├── sensors.cpp          # Sensor reading and fallback logic
│       ├── actuators.cpp        # Thermal hysteresis, ventilation, & turning control
│       └── comm.cpp             # Telemetry publisher & command parser
├── vision/                       # Raspberry Pi 5 Master Coordinator & Vision Engine
│   ├── requirements.txt         # Python dependencies
│   ├── config.py                # System topics, schedules, & paths
│   ├── main.py                  # Main supervisor entrypoint
│   ├── coordinator.py           # Incubation schedule & automated candling state machine
│   ├── candling_pipeline.py     # Pi Camera 3 acquisition, 7x8 matrix grid partitioning, & YOLOv8
│   ├── lcd_manager.py           # 20x4 I2C LCD screen driver & display cycles
│   ├── mqtt_bridge.py           # MQTT client for ESP32 sync
│   ├── logger.py                # SQLite database and CSV telemetry recorder
│   ├── api.py                   # FastAPI backend & WebSocket live telemetry stream
│   └── models/
│       └── yolov8s_candling.py  # YOLOv8s inference engine for egg fertility classification
├── app/                          # Real-Time Web & Mobile Dashboard
│   ├── index.html               # Responsive single-page dashboard
│   ├── style.css                # Dark-mode glassmorphism stylesheet
│   └── app.js                   # Live telemetry gauges & 56-egg interactive grid
└── README.md
```

---

## ⚡ System Architecture Overview

- **Master Environmental Controller (ESP32)**:
  - **Sensors**: DHT22 (Temperature & RH), SCD30 ($\text{CO}_2$, Temp, RH), DFRobot ($\text{O}_2$).
  - **Actuators**: PTC Heater, 12V DC Exhaust Fan, AC Circulation Fan, AC Kinematic Egg Turning Motor, High-Intensity LED Candling Array via 4/8-Channel Opto-isolated Relay.
  - **Communication**: Publishes telemetry and receives commands wirelessly via **MQTT over Wi-Fi** (with USB Serial fallback).
- **Vision Engine & Master Coordinator (Raspberry Pi 5)**:
  - **Camera**: Raspberry Pi Camera Module 3 (12MP).
  - **Display**: 20x4 LCD Screen ($\text{I}^2\text{C}$).
  - **AI Model**: YOLOv8s optimized for 56-egg ($7 \times 8$ matrix) fertility classification:
    - `Fertile` (Active vascular / embryo growth)
    - `Infertile` (Clear / unfertilized)
    - `Early Dead` (Blood ring / arrested development)

---

## 📊 Incubation Environmental Setpoints

| Stage | Days | Target Temp (°C) | Target RH (%) | Target $\text{CO}_2$ | Target $\text{O}_2$ | Egg Turning |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Setting Phase** | Days 0–18 | 37.5 °C | 58% | 0.3% – 0.5% (3,000–5,000 ppm) | 20.9% | Rotates hourly ($45^\circ$) |
| **Hatching Phase** | Days 19–21 | 36.9 °C | 66% – 75% | Max 0.75% (7,500 ppm) | 20.5% | Deactivated |

---

## 📸 Automated Candling Schedule

- **Day 7**: Initial fertility & vascular network audit.
- **Day 10**: Embryo development progress check.
- **Day 18**: Pre-hatching final evaluation.

---

## 🚀 Quickstart Guide

### 1. Flash the ESP32
Open `firmware/` in VS Code with PlatformIO (or Arduino IDE) and upload to your ESP32 board.

### 2. Launch the Vision Engine & Web Dashboard on Raspberry Pi
```bash
cd vision
pip install -r requirements.txt
python main.py
```
Open your browser at `http://localhost:8000/dashboard/` to view the live dashboard and control the incubator.

### 3. Remote Cloudflare Tunneling (Public HTTPS Access)
IncuVision utilizes Cloudflare Tunnel for secure, remote mobile and web monitoring across any network:
```bash
cloudflared tunnel --url http://localhost:8000
```
To run it continuously in the background on the Raspberry Pi:
```bash
nohup cloudflared tunnel --url http://localhost:8000 > ~/tunnel.log 2>&1 &
```
To inspect the active public URL anytime:
```bash
grep -o 'https://.*\.trycloudflare\.com' ~/tunnel.log | tail -n 1
```

