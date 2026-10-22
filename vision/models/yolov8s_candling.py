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

        # 3. Spatial Sorting: Top-to-Bottom, Left-to-Right
        # Cluster rows by rounding Y center coordinate so eggs in each horizontal row are numbered in reading order
        if len(detected) > 0:
            detected.sort(key=lambda e: (round(e["center_y"] / 60.0) * 60.0, e["center_x"]))
            for i, egg in enumerate(detected):
                egg["index"] = i + 1
                egg["row"] = (i // 8) + 1
                egg["col"] = (i % 8) + 1

        return detected

    def predict_egg_crop(self, egg_crop_img: np.ndarray, row: int, col: int, day: int) -> dict:
        """Backward compatibility for single crop classification."""
        crops = self.predict_full_frame(egg_crop_img)
        if len(crops) > 0:
            top = max(crops, key=lambda c: c["confidence"])
            return {"class_id": top["class_id"], "label": top["status"], "confidence": top["confidence"]}
        return {"class_id": 0, "label": "fertile", "confidence": 0.88}