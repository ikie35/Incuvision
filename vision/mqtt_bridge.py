import json
import time
import threading
import paho.mqtt.client as mqtt
from config import (
    MQTT_BROKER_HOST, MQTT_BROKER_PORT,
    TOPIC_TELEMETRY, TOPIC_COMMANDS, TOPIC_STATUS, TOPIC_SETPOINTS
)

class MQTTBridge:
    def __init__(self, on_telemetry_callback=None, on_status_callback=None):
        self.client = mqtt.Client(client_id="IncuVision_PiMaster")
        self.on_telemetry_cb = on_telemetry_callback
        self.on_status_cb = on_status_callback
        self.connected = False
        
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
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect

        try:
            print(f"[MQTT] Connecting to broker at {MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}...")
            self.client.connect_async(MQTT_BROKER_HOST, MQTT_BROKER_PORT, 60)
            self.client.loop_start()
        except Exception as e:
            print(f"[MQTT] Warning: Could not connect to local MQTT broker ({e}). Will retry in background.")

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
                # Parse types
                self.latest_telemetry["temp"] = float(data.get("temp", self.latest_telemetry["temp"]))
                self.latest_telemetry["rh"] = float(data.get("rh", self.latest_telemetry["rh"]))
                self.latest_telemetry["co2"] = int(data.get("co2", self.latest_telemetry["co2"]))
                self.latest_telemetry["o2"] = float(data.get("o2", self.latest_telemetry["o2"]))
                if "actuators" in data:
                    self.latest_telemetry["actuators"] = data["actuators"]
                self.latest_telemetry["phase"] = data.get("phase", self.latest_telemetry["phase"])
                self.latest_telemetry["uptime"] = data.get("uptime", 0)

                if self.on_telemetry_cb:
                    self.on_telemetry_cb(self.latest_telemetry)

            elif msg.topic == TOPIC_STATUS:
                if self.on_status_cb:
                    self.on_status_cb(payload_str)
        except Exception as e:
            print(f"[MQTT] Error handling message on {msg.topic}: {e}")

    def send_command(self, cmd_dict: dict):
        payload = json.dumps(cmd_dict)
        if self.connected:
            self.client.publish(TOPIC_COMMANDS, payload)
            print(f"[MQTT] Command sent to ESP32: {payload}")
        else:
            print(f"[MQTT] Not connected! Could not send command: {payload}")

    def set_candling_light(self, state: bool):
        cmd = "START_CANDLING" if state else "STOP_CANDLING"
        self.send_command({"cmd": cmd})

    def trigger_egg_turning(self, duration_sec: int = 15):
        self.send_command({"cmd": "TURN_EGGS", "duration": duration_sec})

    def set_phase(self, phase_str: str):
        self.send_command({"cmd": "SET_PHASE", "phase": phase_str})

    def set_custom_setpoints(self, temp: float, rh: float, co2: int):
        self.send_command({"cmd": "SET_SETPOINTS", "temp": temp, "rh": rh, "co2": co2})
