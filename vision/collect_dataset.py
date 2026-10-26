"""
IncuVision: Automated In-Chamber Dataset Collector for Model Refinement
Captures real candling images directly from the Raspberry Pi camera under actual
candling LED lighting conditions, and packages/uploads them for Roboflow training.

Usage:
  # 1. Capture a single candling shot for Day 7 (activates lights, captures, turns off lights):
  python collect_dataset.py --capture --day 7

  # 2. Capture a burst of 5 shots with minor delay (for varying angles/lighting):
  python collect_dataset.py --capture --day 7 --burst 5

  # 3. Zip all collected captures for easy 1-click download from web dashboard:
  python collect_dataset.py --zip

  # 4. Upload directly to Roboflow workspace:
  python collect_dataset.py --upload-roboflow
"""

import os
import sys
import time
import json
import zipfile
import argparse
from datetime import datetime
from pathlib import Path
import cv2

# Local imports
from config import CAPTURES_DIR, MQTT_BROKER_HOST, MQTT_BROKER_PORT, TOPIC_COMMANDS
from camera_manager import camera_mgr

DATASET_COLLECT_DIR = CAPTURES_DIR / "dataset"
DATASET_COLLECT_DIR.mkdir(parents=True, exist_ok=True)


def set_candling_light(state: bool):
    """Sends command to ESP32 to turn candling LEDs ON or OFF."""
    try:
        import paho.mqtt.publish as publish
        payload = json.dumps({"cmd": "SET_CANDLING", "state": state})
        publish.single(
            TOPIC_COMMANDS,
            payload=payload,
            hostname=MQTT_BROKER_HOST,
            port=MQTT_BROKER_PORT,
            keepalive=5
        )
        print(f"[LIGHT] Candling LED Array -> {'ON' if state else 'OFF'}")
    except Exception as e:
        print(f"[LIGHT] Warning: Could not send light command via MQTT ({e}). Ensure lights are on manually.")


def capture_candling_frame(day: int, notes: str = "") -> Path:
    """Activates backlight, captures raw full-resolution frame from Pi camera, and turns off light."""
    # 1. Turn on candling lights
    set_candling_light(True)
    # Give LEDs and camera auto-exposure time to stabilize (1.5s)
    time.sleep(1.5)

    # 2. Capture frame
    frame = camera_mgr.capture_raw_frame()

    # 3. Turn off candling lights to prevent heating the chamber
    set_candling_light(False)

    if frame is None:
        print("[ERROR] Camera failed to capture a frame.")
        return None

    # 4. Save file
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    note_suffix = f"_{notes}" if notes else ""
    filename = f"real_day{day:02d}_{timestamp}{note_suffix}.jpg"
    dest_path = DATASET_COLLECT_DIR / filename

    cv2.imwrite(str(dest_path), frame)
    print(f"[SAVED] ✅ Captured real image: {dest_path} ({frame.shape[1]}x{frame.shape[0]})")
    return dest_path


def package_to_zip() -> Path:
    """Zips all captured dataset images into a single downloadable zip file."""
    zip_dest = CAPTURES_DIR / "candling_dataset.zip"
    images = list(DATASET_COLLECT_DIR.glob("*.jpg")) + list(DATASET_COLLECT_DIR.glob("*.png"))

    if not images:
        print("[ZIP] No images found in dataset folder to package.")
        return None

    with zipfile.ZipFile(str(zip_dest), "w", zipfile.ZIP_DEFLATED) as zf:
        for img_path in images:
            zf.write(img_path, arcname=img_path.name)

    size_mb = zip_dest.stat().st_size / (1024 * 1024)
    print(f"\n[ZIP] ✅ Packaged {len(images)} images into: {zip_dest} ({size_mb:.2f} MB)")
    print(f"[DOWNLOAD] Access via your dashboard at: /captures/candling_dataset.zip")
    return zip_dest


def upload_to_roboflow(api_key: str = "B9XvEYgFb9pJuCAln7MO", project_id: str = "incuvision-8gmod-gdfwh"):
    """Uploads collected real images to Roboflow for bounding box annotation."""
    try:
        from roboflow import Roboflow
    except ImportError:
        print("[ROBOFLOW] 'roboflow' package not installed. Run: pip install roboflow")
        return

    images = sorted(list(DATASET_COLLECT_DIR.glob("*.jpg")) + list(DATASET_COLLECT_DIR.glob("*.png")))
    if not images:
        print("[ROBOFLOW] No images found to upload.")
        return

    print(f"\n[ROBOFLOW] Connecting to project '{project_id}'...")
    rf = Roboflow(api_key=api_key)
    workspace = rf.workspace("ike-russel")
    project = workspace.project(project_id)

    uploaded = 0
    history_file = DATASET_COLLECT_DIR / ".uploaded_history.txt"
    already_uploaded = set()
    if history_file.exists():
        already_uploaded = set(history_file.read_text().splitlines())

    for img_path in images:
        if img_path.name in already_uploaded:
            continue

        print(f"[ROBOFLOW] Uploading: {img_path.name}...")
        try:
            project.upload(image_path=str(img_path), num_retry_attempts=3)
            uploaded += 1
            already_uploaded.add(img_path.name)
            time.sleep(0.5)
        except Exception as e:
            print(f"[ROBOFLOW] Error uploading {img_path.name}: {e}")

    with open(history_file, "w") as f:
        f.write("\n".join(already_uploaded))

    print(f"\n[ROBOFLOW] ✅ Upload complete! {uploaded} new images added to Roboflow project.")
    print("👉 Go to https://app.roboflow.com/ to annotate boxes and classes.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="IncuVision In-Chamber Candling Dataset Collector")
    parser.add_argument("--capture", action="store_true", help="Trigger camera capture with candling lights")
    parser.add_argument("--day", type=int, default=7, help="Incubation milestone day (e.g. 3, 7, 10, 14, 18)")
    parser.add_argument("--burst", type=int, default=1, help="Number of consecutive captures to take")
    parser.add_argument("--notes", type=str, default="", help="Optional tag (e.g. 'batch1', 'dark_room')")
    parser.add_argument("--zip", action="store_true", help="Package all captured images into a downloadable zip file")
    parser.add_argument("--upload-roboflow", action="store_true", help="Upload captured images directly to Roboflow")

    args = parser.parse_args()

    if args.capture:
        for i in range(args.burst):
            if args.burst > 1:
                print(f"\n--- Burst Shot {i+1} of {args.burst} ---")
            capture_candling_frame(day=args.day, notes=args.notes)
            if i < args.burst - 1:
                time.sleep(2.0)

    if args.zip:
        package_to_zip()

    if args.upload_roboflow:
        upload_to_roboflow()

    if not args.capture and not args.zip and not args.upload_roboflow:
        parser.print_help()
