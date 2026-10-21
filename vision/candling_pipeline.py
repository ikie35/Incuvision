import os
import time
import cv2
import numpy as np
from datetime import datetime
from pathlib import Path
from config import CAPTURES_DIR, CLASS_LABELS
from models.yolov8s_candling import YOLOv8CandlingModel
from camera_manager import camera_mgr

class CandlingVisionPipeline:
    def __init__(self):
        self.model = YOLOv8CandlingModel()

    def _capture_frame(self) -> np.ndarray:
        """Captures a full-frame image using the CameraManager."""
        frame = camera_mgr.capture_raw_frame()
        if frame is not None:
            return frame
        return camera_mgr._generate_interior_simulation()

    def run_candling_audit(self, day: int) -> dict:
        """
        Executes dynamic YOLOv8 multi-egg candling vision detection across the ENTIRE chamber.
        Does not use any hardcoded grids — bounding boxes are placed ONLY where eggs exist.
        """
        timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        raw_img_filename = f"candling_day{day}_{timestamp_str}_raw.jpg"
        annotated_img_filename = f"candling_day{day}_{timestamp_str}_annotated.jpg"

        raw_img_path = CAPTURES_DIR / raw_img_filename
        annotated_img_path = CAPTURES_DIR / annotated_img_filename

        # 1. Capture Full-Resolution Frame
        raw_frame = self._capture_frame()
        cv2.imwrite(str(raw_img_path), raw_frame)

        annotated_frame = raw_frame.copy()
        h, w = raw_frame.shape[:2]

        # 2. Run Dynamic Object Detection across the 100% full chamber frame
        detected_eggs = self.model.predict_full_frame(raw_frame)

        counts = {"fertile": 0, "infertile": 0, "early_dead": 0}

        # 3. Draw bounding boxes strictly on detected eggs
        for egg in detected_eggs:
            x1, y1, x2, y2 = egg["bbox"]
            label = egg["status"]
            conf = egg["confidence"]
            idx = egg["index"]

            counts[label] = counts.get(label, 0) + 1

            # Color coding: Green for Fertile, Amber for Infertile
            if label == "fertile":
                box_color = (0, 220, 50)       # Green
            else:
                box_color = (0, 180, 255)      # Amber/Orange

            # Draw smooth bounding box
            cv2.rectangle(annotated_frame, (x1, y1), (x2, y2), box_color, 2)

            # Draw label tag with dark background pill for high contrast
            tag = f"#{idx} {label[:4].upper()} {int(conf * 100)}%"
            (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            cv2.rectangle(annotated_frame, (x1, max(0, y1 - 20)), (x1 + tw + 6, max(20, y1)), box_color, -1)
            cv2.putText(annotated_frame, tag, (x1 + 3, max(15, y1 - 5)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1, cv2.LINE_AA)

        # 4. Draw Header Summary Banner on Annotated Image
        total_detected = len(detected_eggs)
        fertile = counts["fertile"]
        infertile = counts["infertile"]
        fertility_rate = (fertile / total_detected * 100.0) if total_detected > 0 else 0.0

        header_text = (f"INCUVISION DAY {day} AUDIT | Detected: {total_detected} | "
                       f"Fertile: {fertile} ({fertility_rate:.1f}%) | "
                       f"Infertile: {infertile}")
        
        banner_h = 50
        cv2.rectangle(annotated_frame, (0, 0), (w, banner_h), (25, 25, 30), -1)
        cv2.putText(annotated_frame, header_text, (20, 34),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.85, (0, 240, 255), 2, cv2.LINE_AA)

        # Save annotated image
        cv2.imwrite(str(annotated_img_path), annotated_frame)
        print(f"[PIPELINE] Audit Day {day} complete. Detected {total_detected} eggs. Fertile: {fertile}, Infertile: {infertile}")

        return {
            "day": day,
            "timestamp": timestamp_str,
            "total_eggs": total_detected,
            "fertile": fertile,
            "infertile": infertile,
            "early_dead": counts.get("early_dead", 0),
            "fertility_rate": round(fertility_rate, 2),
            "raw_image_url": f"/captures/{raw_img_filename}",
            "annotated_image_url": f"/captures/{annotated_img_filename}",
            "matrix": detected_eggs
        }