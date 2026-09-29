"""
IncuVision: Egg Candling AI Model Training Pipeline
Supports:
  1. Binary Classification:
       0: fertile   (Developed - blood vessels, embryo eye/body, dark opacity)
       1: infertile (Undeveloped / Clear / Non-viable)
  2. Multi-Day Representation:
       Day 3/4 (initial blood islands), Day 7 (spider veins), Day 10/14 (embryo body), Day 18 (opaque)
"""

import os
import sys
import argparse
from pathlib import Path
from ultralytics import YOLO

# Project paths
BASE_DIR = Path(__file__).resolve().parent
DATASET_DIR = BASE_DIR / "dataset"
MODELS_DIR = BASE_DIR / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_CONFIG_YAML = DATASET_DIR / "data.yaml"

def create_sample_data_yaml(yaml_path: Path, dataset_root: Path, binary_only: bool = True):
    """Creates standard YOLO detection dataset config YAML."""
    if binary_only:
        content = f"""# IncuVision Binary Candling Dataset (Fertile vs Infertile)
path: {dataset_root.as_posix()}
train: images/train
val: images/val
test: images/test

names:
  0: fertile      # Developed (vessels, embryo mass, dark opacity across Days 3-18)
  1: infertile    # Undeveloped / Clear / Unfertilized
"""
    else:
        content = f"""# IncuVision 3-Class Candling Dataset
path: {dataset_root.as_posix()}
train: images/train
val: images/val
test: images/test

names:
  0: fertile
  1: infertile
  2: early_dead
"""
    yaml_path.parent.mkdir(parents=True, exist_ok=True)
    with open(yaml_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"[Dataset] Created dataset YAML (binary_only={binary_only}) at: {yaml_path}")

def train_detection(
    data_yaml: Path,
    epochs: int = 100,
    img_size: int = 640,
    batch_size: int = 16,
    base_model: str = "yolov8s.pt",
    device: str = "0",
    output_model_name: str = "yolov8s_candling.pt"
):
    """
    Trains a YOLOv8 object detection model on multi-day candled egg trays.
    """
    print("=" * 60)
    print(f"🚀 Starting IncuVision YOLOv8 Detection Training (Multi-Day Candling)")
    print(f"Base Model : {base_model}")
    print(f"Data YAML  : {data_yaml}")
    print(f"Epochs     : {epochs} | Batch: {batch_size} | ImgSize: {img_size}")
    print("=" * 60)

    model = YOLO(base_model)
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=img_size,
        batch=batch_size,
        device=device,
        workers=4,
        # Augmentations customized for multi-day egg candling:
        hsv_h=0.015,     # Color hue jitter
        hsv_s=0.2,       # Color saturation variations
        hsv_v=0.3,       # Exposure / brightness variations
        degrees=15.0,    # Rotation
        translate=0.1,   # Translation
        scale=0.2,       # Scale variation
        fliplr=0.5,      # Horizontal flip
        flipud=0.5,      # Vertical flip
        mosaic=0.5,      # Mosaic augmentations across multi-day samples
        project=str(MODELS_DIR / "runs_detection"),
        name="candling_experiment",
        save=True,
        exist_ok=True
    )

    # Copy best weights to vision/models/
    best_weights = Path(results.save_dir) / "weights" / "best.pt"
    dest_path = MODELS_DIR / output_model_name
    if best_weights.exists():
        import shutil
        shutil.copy(best_weights, dest_path)
        print(f"\n[Success] ✅ Best model saved to: {dest_path}")
    
    return results

def train_classification(
    dataset_dir: Path,
    epochs: int = 50,
    img_size: int = 224,
    batch_size: int = 32,
    base_model: str = "yolov8n-cls.pt",
    device: str = "0",
    output_model_name: str = "yolov8s_candling.pt"
):
    """
    Trains a YOLOv8 classification model on individual cropped egg images across days:
      dataset/
        ├── train/
        │   ├── fertile/    (contains Day 3, 7, 10, 14, 18 developed egg crops)
        │   └── infertile/  (contains Day 3, 7, 10, 14, 18 clear egg crops)
        └── val/
            ├── fertile/
            └── infertile/
    """
    print("=" * 60)
    print(f"🚀 Starting IncuVision YOLOv8-Cls Binary Training (Crop Classification)")
    print(f"Base Model : {base_model}")
    print(f"Dataset Dir: {dataset_dir}")
    print(f"Epochs     : {epochs} | Batch: {batch_size} | ImgSize: {img_size}")
    print("=" * 60)

    model = YOLO(base_model)
    results = model.train(
        data=str(dataset_dir),
        epochs=epochs,
        imgsz=img_size,
        batch=batch_size,
        device=device,
        workers=4,
        project=str(MODELS_DIR / "runs_classification"),
        name="candling_cls_experiment",
        save=True,
        exist_ok=True
    )

    best_weights = Path(results.save_dir) / "weights" / "best.pt"
    dest_path = MODELS_DIR / output_model_name
    if best_weights.exists():
        import shutil
        shutil.copy(best_weights, dest_path)
        print(f"\n[Success] ✅ Best classifier model saved to: {dest_path}")

    return results

def export_model_for_raspberry_pi(model_path: Path):
    """Exports trained weights to ONNX format for high-efficiency inference on Raspberry Pi 5."""
    if not model_path.exists():
        print(f"[Export Error] Model weights not found at {model_path}")
        return
    print(f"[Export] Exporting {model_path} to ONNX format...")
    model = YOLO(str(model_path))
    onnx_path = model.export(format="onnx", imgsz=640, dynamic=False)
    print(f"[Export] ✅ ONNX model created at: {onnx_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train IncuVision Egg Candling AI Model")
    parser.add_argument("--mode", choices=["detect", "classify"], default="detect",
                        help="Training mode: 'detect' (tray object detection) or 'classify' (single egg crops)")
    parser.add_argument("--classes", choices=["binary", "all"], default="binary",
                        help="Class setup: 'binary' (fertile vs infertile) or 'all' (fertile, infertile, early_dead)")
    parser.add_argument("--epochs", type=int, default=100, help="Number of training epochs")
    parser.add_argument("--batch", type=int, default=16, help="Batch size")
    parser.add_argument("--imgsz", type=int, default=640, help="Image resolution")
    parser.add_argument("--model", type=str, default="yolov8s.pt", help="Base model backbone (e.g. yolov8s.pt, yolov8n.pt)")
    parser.add_argument("--device", type=str, default="cpu", help="Device: 'cpu', '0' for GPU 0, etc.")
    parser.add_argument("--export-onnx", action="store_true", help="Export to ONNX after training for Raspberry Pi 5")

    args = parser.parse_args()

    if args.mode == "detect":
        is_binary = (args.classes == "binary")
        create_sample_data_yaml(DEFAULT_CONFIG_YAML, DATASET_DIR, binary_only=is_binary)
        train_detection(
            data_yaml=DEFAULT_CONFIG_YAML,
            epochs=args.epochs,
            img_size=args.imgsz,
            batch_size=args.batch,
            base_model=args.model,
            device=args.device
        )
    else:
        train_classification(
            dataset_dir=DATASET_DIR,
            epochs=args.epochs,
            img_size=args.imgsz,
            batch_size=args.batch,
            base_model="yolov8s-cls.pt" if "s" in args.model else "yolov8n-cls.pt",
            device=args.device
        )

    if args.export_onnx:
        export_model_for_raspberry_pi(MODELS_DIR / "yolov8s_candling.pt")
