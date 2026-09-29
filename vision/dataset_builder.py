"""
IncuVision: Dataset Builder for Binary (Fertile vs Infertile) & Multi-Day Datasets
Supports organizing images from Day 3, 7, 10, 14, 18.
"""

import os
import shutil
import random
import cv2
import numpy as np
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATASET_DIR = BASE_DIR / "dataset"
GRID_ROWS = 7
GRID_COLS = 8

def setup_dataset_structure(binary_only: bool = True):
    """Creates directory tree for multi-day YOLO detection and classification."""
    # Detection structure
    for split in ["train", "val", "test"]:
        (DATASET_DIR / "images" / split).mkdir(parents=True, exist_ok=True)
        (DATASET_DIR / "labels" / split).mkdir(parents=True, exist_ok=True)

    # Classification crops structure
    classes = ["fertile", "infertile"] if binary_only else ["fertile", "infertile", "early_dead"]
    for split in ["train", "val"]:
        for cls_name in classes:
            (DATASET_DIR / "crops" / split / cls_name).mkdir(parents=True, exist_ok=True)

    print(f"[Dataset] Initialized dataset directories at: {DATASET_DIR}")

def crop_tray_into_individual_eggs(tray_image_path: Path, output_dir: Path, day: int = 7):
    """
    Takes a 1920x1080 full 56-egg candling tray image and crops the 56 individual eggs.
    Names output files with incubation day metadata (e.g. day07_egg_01.jpg).
    """
    img = cv2.imread(str(tray_image_path))
    if img is None:
        print(f"[Error] Could not read image at {tray_image_path}")
        return

    tray_x, tray_y = 200, 100
    tray_w, tray_h = 1520, 880
    cell_w = tray_w // GRID_COLS
    cell_h = tray_h // GRID_ROWS

    output_dir.mkdir(parents=True, exist_ok=True)
    stem = tray_image_path.stem

    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            egg_num = r * GRID_COLS + c + 1
            x1 = max(0, tray_x + c * cell_w + 5)
            y1 = max(0, tray_y + r * cell_h + 5)
            x2 = min(img.shape[1], x1 + cell_w - 10)
            y2 = min(img.shape[0], y1 + cell_h - 10)

            crop = img[y1:y2, x1:x2]
            out_file = output_dir / f"day{day:02d}_{stem}_egg_{egg_num:02d}_r{r+1}c{c+1}.jpg"
            cv2.imwrite(str(out_file), crop)

    print(f"[Crop] Extracted 56 egg crops from Day {day} image ({tray_image_path.name}) to {output_dir}")

def generate_multi_day_synthetic_dataset(num_per_day: int = 20, days=(3, 7, 10, 14, 18)):
    """
    Generates realistic multi-day synthetic candling datasets across developmental milestones:
      - Day 3: Small faint blood island / early veins
      - Day 7: Classic spider vascular web radiating from embryo
      - Day 10-14: Large dark embryo shadow occupying central volume
      - Day 18: Almost completely opaque egg with top air cell
      - Infertile (All Days): Transparent yellow-orange glow, no veins or dark mass
    """
    setup_dataset_structure(binary_only=True)
    print(f"[Synthetic] Generating multi-day synthetic dataset across days {days}...")

    total_samples = num_per_day * len(days)
    sample_idx = 0

    for day in days:
        for _ in range(num_per_day):
            sample_idx += 1
            split = "train" if random.random() < 0.8 else "val"

            h, w = 1080, 1920
            img = np.zeros((h, w, 3), dtype=np.uint8)
            img[:] = (18, 18, 22)

            tray_x, tray_y = 200, 100
            tray_w, tray_h = 1520, 880
            cell_w = tray_w // GRID_COLS
            cell_h = tray_h // GRID_ROWS

            labels_lines = []

            for r in range(GRID_ROWS):
                for c in range(GRID_COLS):
                    cx = tray_x + c * cell_w + cell_w // 2
                    cy = tray_y + r * cell_h + cell_h // 2
                    rx, ry = cell_w // 2 - 15, cell_h // 2 - 10

                    is_fertile = (random.random() < 0.88)
                    cls_id = 0 if is_fertile else 1

                    if is_fertile:
                        # Color & appearance based on day
                        if day <= 4:
                            color = (30, 120, 230) # slight blood tint
                        elif day <= 7:
                            color = (25, 95, 235)  # vascular red-orange
                        elif day <= 14:
                            color = (20, 50, 160)  # darkening body
                        else:
                            color = (15, 25, 60)   # Day 18 dark opaque
                    else:
                        # Infertile: always bright clear transparent yolk glow
                        color = (40, random.randint(190, 220), random.randint(235, 255))

                    cv2.ellipse(img, (cx, cy), (rx, ry), 0, 0, 360, color, -1)
                    cv2.ellipse(img, (cx, cy), (rx, ry), 0, 0, 360, (60, 60, 70), 2)

                    # Draw Day-specific vascular details for fertile
                    if is_fertile:
                        if day == 7:
                            for _ in range(random.randint(4, 7)):
                                vx2 = cx + random.randint(-rx + 10, rx - 10)
                                vy2 = cy + random.randint(-ry + 10, ry - 10)
                                cv2.line(img, (cx, cy), (vx2, vy2), (10, 30, 130), 2)
                        elif day >= 10:
                            # Dark inner mass
                            cv2.circle(img, (cx, cy), int(rx * 0.6), (15, 25, 70), -1)

                    # YOLO format: class x_center y_center width height
                    x_norm = cx / w
                    y_norm = cy / h
                    w_norm = (rx * 2) / w
                    h_norm = (ry * 2) / h
                    labels_lines.append(f"{cls_id} {x_norm:.6f} {y_norm:.6f} {w_norm:.6f} {h_norm:.6f}\n")

            # Add noise
            noise = np.random.normal(0, 4, img.shape).astype(np.int16)
            noisy_img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)

            img_filename = f"sim_day{day:02d}_{sample_idx:04d}.jpg"
            label_filename = f"sim_day{day:02d}_{sample_idx:04d}.txt"

            img_dest = DATASET_DIR / "images" / split / img_filename
            lbl_dest = DATASET_DIR / "labels" / split / label_filename

            cv2.imwrite(str(img_dest), noisy_img)
            with open(lbl_dest, "w", encoding="utf-8") as f:
                f.writelines(labels_lines)

    print(f"[Synthetic] ✅ Generated {total_samples} multi-day annotated samples in {DATASET_DIR}")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="IncuVision Multi-Day Dataset Prep")
    parser.add_argument("--setup", action="store_true", help="Setup directory tree")
    parser.add_argument("--generate-multi-day", type=int, default=0, help="Generate N synthetic images per milestone day")
    parser.add_argument("--crop-tray", type=str, help="Crop full tray image into eggs")
    parser.add_argument("--day", type=int, default=7, help="Incubation day of the tray image")
    parser.add_argument("--output-dir", type=str, default="crops", help="Output directory for crops")

    args = parser.parse_args()

    if args.setup:
        setup_dataset_structure(binary_only=True)
    elif args.generate_multi_day > 0:
        generate_multi_day_synthetic_dataset(args.generate_multi_day)
    elif args.crop_tray:
        crop_tray_into_individual_eggs(Path(args.crop_tray), Path(args.output_dir), day=args.day)
    else:
        setup_dataset_structure(binary_only=True)
