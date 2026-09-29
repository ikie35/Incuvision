import asyncio
import json
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import PROJECT_ROOT, CAPTURES_DIR
from logger import logger

app = FastAPI(title="IncuVision Smart Incubator API", version="1.0.0")

# Enable CORS for mobile app & dashboard
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Reference to global coordinator & mqtt bridge (injected at main.py startup)
coordinator = None
mqtt_bridge = None

# Serve static web app and captured candling images
app_dir = PROJECT_ROOT / "app"
app.mount("/captures", StaticFiles(directory=str(CAPTURES_DIR)), name="captures")
app.mount("/dashboard", StaticFiles(directory=str(app_dir), html=True), name="app")

class SetpointsPayload(BaseModel):
    temp: float
    rh: float
    co2: int

class RelayCommandPayload(BaseModel):
    actuator: str  # "heater", "exhaust", "circulate", "motor", "candling"
    state: bool

class DayPayload(BaseModel):
    day: int

@app.get("/")
def root():
    return {"message": "IncuVision API is running. Access dashboard at /dashboard/"}

@app.get("/api/telemetry")
def get_telemetry():
    if not coordinator or not mqtt_bridge:
        raise HTTPException(status_code=503, detail="System initializing")
    
    telem = mqtt_bridge.latest_telemetry
    return {
        "day": coordinator.current_day,
        "phase": coordinator.phase,
        "is_auditing": coordinator.is_auditing_now,
        "telemetry": telem,
        "latest_audit": coordinator.latest_audit_result
    }

@app.get("/api/history")
def get_history(limit: int = 60):
    return logger.get_recent_telemetry(limit)

@app.get("/api/audits")
def get_audits():
    return logger.get_all_audits()

@app.post("/api/candling/trigger")
def trigger_candling():
    if not coordinator:
        raise HTTPException(status_code=503, detail="Coordinator not ready")
    if coordinator.is_auditing_now:
        return {"status": "error", "message": "Candling audit already running"}
    
    # Run in background or immediate
    res = coordinator.trigger_candling_audit_now()
    return {"status": "success", "result": res}

@app.post("/api/control/setpoints")
def update_setpoints(payload: SetpointsPayload):
    if not mqtt_bridge:
        raise HTTPException(status_code=503, detail="MQTT not ready")
    mqtt_bridge.set_custom_setpoints(payload.temp, payload.rh, payload.co2)
    return {"status": "success", "message": "Setpoints sent to ESP32"}

@app.post("/api/control/day")
def set_incubation_day(payload: DayPayload):
    if not coordinator:
        raise HTTPException(status_code=503, detail="Coordinator not ready")
    coordinator.set_manual_day(payload.day)
    return {"status": "success", "day": coordinator.current_day, "phase": coordinator.phase}

@app.post("/api/control/egg_turning")
def trigger_egg_turning(duration: int = 15):
    if not mqtt_bridge:
        raise HTTPException(status_code=503, detail="MQTT not ready")
    mqtt_bridge.trigger_egg_turning(duration)
    return {"status": "success", "message": f"Egg turning triggered for {duration}s"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            if coordinator and mqtt_bridge:
                telem = mqtt_bridge.latest_telemetry
                payload = {
                    "day": coordinator.current_day,
                    "phase": coordinator.phase,
                    "is_auditing": coordinator.is_auditing_now,
                    "telemetry": telem,
                    "latest_audit": coordinator.latest_audit_result
                }
                await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] Disconnect: {e}")
