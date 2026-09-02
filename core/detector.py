import os
import cv2
import numpy as np
from typing import Tuple, Optional


def imread_unicode(path: str, flags: int = cv2.IMREAD_COLOR) -> Optional[np.ndarray]:
    """
    Unicode-safe image reader for Windows supporting paths with Vietnamese accents and special chars.
    """
    try:
        if not os.path.exists(path):
            return None
        with open(path, "rb") as f:
            bytes_data = bytearray(f.read())
        nparr = np.asarray(bytes_data, dtype=np.uint8)
        return cv2.imdecode(nparr, flags)
    except Exception as e:
        print(f"[Warning] Failed to read image with unicode path {path}: {e}")
        return None


def imwrite_unicode(path: str, img: np.ndarray, params: Optional[list] = None) -> bool:
    """
    Unicode-safe image writer for Windows supporting paths with Vietnamese accents and special chars.
    """
    try:
        ext = os.path.splitext(path)[1]
        if not ext:
            ext = ".jpg"
        success, encoded_img = cv2.imencode(ext, img, params or [])
        if success:
            with open(path, "wb") as f:
                encoded_img.tofile(f)
            return True
        return False
    except Exception as e:
        print(f"[Warning] Failed to write image with unicode path {path}: {e}")
        return False


def order_points(pts: np.ndarray) -> np.ndarray:
    """
    Orders 4 points in top-left, top-right, bottom-right, bottom-left order.
    pts: shape (4, 2)
    """
    rect = np.zeros((4, 2), dtype="float32")

    # Top-left has smallest sum (x + y), bottom-right has largest sum
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]

    # Top-right has smallest diff (y - x), bottom-left has largest diff
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]

    return rect


def expand_quad(pts: np.ndarray, img_shape: Tuple[int, int], margin_percent: float = 0.02) -> np.ndarray:
    """
    Expands the quadrilateral outward by margin_percent (e.g. 2%, 5%)
    from its centroid without clamping to image boundaries, allowing margin extension
    even when document touches photo edges.
    """
    pts = order_points(pts)
    h, w = img_shape[:2]

    # Calculate center of the quad
    centroid = np.mean(pts, axis=0)

    # Scale each point away from the centroid
    expanded = np.zeros_like(pts)
    scale = 1.0 + (margin_percent * 2.0)

    for i in range(4):
        vec = pts[i] - centroid
        expanded[i] = centroid + vec * scale

    # Safety bounds to prevent extreme runaway (allow up to 25% outside frame)
    expanded[:, 0] = np.clip(expanded[:, 0], -w * 0.25, w * 1.25)
    expanded[:, 1] = np.clip(expanded[:, 1], -h * 0.25, h * 1.25)

    return expanded.astype(np.float32)


def find_quad_contour(binary_img: np.ndarray, min_area: float) -> Optional[np.ndarray]:
    """Helper to find the best 4-point quadrilateral from a binary edge map."""
    contours, _ = cv2.findContours(binary_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        contours, _ = cv2.findContours(binary_img, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:10]

    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area:
            continue

        peri = cv2.arcLength(c, True)
        for eps in [0.015, 0.02, 0.03, 0.04, 0.05]:
            approx = cv2.approxPolyDP(c, eps * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                return approx.reshape(4, 2)

    # Fallback to convex hull approx
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        hull = cv2.convexHull(c)
        peri = cv2.arcLength(hull, True)
        for eps in [0.015, 0.02, 0.03, 0.04, 0.05]:
            approx = cv2.approxPolyDP(hull, eps * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                return approx.reshape(4, 2)

    return None


def detect_document_corners(image: np.ndarray, margin_percent: float = 0.0) -> Tuple[np.ndarray, bool]:
    """
    Multi-pass automatic document corner detection.
    Returns (corners, detected_flag).
    corners: 4x2 float32 array in original image coordinates.
    """
    orig_h, orig_w = image.shape[:2]

    target_height = 800.0
    ratio = orig_h / target_height
    target_width = int(orig_w / ratio)
    resized = cv2.resize(image, (target_width, int(target_height)), interpolation=cv2.INTER_AREA)

    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY) if len(resized.shape) == 3 else resized.copy()
    smooth = cv2.bilateralFilter(gray, 9, 75, 75)
    min_area = (resized.shape[0] * resized.shape[1]) * 0.15

    best_quad = None

    # Pass 1: Otsu thresholding
    blur = cv2.GaussianBlur(smooth, (5, 5), 0)
    _, thresh_otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    thresh_otsu = cv2.morphologyEx(thresh_otsu, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9)))
    best_quad = find_quad_contour(thresh_otsu, min_area)

    # Pass 2: Canny Edge detection
    if best_quad is None:
        closed = cv2.morphologyEx(smooth, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7)))
        edges = cv2.Canny(closed, 30, 120)
        edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
        best_quad = find_quad_contour(edges, min_area)

    # Pass 3: Morphological Gradient
    if best_quad is None:
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        gradient = cv2.morphologyEx(smooth, cv2.MORPH_GRADIENT, kernel)
        _, grad_thresh = cv2.threshold(gradient, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        best_quad = find_quad_contour(grad_thresh, min_area)

    detected = True
    if best_quad is None:
        detected = False
        inset_x = int(orig_w * 0.02)
        inset_y = int(orig_h * 0.02)
        corners = np.array([
            [inset_x, inset_y],
            [orig_w - inset_x, inset_y],
            [orig_w - inset_x, orig_h - inset_y],
            [inset_x, orig_h - inset_y]
        ], dtype="float32")
    else:
        corners = (best_quad * ratio).astype("float32")
        corners = order_points(corners)

    # Apply margin expansion proportionally (allowing points to extend past image borders)
    if margin_percent > 0:
        corners = expand_quad(corners, (orig_h, orig_w), margin_percent)

    return corners, detected


def four_point_transform(image: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """
    Warps a quadrilateral document into a straight rectangle.
    If points extend beyond image boundaries (e.g. from 2% margin expansion on edge-touching photos),
    automatically extrapolates the paper borders using high-quality texture synthesis / replication.
    """
    rect = order_points(pts)
    (tl, tr, br, bl) = rect

    # Check for out-of-bound coordinates
    h, w = image.shape[:2]
    min_x = np.min(rect[:, 0])
    max_x = np.max(rect[:, 0])
    min_y = np.min(rect[:, 1])
    max_y = np.max(rect[:, 1])

    pad_left = int(max(0, -min_x + 10))
    pad_top = int(max(0, -min_y + 10))
    pad_right = int(max(0, max_x - (w - 1) + 10))
    pad_bottom = int(max(0, max_y - (h - 1) + 10))

    if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
        # Pad image with smooth edge replication to synthesize missing paper margin
        padded_img = cv2.copyMakeBorder(
            image,
            pad_top, pad_bottom, pad_left, pad_right,
            borderType=cv2.BORDER_REPLICATE
        )
        # Shift corner coordinates into padded image space
        adjusted_rect = rect.copy()
        adjusted_rect[:, 0] += pad_left
        adjusted_rect[:, 1] += pad_top
    else:
        padded_img = image
        adjusted_rect = rect

    (tl, tr, br, bl) = adjusted_rect

    # Compute optimal dimensions
    width_a = np.hypot(br[0] - bl[0], br[1] - bl[1])
    width_b = np.hypot(tr[0] - tl[0], tr[1] - tl[1])
    max_width = max(int(width_a), int(width_b), 100)

    height_a = np.hypot(tr[0] - br[0], tr[1] - br[1])
    height_b = np.hypot(tl[0] - bl[0], tl[1] - bl[1])
    max_height = max(int(height_a), int(height_b), 100)

    dst = np.array([
        [0, 0],
        [max_width - 1, 0],
        [max_width - 1, max_height - 1],
        [0, max_height - 1]
    ], dtype="float32")

    m = cv2.getPerspectiveTransform(adjusted_rect, dst)
    warped = cv2.warpPerspective(
        padded_img, 
        m, 
        (max_width, max_height), 
        flags=cv2.INTER_CUBIC, 
        borderMode=cv2.BORDER_REPLICATE
    )
    return warped


def rotate_image(image: np.ndarray, angle_deg: int) -> np.ndarray:
    """
    Rotates image by 90, 180, or 270 degrees.
    """
    angle = angle_deg % 360
    if angle == 90:
        return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    elif angle == 180:
        return cv2.rotate(image, cv2.ROTATE_180)
    elif angle == 270:
        return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return image
