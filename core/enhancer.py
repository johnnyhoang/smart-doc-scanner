import cv2
import numpy as np
from typing import Tuple, Optional


def remove_crease_shadows_and_folds(
    image: np.ndarray, 
    strength: float = 0.7
) -> np.ndarray:
    """
    Eliminates shadows caused by folds and creases across the paper surface.
    Works strictly on Luminance (L channel in LAB) so all ink colors, stamps, and signatures are preserved.
    """
    if strength <= 0.01:
        return image.copy()

    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_chan, a_chan, b_chan = cv2.split(lab)

    h, w = image.shape[:2]
    
    # Scale 1: Broad illumination gradient
    k1 = max(31, int(min(h, w) * 0.08)) | 1
    bg_broad = cv2.GaussianBlur(l_chan, (k1, k1), 0)

    # Scale 2: Narrow crease shadow valleys
    k2 = max(15, int(min(h, w) * 0.03)) | 1
    dilated = cv2.dilate(l_chan, cv2.getStructuringElement(cv2.MORPH_RECT, (k2, k2)))
    bg_crease = cv2.GaussianBlur(dilated, (k2, k2), 0)

    # Combined background estimate
    bg_combined = np.maximum(bg_broad, bg_crease).astype(np.float32) + 1.0

    # Illumination division normalization
    l_float = l_chan.astype(np.float32)
    normalized_l = (l_float / bg_combined) * 255.0
    normalized_l = np.clip(normalized_l, 0, 255).astype(np.uint8)

    # Blend with original luminance based on strength
    l_bleached = cv2.addWeighted(normalized_l, strength, l_chan, 1.0 - strength, 0)

    result_lab = cv2.merge([l_bleached, a_chan, b_chan])
    return cv2.cvtColor(result_lab, cv2.COLOR_LAB2BGR)


def unsharp_mask(
    image: np.ndarray, 
    sigma: float = 1.0, 
    strength: float = 0.6, 
    threshold: int = 2
) -> np.ndarray:
    """
    Sharpens text edges subtly without generating grain noise or halo artifacts.
    Operates on the Luminance channel to prevent color fringing.
    """
    if strength <= 0.01:
        return image.copy()

    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)

    blurred = cv2.GaussianBlur(l, (0, 0), sigma)
    diff = l.astype(np.float32) - blurred.astype(np.float32)

    mask = np.abs(diff) > threshold
    sharpened_l = l.astype(np.float32) + strength * diff * mask
    sharpened_l = np.clip(sharpened_l, 0, 255).astype(np.uint8)

    merged = cv2.merge([sharpened_l, a, b])
    return cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)


def restore_aged_yellowed_paper(image: np.ndarray) -> np.ndarray:
    """
    Specialized restoration for aged, yellowed, foxed, or brown archival documents.
    Neutralizes yellow/brown stain chrominance while deepening faded ink and keeping signatures.
    """
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    h, w = image.shape[:2]

    # 1. Estimate background yellowing in B channel
    k_size = max(31, int(min(h, w) * 0.06)) | 1
    bg_b = cv2.GaussianBlur(b, (k_size, k_size), 0).astype(np.float32)
    bg_a = cv2.GaussianBlur(a, (k_size, k_size), 0).astype(np.float32)

    # 2. Subtract yellow paper tint towards neutral 128 for paper background
    b_float = b.astype(np.float32)
    a_float = a.astype(np.float32)

    # Detect high saturation ink (red stamps or blue signatures) to preserve them
    chroma_dist = np.sqrt((a_float - 128.0)**2 + (b_float - 128.0)**2)
    is_colored_ink = chroma_dist > 22.0

    # Neutralize paper yellowing
    neutral_b = 128.0 + (b_float - bg_b) * 0.85
    neutral_a = 128.0 + (a_float - bg_a) * 0.85

    b_clean = np.where(is_colored_ink, b_float, neutral_b)
    a_clean = np.where(is_colored_ink, a_float, neutral_a)

    b_clean = np.clip(b_clean, 0, 255).astype(np.uint8)
    a_clean = np.clip(a_clean, 0, 255).astype(np.uint8)

    # 3. Enhance luminance: normalize paper background to bright clean paper
    bg_l = cv2.GaussianBlur(l, (k_size, k_size), 0).astype(np.float32) + 1.0
    norm_l = (l.astype(np.float32) / bg_l) * 255.0
    norm_l = np.clip(norm_l * 1.05 + 5, 0, 255).astype(np.uint8)

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_restored = clahe.apply(norm_l)

    merged = cv2.merge([l_restored, a_clean, b_clean])
    return cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)


def remove_bleedthrough_showthrough(image: np.ndarray) -> np.ndarray:
    """
    Suppresses bleed-through text from the back side of thin or double-sided paper
    while enhancing primary front-side text.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image.copy()
    h, w = image.shape[:2]

    # Background illumination estimation
    k = max(25, int(min(h, w) * 0.04)) | 1
    bg = cv2.GaussianBlur(gray, (k, k), 0)
    diff = bg.astype(np.float32) - gray.astype(np.float32)

    # Gradient magnitude to differentiate sharp front text from diffuse back-side bleed
    grad_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    grad_mag = np.sqrt(grad_x**2 + grad_y**2)

    # Front text has strong edge gradient and strong difference from background
    # Bleed-through has low gradient and weak contrast
    front_mask = (grad_mag > 18.0) | (diff > 45.0)

    # In LAB space, bleach areas that are bleed-through
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)

    bg_l = cv2.GaussianBlur(l, (k, k), 0)
    cleaned_l = np.where(front_mask, l, np.maximum(l, bg_l))
    cleaned_l = np.clip(cleaned_l.astype(np.float32) * 1.04 + 6, 0, 255).astype(np.uint8)

    merged = cv2.merge([cleaned_l, a, b])
    return cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)


def boost_stamp_and_signatures(image: np.ndarray) -> np.ndarray:
    """
    Enhances official red stamps, notary seals, and blue ballpoint signatures
    to maximum clarity and vibrancy against pure white paper.
    """
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    h_chan, s_chan, v_chan = cv2.split(hsv)

    # Red seal hue range: (0-12) and (168-180)
    red_mask1 = (h_chan <= 12) & (s_chan > 40)
    red_mask2 = (h_chan >= 168) & (s_chan > 40)
    red_mask = red_mask1 | red_mask2

    # Blue signature hue range: (95-135)
    blue_mask = (h_chan >= 95) & (h_chan <= 135) & (s_chan > 35)

    stamp_mask = red_mask | blue_mask

    # Boost saturation of stamps/signatures
    s_boosted = s_chan.astype(np.float32)
    s_boosted[stamp_mask] = np.clip(s_boosted[stamp_mask] * 1.6 + 25, 0, 255)
    s_boosted[~stamp_mask] = np.clip(s_boosted[~stamp_mask] * 0.9, 0, 255)
    s_final = s_boosted.astype(np.uint8)

    # Clean background V channel
    h_dim, w_dim = image.shape[:2]
    k = max(25, int(min(h_dim, w_dim) * 0.05)) | 1
    bg_v = cv2.GaussianBlur(v_chan, (k, k), 0).astype(np.float32) + 1.0
    norm_v = (v_chan.astype(np.float32) / bg_v) * 255.0
    v_final = np.clip(norm_v * 1.06 + 8, 0, 255).astype(np.uint8)

    merged_hsv = cv2.merge([h_chan, s_final, v_final])
    res = cv2.cvtColor(merged_hsv, cv2.COLOR_HSV2BGR)
    return res


def super_sharp_thermal_receipt(image: np.ndarray) -> np.ndarray:
    """
    Specialized for faint thermal receipts, carbon copies (giấy than),
    and blurry pencil/low-ink printouts.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image.copy()
    h, w = image.shape[:2]

    # Multi-scale background subtraction
    k = max(19, int(min(h, w) * 0.03)) | 1
    bg = cv2.GaussianBlur(gray, (k, k), 0).astype(np.float32) + 1.0
    norm = (gray.astype(np.float32) / bg) * 255.0
    norm = np.clip(norm, 0, 255).astype(np.uint8)

    # High-clip CLAHE for faint text
    clahe = cv2.createCLAHE(clipLimit=3.5, tileGridSize=(6, 6))
    boosted = clahe.apply(norm)

    # Local threshold contrast push
    blurred = cv2.GaussianBlur(boosted, (3, 3), 0)
    laplacian = cv2.Laplacian(blurred, cv2.CV_32F, ksize=3)
    sharp = boosted.astype(np.float32) - 0.7 * laplacian
    sharp = np.clip(sharp, 0, 255).astype(np.uint8)

    # Gamma push for dark text
    gamma_lut = np.array([((i / 255.0) ** 1.35) * 255.0 for i in range(256)]).astype(np.uint8)
    res_gray = cv2.LUT(sharp, gamma_lut)

    return cv2.cvtColor(res_gray, cv2.COLOR_GRAY2BGR)


def enhance_magic_color(image: np.ndarray) -> np.ndarray:
    """
    CamScanner-style Magic Color: Pure white paper, vivid ink colors, razor-sharp text.
    """
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    h, w = image.shape[:2]

    # Bleach paper background
    k = max(25, int(min(h, w) * 0.05)) | 1
    dilated = cv2.dilate(l, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    bg = cv2.GaussianBlur(dilated, (k, k), 0).astype(np.float32) + 1.0

    norm_l = (l.astype(np.float32) / bg) * 255.0
    norm_l = np.clip(norm_l * 1.12 + 10, 0, 255).astype(np.uint8)

    clahe = cv2.createCLAHE(clipLimit=1.8, tileGridSize=(8, 8))
    norm_l = clahe.apply(norm_l)

    # Boost color saturation in HSV space
    merged_lab = cv2.merge([norm_l, a, b])
    bgr_temp = cv2.cvtColor(merged_lab, cv2.COLOR_LAB2BGR)
    hsv = cv2.cvtColor(bgr_temp, cv2.COLOR_BGR2HSV)
    h_c, s_c, v_c = cv2.split(hsv)

    s_boost = np.clip(s_c.astype(np.float32) * 1.4 + 5, 0, 255).astype(np.uint8)
    enhanced_hsv = cv2.merge([h_c, s_boost, v_c])
    return cv2.cvtColor(enhanced_hsv, cv2.COLOR_HSV2BGR)


def enhance_document(
    image: np.ndarray,
    mode: str = "natural",
    shadow_reduction: float = 0.6,
    sharpness: float = 0.6,
    contrast: float = 0.2,
    brightness: float = 0.0
) -> np.ndarray:
    """
    Comprehensive document enhancement & restoration pipeline.
    Modes:
      - 'natural': True-to-life colors, clean even background, crisp text.
      - 'magic_color': CamScanner Magic Color (white paper + vivid colored inks).
      - 'clean_bg': Whiter paper background with high text clarity.
      - 'sharp_text': Higher contrast for faded ink / pencil notes.
      - 'restore_yellowed': Restores aged, yellowed, or browned archival paper.
      - 'remove_bleedthrough': Suppresses 2-sided bleed-through/show-through text.
      - 'high_contrast_stamp': Highlights official red seals & blue signatures.
      - 'super_sharp_mono': For faint thermal paper receipts, carbon copy & micro-text.
      - 'bw_scan': Crisp binarized scan for office printing.
      - 'original': Straight warped image without color modifications.
    """
    if mode == "original":
        return image.copy()

    # Step 1: Crease Shadow & Fold Normalization
    if shadow_reduction > 0:
        img_balanced = remove_crease_shadows_and_folds(image, strength=shadow_reduction)
    else:
        img_balanced = image.copy()

    # Step 2: Mode-specific processing
    if mode == "magic_color":
        img_result = enhance_magic_color(img_balanced)

    elif mode == "restore_yellowed":
        img_result = restore_aged_yellowed_paper(img_balanced)

    elif mode == "remove_bleedthrough":
        img_result = remove_bleedthrough_showthrough(img_balanced)

    elif mode == "high_contrast_stamp":
        img_result = boost_stamp_and_signatures(img_balanced)

    elif mode == "super_sharp_mono":
        img_result = super_sharp_thermal_receipt(img_balanced)

    elif mode == "bw_scan":
        gray = cv2.cvtColor(img_balanced, cv2.COLOR_BGR2GRAY)
        kernel_size = max(25, int(min(image.shape[:2]) * 0.05)) | 1
        bg = cv2.GaussianBlur(gray, (kernel_size, kernel_size), 0)
        norm = (gray.astype(np.float32) / (bg.astype(np.float32) + 1.0)) * 255.0
        norm = np.clip(norm, 0, 255).astype(np.uint8)

        clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
        enhanced = clahe.apply(norm)

        blur = cv2.GaussianBlur(enhanced, (0, 0), 1.2)
        sharp = cv2.addWeighted(enhanced, 1.5, blur, -0.5, 0)
        return cv2.cvtColor(sharp, cv2.COLOR_GRAY2BGR)

    elif mode == "clean_bg":
        lab = cv2.cvtColor(img_balanced, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        kernel_size = max(25, int(min(image.shape[:2]) * 0.05)) | 1
        bg = cv2.GaussianBlur(l, (kernel_size, kernel_size), 0)
        norm_l = (l.astype(np.float32) / (bg.astype(np.float32) + 1.0)) * 255.0
        norm_l = np.clip(norm_l * 1.06 + 8, 0, 255).astype(np.uint8)

        clahe = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8))
        norm_l = clahe.apply(norm_l)

        merged = cv2.merge([norm_l, a, b])
        img_result = cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)

    elif mode == "sharp_text":
        lab = cv2.cvtColor(img_balanced, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)

        clahe = cv2.createCLAHE(clipLimit=2.4, tileGridSize=(8, 8))
        l_clahe = clahe.apply(l)

        merged = cv2.merge([l_clahe, a, b])
        img_result = cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)

    else:
        # 'natural' mode (default)
        lab = cv2.cvtColor(img_balanced, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)

        if contrast > 0:
            clahe = cv2.createCLAHE(clipLimit=1.0 + (contrast * 1.5), tileGridSize=(8, 8))
            l = clahe.apply(l)

        merged = cv2.merge([l, a, b])
        img_result = cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)

    # Step 3: Subtle text unsharp masking
    if sharpness > 0:
        img_result = unsharp_mask(img_result, sigma=1.0, strength=sharpness)

    # Step 4: Brightness adjustment
    if abs(brightness) > 0.01:
        img_float = img_result.astype(np.float32) + (brightness * 50.0)
        img_result = np.clip(img_float, 0, 255).astype(np.uint8)

    return img_result
