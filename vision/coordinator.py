import time
import threading
from datetime import datetime, timedelta
from config import (
    TOTAL_INCUBATION_DAYS, SETTING_DAYS_END, HATCHING_DAYS_START,
    CANDLING_SCHEDULE_DAYS
)
from logger import logger
from lcd_manager import lcd_display
from candling_pipeline import CandlingVisionPipeline

import json
from pathlib import Path

class IncubationCoordinator:
    def __init__(self, mqtt_bridge):
        self.mqtt = mqtt_bridge
        self.pipeline = CandlingVisionPipeline()
        self.state_file = Path(__file__).resolve().parent / "coordinator_state.json"
        
        self.start_time = datetime.now()
        self.current_day = 1
        self.phase = "SETTING"  # "SETTING" or "HATCHING"
        self._load_state()

        self.is_running = False
        self.is_auditing_now = False
        
        self.completed_audits = set()  # Tracks which scheduled days have been completed (e.g. {7, 10, 18})
        self.latest_audit_result = logger.get_latest_audit()
        self._lock = threading.Lock()

    def _save_state(self):
        try:
            with open(self.state_file, "w") as f:
                json.dump({
                    "day": self.current_day,
                    "phase": self.phase,
                    "start_time": self.start_time.isoformat()
                }, f, indent=2)
        except Exception as e:
            print(f"[COORDINATOR] Could not save state: {e}")

    def _load_state(self):
        if self.state_file.exists():
            try:
                with open(self.state_file, "r") as f:
                    data = json.load(f)
                    self.current_day = max(1, min(TOTAL_INCUBATION_DAYS, data.get("day", 1)))
                    self.phase = data.get("phase", "HATCHING" if self.current_day >= HATCHING_DAYS_START else "SETTING")
                    if "start_time" in data:
                        self.start_time = datetime.fromisoformat(data["start_time"])
                    else:
                        self.start_time = datetime.now() - timedelta(days=(self.current_day - 1))
                    print(f"[COORDINATOR] Restored persistent incubation state: Day {self.current_day} ({self.phase})")
                    return
            except Exception as e:
                print(f"[COORDINATOR] State load failed ({e}), starting fresh.")
        self.start_time = datetime.now()
        self.current_day = 1
        self.phase = "SETTING"

    def start(self):
        self.is_running = True
        self.worker_thread = threading.Thread(target=self._run_loop, daemon=True)
        self.worker_thread.start()
        print(f"[COORDINATOR] Incubation Master Supervisor started (Day {self.current_day}, {self.phase}).")
        # Ensure ESP32 starts with the active day, phase, and in AUTO mode
        self.mqtt.set_phase(self.phase)
        self.mqtt.send_command({"cmd": "SET_DAY", "day": self.current_day})
        self.mqtt.send_command({"cmd": "SET_MODE", "mode": "AUTO"})

    def set_start_date(self, start_dt: datetime):
        with self._lock:
            self.start_time = start_dt
            self._update_day_and_phase()
            self._save_state()

    def set_manual_day(self, day: int):
        with self._lock:
            self.current_day = max(1, min(TOTAL_INCUBATION_DAYS, day))
            self.start_time = datetime.now() - timedelta(days=(self.current_day - 1))
            self.phase = "HATCHING" if self.current_day >= HATCHING_DAYS_START else "SETTING"
            print(f"[COORDINATOR] Day set to: {self.current_day} (Phase: {self.phase})")
            self._save_state()
            self.mqtt.set_phase(self.phase)
            self.mqtt.send_command({"cmd": "SET_DAY", "day": self.current_day})
            self.mqtt.send_command({"cmd": "SET_MODE", "mode": "AUTO"})

    def _update_day_and_phase(self):
        elapsed = datetime.now() - self.start_time
        calc_day = int(elapsed.total_seconds() // 86400) + 1
        calc_day = max(1, min(TOTAL_INCUBATION_DAYS, calc_day))

        day_changed = (calc_day != self.current_day)
        self.current_day = calc_day

        new_phase = "HATCHING" if self.current_day >= HATCHING_DAYS_START else "SETTING"
        if new_phase != self.phase:
            self.phase = new_phase
            print(f"[COORDINATOR] Automatic Phase Transition -> {self.phase} (Day {self.current_day})")
            self.mqtt.set_phase(self.phase)
            self.mqtt.send_command({"cmd": "SET_DAY", "day": self.current_day})
        elif day_changed:
            self.mqtt.send_command({"cmd": "SET_DAY", "day": self.current_day})

    def trigger_candling_audit_now(self, day: int = None) -> dict:
        """Executes a full candling audit routine synchronously or via trigger."""
        if self.is_auditing_now:
            return {"error": "Candling audit already in progress"}

        with self._lock:
            self.is_auditing_now = True
            target_day = day if day is not None else self.current_day

        print(f"\n[COORDINATOR] === EXECUTING CANDLING AUDIT (DAY {target_day}) ===")
        lcd_display.display_candling_progress(target_day, "Activating Backlight")

        try:
            # 1. Turn ON high-intensity candling LED array on ESP32
            self.mqtt.set_candling_light(True)
            time.sleep(1.0)  # Wait for lighting and mechanical stabilization

            # 2. Update LCD status
            lcd_display.display_candling_progress(target_day, "YOLOv8 Scanning...")

            # 3. Capture image and run YOLOv8s inference across 56-egg grid
            audit_data = self.pipeline.run_candling_audit(target_day)

            # 4. Turn OFF high-intensity LEDs to avoid heat buildup
            self.mqtt.set_candling_light(False)

            # 5. Log audit to SQLite database
            logger.log_candling_audit(
                day=audit_data["day"],
                total_eggs=audit_data["total_eggs"],
                fertile=audit_data["fertile"],
                infertile=audit_data["infertile"],
                early_dead=audit_data["early_dead"],
                fertility_rate=audit_data["fertility_rate"],
                img_path=audit_data["raw_image_url"],
                annotated_path=audit_data["annotated_image_url"],
                matrix_data=audit_data["matrix"]
            )

            # 6. Display audit results on 20x4 LCD
            lcd_display.display_candling_result(
                target_day, audit_data["fertile"], audit_data["total_eggs"], audit_data["fertility_rate"]
            )

            self.latest_audit_result = audit_data
            self.completed_audits.add(target_day)
            print(f"[COORDINATOR] Day {target_day} candling completed. Fertility Rate: {audit_data['fertility_rate']}%\n")
            return audit_data

        except Exception as e:
            print(f"[COORDINATOR] Error during candling audit: {e}")
            self.mqtt.set_candling_light(False)
            return {"error": str(e)}
        finally:
            with self._lock:
                self.is_auditing_now = False

    def _run_loop(self):
        last_lcd_update = 0
        last_log_time = 0

        while self.is_running:
            now = time.time()
            self._update_day_and_phase()

            telem = self.mqtt.latest_telemetry
            temp = telem.get("temp", 37.5)
            rh = telem.get("rh", 58.0)
            co2 = telem.get("co2", 3200)
            o2 = telem.get("o2", 20.9)
            act = telem.get("actuators", {})

            # 1. Update 20x4 LCD every 3 seconds (when not running vision audit)
            if not self.is_auditing_now and (now - last_lcd_update >= 3.0):
                last_lcd_update = now
                lcd_display.display_home_screen(
                    day=self.current_day,
                    temp=temp,
                    rh=rh,
                    co2=co2,
                    o2=o2,
                    phase=self.phase
                )

            # 2. Log Telemetry to DB & CSV every 10 seconds
            if now - last_log_time >= 10.0:
                last_log_time = now
                logger.log_telemetry(
                    day=self.current_day,
                    temp=temp,
                    rh=rh,
                    co2=co2,
                    o2=o2,
                    heater=act.get("heater", False),
                    exhaust=act.get("exhaust", False),
                    motor=act.get("motor", False),
                    phase=self.phase
                )

            # 3. Check for Automated Scheduled Candling Audits (Day 7, 10, 18)
            if self.current_day in CANDLING_SCHEDULE_DAYS and self.current_day not in self.completed_audits:
                print(f"[COORDINATOR] Scheduled Day {self.current_day} Candling Audit triggered!")
                self.trigger_candling_audit_now(self.current_day)

            time.sleep(1.0)
