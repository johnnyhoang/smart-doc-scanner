import cv2
import numpy as np
from typing import Tuple, List, Optional


def extract_horizontal_flows(gray: np.ndarray, num_bands: int = 10, num_cols: int = 12) -> np.ndarray:
    """
    Analyzes horizontal text lines and dividers to estimate smooth vertical displacement field.
    Applies strong regularization to prevent distortion of naturally straight text.
    """
    h, w = gray.shape[:2]

    # Horizontal gradient extraction
    sobel_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    sobel_y = np.abs(sobel_y)
    
    thresh = np.percentile(sobel_y, 85)
    edges = (sobel_y > thresh).astype(np.uint8) * 255

    # Connect horizontal line segments
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (35, 1))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)

    band_h = h // num_bands
    col_w = w // num_cols
    offsets = np.zeros((num_bands, num_cols), dtype=np.float32)

    for i in range(num_bands):
        y_start = i * band_h
        y_end = min(h, (i + 1) * band_h)
        band = closed[y_start:y_end, :]

        col_centers = []
        for j in range(num_cols):
            x_start = j * col_w
            x_end = min(w, (j + 1) * col_w)
            cell = band[:, x_start:x_end]

            weights = cell.astype(np.float32)
            sum_w = np.sum(weights)
            if sum_w > 20:
                y_indices = np.arange(y_start, y_end).reshape(-1, 1)
                center_y = np.sum(weights * y_indices) / sum_w
            else:
                center_y = (y_start + y_end) / 2.0
            col_centers.append(center_y)

        col_centers = np.array(col_centers, dtype=np.float32)
        expected_y = (y_start + y_end) / 2.0
        diff = col_centers - expected_y

        # Clamp max deviation to at most 3% of image height to prevent distortion
        max_dev = h * 0.035
        diff = np.clip(diff, -max_dev, max_dev)

        # Smooth curve fit
        x_coords = np.arange(num_cols)
        try:
            poly = np.polyfit(x_coords, diff, deg=2)
            smooth_diff = np.polyval(poly, x_coords)
        except Exception:
            smooth_diff = diff

        offsets[i, :] = smooth_diff

    # Vertical smoothing to prevent shears
    offsets = cv2.GaussianBlur(offsets, (3, 3), 0)
    return offsets


def generate_unwrinkle_mesh(
    image_shape: Tuple[int, int],
    rows: int = 8,
    cols: int = 8,
    offsets: Optional[np.ndarray] = None
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Generates source and destination mesh grids.
    """
    h, w = image_shape[:2]

    x_lin = np.linspace(0, w - 1, cols, dtype=np.float32)
    y_lin = np.linspace(0, h - 1, rows, dtype=np.float32)
    dst_x, dst_y = np.meshgrid(x_lin, y_lin)

    dst_mesh = np.stack([dst_x, dst_y], axis=-1)

    if offsets is not None:
        resized_offsets = cv2.resize(offsets, (cols, rows), interpolation=cv2.INTER_CUBIC)
        
        # Lock borders
        resized_offsets[0, :] = 0
        resized_offsets[-1, :] = 0
        resized_offsets[:, 0] = 0
        resized_offsets[:, -1] = 0

        src_x = dst_x.copy()
        src_y = dst_y + resized_offsets

        src_x = np.clip(src_x, 0, w - 1)
        src_y = np.clip(src_y, 0, h - 1)
        src_mesh = np.stack([src_x, src_y], axis=-1)
    else:
        src_mesh = dst_mesh.copy()

    return src_mesh, dst_mesh


def remap_mesh_dense(
    image: np.ndarray,
    src_mesh: np.ndarray,
    dst_mesh: np.ndarray
) -> np.ndarray:
    """
    Bicubic dense mesh remap.
    """
    h, w = image.shape[:2]

    if len(src_mesh.shape) == 2:
        num_points = src_mesh.shape[0]
        side = int(np.sqrt(num_points))
        if side * side == num_points:
            src_mesh = src_mesh.reshape(side, side, 2)
            dst_mesh = dst_mesh.reshape(side, side, 2)
        else:
            src_mesh = src_mesh.reshape(8, -1, 2)
            dst_mesh = dst_mesh.reshape(8, -1, 2)

    src_x_grid = src_mesh[:, :, 0].astype(np.float32)
    src_y_grid = src_mesh[:, :, 1].astype(np.float32)

    map_x = cv2.resize(src_x_grid, (w, h), interpolation=cv2.INTER_CUBIC)
    map_y = cv2.resize(src_y_grid, (w, h), interpolation=cv2.INTER_CUBIC)

    map_x = np.clip(map_x, 0, w - 1).astype(np.float32)
    map_y = np.clip(map_y, 0, h - 1).astype(np.float32)

    dewarped = cv2.remap(
        image, 
        map_x, 
        map_y, 
        interpolation=cv2.INTER_CUBIC, 
        borderMode=cv2.BORDER_REPLICATE
    )
    return dewarped


def ai_auto_unwrinkle(
    image: np.ndarray,
    strength: float = 0.8,
    mesh_rows: int = 8,
    mesh_cols: int = 8
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Careful AI unwrinkling with bounded regularization.
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image.copy()

    if strength <= 0.05:
        src, dst = generate_unwrinkle_mesh((h, w), mesh_rows, mesh_cols)
        return image.copy(), src, dst

    offsets = extract_horizontal_flows(gray, num_bands=10, num_cols=12) * strength
    src_mesh, dst_mesh = generate_unwrinkle_mesh((h, w), rows=mesh_rows, cols=mesh_cols, offsets=offsets)
    dewarped = remap_mesh_dense(image, src_mesh, dst_mesh)

    return dewarped, src_mesh, dst_mesh


def dewarp_page(image: np.ndarray, strength: float = 0.8) -> np.ndarray:
    result, _, _ = ai_auto_unwrinkle(image, strength=strength)
    return result
