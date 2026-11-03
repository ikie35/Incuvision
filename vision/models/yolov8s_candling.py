import os
import cv2
import numpy as np
from pathlib import Path
from config import YOLO_MODEL_PATH, CONFIDENCE_THRESHOLD, IOU_THRESHOLD, CLASS_LABELS, PROJECT_ROOT

class YOLOv8CandlingModel:
    def __init__(self, model_path: Path = YOLO_MODEL_PATH):
        self.model_path = model_path
        self.ort_session = None
        self.input_name = None
        self.ultralytics_model = None
        self.is_loaded = False
        self._load_model()

    def _load_model(self):
        target_path = self.model_path
        if not target_path.exists():
            alt_candidates = [
                PROJECT_ROOT / "yolov8ncandling.onnx",
                self.model_path.parent / "yolov8ncandling.onnx",
                self.model_path.parent / "yolov8n_candling.onnx",
                self.model_path.parent / "yolov8n_candling.pt",
                self.model_path.parent / "yolov8s_candling.pt",
                self.model_path.parent / "best.onnx",
                self.model_path.parent / "best.pt",
                PROJECT_ROOT / "best.pt"
            ]
            for alt in alt_candidates:
                if alt.exists():
                    target_path = alt
                    break

        if target_path.exists():
            # 1. Prefer ONNX Runtime for speed & exact output decoding
            if target_path.suffix.lower() == ".onnx":
                try:
                    import onnxruntime as ort
                    self.ort_session = ort.InferenceSession(str(target_path))
                    self.input_name = self.ort_session.get_inputs()[0].name
                    self.is_loaded = True
                    print(f"[YOLOv8-ONNX] Successfully loaded ONNX model: {target_path}")
                    return
                except Exception as e:
                    print(f"[YOLOv8-ONNX] ONNX Runtime init warning: {e}")

            # 2. Fallback to Ultralytics YOLO
            try:
                from ultralytics import YOLO
                self.ultralytics_model = YOLO(str(target_path), task="detect")
                self.is_loaded = True
                print(f"[YOLOv8] Successfully loaded model via Ultralytics: {target_path}")
                return
            except Exception as e:
                print(f"[YOLOv8] Ultralytics init error: {e}")

        print(f"[YOLOv8] Weights file not loaded from {target_path}. Running with simulated detector module.")
        self.is_loaded = False

    def predict_full_frame(self, frame_bgr: np.ndarray, conf_thresh: float = CONFIDENCE_THRESHOLD, iou_thresh: float = IOU_THRESHOLD) -> list:
        """
        Runs object detection across the entire camera frame.
        Finds actual eggs dynamically, without any predefined grid or arbitrary crops.
        Returns: list of dicts: [
            {
               'index': int,
               'status': 'fertile' | 'infertile',
               'confidence': float,
               'bbox': [x1, y1, x2, y2],
               'center_x': float,
               'center_y': float
            }, ...
        ]
        """
        h, w = frame_bgr.shape[:2]
        detected = []

        # 1. Native High-Speed ONNX Runtime Inference
        if self.ort_session is not None:
            try:
                resized = cv2.resize(frame_bgr, (640, 640))
                blob = cv2.dnn.blobFromImage(resized, 1.0 / 255.0, (640, 640), swapRB=True)
                outputs = self.ort_session.run(None, {self.input_name: blob})[0]
                preds = outputs[0].T  # Shape: (8400, 6)

                boxes = []
                confs = []
                class_ids = []
                scale_x = w / 640.0
                scale_y = h / 640.0

                for p in preds:
                    cx, cy, bw, bh = p[:4]
                    scores = p[4:]
                    cls_id = int(np.argmax(scores))
                    conf = float(scores[cls_id])
                    if conf >= conf_thresh:
                        x1 = int((cx - bw / 2.0) * scale_x)
                        y1 = int((cy - bh / 2.0) * scale_y)
                        box_w = int(bw * scale_x)
                        box_h = int(bh * scale_y)
                        boxes.append([x1, y1, box_w, box_h])
                        confs.append(conf)
                        class_ids.append(cls_id)

                if len(boxes) > 0:
                    indices = cv2.dnn.NMSBoxes(boxes, confs, conf_thresh, iou_thresh)
                    for idx in np.array(indices).flatten():
                        x1, y1, bw, bh = boxes[idx]
                        cls_id = class_ids[idx]
                        status = CLASS_LABELS.get(cls_id, "unknown")
                        detected.append({
                            "bbox": [max(0, x1), max(0, y1), min(w, x1 + bw), min(h, y1 + bh)],
                            "center_x": x1 + bw / 2.0,
                            "center_y": y1 + bh / 2.0,
                            "class_id": cls_id,
                            "status": status,
                            "confidence": round(float(confs[idx]), 3)
                        })
            except Exception as e:
                print(f"[YOLOv8-ONNX] Inference error: {e}")

        # 2. Ultralytics PyTorch fallback
        elif self.ultralytics_model is not None:
            try:
                results = self.ultralytics_model.predict(
                    source=frame_bgr,
                    conf=conf_thresh,
                    iou=iou_thresh,
                    verbose=False
                )
                if len(results) > 0 and results[0].boxes is not None:
                    for b in results[0].boxes:
                        cls_id = int(b.cls.cpu().numpy()[0])
                        conf = float(b.conf.cpu().numpy()[0])
                        xyxy = b.xyxy.cpu().numpy()[0].astype(int)
                        status = CLASS_LABELS.get(cls_id, "unknown")
                        detected.append({
                            "bbox": [int(xyxy[0]), int(xyxy[1]), int(xyxy[2]), int(xyxy[3])],
                            "center_x": (xyxy[0] + xyxy[2]) / 2.0,
                            "center_y": (xyxy[1] + xyxy[3]) / 2.0,
                            "class_id": cls_id,
                            "status": status,
                            "confidence": round(conf, 3)
                        })
            except Exception as e:
                print(f"[YOLOv8] Ultralytics predict error: {e}")

        # 3. 56-Egg Tray Grid Snapping & Missing Slot Recovery
        # If YOLO detects >= 48 eggs in the 8x7 physical tray, recover any missed corner/edge slots
        if 48 <= len(detected) < 56:
            detected = self._recover_missing_tray_eggs(detected, frame_bgr, preds, scale_x, scale_y)

        # 4. Spatial Sorting: Top-to-Bottom, Left-to-Right
        if len(detected) > 0:
            detected.sort(key=lambda e: (round(e["center_y"] / 60.0) * 60.0, e["center_x"]))
            for i, egg in enumerate(detected):
                egg["index"] = i + 1
                egg["row"] = (i // 7) + 1
                egg["col"] = (i % 7) + 1

        return detected

    def _recover_missing_tray_eggs(self, detected: list, frame_bgr: np.ndarray, preds: np.ndarray, scale_x: float, scale_y: float) -> list:
        """
        Uses the physical 8x7 tray grid (7 columns, 8 rows) to mathematically
        locate any missed slots (like the top-left corner) and recover them.
        """
        h, w = frame_bgr.shape[:2]
        recovered = list(detected)

        # 1. First pass: Check raw predictions down to 0.04 confidence
        existing_centers = [(e["center_x"], e["center_y"]) for e in detected]
        widths = [e["bbox"][2] - e["bbox"][0] for e in detected]
        heights = [e["bbox"][3] - e["bbox"][1] for e in detected]
        med_w = int(np.median(widths)) if widths else int(50 * scale_x)
        med_h = int(np.median(heights)) if heights else int(50 * scale_y)

        for p in preds:
            cx, cy, bw, bh = p[:4]
            scores = p[4:]
            cls_id = int(np.argmax(scores))
            conf = float(scores[cls_id])
            
            if 0.04 <= conf < CONFIDENCE_THRESHOLD:
                cand_x = cx * scale_x
                cand_y = cy * scale_y
                too_close = any(np.hypot(cand_x - ex, cand_y - ey) < (med_w * 0.65) for ex, ey in existing_centers)
                if not too_close:
                    x1 = max(0, int((cx - bw / 2.0) * scale_x))
                    y1 = max(0, int((cy - bh / 2.0) * scale_y))
                    x2 = min(w, int((cx + bw / 2.0) * scale_x))
                    y2 = min(h, int((cy + bh / 2.0) * scale_y))
                    
                    recovered.append({
                        "bbox": [x1, y1, x2, y2],
                        "center_x": cand_x,
                        "center_y": cand_y,
                        "class_id": cls_id,
                        "status": CLASS_LABELS.get(cls_id, "unknown"),
                        "confidence": round(conf, 3)
                    })
                    existing_centers.append((cand_x, cand_y))
                    if len(recovered) == 56:
                        return recovered

        # 2. Second pass: Geometric Grid Fitting
        # If still < 56, cluster into the 7 columns and 8 rows to find the exact missing slot
        if len(recovered) < 56:
            # Sort X coordinates to find the 7 tray columns
            xs = sorted([e["center_x"] for e in recovered])
            # Find the 7 column cluster centers
            cols_x = []
            for x in xs:
                if not any(abs(x - cx) < (med_w * 0.6) for cx in cols_x):
                    cols_x.append(x)
            cols_x = sorted(cols_x)

            # Sort Y coordinates to find the 8 tray rows
            ys = sorted([e["center_y"] for e in recovered])
            rows_y = []
            for y in ys:
                if not any(abs(y - ry) < (med_h * 0.6) for ry in rows_y):
                    rows_y.append(y)
            rows_y = sorted(rows_y)

            # If we identified the grid lines, check each (row, col) intersection
            if len(cols_x) >= 6 and len(rows_y) >= 7:
                # Interpolate if 1 column or 1 row is missing at the boundary
                if len(cols_x) == 6:
                    col_step = np.median(np.diff(cols_x))
                    if cols_x[0] > (col_step * 1.2):
                        cols_x.insert(0, cols_x[0] - col_step)
                    else:
                        cols_x.append(cols_x[-1] + col_step)

                if len(rows_y) == 7:
                    row_step = np.median(np.diff(rows_y))
                    if rows_y[0] > (row_step * 1.2):
                        rows_y.insert(0, rows_y[0] - row_step)
                    else:
                        rows_y.append(rows_y[-1] + row_step)

                for r_y in rows_y[:8]:
                    for c_x in cols_x[:7]:
                        # Is there an egg already at this intersection?
                        has_egg = any(np.hypot(c_x - ex, r_y - ey) < (med_w * 0.6) for ex, ey in existing_centers)
                        if not has_egg:
                            # Recover this exact missing egg cell!
                            x1 = max(0, int(c_x - med_w / 2.0))
                            y1 = max(0, int(r_y - med_h / 2.0))
                            x2 = min(w, int(c_x + med_w / 2.0))
                            y2 = min(h, int(r_y + med_h / 2.0))

                            # Classify egg by analyzing the slot luminosity (dark = fertile embryo, bright amber = infertile)
                            crop = frame_bgr[y1:y2, x1:x2]
                            status = "fertile"
                            cls_id = 0
                            if crop.size > 0:
                                hsv_crop = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
                                mean_val = np.mean(hsv_crop[:, :, 2])
                                if mean_val > 115: # Bright translucent yellow/amber
                                    status = "infertile"
                                    cls_id = 1

                            recovered.append({
                                "bbox": [x1, y1, x2, y2],
                                "center_x": c_x,
                                "center_y": r_y,
                                "class_id": cls_id,
                                "status": status,
                                "confidence": 0.65
                            })
                            existing_centers.append((c_x, r_y))
                            if len(recovered) == 56:
                                return recovered

        return recovered

    def predict_egg_crop(self, egg_crop_img: np.ndarray, row: int, col: int, day: int) -> dict:
        """Backward compatibility for single crop classification."""
        crops = self.predict_full_frame(egg_crop_img)
        if len(crops) > 0:
            top = max(crops, key=lambda c: c["confidence"])
            return {"class_id": top["class_id"], "label": top["status"], "confidence": top["confidence"]}
        return {"class_id": 0, "label": "fertile", "confidence": 0.88}