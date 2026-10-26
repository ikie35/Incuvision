# IncuVision: Model Refinement & Fine-Tuning Guide

This guide explains how to collect real candling images from the Raspberry Pi camera inside the incubator, annotate them, and fine-tune the YOLOv8 model for maximum accuracy under your chamber's physical lighting and lens setup.

---

## Overview of the Refinement Pipeline

```
┌─────────────────────────────────┐
│ 1. In-Chamber Image Collection   │
│    Raspberry Pi 5 Camera +      │
│    Candling LED Backlight Array │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 2. Annotation & Labeling        │
│    Roboflow (ike-russel)        │
│    Classes: 'fertile', 'infertile'
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 3. Transfer Learning / Training │
│    Free Cloud GPU (Kaggle/Colab)│
│    Fine-tune YOLOv8 Nano (50 ep)│
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 4. Export & Edge Deployment     │
│    Export to ONNX (yolov8n)     │
│    Deploy to Raspberry Pi 5     │
└─────────────────────────────────┘
```

---

## Step 1: Capture Real Images with the Pi Camera

To ensure the model learns your exact hardware environment (LED color temperature, light diffusion, camera distance, and egg tray layout), capture real photos during active candling.

### Recommended Milestone Days for Capturing
* **Day 3–4:** Early vascular development (faint spider veins).
* **Day 7:** Classic spider vascular network and embryo dark spot.
* **Day 10–14:** Visible dark embryo body occupying inner volume.
* **Day 18:** Pre-lockdown dense opacity with distinct air cell.
* **Infertile / Clear Eggs:** Bright, unobstructed light pass-through at any day.

### Method A: Automated CLI Collector Tool
SSH into your Raspberry Pi and run:
```bash
cd ~/IncuVision/vision

# Capture a single photo (automatically turns on candling LEDs, waits 1.5s, snaps, turns off):
python collect_dataset.py --capture --day 7

# Capture a burst of 5 shots with slightly different lighting / angles:
python collect_dataset.py --capture --day 7 --burst 5
```
Captured images are saved in `~/IncuVision/vision/captures/dataset/`.

### Method B: Via the Web Dashboard
1. Open your IncuVision dashboard link on your phone or PC.
2. Go to the **Fertility** screen (`🥚 Fertility` tab).
3. Tap **Trigger Candling Audit** or **Snapshot**.
4. The high-resolution raw frame is automatically stored on the Pi under `vision/captures/`.

---

## Step 2: Packaging or Uploading to Roboflow

### Option 1: Direct 1-Click Upload to Roboflow (Easiest)
On the Raspberry Pi terminal, run:
```bash
python collect_dataset.py --upload-roboflow
```
This automatically uploads all new captures directly to your workspace (`ike-russel / incuvision-8gmod-gdfwh`).

### Option 2: Download Images via ZIP Archive
If you prefer annotating locally or manually uploading:
```bash
python collect_dataset.py --zip
```
Download the resulting archive directly from your browser:
`http://<pi-ip>:8000/captures/candling_dataset.zip` (or your Cloudflare link).

---

## Step 3: Annotate on Roboflow

1. Log in to [Roboflow](https://app.roboflow.com/) and navigate to your `incuvision-8gmod-gdfwh` project.
2. In the **Annotate** tab, review the uploaded images.
3. Draw a tight bounding box around each egg in the tray:
   * **`fertile`**: Eggs displaying vascular branching, embryo eye/shadow, or developmental opacity.
   * **`infertile`**: Clear eggs with uniform translucency and no veins.
4. Click **Generate Version**:
   * Preprocessing: Auto-Orient, Resize to 640×640.
   * Augmentations: Minor Saturation (±25%), Exposure (±20%), Flip Horizontal/Vertical.
   * Format: **YOLOv8**.

---

## Step 4: Fine-Tuning the Model on Kaggle or Colab (Free GPU)

Training on a cloud GPU (Kaggle or Google Colab) takes only **3 to 5 minutes** for 50 epochs:

1. Open Kaggle or Google Colab.
2. Set Runtime to **GPU** (e.g. T4).
3. Run the IncuVision training script:
   ```python
   # Run the pre-configured Kaggle script from the repository:
   python vision/train_kaggle.py
   ```
   * The script automatically downloads your latest Roboflow dataset version.
   * It loads your existing `yolov8n.pt` weights and fine-tunes them for 50–100 epochs.
   * It generates confusion matrices, Precision-Recall curves, and exports `best.pt`.

---

## Step 5: Export to ONNX & Deploy to Raspberry Pi 5

Raspberry Pi 5 runs ONNX Runtime with CPU acceleration, giving **~60–90ms inference speed** per full tray without requiring heavy PyTorch dependencies during runtime.

### 1. Export `.pt` to `.onnx` (Run on Kaggle, PC, or Colab)
```python
from ultralytics import YOLO

model = YOLO("runs/incuvision_candling/weights/best.pt")
model.export(format="onnx", imgsz=640, dynamic=False)
# Produces best.onnx
```

### 2. Copy the New Model to the Raspberry Pi
Rename the exported `best.onnx` to `yolov8ncandling.onnx` and place it in the project root:
```bash
# On your Raspberry Pi:
scp user@computer:/path/to/best.onnx ~/IncuVision/yolov8ncandling.onnx

# Or if downloaded via browser:
mv ~/Downloads/best.onnx ~/IncuVision/yolov8ncandling.onnx
```

### 3. Restart IncuVision Service
```bash
sudo systemctl restart incuvision
```

### 4. Verify Model Initialization
Check the service log to ensure ONNX Runtime loaded the refined model:
```bash
journalctl -u incuvision -n 20 --no-pager | grep ONNX
```
Output:
```
[YOLOv8-ONNX] Successfully loaded ONNX model: /home/incuvision/IncuVision/yolov8ncandling.onnx
```

Your Raspberry Pi is now running your freshly fine-tuned model tailored specifically to your chamber's physical optics!
