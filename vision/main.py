import sys
import uvicorn
import api
from mqtt_bridge import MQTTBridge
from coordinator import IncubationCoordinator

def main():
    print("==================================================")
    print("   INCUVISION: Raspberry Pi 5 Master Engine       ")
    print("   Vision, Coordinator & Web API Service          ")
    print("==================================================")

    # 1. Initialize MQTT Bridge
    mqtt_bridge = MQTTBridge()
    mqtt_bridge.start()

    # 2. Initialize Incubation Coordinator Supervisor
    coordinator = IncubationCoordinator(mqtt_bridge)
    coordinator.start()

    # 3. Inject references into FastAPI app
    api.coordinator = coordinator
    api.mqtt_bridge = mqtt_bridge

    # 4. Start Uvicorn HTTP / WebSocket Server (Fast 2s shutdown so systemctl restart never hangs)
    print("\n[SERVER] Launching Web Dashboard & API at http://0.0.0.0:8000 ...\n")
    uvicorn.run(api.app, host="0.0.0.0", port=8000, log_level="info", timeout_graceful_shutdown=2)

if __name__ == "__main__":
    main()
