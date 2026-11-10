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


import base64
import io
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter


def _get_font(size: int, bold: bool = False) -> Any:
    candidates = [
        "C:\\Windows\\Fonts\\arialbd.ttf" if bold else "C:\\Windows\\Fonts\\arial.ttf",
        "C:\\Windows\\Fonts\\segoeuib.ttf" if bold else "C:\\Windows\\Fonts\\segoeui.ttf",
        "arial.ttf",
        "segoeui.ttf",
    ]
    for p in candidates:
        try:
            return ImageFont.truetype(p, max(10, int(size)))
        except Exception:
            continue
    try:
        return ImageFont.load_default()
    except Exception:
        return None


def _parse_rgba(val: Any, default=(239, 68, 68, 255)) -> Tuple[int, int, int, int]:
    if not val or not isinstance(val, str):
        return default
    val = val.strip()
    if val.startswith("#"):
        h = val.lstrip("#")
        if len(h) == 3:
            h = "".join([c * 2 for c in h])
        if len(h) == 6:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
        if len(h) == 8:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16))
    if val.startswith("rgba"):
        import re
        nums = re.findall(r"[\d.]+", val)
        if len(nums) >= 4:
            return (int(float(nums[0])), int(float(nums[1])), int(float(nums[2])), int(float(nums[3]) * 255))
    if val.startswith("rgb"):
        import re
        nums = re.findall(r"\d+", val)
        if len(nums) >= 3:
            return (int(nums[0]), int(nums[1]), int(nums[2]), 255)
    return default


def bake_annotations(img: np.ndarray, annotations: Optional[list]) -> np.ndarray:
    """Hòa trộn các lớp vector chú thích lên ảnh ở độ phân giải hiện tại."""
    if not annotations or not isinstance(annotations, list) or len(annotations) == 0:
        return img

    h, w = img.shape[:2]
    if w <= 0 or h <= 0:
        return img

    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    pil_base = Image.fromarray(rgb).convert("RGBA")
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    scale_ref = max(w, h)

    for ann in annotations:
        if not isinstance(ann, dict):
            continue
        atype = ann.get("type", "rect")
        color = _parse_rgba(ann.get("color", "#ef4444"))
        stroke_w = max(2, int(round(float(ann.get("strokeWidth", 4)) * scale_ref / 1000.0)))
        font_sz = max(12, int(round(float(ann.get("fontSize", 18)) * scale_ref / 1000.0)))

        # 1. Hình chữ nhật (Rect)
        if atype == "rect":
            x1 = int(round(float(ann.get("x", 0)) * w))
            y1 = int(round(float(ann.get("y", 0)) * h))
            x2 = int(round((float(ann.get("x", 0)) + float(ann.get("w", 0))) * w))
            y2 = int(round((float(ann.get("y", 0)) + float(ann.get("h", 0))) * h))
            fill_c = _parse_rgba(ann["fillColor"]) if ann.get("fillColor") else None
            draw.rectangle([min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)], outline=color, width=stroke_w, fill=fill_c)

        # 2. Hình tròn / Elip
        elif atype == "ellipse":
            x1 = int(round(float(ann.get("x", 0)) * w))
            y1 = int(round(float(ann.get("y", 0)) * h))
            x2 = int(round((float(ann.get("x", 0)) + float(ann.get("w", 0))) * w))
            y2 = int(round((float(ann.get("y", 0)) + float(ann.get("h", 0))) * h))
            fill_c = _parse_rgba(ann["fillColor"]) if ann.get("fillColor") else None
            draw.ellipse([min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)], outline=color, width=stroke_w, fill=fill_c)

        # 3. Đường thẳng (Line)
        elif atype == "line":
            x1 = int(round(float(ann.get("x1", 0)) * w))
            y1 = int(round(float(ann.get("y1", 0)) * h))
            x2 = int(round(float(ann.get("x2", 0)) * w))
            y2 = int(round(float(ann.get("y2", 0)) * h))
            draw.line([(x1, y1), (x2, y2)], fill=color, width=stroke_w)

        # 4. Mũi tên (Arrow) kèm nhãn
        elif atype == "arrow":
            x1 = int(round(float(ann.get("x1", 0)) * w))
            y1 = int(round(float(ann.get("y1", 0)) * h))
            x2 = int(round(float(ann.get("x2", 0)) * w))
            y2 = int(round(float(ann.get("y2", 0)) * h))
            draw.line([(x1, y1), (x2, y2)], fill=color, width=stroke_w)

            # Vẽ đầu mũi tên hình tam giác
            angle = math.atan2(y2 - y1, x2 - x1)
            arrow_len = max(14, stroke_w * 4)
            arrow_w = arrow_len * 0.55
            p1 = (x2, y2)
            p2 = (
                x2 - arrow_len * math.cos(angle) + arrow_w * math.sin(angle),
                y2 - arrow_len * math.sin(angle) - arrow_w * math.cos(angle),
            )
            p3 = (
                x2 - arrow_len * math.cos(angle) - arrow_w * math.sin(angle),
                y2 - arrow_len * math.sin(angle) + arrow_w * math.cos(angle),
            )
            draw.polygon([p1, p2, p3], fill=color)

            # Chú thích dọc theo thân mũi tên
            text = ann.get("text")
            if text:
                font = _get_font(font_sz, bold=True)
                mx = (x1 + x2) // 2
                my = (y1 + y2) // 2
                bbox = draw.textbbox((mx, my), text, font=font)
                pw, ph = (bbox[2] - bbox[0]) + 16, (bbox[3] - bbox[1]) + 8
                bx1, by1 = mx - pw // 2, my - ph // 2
                draw.rounded_rectangle([bx1, by1, bx1 + pw, by1 + ph], radius=6, fill=(15, 23, 42, 220), outline=color, width=1)
                draw.text((bx1 + 8, by1 + 4), text, font=font, fill=(255, 255, 255, 255))

        # 5. Bút dạ quang (Highlighter vệt sáng trong suốt)
        elif atype == "highlighter":
            x1 = int(round(float(ann.get("x", 0)) * w))
            y1 = int(round(float(ann.get("y", 0)) * h))
            x2 = int(round((float(ann.get("x", 0)) + float(ann.get("w", 0))) * w))
            y2 = int(round((float(ann.get("y", 0)) + float(ann.get("h", 0))) * h))
            hl_color = (color[0], color[1], color[2], 100)
            draw.rectangle([min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)], fill=hl_color)

        # 6. Hộp văn bản (Text Box)
        elif atype == "text":
            x = int(round(float(ann.get("x", 0)) * w))
            y = int(round(float(ann.get("y", 0)) * h))
            text = ann.get("text", "")
            if text:
                font = _get_font(font_sz, bold=ann.get("bold", False))
                bbox = draw.textbbox((x, y), text, font=font)
                tw = bbox[2] - bbox[0]
                th = bbox[3] - bbox[1]
                if ann.get("fillColor"):
                    fill_c = _parse_rgba(ann["fillColor"])
                    draw.rounded_rectangle([x - 6, y - 4, x + tw + 10, y + th + 8], radius=4, fill=fill_c, outline=color if stroke_w > 1 else None, width=stroke_w)
                draw.text((x, y), text, font=font, fill=color)

        # 7. Bóng thoại (Callout Snagit)
        elif atype == "callout":
            bx = int(round(float(ann.get("x", 0)) * w))
            by = int(round(float(ann.get("y", 0)) * h))
            bw = max(60, int(round(float(ann.get("w", 0.2)) * w)))
            bh = max(36, int(round(float(ann.get("h", 0.08)) * h)))
            tx = int(round(float(ann.get("tailX", ann.get("x", 0))) * w))
            ty = int(round(float(ann.get("tailY", ann.get("y", 0))) * h))

            bg_c = _parse_rgba(ann.get("fillColor", "#0284c7"))
            border_c = _parse_rgba(ann.get("color", "#ffffff"))

            # Vẽ đuôi bóng thoại trỏ vào điểm mục tiêu
            cx = bx + bw // 2
            cy = by + bh // 2
            draw.polygon([(cx - 12, cy), (cx + 12, cy), (tx, ty)], fill=bg_c)
            draw.rounded_rectangle([bx, by, bx + bw, by + bh], radius=8, fill=bg_c, outline=border_c, width=stroke_w)

            text = ann.get("text", "Chú thích")
            font = _get_font(font_sz, bold=True)
            draw.text((bx + 12, by + 8), text, font=font, fill=(255, 255, 255, 255))

        # 8. Đánh số bước tuần tự (Step Badges 1, 2, 3...)
        elif atype == "step":
            cx = int(round(float(ann.get("x", 0)) * w))
            cy = int(round(float(ann.get("y", 0)) * h))
            radius = max(14, int(round(float(ann.get("radius", 18)) * scale_ref / 1000.0)))
            step_num = str(ann.get("stepNumber", 1))

            # Hình tròn nền với viền trắng nổi bật
            draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=color, outline=(255, 255, 255, 255), width=max(2, stroke_w))
            font = _get_font(int(radius * 1.2), bold=True)
            tbox = draw.textbbox((0, 0), step_num, font=font)
            tw = tbox[2] - tbox[0]
            th = tbox[3] - tbox[1]
            draw.text((cx - tw // 2, cy - th // 2 - 2), step_num, font=font, fill=(255, 255, 255, 255))

        # 9. Làm mờ bảo mật (Blur / Pixelate Redaction)
        elif atype == "blur":
            x1 = max(0, min(w - 1, int(round(float(ann.get("x", 0)) * w))))
            y1 = max(0, min(h - 1, int(round(float(ann.get("y", 0)) * h))))
            x2 = max(0, min(w, int(round((float(ann.get("x", 0)) + float(ann.get("w", 0))) * w))))
            y2 = max(0, min(h, int(round((float(ann.get("y", 0)) + float(ann.get("h", 0))) * h))))
            bw = max(4, x2 - x1)
            bh = max(4, y2 - y1)
            # Pixelate khu vực nhạy cảm
            sub = pil_base.crop((x1, y1, x1 + bw, y1 + bh))
            small = sub.resize((max(2, bw // 16), max(2, bh // 16)), Image.NEAREST)
            pixelated = small.resize((bw, bh), Image.NEAREST)
            pil_base.paste(pixelated, (x1, y1))
            draw.rectangle([x1, y1, x1 + bw, y1 + bh], outline=(100, 116, 139, 160), width=1)

        # 10. Tẩy trắng / Xóa (Smart Whiteout)
        elif atype == "whiteout":
            x1 = int(round(float(ann.get("x", 0)) * w))
            y1 = int(round(float(ann.get("y", 0)) * h))
            x2 = int(round((float(ann.get("x", 0)) + float(ann.get("w", 0))) * w))
            y2 = int(round((float(ann.get("y", 0)) + float(ann.get("h", 0))) * h))
            draw.rectangle([min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)], fill=(255, 255, 255, 255))

        # 11. Cắt - Kéo - Dán (Image Patch)
        elif atype == "image_patch":
            patch_data = ann.get("patchDataUrl")
            if patch_data and "base64," in patch_data:
                try:
                    b64 = patch_data.split("base64,")[1]
                    patch_img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGBA")
                    px = int(round(float(ann.get("x", 0)) * w))
                    py = int(round(float(ann.get("y", 0)) * h))
                    pw = int(round(float(ann.get("w", 0)) * w))
                    ph = int(round(float(ann.get("h", 0)) * h))
                    if pw > 0 and ph > 0:
                        patch_img = patch_img.resize((pw, ph), Image.Resampling.LANCZOS)
                        pil_base.paste(patch_img, (px, py), patch_img)
                except Exception as e:
                    print(f"[bake_annotations] Lỗi dán ảnh: {e}")

    # Ghép overlay vector lên ảnh nền
    final_pil = Image.alpha_composite(pil_base, overlay).convert("RGB")
    return cv2.cvtColor(np.array(final_pil), cv2.COLOR_RGB2BGR)


def apply_page_format(
    image: np.ndarray,
    preset: str = "original",
    orientation: str = "auto",
    fit_mode: str = "fill",
    margin_pct: float = 0.0,
    stretch_x: float = 1.0,
    stretch_y: float = 1.0,
    bg_color: Tuple[int, int, int] = (255, 255, 255),
) -> np.ndarray:
    """
    Chuẩn hóa ảnh tài liệu theo các khổ giấy và tỉ lệ chuẩn:
      - Văn bản: A4, A5, A3, Letter
      - Giấy tờ: Passport đơn, Passport 2 trang mở, CCCD/ID Card
      - Tỉ lệ: 2:3, 16:9, 4:3, 1:1
    Resize/co giãn trực tiếp trên ảnh hiện tại để vừa khít 100% tỉ lệ chuẩn, không phủ lề.
    """
    if image is None or image.size == 0:
        return image

    h, w = image.shape[:2]
    if h <= 0 or w <= 0:
        return image

    PRESET_RATIOS = {
        "a4": 1.41421356,
        "a5": 1.4189,
        "a3": 1.41421356,
        "letter": 11.0 / 8.5,
        "passport": 45.0 / 35.0,
        "passport_single": 45.0 / 35.0,
        "passport_4x6": 6.0 / 4.0,
        "passport_spread": 176.0 / 125.0,
        "id_card": 85.6 / 54.0,
        "ratio_2_3": 3.0 / 2.0,
        "ratio_16_9": 16.0 / 9.0,
        "ratio_4_3": 4.0 / 3.0,
        "ratio_1_1": 1.0,
    }

    if preset and preset != "original":
        base_r = PRESET_RATIOS.get(preset, 1.41421356)

        if orientation == "auto":
            is_landscape = (w >= h)
        elif orientation == "landscape":
            is_landscape = True
        else:
            is_landscape = False

        # Tính toán tỉ lệ mục tiêu W / H
        if preset in ("passport_spread", "id_card", "ratio_16_9", "ratio_4_3"):
            target_r = base_r if is_landscape else (1.0 / base_r)
        elif preset in ("ratio_1_1",):
            target_r = 1.0
        else:
            target_r = (1.0 / base_r) if not is_landscape else base_r

        cur_r = w / float(h)

        if fit_mode == "crop":
            # Cắt xén phủ kín: Giữ nguyên tỉ lệ điểm ảnh, cắt bớt mép ngoài để vừa khít
            if cur_r < target_r:
                crop_h = max(1, int(round(w / target_r)))
                y1 = max(0, (h - crop_h) // 2)
                image = image[y1:y1 + crop_h, :]
            else:
                crop_w = max(1, int(round(h * target_r)))
                x1 = max(0, (w - crop_w) // 2)
                image = image[:, x1:x1 + crop_w]
        else:
            # fit_mode in ("fill", "stretch", "fit"):
            # Resize / Co giãn trực tiếp ảnh hiện tại để đạt 100% tỉ lệ chuẩn (KHÔNG phủ lề)
            if cur_r < target_r:
                new_w = max(1, int(round(h * target_r)))
                new_h = h
            else:
                new_w = w
                new_h = max(1, int(round(w / target_r)))
            image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)

    # Co giãn tinh chỉnh theo chiều ngang/dọc (stretch_x / stretch_y)
    sx = float(stretch_x) if stretch_x is not None else 1.0
    sy = float(stretch_y) if stretch_y is not None else 1.0
    if abs(sx - 1.0) > 0.005 or abs(sy - 1.0) > 0.005:
        cur_h, cur_w = image.shape[:2]
        new_w = max(10, int(round(cur_w * sx)))
        new_h = max(10, int(round(cur_h * sy)))
        if new_w != cur_w or new_h != cur_h:
            image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)

    # Nếu người dùng cố ý đặt lề viền phụ > 0%
    margin = float(margin_pct or 0.0)
    if margin > 0.005:
        margin = min(0.25, margin)
        cur_h, cur_w = image.shape[:2]
        pad_x = int(round(cur_w * margin))
        pad_y = int(round(cur_h * margin))
        image = cv2.copyMakeBorder(image, pad_y, pad_y, pad_x, pad_x, cv2.BORDER_CONSTANT, value=bg_color)

    return image




def render_page(
    original: np.ndarray,
    corners: Optional[list],
    rotation: int,
    settings: Dict[str, Any],
    max_dim: Optional[int] = None,
    annotations: Optional[list] = None,
) -> np.ndarray:
    """
    Dựng ảnh đang sửa từ ảnh gốc và tình trạng hiện tại, kèm hòa trộn các lớp chú thích.

    max_dim=None  -> kết xuất đầy đủ độ phân giải (dùng khi lưu đĩa / xuất PDF).
    max_dim=<int> -> kết xuất nhanh cho xem trước.
    """
    work = original
    scale = 1.0
    if max_dim:
        work, scale = scale_to_max(original, max_dim)

    if corners and len(corners) in (4, 6):
        pts = np.array(corners, dtype=np.float32) * scale
        margin_pct = float(settings.get("margin_percent", 0.0))
        if margin_pct > 0.001:
            from core.detector import expand_quad
            pts = expand_quad(pts, work.shape[:2], margin_pct)
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

    # Bước 2: Khổ ảnh & Cỡ giấy chuẩn (A4, Passport, CCCD, 2:3, 16:9...)
    page_preset = settings.get("page_size_preset", "original")
    scale_x = float(settings.get("page_scale_x", 1.0))
    scale_y = float(settings.get("page_scale_y", 1.0))
    margin_pct = float(settings.get("page_margin_pct", 0.0))

    if (page_preset and page_preset != "original") or abs(scale_x - 1.0) > 0.005 or abs(scale_y - 1.0) > 0.005 or margin_pct > 0.005:
        warped = apply_page_format(
            warped,
            preset=page_preset or "original",
            orientation=settings.get("page_orientation", "auto"),
            fit_mode=settings.get("page_fit_mode", "fill"),
            margin_pct=margin_pct,
            stretch_x=scale_x,
            stretch_y=scale_y,
        )

    enhanced = enhance_document(
        warped,
        mode=settings.get("mode", "original"),
        brightness=float(settings.get("brightness", 0.0)),
        shadow_reduction=float(settings.get("shadow_reduction", 0.0)),
        sharpness=float(settings.get("sharpness", 0.0)),
        contrast=float(settings.get("contrast", 0.0)),
        filter_intensity=float(settings.get("filter_intensity", 1.0)),
    )

    if annotations:
        enhanced = bake_annotations(enhanced, annotations)

    return enhanced


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
