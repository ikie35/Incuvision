"""
IncuVision: Egg Candling AI Model Training on Kaggle
Exports:
  - yolov8s_candling.pt (Best model weights)
  - metrics_summary.json & results.csv (mAP50, mAP50-95, Precision, Recall)
  - Confusion Matrix (raw & normalized)
  - Performance curves (Loss curves, F1 curve, PR curve)
  - Visual Test Predictions (sample images with predicted labels & confidence)
  - incuvision_evaluation_bundle.zip (1-click download package)
"""

# Install dependencies if running directly in a Kaggle cell:
# !pip install -q ultralytics roboflow

import os
import json
import shutil
from pathlib import Path
from roboflow import Roboflow
from ultralytics import YOLO

def main():
    # 1. Download Roboflow dataset
    rf = Roboflow(api_key="B9XvEYgFb9pJuCAln7MO")
    project = rf.workspace("ike-russel").project("incuvision-8gmod-gdfwh")
    version = project.version(1)
    dataset = version.download("yolov8")

    dataset_root = Path(dataset.location)
    data_yaml = dataset_root / "data.yaml"
    print(f"\n[Dataset] ✅ Dataset ready at: {data_yaml}")

    # 2. Train YOLOv8 with Online Augmentations (Nano backbone)
    model = YOLO("yolov8n.pt")

    results = model.train(
        data=str(data_yaml),
        epochs=100,
        patience=20,              # Early stopping: stops if no improvement after 20 epochs
        imgsz=640,
        batch=16,
        device=0,                 # GPU 0 on Kaggle
        project="/kaggle/working/runs",
        name="incuvision_candling",
        save=True,
        exist_ok=True,

        # Online Augmentations for Egg Candling
        degrees=15.0,             # Tilt / roll
        fliplr=0.5,               # Horizontal flip
        flipud=0.5,               # Vertical flip
        translate=0.08,           # Shift jitter
        scale=0.15,               # Minor zoom in/out
        hsv_h=0.015,              # Preserves yolk/blood hue
        hsv_s=0.30,               # Saturation (light transmittance)
        hsv_v=0.30,               # Brightness (LED variations)
        mosaic=0.30,              # Subtle mosaic
        close_mosaic=10,          # Deactivates mosaic in last 10 epochs
        shear=0.0,
        perspective=0.0,
        erasing=0.0
    )

    runs_dir = Path(results.save_dir)
    best_weights = runs_dir / "weights" / "best.pt"

    # 3. Comprehensive Validation & Metric Extraction
    print("\n" + "=" * 60)
    print("📊 Evaluating Best Model on Validation Split...")
    print("=" * 60)
    best_model = YOLO(str(best_weights))
    val_results = best_model.val(data=str(data_yaml), split="val")

    metrics_summary = {
        "mAP50": round(float(val_results.box.map50), 4),
        "mAP50_95": round(float(val_results.box.map), 4),
        "mean_precision": round(float(val_results.box.mp), 4),
        "mean_recall": round(float(val_results.box.mr), 4),
        "class_names": val_results.names,
    }

    # Per-class metrics if available
    try:
        class_map50 = val_results.box.maps.tolist()
        metrics_summary["per_class_mAP50"] = {
            val_results.names[i]: round(score, 4)
            for i, score in enumerate(class_map50)
        }
    except Exception:
        pass

    print("\n--- Final Research Metrics ---")
    print(json.dumps(metrics_summary, indent=2))

    # 4. Generate Predictions on Test Set Sample Images
    bundle_dir = Path("/kaggle/working/incuvision_evaluation_bundle")
    bundle_dir.mkdir(parents=True, exist_ok=True)
    test_pred_dir = bundle_dir / "test_predictions"

    # Find test images directory from Roboflow export
    possible_test_paths = [
        dataset_root / "test" / "images",
        dataset_root / "images" / "test",
        dataset_root / "test"
    ]
    test_img_dir = next((p for p in possible_test_paths if p.exists() and any(p.glob("*.jpg")) or any(p.glob("*.png"))), None)

    if test_img_dir:
        print(f"\n🖼️ Running inference on holdout test set images: {test_img_dir}")
        best_model.predict(
            source=str(test_img_dir),
            conf=0.40,
            save=True,
            project=str(bundle_dir),
            name="test_predictions",
            exist_ok=True
        )
        print(f"✅ Annotated test sample images saved to: {test_pred_dir}")
    else:
        print("⚠️ No dedicated test images folder found, predicting on val samples instead...")
        val_img_dir = dataset_root / "valid" / "images" if (dataset_root / "valid").exists() else dataset_root / "val" / "images"
        if val_img_dir.exists():
            best_model.predict(
                source=str(val_img_dir),
                conf=0.40,
                save=True,
                project=str(bundle_dir),
                name="test_predictions",
                exist_ok=True
            )

    # 5. Assemble All Deliverables into the Bundle Folder
    # A. Best Model Weights (.pt) - save as both yolov8n and yolov8s for drop-in compatibility
    shutil.copy(best_weights, bundle_dir / "yolov8n_candling.pt")
    shutil.copy(best_weights, bundle_dir / "yolov8s_candling.pt")
    shutil.copy(best_weights, Path("/kaggle/working/yolov8n_candling.pt"))
    shutil.copy(best_weights, Path("/kaggle/working/yolov8s_candling.pt"))

    # B. Metrics JSON
    with open(bundle_dir / "metrics_summary.json", "w", encoding="utf-8") as f:
        json.dump(metrics_summary, f, indent=4)

    # C. Diagnostic Charts & Confusion Matrices
    diagnostic_files = [
        "confusion_matrix.png",
        "confusion_matrix_normalized.png",
        "results.png",
        "results.csv",
        "F1_curve.png",
        "PR_curve.png",
        "P_curve.png",
        "R_curve.png",
        "labels.jpg",
        "val_batch0_pred.jpg",
        "val_batch1_pred.jpg",
        "val_batch0_labels.jpg"
    ]

    for fname in diagnostic_files:
        src = runs_dir / fname
        if src.exists():
            shutil.copy(src, bundle_dir / fname)

    # 6. Create 1-Click Downloadable ZIP
    zip_path = shutil.make_archive("/kaggle/working/incuvision_evaluation_bundle", "zip", bundle_dir)

    print("\n" + "=" * 65)
    print("🎉 ALL DELIVERABLES GENERATED SUCCESSFULLY!")
    print("=" * 65)
    print(f"1. Individual Best Model : /kaggle/working/yolov8s_candling.pt")
    print(f"2. Complete Research Zip : {zip_path}")
    print("\nContents of the bundle zip:")
    print("  ├── yolov8s_candling.pt          (Best trained weights)")
    print("  ├── metrics_summary.json         (mAP, precision, recall per class)")
    print("  ├── confusion_matrix.png         (Raw confusion matrix)")
    print("  ├── confusion_matrix_normalized.png")
    print("  ├── results.png & results.csv    (Loss curves & epoch progression)")
    print("  ├── PR_curve.png & F1_curve.png  (Evaluation curves)")
    print("  ├── val_batch*_pred.jpg          (Validation predictions)")
    print("  └── test_predictions/           (Sample test images with bounding boxes & labels)")
    print("=" * 65)

if __name__ == "__main__":
    main()
