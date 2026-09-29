"""
IncuVision: Candling Image Enhancer
Solves the "faint / low visibility" problem in real egg candling (e.g. brown shells,
thick shells, weak vascular contrast, or LED glare).
Techniques:
 1. Hemoglobin Spectral Extraction (Green-Channel isolation / (R - G) differencing)
 2. CLAHE (Contrast Limited Adaptive Histogram Equalization)
 3. Unsharp Masking & High-Pass Filtering for vascular branching enhancement
 4. Glare Suppression & Illumination Normalization
"""

import cv2
import numpy as np

class CandlingImageEnhancer:
    def __init__(self, clip_limit: float = 3.5, tile_grid_size: tuple = (8, 8)):
        self.clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=tile_grid_size)

    def enhance_egg_crop(self, egg_bgr: np.ndarray) -> np.ndarray:
        """
        Enhances a cropped egg image so that faint blood vessels (Day 7)
        and subtle embryo masses (Day 10-14) become clearly visible to both
        human eyes and CNN models.
        """
        if egg_bgr is None or egg_bgr.size == 0:
            return egg_bgr

        # 1. Extract Channels
        # Hemoglobin (blood) strongly absorbs green light (~540-575 nm)
        # while egg shell and yolk transmit red light (~600-700 nm).
        b, g, r = cv2.split(egg_bgr)

        # 2. Spectral Differencing (R - G) Highlights Vascular Structures
        diff_rg = cv2.subtract(r, g)

        # 3. Apply CLAHE on Green & Red-Green Diff
        clahe_g = self.clahe.apply(g)
        clahe_diff = self.clahe.apply(diff_rg)

        # 4. Enhance Luminance in LAB Color Space
        lab = cv2.cvtColor(egg_bgr, cv2.COLOR_BGR2LAB)
        l, a, b_ch = cv2.split(lab)
        clahe_l = self.clahe.apply(l)

        # 5. Unsharp Masking on L channel to accentuate faint blood vessels
        gaussian = cv2.GaussianBlur(clahe_l, (0, 0), sigmaX=2.0)
        sharp_l = cv2.addWeighted(clahe_l, 1.5, gaussian, -0.5, 0)

        # Recombine into enhanced RGB
        enhanced_lab = cv2.merge([sharp_l, a, b_ch])
        enhanced_bgr = cv2.cvtColor(enhanced_lab, cv2.COLOR_LAB2BGR)

        # Blend with spectral difference channel for maximum capillary contrast
        enhanced_bgr[:, :, 1] = cv2.addWeighted(enhanced_bgr[:, :, 1], 0.7, clahe_g, 0.3, 0)
        enhanced_bgr[:, :, 2] = cv2.addWeighted(enhanced_bgr[:, :, 2], 0.7, clahe_diff, 0.3, 0)

        return enhanced_bgr

    def extract_vascular_feature_map(self, egg_bgr: np.ndarray) -> np.ndarray:
        """
        Outputs a normalized grayscale vascular heat-map where blood vessels
        and dark embryo clumps appear as bright white structures on a dark background.
        """
        b, g, r = cv2.split(egg_bgr)
        # Blood vessels absorb green: invert G channel and subtract background
        inv_g = cv2.bitwise_not(g)
        clahe_inv = self.clahe.apply(inv_g)

        # Morphological Top-Hat to isolate tubular capillaries
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
        tophat = cv2.morphologyEx(clahe_inv, cv2.MORPH_TOPHAT, kernel)
        
        # Normalize to 0-255
        norm_map = cv2.normalize(tophat, None, 0, 255, cv2.NORM_MINMAX)
        return norm_map

    def compute_development_metrics(self, egg_bgr: np.ndarray) -> dict:
        """
        Calculates numerical opacity and vascular texture scores to classify
        development even when images are visually dark or faint.
        """
        gray = cv2.cvtColor(egg_bgr, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(egg_bgr, cv2.COLOR_BGR2HSV)
        v_channel = hsv[:, :, 2]

        # Vascular texture score via Laplacian variance
        laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()

        # Mean and standard deviation of brightness
        mean_lum = float(np.mean(v_channel))
        dark_pixel_ratio = float(np.sum(v_channel < 70) / v_channel.size)

        return {
            "mean_luminance": round(mean_lum, 2),
            "dark_pixel_ratio": round(dark_pixel_ratio, 3),
            "vascular_texture_score": round(laplacian_var, 2)
        }
