import time
import threading
from datetime import datetime, timedelta
from config import (
    TOTAL_INCUBATION_DAYS, SETTING_DAYS_END, HATCHING_DAYS_START,
    CANDLING_SCHEDULE_DAYS, TELEMETRY_LOG_INTERVAL_S
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
        
        self.schedule_active = False
        self.start_time = datetime.now()
        self.current_day = 1
        self.phase = "SETTING"  # "SETTING" or "HATCHING"
        self._load_state()

        self.is_running = False
        self.is_auditing_now = False
        
        self.completed_audits = set()  # Tracks which scheduled days have been completed (e.g. {7, 10, 18})
        self.latest_audit_result = logger.get_latest_audit()
        self.last_turned_hour = datetime.now().hour if datetime.now().minute > 0 else None
        self._lock = threading.Lock()

    def _save_state(self):
        try:
            with open(self.state_file, "w") as f:
                json.dump({
                    "schedule_active": self.schedule_active,
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
                    self.schedule_active = data.get("schedule_active", False)
                    if self.schedule_active:
                        self.current_day = max(1, min(TOTAL_INCUBATION_DAYS, data.get("day", 1)))
                        self.phase = data.get("phase", "HATCHING" if self.current_day >= HATCHING_DAYS_START else "SETTING")
                        if "start_time" in data:
                            self.start_time = datetime.fromisoformat(data["start_time"])
                        else:
                            self.start_time = datetime.now() - timedelta(days=max(0, self.current_day - 1))
                        self._update_day_and_phase()
                        logger.sync_days_with_start_time(self.start_time)
                        print(f"[COORDINATOR] Restored active persistent incubation state: Day {self.current_day} ({self.phase})")
                        return
                    else:
                        print("[COORDINATOR] Saved state indicates schedule is not active. Awaiting batch start.")
            except Exception as e:
                print(f"[COORDINATOR] State load failed ({e}), starting fresh.")
        self.schedule_active = False
        self.start_time = datetime.now()
        self.current_day = 1
        self.phase = "SETTING"

    def start(self):
        self.is_running = True
        self.worker_thread = threading.Thread(target=self._run_loop, daemon=True)
        self.worker_thread.start()
        print(f"[COORDINATOR] Incubation Master Supervisor started (Schedule Active: {self.schedule_active}, Day {self.current_day}, {self.phase}).")
        # Ensure ESP32 starts with the active day, phase, and in AUTO mode
        if self.schedule_active:
            self.mqtt.set_phase(self.phase)
            self.mqtt.send_command({"cmd": "SET_DAY", "day": self.current_day})
        else:
            self.mqtt.set_phase("SETTING")
            self.mqtt.send_command({"cmd": "SET_DAY", "day": 1})
        self.mqtt.send_command({"cmd": "SET_MODE", "mode": "AUTO"})

    def set_start_date(self, start_dt: datetime, phase: str = None):
        with self._lock:
            self.schedule_active = True
            self.start_time = start_dt
            self._update_day_and_phase()
            if phase in ("SETTING", "HATCHING"):
                self.phase = phase
            self._save_state()
            logger.sync_days_with_start_time(self.start_time)
            self.mqtt.set_phase(self.phase)
            self.mqtt.send_command({"cmd": "SET_DAY", "day": self.current_day})
            self.mqtt.send_command({"cmd": "SET_MODE", "mode": "AUTO"})
            print(f"[COORDINATOR] Incubation schedule applied: {self.start_time.isoformat()} (Day {self.current_day}, Phase: {self.phase})")

    def set_manual_schedule(self, day: int, hours: int = 0, minutes: int = 0, phase: str = None):
        with self._lock:
            self.schedule_active = True
            self.current_day = max(1, min(TOTAL_INCUBATION_DAYS, day))
            offset = timedelta(days=max(0, self.current_day - 1), hours=hours, minutes=minutes)
            self.start_time = datetime.now() - offset
            if phase in ("SETTING", "HATCHING"):
                self.phase = phase
            else:
                self.phase = "HATCHING" if self.current_day >= HATCHING_DAYS_START else "SETTING"
            print(f"[COORDINATOR] Incubation schedule applied: Day {self.current_day} ({hours:02d}:{minutes:02d} into day, Phase: {self.phase})")
            self._save_state()
            logger.sync_days_with_start_time(self.start_time)
            self.mqtt.set_phase(self.phase)
            self.mqtt.send_command({"cmd": "SET_DAY", "day": self.current_day})
            self.mqtt.send_command({"cmd": "SET_MODE", "mode": "AUTO"})

    def set_manual_day(self, day: int):
        self.set_manual_schedule(day=day, hours=0, minutes=0)

    def _update_day_and_phase(self):
        if not self.schedule_active:
            # Do not auto-advance day or phase if schedule has not been explicitly applied!
            return

        elapsed = datetime.now() - self.start_time
        calc_day = int(max(0.0, elapsed.total_seconds()) // 86400) + 1
        calc_day = max(1, min(TOTAL_INCUBATION_DAYS, calc_day))

        day_changed = (calc_day != self.current_day)
        self.current_day = calc_day

        new_phase = "HATCHING" if self.current_day >= HATCHING_DAYS_START else "SETTING"
        if new_phase != self.phase:
            self.phase = new_phase
            print(f"[COORDINATOR] Automatic Phase Transition -> {self.phase} (Day {self.current_day})")
            self._save_state()
            logger.sync_days_with_start_time(self.start_time)
            self.mqtt.set_phase(self.phase)
            self.mqtt.send_command({"cmd": "SET_DAY", "day": self.current_day})
        elif day_changed:
            self._save_state()
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
            time.sleep(3.0)  # Wait for lighting and mechanical stabilization (3s for camera AE/AWB settle)

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

    def discard_latest_audit(self) -> dict:
        """Discards the most recent candling audit, purging files and rolling back latest audit state."""
        with self._lock:
            deleted = logger.delete_latest_audit()
            self.latest_audit_result = logger.get_latest_audit()
            return {
                "status": "success",
                "deleted": deleted,
                "latest_audit": self.latest_audit_result
            }

    def log_telemetry_now(self, motor_override: bool = None):
        """Immediately logs the current telemetry and actuator states to SQLite and CSV."""
        if not self.mqtt:
            return
        telem = self.mqtt.latest_telemetry
        act = telem.get("actuators", {})
        motor_state = (
            motor_override
            if motor_override is not None
            else (act.get("motor", False) or getattr(self.mqtt, "motor_turned_since_last_log", False))
        )
        self.mqtt.motor_turned_since_last_log = False
        logger.log_telemetry(
            day=self.current_day if self.schedule_active else 1,
            temp=telem.get("temp", 37.5),
            rh=telem.get("rh", 58.0),
            co2=telem.get("co2", 3200),
            o2=telem.get("o2", 20.9),
            heater=act.get("heater", False),
            exhaust=act.get("exhaust", False),
            motor=motor_state,
            phase=self.phase if self.schedule_active else "STANDBY"
        )

    def _run_loop(self):
        last_lcd_update = 0
        last_log_time = 0
        last_thermal_priority_sync = 0

        while self.is_running:
            now = time.time()
            self._update_day_and_phase()

            # Wait until ESP32 delivers real live telemetry before logging dummy defaults
            if self.mqtt and not getattr(self.mqtt, "has_received_live_telemetry", False):
                time.sleep(0.5)
                continue

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
                    day=self.current_day if self.schedule_active else 1,
                    temp=temp,
                    rh=rh,
                    co2=co2,
                    o2=o2,
                    phase=self.phase if self.schedule_active else "STANDBY"
                )

            # 2. Log Telemetry to DB & CSV every 60 seconds (1 minute interval)
            if now - last_log_time >= TELEMETRY_LOG_INTERVAL_S:
                last_log_time = now
                self.log_telemetry_now()

            # 3. Emergency Overheat Watchdog: if manual mode is active and temp >= 38.0°C, force revert to AUTO
            if temp >= 38.0 and act.get("manual", False):
                print(f"[COORDINATOR SAFETY] Critical temp {temp}°C in MANUAL mode! Force-reverting to AUTOMATIC.")
                if self.mqtt:
                    self.mqtt.latest_telemetry["actuators"]["manual"] = False
                    self.mqtt.send_command({"cmd": "SET_MODE", "mode": "AUTO"})
                    self.mqtt.send_command({"cmd": "SET_RELAY", "actuator": "heater", "state": False})
                    self.mqtt.send_command({"cmd": "SET_RELAY", "actuator": "exhaust", "state": True})

            # 3b. Strict Temperature Priority Supervisor (Every 10s in AUTO mode):
            # - Ensures ESP32 target_temp is synced to the active phase (37.5°C Setting / 36.9°C Hatching)
            # - If chamber temperature is below target_temp, suppresses humidity-triggered exhaust venting
            #   by raising the ESP32 humidity ceiling to 90% until target_temp is reached.
            if self.mqtt and not act.get("manual", False) and (now - last_thermal_priority_sync >= 10.0):
                last_thermal_priority_sync = now
                desired_t = getattr(self.mqtt, "desired_temp", 36.9 if self.phase == "HATCHING" else 37.5)
                desired_rh = getattr(self.mqtt, "desired_rh", 70.0 if self.phase == "HATCHING" else 58.0)
                desired_co2 = getattr(self.mqtt, "desired_co2", 7500 if self.phase == "HATCHING" else 5000)
                reported_t = telem.get("target_temp", desired_t)
                reported_rh = telem.get("target_rh", desired_rh)

                if temp < desired_t:
                    # Chamber is under target temperature: prioritize heating 100% and prevent RH exhaust venting
                    if abs(reported_t - desired_t) > 0.05 or reported_rh < 85.0 or act.get("exhaust", False):
                        self.mqtt.send_command({
                            "cmd": "SET_SETPOINTS",
                            "temp": desired_t,
                            "rh": 90.0,
                            "co2": desired_co2
                        })
                else:
                    # Target temperature reached: restore normal RH target on ESP32 if it was raised
                    if abs(reported_t - desired_t) > 0.05 or abs(reported_rh - desired_rh) > 1.0:
                        self.mqtt.send_command({
                            "cmd": "SET_SETPOINTS",
                            "temp": desired_t,
                            "rh": desired_rh,
                            "co2": desired_co2
                        })

            # 4. Top-of-the-Hour Automatic Egg Turning (XX:00:00 every hour in Setting Phase when batch is active)
            now_dt = datetime.now()
            current_hour = now_dt.hour
            if self.schedule_active and self.phase != "HATCHING" and not self.is_auditing_now:
                if now_dt.minute == 0 and self.last_turned_hour != current_hour:
                    print(f"[COORDINATOR] Top of the hour ({now_dt.strftime('%H:%M')}): Triggering automatic egg turning.")
                    self.last_turned_hour = current_hour
                    if self.mqtt:
                        if self.mqtt.trigger_egg_turning(15):
                            self.log_telemetry_now(motor_override=True)
                            last_log_time = now

            # 5. Check for Automated Scheduled Candling Audits (Day 7, 10, 18 when batch is active)
            if self.schedule_active and self.current_day in CANDLING_SCHEDULE_DAYS and self.current_day not in self.completed_audits:
                print(f"[COORDINATOR] Scheduled Day {self.current_day} Candling Audit triggered!")
                self.trigger_candling_audit_now(self.current_day)

            time.sleep(1.0)
