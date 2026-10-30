import os
import re
import glob
import json
import time
import threading
from datetime import datetime
import paho.mqtt.client as mqtt

from config import (
    MQTT_BROKER_HOST, MQTT_BROKER_PORT,
    TOPIC_TELEMETRY, TOPIC_COMMANDS, TOPIC_STATUS, TOPIC_SETPOINTS,
    SERIAL_PORT, SERIAL_BAUDRATE, ENABLE_SERIAL_BRIDGE
)

try:
    import serial
    import serial.tools.list_ports
    SERIAL_AVAILABLE = True
except ImportError:
    SERIAL_AVAILABLE = False


class MQTTBridge:
    def __init__(self, on_telemetry_callback=None, on_status_callback=None):
        self.client = mqtt.Client(client_id="IncuVision_PiMaster")
        self.on_telemetry_cb = on_telemetry_callback
        self.on_status_cb = on_status_callback
        self.connected = False
        
        # Serial connection state
        self.serial_conn = None
        self.serial_thread = None
        self.stop_requested = False
        
        # Live Telemetry State
        self.latest_telemetry = {
            "temp": 37.5,
            "rh": 58.0,
            "co2": 3200,
            "o2": 20.9,
            "actuators": {
                "heater": False,
                "exhaust": False,
                "circulate": True,
                "motor": False,
                "candling": False,
                "alarm": False,
                "manual": False
            },
            "phase": "SETTING",
            "uptime": 0,
            "next_turn_seconds": 3600
        }
        self._turn_sync_timestamp = time.time()
        self._turn_interval_remaining = 3600
        self.has_received_live_telemetry = False
        self.motor_turned_since_last_log = False
        self._motor_reset_timer = None
        self.desired_phase = "SETTING"
        self.desired_temp = 37.5
        self.desired_rh = 58.0
        self.desired_co2 = 5000

    def get_telemetry(self) -> dict:
        """Returns the latest telemetry dictionary with dynamically updated next_turn_seconds to the start of the next hour."""
        if self.latest_telemetry.get("phase") == "HATCHING":
            self.latest_telemetry["next_turn_seconds"] = 0
        elif self.latest_telemetry.get("actuators", {}).get("motor", False):
            self.latest_telemetry["next_turn_seconds"] = 0
        else:
            now_dt = datetime.now()
            seconds_into_hour = now_dt.minute * 60 + now_dt.second
            self.latest_telemetry["next_turn_seconds"] = max(0, 3600 - seconds_into_hour)
        return self.latest_telemetry

    def start(self):
        # 1. Start MQTT Client
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect

        try:
            print(f"[MQTT] Connecting to broker at {MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}...")
            self.client.connect_async(MQTT_BROKER_HOST, MQTT_BROKER_PORT, 60)
            self.client.loop_start()
        except Exception as e:
            print(f"[MQTT] Warning: Could not connect to local MQTT broker ({e}). Will retry in background.")

        # 2. Start Serial USB Bridge (Auto-detect ESP32 on USB)
        if ENABLE_SERIAL_BRIDGE:
            if SERIAL_AVAILABLE:
                self.serial_thread = threading.Thread(target=self._serial_worker, daemon=True)
                self.serial_thread.start()
            else:
                print("[SERIAL] Note: 'pyserial' not installed. Install with 'pip install pyserial' to enable direct USB telemetry.")

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            self.connected = True
            print("[MQTT] Connected to MQTT Broker successfully.")
            client.subscribe([(TOPIC_TELEMETRY, 0), (TOPIC_STATUS, 0)])
        else:
            print(f"[MQTT] Connection failed with result code {rc}")

    def _on_disconnect(self, client, userdata, rc):
        self.connected = False
        print(f"[MQTT] Disconnected from broker (rc={rc}). Reconnecting...")

    def _on_message(self, client, userdata, msg):
        try:
            payload_str = msg.payload.decode("utf-8")
            if msg.topic == TOPIC_TELEMETRY:
                data = json.loads(payload_str)
                self._update_telemetry_dict(data)
                print(f"[MQTT] Telemetry updated: {self.latest_telemetry['temp']}°C, {self.latest_telemetry['rh']}%, CO2={self.latest_telemetry['co2']}")
                if self.on_telemetry_cb:
                    self.on_telemetry_cb(self.latest_telemetry)

            elif msg.topic == TOPIC_STATUS:
                if self.on_status_cb:
                    self.on_status_cb(payload_str)
        except Exception as e:
            print(f"[MQTT] Error handling message on {msg.topic}: {e}")

    def _update_telemetry_dict(self, data: dict):
        """Helper to safely merge telemetry keys."""
        if "temp" in data:
            self.latest_telemetry["temp"] = float(data["temp"])
        if "rh" in data:
            self.latest_telemetry["rh"] = float(data["rh"])
        if "co2" in data:
            self.latest_telemetry["co2"] = int(float(data["co2"]))
        if "o2" in data:
            self.latest_telemetry["o2"] = float(data["o2"])
        if "actuators" in data and isinstance(data["actuators"], dict):
            self.latest_telemetry["actuators"].update(data["actuators"])
            if self.latest_telemetry["actuators"].get("motor", False):
                self.motor_turned_since_last_log = True
        if "phase" in data:
            self.latest_telemetry["phase"] = data["phase"]
        if "next_turn_seconds" in data:
            val = int(data["next_turn_seconds"])
            self.latest_telemetry["next_turn_seconds"] = val
            self._turn_interval_remaining = val
            self._turn_sync_timestamp = time.time()
        if "uptime" in data:
            self.latest_telemetry["uptime"] = data["uptime"]
        if "target_temp" in data:
            self.latest_telemetry["target_temp"] = float(data["target_temp"])
        if "target_rh" in data:
            self.latest_telemetry["target_rh"] = float(data["target_rh"])
        if "target_co2" in data:
            self.latest_telemetry["target_co2"] = int(data["target_co2"])
        self.has_received_live_telemetry = True

    # =========================================================================
    # USB SERIAL BRIDGE & TELEMETRY PARSER
    # =========================================================================
    def _find_serial_port(self):
        """Locates the ESP32 USB serial port (/dev/ttyUSB0, /dev/ttyACM0, etc.)."""
        if os.path.exists(SERIAL_PORT):
            return SERIAL_PORT
        
        matches = glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*")
        if matches:
            return matches[0]

        if SERIAL_AVAILABLE:
            try:
                ports = list(serial.tools.list_ports.comports())
                for port in ports:
                    desc = port.description.upper()
                    if "CH340" in desc or "CP210" in desc or "USB" in desc or "SERIAL" in desc:
                        return port.device
                if ports:
                    return ports[0].device
            except Exception:
                pass
        return None

    def _serial_worker(self):
        """Continuously reads telemetry from ESP32 over USB Serial."""
        while not self.stop_requested:
            port = self._find_serial_port()
            if not port:
                time.sleep(2.0)
                continue

            try:
                print(f"[SERIAL] Connecting to ESP32 on {port} @ {SERIAL_BAUDRATE} baud...")
                self.serial_conn = serial.Serial(port, SERIAL_BAUDRATE, timeout=1.5)
                print(f"[SERIAL] SUCCESS: Connected to ESP32 on {port}! Streaming live telemetry...")
                # Sync active phase & setpoints after ESP32 finishes USB DTR boot (2.5s)
                def _sync_after_connect():
                    time.sleep(2.5)
                    self.set_phase(self.desired_phase)
                threading.Thread(target=_sync_after_connect, daemon=True).start()

                while not self.stop_requested:
                    raw_line = self.serial_conn.readline()
                    if raw_line:
                        try:
                            line_str = raw_line.decode("utf-8", errors="ignore").strip()
                            if line_str:
                                self._parse_serial_line(line_str)
                        except Exception as e:
                            pass
            except Exception as e:
                print(f"[SERIAL] Device on {port} disconnected ({e}). Retrying in 3 seconds...")
                if self.serial_conn:
                    try:
                        self.serial_conn.close()
                    except Exception:
                        pass
                    self.serial_conn = None
                time.sleep(3.0)

    def _parse_serial_line(self, line: str):
        """Parses telemetry from the ESP32 serial output (CSV, text headers, or JSON)."""
        updated = False

        # 1. Parse CSV format from ESP32 sketch:
        # DATA,incubationDay,dhtTemp,dhtRH,scdTemp,scdRH,co2,oxygenPercent,warmupComplete,turnerRunning,ledState
        if line.startswith("DATA"):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 8:
                try:
                    if len(parts) >= 2:
                        try:
                            self.latest_telemetry["day"] = int(float(parts[1]))
                        except Exception:
                            pass

                    # Index 2: DHT Temp, Index 3: DHT RH
                    # Index 4: SCD Temp, Index 5: SCD RH
                    # Index 6: SCD CO2,  Index 7: O2
                    temp = float(parts[2])
                    rh = float(parts[3])
                    co2 = int(float(parts[6]))
                    o2 = float(parts[7])

                    if 0 < temp < 65:
                        self.latest_telemetry["temp"] = round(temp, 2)
                    if 0 <= rh <= 100:
                        self.latest_telemetry["rh"] = round(rh, 1)
                    if co2 >= 0:
                        self.latest_telemetry["co2"] = co2
                    if 0 <= o2 <= 100:
                        self.latest_telemetry["o2"] = round(o2, 2)

                    # Index 8: warmupComplete (1 or 0)
                    if len(parts) >= 9:
                        self.latest_telemetry["warmup"] = (parts[8] == "1")

                    # Index 9: turnerRunning (1 or 0) -> Egg Turner Motor
                    if len(parts) >= 10:
                        self.latest_telemetry["actuators"]["motor"] = (parts[9] == "1")
                        if self.latest_telemetry["actuators"]["motor"]:
                            self.motor_turned_since_last_log = True

                    # Index 10: ledState (1 or 0) -> Candling LED
                    if len(parts) >= 11:
                        self.latest_telemetry["actuators"]["candling"] = (parts[10] == "1")

                    # If extended columns exist for heater & exhaust:
                    if len(parts) >= 13:
                        self.latest_telemetry["actuators"]["heater"] = (parts[11] == "1")
                        self.latest_telemetry["actuators"]["exhaust"] = (parts[12] == "1")

                    updated = True
                    self.has_received_live_telemetry = True
                except Exception:
                    pass

        # 2. Parse key-value / filtered headers
        m_temp = re.search(r'(?:FILTERED\s+)?TEMP(?:ERATURE)?:\s*([\d\.]+)', line, re.IGNORECASE)
        if m_temp:
            val = float(m_temp.group(1))
            if 0 < val < 65:
                self.latest_telemetry["temp"] = round(val, 2)
                updated = True

        m_rh = re.search(r'(?:FILTERED\s+)?HUMIDITY:\s*([\d\.]+)', line, re.IGNORECASE)
        if m_rh:
            val = float(m_rh.group(1))
            if 0 <= val <= 100:
                self.latest_telemetry["rh"] = round(val, 1)
                updated = True

        m_co2 = re.search(r'(?:FILTERED\s+)?CO2:\s*([\d\.]+)', line, re.IGNORECASE)
        if m_co2:
            val = int(float(m_co2.group(1)))
            if val >= 0:
                self.latest_telemetry["co2"] = val
                updated = True

        m_o2 = re.search(r'(?:FILTERED\s+)?O2:\s*([\d\.]+)', line, re.IGNORECASE)
        if m_o2:
            val = float(m_o2.group(1))
            if 0 <= val <= 100:
                self.latest_telemetry["o2"] = round(val, 2)
                updated = True

        m_heater = re.search(r'HEATER:\s*(ON|OFF)', line, re.IGNORECASE)
        if m_heater:
            self.latest_telemetry["actuators"]["heater"] = (m_heater.group(1).upper() == "ON")
            updated = True

        m_exhaust = re.search(r'EXHAUST:\s*(ON|OFF)', line, re.IGNORECASE)
        if m_exhaust:
            self.latest_telemetry["actuators"]["exhaust"] = (m_exhaust.group(1).upper() == "ON")
            updated = True

        m_turner = re.search(r'(?:TURNER|MOTOR):\s*(ON|OFF)', line, re.IGNORECASE)
        if m_turner:
            self.latest_telemetry["actuators"]["motor"] = (m_turner.group(1).upper() == "ON")
            if self.latest_telemetry["actuators"]["motor"]:
                self.motor_turned_since_last_log = True
            updated = True

        m_candling = re.search(r'CANDLING(?:\s+LED)?:\s*(ON|OFF)', line, re.IGNORECASE)
        if m_candling:
            self.latest_telemetry["actuators"]["candling"] = (m_candling.group(1).upper() == "ON")
            updated = True

        if "MODE_MANUAL" in line or "MODE MANUAL" in line:
            self.latest_telemetry["actuators"]["manual"] = True
            updated = True
        elif "MODE_AUTO" in line or "MODE AUTO" in line:
            self.latest_telemetry["actuators"]["manual"] = False
            updated = True

        # 3. Parse JSON lines (supports raw JSON or [TELEMETRY] prefix)
        json_str = line.split('[TELEMETRY]', 1)[1].strip() if '[TELEMETRY]' in line else line
        if json_str.startswith("{") and json_str.endswith("}"):
            line = json_str
            try:
                data = json.loads(line)
                self._update_telemetry_dict(data)
                updated = True
            except Exception:
                pass

        if updated:
            print(f"[SERIAL] Telemetry parsed: {self.latest_telemetry['temp']}°C, {self.latest_telemetry['rh']}%, CO2={self.latest_telemetry['co2']}")
            # Trigger listener callbacks (dashboard broadcast, SQLite logger, 20x4 LCD)
            if self.on_telemetry_cb:
                self.on_telemetry_cb(self.latest_telemetry)
        elif line:
            # Print any diagnostic lines emitted by ESP32 firmware
            if any(k in line for k in ["DATA", "TELEMETRY", "SENSORS", "COMM", "ERROR", "{", "T:"]):
                print(f"[ESP32 SERIAL RAW] {line}")

    # =========================================================================
    # COMMAND DISPATCH (MQTT + USB SERIAL)
    # =========================================================================
    def send_command(self, cmd_dict: dict):
        payload = json.dumps(cmd_dict)
        # Send via MQTT
        if self.connected:
            self.client.publish(TOPIC_COMMANDS, payload)
            print(f"[MQTT] Command sent to ESP32: {payload}")
        
        # Also write directly over USB Serial
        if self.serial_conn and self.serial_conn.is_open:
            try:
                # 1. Send JSON payload
                self.serial_conn.write((payload + "\n").encode("utf-8"))

                # 2. Send plain text command for ESP32 Arduino sketch
                cmd = cmd_dict.get("cmd", "")
                if cmd in ("CANDLING_ON", "START_CANDLING"):
                    self.serial_conn.write(b"LED ON\n")
                elif cmd in ("CANDLING_OFF", "STOP_CANDLING"):
                    self.serial_conn.write(b"LED OFF\n")
                elif cmd == "SET_RELAY":
                    act = cmd_dict.get("actuator", "")
                    st = cmd_dict.get("state", False)
                    self.latest_telemetry["actuators"][act] = st
                    self.latest_telemetry["actuators"]["manual"] = True
                    if act in ("candling", "led"):
                        self.serial_conn.write(b"LED ON\n" if st else b"LED OFF\n")
                    elif act == "heater":
                        self.serial_conn.write(b"HEATER ON\n" if st else b"HEATER OFF\n")
                    elif act in ("exhaust", "fan"):
                        self.serial_conn.write(b"EXHAUST ON\n" if st else b"EXHAUST OFF\n")
                    elif act in ("motor", "turner"):
                        self.serial_conn.write(b"TURN ON\n" if st else b"TURN OFF\n")
                elif cmd == "SET_MODE":
                    m = cmd_dict.get("mode", "AUTO").upper()
                    self.latest_telemetry["actuators"]["manual"] = (m == "MANUAL")
                    self.serial_conn.write(f"MODE {m}\n".encode("utf-8"))
                elif cmd in ("SET_DAY", "DAY"):
                    d = cmd_dict.get("day", 1)
                    self.serial_conn.write(f"DAY {d}\n".encode("utf-8"))
                    self.serial_conn.write(b"MODE AUTO\n")
                elif cmd == "TURN_EGGS":
                    dur = cmd_dict.get("duration", 15)
                    self.serial_conn.write(f"TURN {dur}\n".encode("utf-8"))
                elif cmd == "SET_PHASE":
                    p = cmd_dict.get("phase", "SETTING")
                    d = 19 if p == "HATCHING" else 1
                    self.serial_conn.write(f"DAY {d}\n".encode("utf-8"))
                    self.serial_conn.write(b"MODE AUTO\n")

                print(f"[SERIAL] Command sent to ESP32: {payload}")
            except Exception as e:
                print(f"[SERIAL] Error sending command over serial: {e}")

    def set_candling_light(self, state: bool):
        cmd = "START_CANDLING" if state else "STOP_CANDLING"
        self.send_command({"cmd": cmd})

    def trigger_egg_turning(self, duration_sec: int = 15):
        if self.latest_telemetry.get("phase") == "HATCHING":
            print("[TURNING] Blocked: Egg turning is prohibited during Hatching Phase (Lockdown).")
            return
        self.latest_telemetry["actuators"]["motor"] = True
        self.latest_telemetry["next_turn_seconds"] = 0
        self._turn_sync_timestamp = time.time() + duration_sec
        self._turn_interval_remaining = 3600
        self.send_command({"cmd": "TURN_EGGS", "duration": duration_sec})
        self.motor_turned_since_last_log = True

        if self._motor_reset_timer:
            try:
                self._motor_reset_timer.cancel()
            except Exception:
                pass

        def _reset_motor_after_turn():
            if not self.latest_telemetry.get("actuators", {}).get("manual", False):
                self.latest_telemetry["actuators"]["motor"] = False

        self._motor_reset_timer = threading.Timer(duration_sec, _reset_motor_after_turn)
        self._motor_reset_timer.daemon = True
        self._motor_reset_timer.start()
        return True

    def set_phase(self, phase_str: str):
        self.latest_telemetry["phase"] = phase_str
        self.desired_phase = phase_str
        if phase_str == "HATCHING":
            self.latest_telemetry["target_temp"] = 36.9
            self.desired_temp = 36.9
            self.desired_rh = 70.0
            self.desired_co2 = 7500
            self.latest_telemetry["target_rh"] = 70.0
            self.latest_telemetry["target_co2"] = 7500
            self.latest_telemetry["next_turn_seconds"] = 0
            if "actuators" in self.latest_telemetry and isinstance(self.latest_telemetry["actuators"], dict):
                self.latest_telemetry["actuators"]["motor"] = False
            self.send_command({"cmd": "SET_PHASE", "phase": "HATCHING"})
            self.send_command({"cmd": "SET_SETPOINTS", "temp": 36.9, "rh": 70.0, "co2": 7500})
        else:
            self.latest_telemetry["target_temp"] = 37.5
            self.desired_temp = 37.5
            self.desired_rh = 58.0
            self.desired_co2 = 5000
            self.latest_telemetry["target_rh"] = 58.0
            self.latest_telemetry["target_co2"] = 5000
            self.send_command({"cmd": "SET_PHASE", "phase": "SETTING"})
            self.send_command({"cmd": "SET_SETPOINTS", "temp": 37.5, "rh": 58.0, "co2": 5000})

    def set_custom_setpoints(self, temp: float, rh: float, co2: int, o2: float = 20.9):
        self.latest_telemetry["target_temp"] = float(temp)
        self.desired_temp = float(temp)
        self.desired_rh = float(rh)
        self.desired_co2 = int(co2)
        self.latest_telemetry["target_rh"] = float(rh)
        self.latest_telemetry["target_co2"] = int(co2)
        self.latest_telemetry["target_o2"] = float(o2)
        self.send_command({"cmd": "SET_SETPOINTS", "temp": temp, "rh": rh, "co2": co2, "o2": o2})

