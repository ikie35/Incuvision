import asyncio
import json
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, Response, RedirectResponse, FileResponse, JSONResponse
from pydantic import BaseModel

from config import PROJECT_ROOT, CAPTURES_DIR
from logger import logger
from camera_manager import camera_mgr

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

class PhasePayload(BaseModel):
    phase: str  # "SETTING" or "HATCHING"

class CandlingLightPayload(BaseModel):
    state: bool

class ModePayload(BaseModel):
    mode: str  # "AUTO" or "MANUAL"

@app.get("/")
def root():
    return RedirectResponse(url="/dashboard/")

@app.get("/dashboard")
def redirect_dashboard():
    return RedirectResponse(url="/dashboard/")

@app.get("/style.css")
def root_style():
    return FileResponse(str(app_dir / "style.css"), media_type="text/css")

@app.get("/app.js")
def root_app():
    return FileResponse(str(app_dir / "app.js"), media_type="application/javascript")

@app.get("/sw.js")
def service_worker():
    return FileResponse(
        str(app_dir / "sw.js"),
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"}
    )

@app.get("/api/telemetry")
def get_telemetry():
    if not coordinator or not mqtt_bridge:
        raise HTTPException(status_code=503, detail="System initializing")
    
    telem = mqtt_bridge.get_telemetry()
    payload = {
        "day": coordinator.current_day,
        "phase": coordinator.phase,
        "is_auditing": coordinator.is_auditing_now,
        "telemetry": telem,
        "latest_audit": coordinator.latest_audit_result
    }
    return JSONResponse(
        content=payload,
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0"
        }
    )

@app.get("/api/history")
def get_history(limit: int = 60):
    return logger.get_recent_telemetry(limit)

@app.get("/api/audits")
def get_audits():
    return logger.get_all_audits()

@app.get("/api/camera/snapshot")
def get_camera_snapshot():
    telem = mqtt_bridge.get_telemetry() if mqtt_bridge else None
    jpeg_bytes = camera_mgr.get_snapshot_jpeg(overlay_telemetry=telem)
    return Response(content=jpeg_bytes, media_type="image/jpeg")

@app.get("/api/camera/stream")
def get_camera_stream():
    def get_telem():
        return mqtt_bridge.get_telemetry() if mqtt_bridge else None
    return StreamingResponse(
        camera_mgr.generate_mjpeg_stream(get_telemetry_fn=get_telem),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@app.get("/api/candling/latest")
def get_latest_candling():
    if not coordinator:
        raise HTTPException(status_code=503, detail="Coordinator not ready")
    return {
        "status": "success",
        "latest_audit": coordinator.latest_audit_result
    }

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

@app.post("/api/control/phase")
def set_incubation_phase(payload: PhasePayload):
    if not coordinator or not mqtt_bridge:
        raise HTTPException(status_code=503, detail="Coordinator not ready")
    p = payload.phase.upper()
    if p not in ("SETTING", "HATCHING"):
        raise HTTPException(status_code=400, detail="Invalid phase. Must be SETTING or HATCHING")
    if p == "HATCHING" and coordinator.current_day < 19:
        coordinator.set_manual_day(19)
    elif p == "SETTING" and coordinator.current_day >= 19:
        coordinator.set_manual_day(1)
    else:
        coordinator.phase = p
        mqtt_bridge.set_phase(p)
    return {"status": "success", "phase": coordinator.phase, "day": coordinator.current_day}

@app.post("/api/control/egg_turning")
def trigger_egg_turning(duration: int = 15):
    if not mqtt_bridge:
        raise HTTPException(status_code=503, detail="MQTT not ready")
    mqtt_bridge.trigger_egg_turning(duration)
    return {"status": "success", "message": f"Egg turning triggered for {duration}s"}

@app.post("/api/control/candling_light")
def toggle_candling_light(payload: CandlingLightPayload):
    if not mqtt_bridge:
        raise HTTPException(status_code=503, detail="MQTT not ready")
    mqtt_bridge.set_candling_light(payload.state)
    return {"status": "success", "candling_light": payload.state}

@app.post("/api/control/relay")
def control_relay(payload: RelayCommandPayload):
    if not mqtt_bridge:
        raise HTTPException(status_code=503, detail="MQTT not ready")
    if payload.actuator in mqtt_bridge.latest_telemetry["actuators"]:
        mqtt_bridge.latest_telemetry["actuators"][payload.actuator] = payload.state
    mqtt_bridge.send_command({
        "cmd": "SET_RELAY",
        "actuator": payload.actuator,
        "state": payload.state
    })
    return {"status": "success", "actuator": payload.actuator, "state": payload.state}

@app.post("/api/control/mode")
def set_control_mode(payload: ModePayload):
    if not mqtt_bridge:
        raise HTTPException(status_code=503, detail="MQTT not ready")
    mqtt_bridge.send_command({
        "cmd": "SET_MODE",
        "mode": payload.mode
    })
    return {"status": "success", "mode": payload.mode}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            if coordinator and mqtt_bridge:
                telem = mqtt_bridge.get_telemetry()
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
