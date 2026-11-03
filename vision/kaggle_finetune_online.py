# ==============================================================================
# INCUVISION: FINE-TUNE FROM PROVEN `best.pt` WITH ONLINE AUGMENTATIONS
# Platform: Kaggle GPU (T4 / P100) | Target: Raspberry Pi 5
# ==============================================================================

# 1. Install & verify environments
!pip install -q ultralytics roboflow onnx onnxruntime

import os
import shutil
import glob
import zipfile
from pathlib import Path
import onnx
from roboflow import Roboflow
from ultralytics import YOLO

# ------------------------------------------------------------------------------
# STEP 1: FETCH DATASET FROM ROBOFLOW
# ------------------------------------------------------------------------------
ROBOFLOW_API_KEY = "B9XvEYgFb9pJuCAln7MO"
WORKSPACE_ID     = "ike-russel"
PROJECT_ID       = "finetune-skerg"
VERSION_NUM      = 2

print("[1/6] Downloading dataset from Roboflow...")
rf = Roboflow(api_key=ROBOFLOW_API_KEY)
project = rf.workspace(WORKSPACE_ID).project(PROJECT_ID)
dataset = project.version(VERSION_NUM).download("yolov8")

data_yaml = f"{dataset.location}/data.yaml"
print(f"✅ Dataset Path: {dataset.location}")

# Print verified class mapping from data.yaml
with open(data_yaml, 'r') as f:
    print("\n--- DATASET YAML MAPPING ---")
    print(f.read())
    print("----------------------------\n")

# ------------------------------------------------------------------------------
# STEP 2: LOAD PROVEN PRE-TRAINED `yolov8n_candling.pt`
# ------------------------------------------------------------------------------
print("\n[2/6] Loading proven pre-trained candling weights...")
base_weights = "/kaggle/input/datasets/ikerussel/finetune/yolov8n_candling.pt"

# Verify exact path or search fallback
if not os.path.exists(base_weights):
    pt_files = glob.glob("/kaggle/input/**/yolov8n_candling.pt", recursive=True) or glob.glob("/kaggle/input/**/best.pt", recursive=True)
    if pt_files:
        base_weights = pt_files[0]
    else:
        raise FileNotFoundError(f"❌ Could not find model at: {base_weights}")

print(f"✅ Using base weights: {base_weights}")
model = YOLO(base_weights)

# ------------------------------------------------------------------------------
# STEP 3: FINE-TUNE WITH ONLINE AUGMENTATION ENABLED
# ------------------------------------------------------------------------------
print("\n[3/6] Starting fine-tuning with online augmentations on GPU...")

results = model.train(
    data=data_yaml,
    epochs=40,             # 40 epochs is ideal for fine-tuning without catastrophic forgetting
    patience=15,           # Early stopping if validation loss stops improving
    imgsz=640,
    batch=16,
    freeze=10,             # Freezes backbone layers 0-9 to protect original 653-dataset learning
    lr0=0.0005,            # Low initial learning rate for delicate domain adaptation
    lrf=0.01,
    seed=42,
    deterministic=True,    # Enforces reproducible weight optimization
    device=0,
    workers=4,
    # --- ONLINE AUGMENTATIONS (Candling-Safe) ---
    augment=True,          # Enable online augmentation pipeline during training
    fliplr=0.5,            # 50% chance horizontal flip
    flipud=0.5,            # 50% chance vertical flip
    degrees=15.0,          # ±15 degree rotation (simulates egg tilt in tray)
    translate=0.08,        # ±8% translation shift
    scale=0.10,            # ±10% scale variation
    hsv_h=0.015,           # Tiny hue shift (keeps blood vessels naturally red)
    hsv_s=0.20,            # 20% saturation variation
    hsv_v=0.25,            # 25% brightness/exposure variation (simulates LED intensity)
    mosaic=0.0,            # 0.0 for fine-tuning (keeps natural egg tray geometry intact)
    mixup=0.0,             # 0.0 to prevent overlapping egg artifacts
    # --------------------------------------------
    project="/kaggle/working/runs",
    name="pi_online_finetune",
    save=True,
    exist_ok=True
)

# ------------------------------------------------------------------------------
# STEP 4: EVALUATE BEST CHECKPOINT
# ------------------------------------------------------------------------------
print("\n[4/6] Evaluating fine-tuned model...")
run_dir = Path("/kaggle/working/runs/pi_online_finetune")
best_pt_path = run_dir / "weights" / "best.pt"
trained_model = YOLO(str(best_pt_path))
metrics = trained_model.val(data=data_yaml)

print(f"\n📊 IncuVision Fine-Tuned Performance Metrics:")
print(f"   • Mean Precision (mP) : {metrics.box.mp:.4f}")
print(f"   • Mean Recall (mR)    : {metrics.box.mr:.4f}")
print(f"   • mAP@0.50            : {metrics.box.map50:.4f}")
print(f"   • mAP@0.50:0.95       : {metrics.box.map:.4f}")

# ------------------------------------------------------------------------------
# STEP 5: EXPORT TO ONNX (OPSET 12 STATIC FOR RASPBERRY PI 5)
# ------------------------------------------------------------------------------
print("\n[5/6] Exporting to static ONNX for Raspberry Pi 5...")
onnx_exported_path = trained_model.export(
    format="onnx",
    imgsz=640,
    dynamic=False,
    simplify=True,
    opset=12               # Universal Raspberry Pi onnxruntime standard
)

# Check graph integrity
onnx_m = onnx.load(onnx_exported_path)
onnx.checker.check_model(onnx_m)
print("✅ ONNX Model Graph verified successfully.")

output_pt   = "/kaggle/working/best.pt"
output_onnx = "/kaggle/working/yolov8ncandling.onnx"
shutil.copy(str(best_pt_path), output_pt)
shutil.copy(onnx_exported_path, output_onnx)

# ------------------------------------------------------------------------------
# STEP 6: PACKAGE RESULTS INTO ZIP
# ------------------------------------------------------------------------------
print("\n[6/6] Zipping training artifacts...")
zip_filename = "/kaggle/working/candling_online_finetune_results.zip"

with zipfile.ZipFile(zip_filename, "w", zipfile.ZIP_DEFLATED) as zipf:
    zipf.write(output_onnx, arcname="weights/yolov8ncandling.onnx")
    zipf.write(output_pt, arcname="weights/best.pt")
    for f in run_dir.glob("*"):
        if f.is_file():
            zipf.write(str(f), arcname=f"evaluation/{f.name}")

print(f"✅ Created: {zip_filename}")
print("\n" + "=" * 60)
print("🎉 FINETUNING COMPLETE! Ready to download from Kaggle Output:")
print(" 1. yolov8ncandling.onnx                <-- Deploy to IncuVision")
print(" 2. candling_online_finetune_results.zip <-- Complete thesis evaluation & weights")
print("=" * 60)

