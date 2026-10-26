# IncuVision: System Setup & Operating Guide

This guide walks you through setting up both the **ESP32 Firmware** and the **Raspberry Pi 5 Vision Engine**.

---

## Part 1: ESP32 Firmware Setup

### Option A: Using PlatformIO (Recommended)
1. Open Visual Studio Code with the **PlatformIO IDE** extension installed.
2. Open the `firmware/` directory (`File -> Open Folder -> IncuVision/firmware`).
3. Edit `include/config.h` to configure your Wi-Fi SSID, Password, and Raspberry Pi's MQTT Broker IP:
   ```cpp
   #define WIFI_SSID     "IncuVision_AP"       // Or your local Wi-Fi router SSID
   #define WIFI_PASSWORD "incubator2026"
   #define MQTT_BROKER   "192.168.4.1"         // IP of Raspberry Pi 5
   ```
4. Connect the ESP32 via USB and click **Upload** (or run `pio run --target upload`).
5. Open the Serial Monitor at **115200 baud** to verify startup and sensor calibration.

### Option B: Using Arduino IDE
1. Open Arduino IDE and add ESP32 board support via Boards Manager (`esp32 by Espressif Systems`).
2. Install the required libraries via Library Manager:
   - `PubSubClient` (Nick O'Leary)
   - `ArduinoJson` (Benoît Blanchon)
   - `DHT sensor library` (Adafruit)
   - `SparkFun SCD30 Arduino Library`
3. Open `firmware/src/main.cpp` and click **Upload**.

---

## Part 2: Raspberry Pi 5 Setup

### 1. Enable Camera & $\text{I}^2\text{C}$ Interfaces
On your Raspberry Pi terminal, run:
```bash
sudo raspi-config
```
* Navigate to **Interface Options** $\rightarrow$ Enable **I2C** and **Camera**.
* Reboot if prompted: `sudo reboot`.

### 2. Install Mosquitto MQTT Broker
```bash
sudo apt update
sudo apt install -y mosquitto mosquitto-clients
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
```
To allow external connections (like ESP32), create `/etc/mosquitto/conf.d/local.conf`:
```
listener 1883
allow_anonymous true
```
Restart Mosquitto: `sudo systemctl restart mosquitto`.

### 3. Install Python Dependencies
In the `vision/` directory:
```bash
cd vision
pip install -r requirements.txt
```

### 4. Running the IncuVision Coordinator & Web Dashboard
To start the supervisor service and local web server:
```bash
python main.py
```
Open your browser at `http://<raspberry-pi-ip>:8000` or `http://localhost:8000` to view the **IncuVision Real-Time Dashboard**.

### 5. Remote Access via Cloudflare Tunnel
IncuVision uses Cloudflare Tunnel to expose the local dashboard securely over public HTTPS for mobile and off-site monitoring:
```bash
cloudflared tunnel --url http://localhost:8000
```
To run it continuously in the background on the Raspberry Pi:
```bash
nohup cloudflared tunnel --url http://localhost:8000 > ~/tunnel.log 2>&1 &
```
To retrieve the active public URL:
```bash
grep -o 'https://.*\.trycloudflare\.com' ~/tunnel.log | tail -n 1
```

---

### 6. Auto-Start on Boot & Health Checks

To verify if IncuVision is configured to launch automatically on Raspberry Pi boot:

#### A. Check if the Service is Enabled on Boot
```bash
systemctl is-enabled incuvision
```
- If configured for boot, it outputs: `enabled`
- If not configured for boot, it outputs: `disabled`

#### B. Check Current Running Status
```bash
sudo systemctl status incuvision
```
Look for:
- `Loaded: ...; enabled; ...` (confirms boot auto-start)
- `Active: active (running) since ...` (confirms it is actively running)

#### C. Inspect Boot Logs
To view logs generated since the most recent boot:
```bash
journalctl -u incuvision -b
```
Or follow real-time logs:
```bash
journalctl -u incuvision -f
```

#### D. How to Enable Auto-Start on Boot (If Disabled)
If `systemctl is-enabled incuvision` returns `disabled`, enable it with:
```bash
sudo systemctl daemon-reload
sudo systemctl enable incuvision
sudo systemctl start incuvision
```
Similarly, verify that the Mosquitto MQTT broker is enabled on boot:
```bash
systemctl is-enabled mosquitto
```
