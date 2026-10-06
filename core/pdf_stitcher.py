"""
core/pdf_stitcher.py — Ghép các trang của file PDF thành 1 ảnh duy nhất (Ảnh dài hoặc Ảnh lưới / Grid).

HỖ TRỢ CÁC BỐ CỤC:
    1. "vertical" (Dọc / Dài): Toàn bộ trang xếp thành 1 cột từ trên xuống dưới.
    2. "grid" (Lưới / Rộng): Xếp thành N cột (ví dụ 3 cột: 5 trang -> 3 trên, 2 dưới căn giữa hoặc căn trái).
    3. "horizontal" (Ngang): Toàn bộ trang xếp thành 1 hàng ngang từ trái sang phải.
"""

import io
import math
from typing import List, Tuple, Optional, Dict, Any

import cv2
import numpy as np


def render_pdf_to_images(
    pdf_bytes: bytes,
    dpi: float = 200.0,
    max_dim_per_page: int = 2400
) -> List[np.ndarray]:
    """
    Trích xuất toàn bộ các trang của file PDF thành danh sách ảnh BGR NumPy.
    Sử dụng PyMuPDF (fitz) để kết xuất trang sắc nét với độ phân giải DPI phù hợp.
    """
    try:
        import fitz
    except ImportError:
        raise RuntimeError("Máy chủ chưa cài đặt thư viện đọc PDF (PyMuPDF).")

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise ValueError("Tệp PDF bị hỏng hoặc không đúng định dạng.")

    if doc.is_encrypted:
        raise ValueError("Tệp PDF được bảo vệ bằng mật khẩu, vui lòng mở khóa trước.")

    if len(doc) == 0:
        raise ValueError("Tệp PDF rỗng, không có trang nào.")

    images: List[np.ndarray] = []
    for page_idx in range(len(doc)):
        page = doc[page_idx]
        rect = page.rect
        w_pt, h_pt = float(rect.width), float(rect.height)
        if w_pt <= 0 or h_pt <= 0:
            continue

        # Tính toán hệ số phóng đại (scale) dựa theo DPI và giới hạn cạnh dài
        scale = min(dpi / 72.0, float(max_dim_per_page) / max(w_pt, h_pt))
        scale = max(scale, 100.0 / 72.0)  # Tối thiểu ~100 DPI để rõ chữ

        matrix = fitz.Matrix(scale, scale)
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        samples = np.frombuffer(pix.samples, dtype=np.uint8)
        img = samples.reshape((pix.height, pix.width, pix.n))

        if pix.n == 3:
            bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        elif pix.n == 1:
            bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        elif pix.n == 4:
            bgr = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
        else:
            bgr = cv2.cvtColor(img[:, :, :3], cv2.COLOR_RGB2BGR)

        images.append(bgr)

    if not images:
        raise ValueError("Không thể trích xuất trang nào từ tệp PDF.")

    return images


def parse_color_hex(hex_str: str, default: Tuple[int, int, int] = (255, 255, 255)) -> Tuple[int, int, int]:
    """Chuyển đổi mã màu hex (#ffffff hoặc #0f172a) sang BGR tuple cho OpenCV."""
    if not hex_str or not isinstance(hex_str, str):
        return default
    h = hex_str.strip().lstrip("#")
    if len(h) == 3:
        h = "".join([c * 2 for c in h])
    if len(h) == 6:
        try:
            r = int(h[0:2], 16)
            g = int(h[2:4], 16)
            b = int(h[4:6], 16)
            return (b, g, r)  # BGR
        except ValueError:
            pass
    return default


def stitch_images(
    images: List[np.ndarray],
    layout: str = "grid",
    cols: int = 3,
    spacing: int = 24,
    padding: int = 32,
    bg_color: Tuple[int, int, int] = (255, 255, 255),
    draw_border: bool = True,
    last_row_align: str = "center",
    scale: float = 1.0,
    max_total_dim: int = 24000
) -> np.ndarray:
    """
    Ghép danh sách ảnh thành 1 ảnh tổng hợp duy nhất.

    Tham số:
        - images: Danh sách các ảnh trang (NumPy BGR).
        - layout: "vertical" (ảnh dài), "grid" (lưới N cột), "horizontal" (ảnh ngang).
        - cols: Số cột khi dùng bố cục grid (mặc định 3 cột).
        - spacing: Khoảng cách giữa các trang (pixel).
        - padding: Lề bao quanh ảnh ghép (pixel).
        - bg_color: Màu nền ảnh ghép (BGR tuple, mặc định trắng).
        - draw_border: Vẽ viền mỏng quanh từng trang để tách biệt nền.
        - last_row_align: Căn hàng cuối khi không đủ cột ("center" hoặc "left").
        - scale: Tỷ lệ co giãn các trang (0.25 - 1.0).
        - max_total_dim: Cạnh dài tối đa của ảnh ghép để chống tràn RAM.
    """
    if not images:
        raise ValueError("Danh sách trang rỗng.")

    # 1. Thu phóng trang theo scale nếu scale != 1.0
    processed_images: List[np.ndarray] = []
    scale = max(0.1, min(2.0, float(scale or 1.0)))
    for img in images:
        h, w = img.shape[:2]
        if abs(scale - 1.0) > 0.01:
            nw = max(10, int(round(w * scale)))
            nh = max(10, int(round(h * scale)))
            resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LANCZOS4)
            processed_images.append(resized)
        else:
            processed_images.append(img)

    num_pages = len(processed_images)
    spacing = max(0, int(spacing))
    padding = max(0, int(padding))

    # 2. Xử lý theo bố cục
    if layout == "vertical" or cols <= 1:
        # BỐ CỤC DỌC (1 CỘT DÀI)
        max_w = max(img.shape[1] for img in processed_images)
        total_w = max_w + 2 * padding
        total_h = sum(img.shape[0] for img in processed_images) + (num_pages - 1) * spacing + 2 * padding

        canvas = np.full((total_h, total_w, 3), bg_color, dtype=np.uint8)

        cur_y = padding
        for img in processed_images:
            h, w = img.shape[:2]
            cur_x = padding + (max_w - w) // 2
            canvas[cur_y:cur_y + h, cur_x:cur_x + w] = img
            if draw_border:
                cv2.rectangle(canvas, (cur_x, cur_y), (cur_x + w - 1, cur_y + h - 1), (218, 222, 229), 1)
            cur_y += h + spacing

    elif layout == "horizontal":
        # BỐ CỤC NGANG (1 HÀNG)
        max_h = max(img.shape[0] for img in processed_images)
        total_h = max_h + 2 * padding
        total_w = sum(img.shape[1] for img in processed_images) + (num_pages - 1) * spacing + 2 * padding

        canvas = np.full((total_h, total_w, 3), bg_color, dtype=np.uint8)

        cur_x = padding
        for img in processed_images:
            h, w = img.shape[:2]
            cur_y = padding + (max_h - h) // 2
            canvas[cur_y:cur_y + h, cur_x:cur_x + w] = img
            if draw_border:
                cv2.rectangle(canvas, (cur_x, cur_y), (cur_x + w - 1, cur_y + h - 1), (218, 222, 229), 1)
            cur_x += w + spacing

    else:
        # BỐ CỤC LƯỚI (GRID N CỘT)
        cols = max(1, int(cols))
        cols = min(cols, num_pages)

        # Chuẩn hóa độ rộng cột: lấy độ rộng trung vị / tối đa của các trang
        col_w = max(img.shape[1] for img in processed_images)

        # Điều chỉnh kích thước từng trang để vừa khít độ rộng cột col_w (giữ nguyên tỷ lệ)
        scaled_grid_imgs: List[np.ndarray] = []
        for img in processed_images:
            h, w = img.shape[:2]
            if w != col_w:
                ratio = float(col_w) / float(w)
                new_h = max(10, int(round(h * ratio)))
                resized = cv2.resize(img, (col_w, new_h), interpolation=cv2.INTER_AREA if ratio < 1.0 else cv2.INTER_LANCZOS4)
                scaled_grid_imgs.append(resized)
            else:
                scaled_grid_imgs.append(img)

        # Phân chia thành các hàng
        rows_data = []
        for i in range(0, num_pages, cols):
            row_items = scaled_grid_imgs[i:i + cols]
            row_max_h = max(item.shape[0] for item in row_items)
            rows_data.append((row_items, row_max_h))

        # Tính tổng kích thước khung hình
        grid_content_w = cols * col_w + (cols - 1) * spacing
        total_w = grid_content_w + 2 * padding
        total_h = sum(r_h for _, r_h in rows_data) + (len(rows_data) - 1) * spacing + 2 * padding

        canvas = np.full((total_h, total_w, 3), bg_color, dtype=np.uint8)

        cur_y = padding
        for row_items, row_h in rows_data:
            item_count = len(row_items)
            # Tính tọa độ bắt đầu x của hàng
            if item_count < cols and last_row_align == "center":
                row_content_w = item_count * col_w + (item_count - 1) * spacing
                start_x = padding + (grid_content_w - row_content_w) // 2
            else:
                start_x = padding

            for idx, img in enumerate(row_items):
                ih, iw = img.shape[:2]
                ix = start_x + idx * (col_w + spacing)
                # Căn giữa theo chiều dọc trong hàng
                iy = cur_y + (row_h - ih) // 2

                canvas[iy:iy + ih, ix:ix + iw] = img
                if draw_border:
                    cv2.rectangle(canvas, (ix, iy), (ix + iw - 1, iy + ih - 1), (218, 222, 229), 1)

            cur_y += row_h + spacing

    # 3. Giới hạn kích thước tối đa để tránh lỗi bộ nhớ hoặc kích thước vượt chuẩn JPEG
    ch, cw = canvas.shape[:2]
    longest = max(ch, cw)
    if longest > max_total_dim:
        scale_down = float(max_total_dim) / float(longest)
        target_w = max(10, int(round(cw * scale_down)))
        target_h = max(10, int(round(ch * scale_down)))
        canvas = cv2.resize(canvas, (target_w, target_h), interpolation=cv2.INTER_AREA)

    return canvas


def encode_stitched_image(
    image: np.ndarray,
    format: str = "jpeg",
    quality: int = 88
) -> Tuple[bytes, str]:
    """Mã hóa ảnh ghép thành bytes JPEG hoặc PNG."""
    fmt = (format or "jpeg").lower()
    if fmt in ("png",):
        ok, buf = cv2.imencode(".png", image, [int(cv2.IMWRITE_PNG_COMPRESSION), 6])
        mime = "image/png"
    else:
        quality = max(30, min(100, int(quality or 88)))
        ok, buf = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        mime = "image/jpeg"

    if not ok:
        raise ValueError("Không thể mã hóa ảnh kết quả.")

    return buf.tobytes(), mime


def make_stitched_preview(image: np.ndarray, max_preview_dim: int = 1600, quality: int = 80) -> bytes:
    """Tạo bản xem trước thu nhỏ của ảnh ghép để hiển thị siêu nhanh trên giao diện."""
    h, w = image.shape[:2]
    longest = max(h, w)
    if longest <= max_preview_dim:
        thumb = image
    else:
        scale = float(max_preview_dim) / float(longest)
        nw = max(1, int(round(w * scale)))
        nh = max(1, int(round(h * scale)))
        thumb = cv2.resize(image, (nw, nh), interpolation=cv2.INTER_AREA)

    ok, buf = cv2.imencode(".jpg", thumb, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise ValueError("Không thể tạo ảnh xem trước.")
    return buf.tobytes()
