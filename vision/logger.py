import sqlite3
import csv
import io
import os
import json
from datetime import datetime
from config import DB_PATH, CSV_LOG_PATH

class DataLogger:
    def __init__(self):
        self._init_db()
        self._init_csv()

    def _init_db(self):
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # Telemetry Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS telemetry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                day INTEGER,
                temperature REAL,
                humidity REAL,
                co2 INTEGER,
                o2 REAL,
                heater_state INTEGER,
                exhaust_state INTEGER,
                motor_state INTEGER,
                phase TEXT
            )
        """)

        # Candling Audits Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS candling_audits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                day INTEGER NOT NULL,
                total_eggs INTEGER NOT NULL,
                fertile_count INTEGER NOT NULL,
                infertile_count INTEGER NOT NULL,
                early_dead_count INTEGER NOT NULL,
                fertility_rate REAL NOT NULL,
                image_path TEXT,
                annotated_image_path TEXT,
                matrix_json TEXT
            )
        """)

        conn.commit()
        conn.close()

    def _init_csv(self):
        if not os.path.exists(CSV_LOG_PATH):
            with open(CSV_LOG_PATH, mode='w', newline='') as f:
                writer = csv.writer(f)
                writer.writerow([
                    "timestamp", "day", "temperature", "humidity", 
                    "co2", "o2", "heater", "exhaust", "motor", "phase"
                ])

    def log_telemetry(self, day: int, temp: float, rh: float, co2: int, o2: float, 
                      heater: bool, exhaust: bool, motor: bool, phase: str):
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # Write to SQLite
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO telemetry (timestamp, day, temperature, humidity, co2, o2, 
                                       heater_state, exhaust_state, motor_state, phase)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (now_str, day, temp, rh, co2, o2, int(heater), int(exhaust), int(motor), phase))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[LOGGER] DB Error: {e}")

        # Write to CSV
        try:
            with open(CSV_LOG_PATH, mode='a', newline='') as f:
                writer = csv.writer(f)
                writer.writerow([now_str, day, temp, rh, co2, o2, int(heater), int(exhaust), int(motor), phase])
        except Exception as e:
            print(f"[LOGGER] CSV Error: {e}")

    def log_candling_audit(self, day: int, total_eggs: int, fertile: int, infertile: int, 
                            early_dead: int, fertility_rate: float, img_path: str, 
                            annotated_path: str, matrix_data: list):
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO candling_audits (
                    timestamp, day, total_eggs, fertile_count, infertile_count, 
                    early_dead_count, fertility_rate, image_path, annotated_image_path, matrix_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                now_str, day, total_eggs, fertile, infertile, early_dead,
                fertility_rate, str(img_path), str(annotated_path), json.dumps(matrix_data)
            ))
            conn.commit()
            conn.close()
            print(f"[LOGGER] Candling Audit Day {day} successfully logged to database.")
        except Exception as e:
            print(f"[LOGGER] Candling DB Error: {e}")

    def get_recent_telemetry(self, limit: int = 50):
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM telemetry ORDER BY id DESC LIMIT ?", (limit,))
            rows = [dict(r) for r in cursor.fetchall()]
            conn.close()
            return rows[::-1]  # Return chronological order
        except Exception as e:
            print(f"[LOGGER] Query error: {e}")
            return []

    def get_latest_audit(self):
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM candling_audits ORDER BY id DESC LIMIT 1")
            row = cursor.fetchone()
            conn.close()
            if row:
                r = dict(row)
                if r.get("matrix_json"):
                    try:
                        r["matrix"] = json.loads(r["matrix_json"])
                    except Exception:
                        pass
                if r.get("annotated_image_path"):
                    r["annotated_image_url"] = "/captures/" + os.path.basename(r["annotated_image_path"])
                if r.get("image_path"):
                    r["raw_image_url"] = "/captures/" + os.path.basename(r["image_path"])
                return r
            return None
        except Exception as e:
            print(f"[LOGGER] Audit query error: {e}")
            return None

    def delete_latest_audit(self) -> bool:
        """Deletes the most recent candling audit from the database and removes associated image files."""
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT id, image_path, annotated_image_path FROM candling_audits ORDER BY id DESC LIMIT 1")
            row = cursor.fetchone()
            if not row:
                conn.close()
                return False
            
            audit_id = row["id"]
            img_path = row["image_path"]
            ann_path = row["annotated_image_path"]

            cursor.execute("DELETE FROM candling_audits WHERE id = ?", (audit_id,))
            conn.commit()
            conn.close()

            # Clean up files on disk if present
            for p in [img_path, ann_path]:
                if p and os.path.exists(p):
                    try:
                        os.remove(p)
                    except Exception:
                        pass
            print(f"[LOGGER] Successfully deleted latest candling audit #{audit_id}.")
            return True
        except Exception as e:
            print(f"[LOGGER] Error deleting latest audit: {e}")
            return False

    def sync_days_with_start_time(self, start_time: datetime = None):
        """Retroactively aligns all telemetry records in SQLite and CSV to the 1-based Day (Day 1-21) standard."""
        if start_time is None:
            state_path = os.path.join(os.path.dirname(str(DB_PATH)), "coordinator_state.json")
            if os.path.exists(state_path):
                try:
                    with open(state_path, "r") as f:
                        data = json.load(f)
                        if data.get("schedule_active") and "start_time" in data:
                            start_time = datetime.fromisoformat(data["start_time"])
                except Exception:
                    pass

        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()

            if start_time is not None:
                cursor.execute("SELECT id, timestamp, day FROM telemetry")
                all_rows = cursor.fetchall()
                updates = []
                for row_id, ts_str, old_day in all_rows:
                    try:
                        row_dt = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S")
                        elapsed_sec = (row_dt - start_time).total_seconds()
                        if elapsed_sec >= 0:
                            new_day = max(1, min(21, int(elapsed_sec // 86400) + 1))
                        else:
                            new_day = max(1, old_day or 1)
                        if old_day != new_day:
                            updates.append((new_day, row_id))
                    except Exception:
                        if old_day is None or old_day < 1:
                            updates.append((1, row_id))
                if updates:
                    cursor.executemany("UPDATE telemetry SET day = ? WHERE id = ?", updates)
            else:
                cursor.execute("UPDATE telemetry SET day = day + 1 WHERE day >= 0 AND EXISTS (SELECT 1 FROM telemetry WHERE day = 0)")
                cursor.execute("UPDATE telemetry SET day = 1 WHERE day < 1 OR day IS NULL")

            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[LOGGER] Day sync error: {e}")

    def export_telemetry_csv_string(self, order: str = "desc") -> str:
        """Exports all telemetry records to a CSV string. Defaults to DESC (latest reading at the top)."""
        order_clause = "DESC" if order.lower() == "desc" else "ASC"
        self.sync_days_with_start_time()
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            # Clean up any initial dummy boot placeholder records (37.5C, 58%RH, 3200ppm CO2) unless motor was active
            cursor.execute("DELETE FROM telemetry WHERE co2 = 3200 AND temperature = 37.5 AND humidity = 58.0 AND motor_state = 0")
            conn.commit()

            cursor.execute(f"""
                SELECT timestamp, day, temperature, humidity, co2, o2, 
                       heater_state, exhaust_state, motor_state, phase 
                FROM telemetry 
                ORDER BY id {order_clause}
            """)
            rows = cursor.fetchall()
            conn.close()

            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(["timestamp", "day", "temperature", "humidity", "co2", "o2", "heater", "exhaust", "motor", "phase"])
            writer.writerows(rows)
            return output.getvalue()
        except Exception as e:
            print(f"[LOGGER] Export CSV Error: {e}")
            return "timestamp,day,temperature,humidity,co2,o2,heater,exhaust,motor,phase\n"

logger = DataLogger()
