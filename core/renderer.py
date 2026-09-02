"""
core/renderer.py — Bộ dựng ảnh xác định (Deterministic Renderer).

NGUYÊN TẮC:
    Ảnh đang sửa LUÔN là hàm thuần của (ảnh gốc + tình trạng trong metadata).
        anh_dang_sua = render(anh_goc, corners, rotation, settings)

    Nhờ vậy tệp trên đĩa và metadata không bao giờ lệch nhau: chỉ cần dựng lại
    là ra đúng thứ người dùng đang nhìn thấy.

TỐC ĐỘ:
    - Xem trước (preview): thu nhỏ ảnh gốc trước khi xử lý -> phản hồi tức thì khi kéo thanh trượt.
    - Kết xuất cuối (full): xử lý ở độ phân giải đầy đủ khi lưu / xuất PDF.
"""

from typing import Optional, Tuple, Dict, Any

import cv2
import numpy as np

from core.detector import detect_document_corners, four_point_transform, rotate_image
from core.dewarp import ai_auto_unwrinkle
from core.enhancer import enhance_document
from core.compressor import compress_image_to_bytes

# Cạnh dài tối đa của ảnh xem trước. Đủ nét trên màn hình Retina, đủ nhanh khi kéo trượt.
PREVIEW_MAX_DIM = 1600
# Cạnh dài tối đa của ảnh gốc hiển thị trên canvas khi căn 4 góc.
ORIGINAL_VIEW_MAX_DIM = 2000


def scale_to_max(img: np.ndarray, max_dim: int) -> Tuple[np.ndarray, float]:
    """Thu nhỏ ảnh sao cho cạnh dài không vượt max_dim. Trả về (ảnh, tỉ lệ đã áp dụng)."""
    h, w = img.shape[:2]
    longest = max(h, w)
    if longest <= max_dim:
        return img, 1.0
    scale = max_dim / float(longest)
    resized = cv2.resize(
        img,
        (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
        interpolation=cv2.INTER_AREA,
    )
    return resized, scale


def render_page(
    original: np.ndarray,
    corners: Optional[list],
    rotation: int,
    settings: Dict[str, Any],
    max_dim: Optional[int] = None,
) -> np.ndarray:
    """
    Dựng ảnh đang sửa từ ảnh gốc và tình trạng hiện tại.

    max_dim=None  -> kết xuất đầy đủ độ phân giải (dùng khi lưu đĩa / xuất PDF).
    max_dim=<int> -> kết xuất nhanh cho xem trước.
    """
    work = original
    scale = 1.0
    if max_dim:
        work, scale = scale_to_max(original, max_dim)

    if corners and len(corners) == 4:
        pts = np.array(corners, dtype=np.float32) * scale
    else:
        pts, _ = detect_document_corners(
            work, margin_percent=float(settings.get("margin_percent", 0.02))
        )

    warped = four_point_transform(work, pts)

    rot = int(rotation or 0) % 360
    if rot:
        warped = rotate_image(warped, rot)

    if settings.get("dewarp_enabled") and float(settings.get("dewarp_strength", 0.8)) > 0.05:
        warped, _, _ = ai_auto_unwrinkle(warped, strength=float(settings["dewarp_strength"]))

    return enhance_document(
        warped,
        mode=settings.get("mode", "natural"),
        shadow_reduction=float(settings.get("shadow_reduction", 0.6)),
        sharpness=float(settings.get("sharpness", 0.6)),
        contrast=float(settings.get("contrast", 0.2)),
        brightness=float(settings.get("brightness", 0.0)),
    )


def encode_preview(img: np.ndarray, quality: int = 88) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise ValueError("Không thể mã hóa ảnh xem trước.")
    return buf.tobytes()


def encode_final(img: np.ndarray, settings: Dict[str, Any]) -> Tuple[bytes, int, Tuple[int, int]]:
    """Nén ảnh ở chất lượng người dùng chọn, chuẩn hóa 300 DPI nếu được bật."""
    return compress_image_to_bytes(
        img,
        format="jpeg",
        quality=int(settings.get("quality", 85)),
        normalize_res=bool(settings.get("normalize_res", True)),
    )


def make_thumbnail(img: np.ndarray, max_dim: int = 320, quality: int = 78) -> bytes:
    thumb, _ = scale_to_max(img, max_dim)
    return encode_preview(thumb, quality=quality)
