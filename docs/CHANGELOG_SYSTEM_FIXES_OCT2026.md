# IncuVision Engineering Changelog & System Fixes
**Date:** October 21, 2026  
**Project:** IncuVision: Smart Chicken Egg Incubator with Automated Environmental Control & YOLOv8 Vision  
**Target Hardware:** Raspberry Pi 5 (8GB) + ESP32 NodeMCU-32S + 4-Channel Active-LOW Relay Module  
**Remote Environment:** Raspberry Pi located in Zamboanga City | Remote Monitoring & Client in Kabasalan  

---

## 1. Actuator Controls & Closed-Loop Regulation Fixes

### Problem Identified
* When manual actuator commands (PTC Heater, Exhaust Fan, Egg Turner, Candling Light) were triggered from the dashboard or serial bridge, the relays toggled briefly but were immediately forced OFF after 2 seconds.
* Relays were inverted on initial power-up.
* Plain-text serial commands from `mqtt_bridge.py` (`HEATER ON`, `EXHAUST ON`, etc.) were failing JSON deserialization on the ESP32.

### Root Causes
1. **Manual Override Overwrite:** In `firmware/src/comm.cpp`, receiving `SET_RELAY` toggled the pin but left `manualOverride = false`. Every 2 seconds, `actuators.updateControl()` executed its thermal and ventilation closed loops, immediately overwriting the relays.
2. **Relay Polarity Inversion:** Most opto-isolated 4-channel relay modules are Active LOW (`LOW = ON`, `HIGH = OFF`).
3. **Serial Protocol Mismatch:** `mqtt_bridge.py` sent plain-text commands over USB Serial fallback, while `comm.cpp` expected pure JSON.

### Changes Applied
* **`firmware/include/config.h`:**
  * Defined `#define RELAY_ACTIVE_LEVEL LOW` and `#define RELAY_INACTIVE_LEVEL HIGH`.
* **`firmware/src/actuators.cpp`:**
  * Updated `setRelay()` to use `RELAY_ACTIVE_LEVEL` and `RELAY_INACTIVE_LEVEL`.
* **`firmware/src/comm.cpp`:**
  * Added `actuators.setManualOverride(true)` when `SET_RELAY` is executed.
  * Added plain-text command parser fallback for `HEATER ON/OFF`, `EXHAUST ON/OFF`, `TURN ON/OFF`, `LED ON/OFF`, `MODE MANUAL/AUTO`, and `DAY <n>`.

---

## 2. Egg Turner 1-Hour Cycle & Hardware Synchronization

### Problem Identified
* The web dashboard ran an arbitrary, un-synchronized browser countdown timer (`turningSecondsLeft = 30 * 60 + 9`) that drifted out of sync with the ESP32 microcontroller's physical motor cycle.

### Changes Applied
* **`firmware/include/actuators.h` & `firmware/src/actuators.cpp`:**
  * Implemented `getSecondsToNextTurn()` to calculate the exact remaining seconds based on `lastTurnTimestamp` and `DEFAULT_TURNING_INTERVAL_S` (3600s / 1 hour).
* **`firmware/src/comm.cpp`:**
  * Added `"next_turn_seconds"` into the JSON telemetry broadcast payload.
* **`vision/mqtt_bridge.py`:**
  * Added `next_turn_seconds` ingestion and forwarding via WebSocket.
* **`app/app.js`:**
  * Synchronized the dashboard countdown element (`turningCountdown`) directly to `telem.next_turn_seconds`, displaying `"TURNING..."` when the motor is rotating and counting down accurately from hardware state.

---

## 3. Dynamic Full-Frame AI Candling Vision Overhaul

### Problem Identified
* The vision system was displaying a rigid, predefined 56-box ($7 \times 8$) grid over every snapshot.
* Bounding boxes were being stamped directly over the **aluminum duct hose** and the **switching power supply**, assigning fake random confidences (`#1 FERT 95%`, `#13 INFE 85%`).
* The camera view was artificially cropped, missing eggs situated near the chamber walls.

### Root Causes
1. **Mathematical Slicing:** `vision/candling_pipeline.py` had a hardcoded $7 \times 8$ loop slicing the image into arbitrary rectangular crops.
2. **Artificial Margin Crop:** Slicing started at `tray_x = 0.12 * w` and `tray_y = 0.14 * h`, cutting off 24% width and 28% height.
3. **Synthetic Fallback Loop:** `yolov8s_candling.py` generated pseudo-random values (`seed % 100`) whenever a crop didn't match.

### Changes Applied
* **`vision/models/yolov8s_candling.py`:**
  * Implemented full-frame dynamic object detection using high-speed `onnxruntime` on `yolov8ncandling.onnx`.
  * Outputs bounding boxes `[x1, y1, x2, y2]` strictly where actual eggs are detected, with Non-Maximum Suppression (`cv2.dnn.NMSBoxes`).
  * Implemented spatial sorting (top-to-bottom, left-to-right) to tag eggs in natural reading order (`#1`, `#2`, `#3`...).
* **`vision/candling_pipeline.py`:**
  * Removed the hardcoded $7 \times 8$ grid and artificial edge cropping.
  * Pipeline now runs across the **100% full frame** (from $0$ to $W$ and $0$ to $H$).
  * Empty areas, duct hoses, and power supplies receive **no bounding boxes**.
  * Dynamic header banner displays actual detected count and calculated fertility rate.
* **`vision/camera_manager.py`:**
  * Configured Picamera2 and USB camera interfaces for **1920 × 1080** full-sensor capture to maximize field-of-view across the incubation tray.

---

## 4. Frontend Web Dashboard & Remote Access Fixes

### Changes Applied
* **Dynamic Wave Chart (`app/app.js`):**
  * Replaced static mockup coordinates with a dynamic rolling buffer (`telemetryHistory[]`, 50 samples).
  * Added `loadTelemetryHistory()` preloading from `/api/history?limit=50`.
  * Scaled bezier curves dynamically to min/max ranges for Temperature, Humidity, $\text{CO}_2$, and $\text{O}_2$.
* **Syntax Error Bugfix (`app/app.js`):**
  * Removed rogue extra closing bracket (`});`) at line 762 that had broken JavaScript execution and caused dashboard buttons to be unclickable.
* **Encoding Glitch Resolution:**
  * Normalized UTF-8 double-encoding that caused `37.2Â°C` to display properly as `37.2°C`.
* **Remote Inter-City Tunneling:**
  * Established public reverse tunnel (`localhost.run`) to bridge the Raspberry Pi in Zamboanga City with the client browser in Kabasalan.

---

## 5. Git Commit Summary
* **Commit `2af3a10`:** Fix relay polarity, manual override retention, dynamic full-frame YOLOv8 detection, and live analytics graph.
* **Commit `0686d68`:** Fix syntax error in `app.js` extra closing bracket to restore button interactivity.
* **Commit `707b1d0`:** Fix UTF-8 double-encoding artifact `Â` in degree symbol.

---
*Documented and verified on October 21, 2026 for MSU-IIT Graduate Research.*