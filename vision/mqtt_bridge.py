import os
import re
import glob
import json
import time
import threading
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
                "alarm": False
            },
            "phase": "SETTING",
            "uptime": 0
        }

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
        if "phase" in data:
            self.latest_telemetry["phase"] = data["phase"]
        if "uptime" in data:
            self.latest_telemetry["uptime"] = data["uptime"]

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

        # 1. Parse CSV format: DATA,day,dht_temp,dht_rh,scd_temp,scd_rh,scd_co2,o2,heater,exhaust,turner
        if line.startswith("DATA"):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 8:
                try:
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

                    if len(parts) >= 11:
                        self.latest_telemetry["actuators"]["heater"] = parts[8] in ("1", "ON", "on", "True")
                        self.latest_telemetry["actuators"]["exhaust"] = parts[9] in ("1", "ON", "on", "True")
                        self.latest_telemetry["actuators"]["motor"] = parts[10] in ("1", "ON", "on", "True")

                    updated = True
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
            updated = True

        m_candling = re.search(r'CANDLING(?:\s+LED)?:\s*(ON|OFF)', line, re.IGNORECASE)
        if m_candling:
            self.latest_telemetry["actuators"]["candling"] = (m_candling.group(1).upper() == "ON")
            updated = True

        # 3. Parse JSON lines
        if line.startswith("{") and line.endswith("}"):
            try:
                data = json.loads(line)
                self._update_telemetry_dict(data)
                updated = True
            except Exception:
                pass

        if updated:
            # Trigger listener callbacks (dashboard broadcast, SQLite logger, 20x4 LCD)
            if self.on_telemetry_cb:
                self.on_telemetry_cb(self.latest_telemetry)

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
                self.serial_conn.write((payload + "\n").encode("utf-8"))
                print(f"[SERIAL] Command sent to ESP32: {payload}")
            except Exception as e:
                print(f"[SERIAL] Error sending command over serial: {e}")

    def set_candling_light(self, state: bool):
        cmd = "START_CANDLING" if state else "STOP_CANDLING"
        self.send_command({"cmd": cmd})

    def trigger_egg_turning(self, duration_sec: int = 15):
        self.send_command({"cmd": "TURN_EGGS", "duration": duration_sec})

    def set_phase(self, phase_str: str):
        self.send_command({"cmd": "SET_PHASE", "phase": phase_str})

    def set_custom_setpoints(self, temp: float, rh: float, co2: int):
        self.send_command({"cmd": "SET_SETPOINTS", "temp": temp, "rh": rh, "co2": co2})
