import os
import time
import cv2
import numpy as np
from datetime import datetime
from pathlib import Path
from config import (
    CAPTURES_DIR, GRID_ROWS, GRID_COLS, TOTAL_EGG_CAPACITY,
    CLASS_LABELS
)
from models.yolov8s_candling import YOLOv8CandlingModel

class CandlingVisionPipeline:
    def __init__(self):
        self.model = YOLOv8CandlingModel()
        self.cam = None

    def _capture_frame(self) -> np.ndarray:
        """Captures a frame using Pi Camera Module 3 (via Picamera2) or OpenCV fallback."""
        try:
            # Try Picamera2 first (Native for Raspberry Pi 5)
            from picam2 import Picamera2
            picam2 = Picamera2()
            config = picam2.create_still_configuration(main={"size": (1920, 1080)})
            picam2.configure(config)
            picam2.start()
            time.sleep(0.5) # allow auto-focus and auto-exposure to settle
            frame = picam2.capture_array()
            picam2.stop()
            picam2.close()
            # Convert RGB to BGR for OpenCV
            return cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        except Exception as e:
            # Fallback to standard OpenCV VideoCapture
            cap = cv2.VideoCapture(0)
            if cap.isOpened():
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
                ret, frame = cap.read()
                cap.release()
                if ret and frame is not None:
                    return frame

        # Synthetic Realistic 56-Egg Candling Image Generator (when running on host or camera detached)
        return self._generate_synthetic_tray_frame()

    def _generate_synthetic_tray_frame(self) -> np.ndarray:
        """Generates a realistic 1920x1080 candled egg tray simulation for testing."""
        h, w = 1080, 1920
        img = np.zeros((h, w, 3), dtype=np.uint8)
        # Dark incubator interior background
        img[:] = (18, 18, 22)

        tray_x, tray_y = 200, 100
        tray_w, tray_h = 1520, 880
        cell_w = tray_w // GRID_COLS
        cell_h = tray_h // GRID_ROWS

        for r in range(GRID_ROWS):
            for c in range(GRID_COLS):
                cx = tray_x + c * cell_w + cell_w // 2
                cy = tray_y + r * cell_h + cell_h // 2
                rx, ry = cell_w // 2 - 15, cell_h // 2 - 10

                seed = (r * 8 + c) % 100
                if seed < 86:
                    # Fertile: Deep warm orange-red with dark embryo vascular shadow
                    color = (25, 95, 235)  # BGR
                elif seed < 94:
                    # Infertile: Bright yellow-orange transparent glow
                    color = (40, 200, 245)
                else:
                    # Early dead: Blood ring motif
                    color = (30, 60, 160)

                cv2.ellipse(img, (cx, cy), (rx, ry), 0, 0, 360, color, -1)
                # Outer egg boundary
                cv2.ellipse(img, (cx, cy), (rx, ry), 0, 0, 360, (60, 60, 70), 2)
        return img

    def run_candling_audit(self, day: int) -> dict:
        """
        Executes complete multi-egg candling vision analysis across the 56-egg grid.
        """
        timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        raw_img_filename = f"candling_day{day}_{timestamp_str}_raw.jpg"
        annotated_img_filename = f"candling_day{day}_{timestamp_str}_annotated.jpg"

        raw_img_path = CAPTURES_DIR / raw_img_filename
        annotated_img_path = CAPTURES_DIR / annotated_img_filename

        # 1. Capture High-Resolution Frame
        raw_frame = self._capture_frame()
        cv2.imwrite(str(raw_img_path), raw_frame)

        annotated_frame = raw_frame.copy()
        h, w = raw_frame.shape[:2]

        tray_x, tray_y = 200, 100
        tray_w, tray_h = 1520, 880
        cell_w = tray_w // GRID_COLS
        cell_h = tray_h // GRID_ROWS

        matrix_results = []
        counts = {"fertile": 0, "infertile": 0, "early_dead": 0}

        # 2. Iterate through 7x8 Matrix Grid
        for r in range(GRID_ROWS):
            row_list = []
            for c in range(GRID_COLS):
                egg_index = r * GRID_COLS + c + 1
                x1 = max(0, tray_x + c * cell_w + 5)
                y1 = max(0, tray_y + r * cell_h + 5)
                x2 = min(w, x1 + cell_w - 10)
                y2 = min(h, y1 + cell_h - 10)

                egg_crop = raw_frame[y1:y2, x1:x2]
                pred = self.model.predict_egg_crop(egg_crop, r, c, day)
                label = pred["label"]
                conf = pred["confidence"]
                counts[label] = counts.get(label, 0) + 1

                egg_entry = {
                    "index": egg_index,
                    "row": r + 1,
                    "col": c + 1,
                    "status": label,
                    "confidence": conf,
                    "bbox": [int(x1), int(y1), int(x2), int(y2)]
                }
                row_list.append(egg_entry)

                # Color coding: Green = Fertile, Amber/Yellow = Infertile
                if label == "fertile":
                    box_color = (0, 220, 50)       # Green
                else:
                    box_color = (0, 180, 255)      # Amber/Yellow

                # Draw bounding box and label
                cv2.rectangle(annotated_frame, (x1, y1), (x2, y2), box_color, 2)
                tag = f"#{egg_index} {label[:4].upper()} {int(conf*100)}%"
                cv2.putText(annotated_frame, tag, (x1 + 4, y1 + 18), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

            matrix_results.append(row_list)

        # 3. Draw Header Summary Banner on Annotated Image
        total_eggs = TOTAL_EGG_CAPACITY
        fertile = counts["fertile"]
        infertile = counts["infertile"]
        fertility_rate = (fertile / total_eggs) * 100.0

        header_text = (f"INCUVISION DAY {day} AUDIT | Total: {total_eggs} | "
                       f"Fertile: {fertile} ({fertility_rate:.1f}%) | "
                       f"Infertile: {infertile}")
        cv2.rectangle(annotated_frame, (0, 0), (w, 50), (30, 30, 35), -1)
        cv2.putText(annotated_frame, header_text, (20, 34), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.85, (0, 240, 255), 2, cv2.LINE_AA)

        # Save annotated image
        cv2.imwrite(str(annotated_img_path), annotated_frame)

        return {
            "day": day,
            "timestamp": timestamp_str,
            "total_eggs": total_eggs,
            "fertile": counts["fertile"],
            "infertile": counts["infertile"],
            "early_dead": counts["early_dead"],
            "fertility_rate": round(fertility_rate, 2),
            "raw_image_url": f"/captures/{raw_img_filename}",
            "annotated_image_url": f"/captures/{annotated_img_filename}",
            "matrix": matrix_results
        }
