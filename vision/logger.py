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
            print(f"[LOGGER] Query latest audit error: {e}")
            return None

    def export_telemetry_csv_string(self, order: str = "desc") -> str:
        """Exports all telemetry records to a CSV string. Defaults to DESC (latest reading at the top)."""
        order_clause = "DESC" if order.lower() == "desc" else "ASC"
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            # Clean up any initial dummy boot placeholder records (37.5C, 58%RH, 3200ppm CO2)
            cursor.execute("DELETE FROM telemetry WHERE co2 = 3200 AND temperature = 37.5 AND humidity = 58.0")
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
