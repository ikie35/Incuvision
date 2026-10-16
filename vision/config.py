import os
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
DATASET_DIR = BASE_DIR / "dataset"
MODELS_DIR = BASE_DIR / "models"
CAPTURES_DIR = BASE_DIR / "captures"
DB_PATH = BASE_DIR / "incuvision_data.db"
CSV_LOG_PATH = BASE_DIR / "telemetry_log.csv"

# Ensure runtime directories exist
CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# MQTT Broker Settings
MQTT_BROKER_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_BROKER_PORT = int(os.getenv("MQTT_PORT", 1883))
TOPIC_TELEMETRY = "incuvision/telemetry"
TOPIC_COMMANDS = "incuvision/commands"
TOPIC_STATUS = "incuvision/status"
TOPIC_SETPOINTS = "incuvision/setpoints"

# Serial / USB Bridge Settings (Auto-fallback to USB when ESP32 is plugged into Pi)
SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/ttyUSB0")
SERIAL_BAUDRATE = int(os.getenv("SERIAL_BAUD", 115200))
ENABLE_SERIAL_BRIDGE = True

# Hardware / LCD Settings
I2C_BUS = 1
LCD_I2C_ADDR = 0x27  # Common I2C backpack address (or 0x3F)
LCD_COLS = 20
LCD_ROWS = 4

# Incubation Schedule & Parameters
TOTAL_INCUBATION_DAYS = 21
SETTING_DAYS_END = 18       # Day 1 to 18
HATCHING_DAYS_START = 19    # Day 19 to 21

# Automated Candling Audit Schedule (Days)
CANDLING_SCHEDULE_DAYS = [7, 10, 18]

# 56-Egg Matrix Grid Layout (7 Rows x 8 Columns)
GRID_ROWS = 7
GRID_COLS = 8
TOTAL_EGG_CAPACITY = GRID_ROWS * GRID_COLS  # 56 Eggs

# Model Configuration (Defaults to ONNX for fast Raspberry Pi inference)
YOLO_MODEL_PATH = PROJECT_ROOT / "yolov8ncandling.onnx"
if not YOLO_MODEL_PATH.exists():
    YOLO_MODEL_PATH = MODELS_DIR / "yolov8ncandling.onnx"
if not YOLO_MODEL_PATH.exists():
    YOLO_MODEL_PATH = MODELS_DIR / "yolov8s_candling.pt"
CONFIDENCE_THRESHOLD = 0.45
IOU_THRESHOLD = 0.50

# Class Labels for Egg Candling (Binary: Fertile vs Infertile)
CLASS_LABELS = {
    0: "fertile",         # Clear blood vessel network & visible embryo
    1: "infertile"        # Clear/unfertilized or non-viable egg
}
