# ==============================================================================
# INCUVISION: PRODUCTION-STANDARD CANDLING TRAINING & ONNX EXPORT PIPELINE
# Platform: Kaggle GPU (T4 / P100) | Target: Raspberry Pi 5 Edge Inference
# Dataset: Roboflow ike-russel / incuvision-8gmod-gdfwh (v4)
# ==============================================================================

# 1. Install & verify environments
!pip install -q ultralytics roboflow onnx onnxruntime

import os
import shutil
import zipfile
from pathlib import Path
import onnx
from roboflow import Roboflow
from ultralytics import YOLO

# ------------------------------------------------------------------------------
# STEP 1: FETCH DATASET (ROBOFLOW API - VERSION 4)
# ------------------------------------------------------------------------------
ROBOFLOW_API_KEY = "B9XvEYgFb9pJuCAln7MO"
WORKSPACE_ID     = "ike-russel"
PROJECT_ID       = "incuvision-8gmod-gdfwh"
VERSION_NUM      = 4

print("[1/6] Downloading dataset v4 from Roboflow...")
rf = Roboflow(api_key=ROBOFLOW_API_KEY)
project = rf.workspace(WORKSPACE_ID).project(PROJECT_ID)
dataset = project.version(VERSION_NUM).download("yolov8")

data_yaml = f"{dataset.location}/data.yaml"
print(f"✅ Dataset Path: {dataset.location}")

# Print out class names confirmed in the downloaded YAML
with open(data_yaml, 'r') as f:
    print("\n--- DATASET YAML INFO ---")
    print(f.read())
    print("-------------------------\n")

# ------------------------------------------------------------------------------
# STEP 2: MODEL TRAINING (STRICT OFFLINE AUGMENTATION)
# ------------------------------------------------------------------------------
print("\n[2/6] Training YOLOv8n (Offline Augmentations only)...")
model = YOLO("yolov8n.pt")

results = model.train(
    data=data_yaml,
    epochs=100,            # Standard training duration
    patience=20,           # Early stopping to prevent overfitting
    imgsz=640,             # Static 640x640 resolution
    batch=16,              # Standard batch size for Kaggle GPU
    seed=42,               # Reproducible seed
    deterministic=True,    # Reproducible weight initialization
    device=0,
    workers=4,
    # --- Disable all online runtime augmentations ---
    augment=False,
    hsv_h=0.0,
    hsv_s=0.0,
    hsv_v=0.0,
    degrees=0.0,
    translate=0.0,
    scale=0.0,
    shear=0.0,
    perspective=0.0,
    flipud=0.0,
    fliplr=0.0,
    mosaic=0.0,
    mixup=0.0,
    copy_paste=0.0,
    erasing=0.0,
    # -----------------------------------------------
    project="/kaggle/working/runs",
    name="incuvision_v4_candling",
    save=True,
    exist_ok=True
)

# ------------------------------------------------------------------------------
# STEP 3: FORMAL VALIDATION EVALUATION
# ------------------------------------------------------------------------------
print("\n[3/6] Evaluating Best Model Checkpoint...")
run_dir = Path("/kaggle/working/runs/incuvision_v4_candling")
best_weights = run_dir / "weights" / "best.pt"
trained_model = YOLO(str(best_weights))
metrics = trained_model.val(data=data_yaml)

print(f"\n📊 IncuVision Model Performance Report:")
print(f"   • Precision (P) : {metrics.box.p[0]:.4f}")
print(f"   • Recall (R)    : {metrics.box.r[0]:.4f}")
print(f"   • mAP@0.50      : {metrics.box.map50:.4f}")
print(f"   • mAP@0.50:0.95 : {metrics.box.map:.4f}")

# ------------------------------------------------------------------------------
# STEP 4: EXPORT TO ONNX (OPSET 12 COMPLIANT FOR PI 5)
# ------------------------------------------------------------------------------
print("\n[4/6] Exporting to standard ONNX (opset=12, static 640x640)...")
onnx_exported_path = trained_model.export(
    format="onnx",
    imgsz=640,
    dynamic=False,
    simplify=True,         # Optimizes ONNX graph for faster Pi inference
    opset=12               # Universal standard compatible with Raspberry Pi ONNX Runtime
)

# ------------------------------------------------------------------------------
# STEP 5: ONNX INTEGRITY CHECK
# ------------------------------------------------------------------------------
print("\n[5/6] Validating ONNX graph integrity...")
onnx_model = onnx.load(onnx_exported_path)
onnx.checker.check_model(onnx_model)
print("✅ ONNX Model Graph verified successfully (No structural faults).")

# Copy individual key deployment artifacts to root for direct download
output_pt   = "/kaggle/working/best.pt"
output_onnx = "/kaggle/working/yolov8ncandling.onnx"
shutil.copy(str(best_weights), output_pt)
shutil.copy(onnx_exported_path, output_onnx)

# ------------------------------------------------------------------------------
# STEP 6: ZIP RESEARCH RESULTS (GRAPHS, METRICS, CONFUSION MATRIX, WEIGHTS)
# ------------------------------------------------------------------------------
print("\n[6/6] Packaging research artifacts into zip...")
zip_filename = "/kaggle/working/incuvision_v4_training_results.zip"

with zipfile.ZipFile(zip_filename, "w", zipfile.ZIP_DEFLATED) as zipf:
    # 1. Add Model Weights (PyTorch + ONNX)
    if os.path.exists(output_onnx):
        zipf.write(output_onnx, arcname="weights/yolov8ncandling.onnx")
    if os.path.exists(output_pt):
        zipf.write(output_pt, arcname="weights/best.pt")
    last_weights = run_dir / "weights" / "last.pt"
    if last_weights.exists():
        zipf.write(str(last_weights), arcname="weights/last.pt")

    # 2. Add All Graphs, Confusion Matrices, and CSV Logs
    for file in run_dir.glob("*"):
        if file.is_file():
            # Includes results.png, confusion_matrix.png, confusion_matrix_normalized.png,
            # F1_curve.png, PR_curve.png, P_curve.png, R_curve.png, results.csv, args.yaml
            zipf.write(str(file), arcname=f"evaluation/{file.name}")

print(f"✅ Created Zip Archive: {zip_filename}")
print(f"   Size: {os.path.getsize(zip_filename) / (1024*1024):.2f} MB")

print("\n" + "=" * 60)
print("🎯 ALL COMPLETE! Files ready in Kaggle Output pane:")
print(f" 📦 1. incuvision_v4_training_results.zip  <-- Everything (weights + graphs + thesis metrics)")
print(f" 🚀 2. yolov8ncandling.onnx               <-- 1-click model file for Raspberry Pi")
print(f" 💾 3. best.pt                            <-- Backup PyTorch weights")
print("=" * 60)
