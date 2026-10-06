"""
tests/test_pdf_stitcher.py — Kiểm thử tự động tính năng Ghép PDF thành 1 ảnh (Dài / Lưới Grid).
"""

import io
import os
import sys
import unittest
import numpy as np
import cv2
import fitz
from starlette.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.pdf_stitcher import (
    render_pdf_to_images,
    stitch_images,
    encode_stitched_image,
    make_stitched_preview,
    parse_color_hex,
)
from server import app


def _create_sample_pdf(num_pages=5, width=600, height=800) -> bytes:
    """Tạo tệp PDF mẫu gồm N trang để kiểm thử."""
    doc = fitz.open()
    for idx in range(1, num_pages + 1):
        # Tạo trang với kích thước cụ thể
        page = doc.new_page(width=float(width), height=float(height))
        # Vẽ hình chữ nhật và viết số trang
        rect = fitz.Rect(50, 50, width - 50, height - 50)
        shape = page.new_shape()
        shape.draw_rect(rect)
        shape.finish(color=(0.2, 0.4, 0.8), fill=(0.9, 0.95, 1.0))
        shape.commit()
        page.insert_text(fitz.Point(100, 150), f"Trang {idx} / {num_pages}", fontsize=28, color=(0.1, 0.2, 0.5))
    data = doc.write(deflate=True)
    doc.close()
    return data


class TestPdfStitcher(unittest.TestCase):

    def setUp(self):
        self.sample_pdf = _create_sample_pdf(num_pages=5, width=600, height=800)
        self.client = TestClient(app)

    def test_render_pdf_to_images(self):
        """Kiểm tra trích xuất chính xác 5 trang từ file PDF."""
        images = render_pdf_to_images(self.sample_pdf, dpi=100.0, max_dim_per_page=1000)
        self.assertEqual(len(images), 5)
        for img in images:
            self.assertIsInstance(img, np.ndarray)
            self.assertEqual(len(img.shape), 3)
            self.assertGreater(img.shape[0], 0)
            self.assertGreater(img.shape[1], 0)

    def test_stitch_vertical_long_image(self):
        """Kiểm tra ghép ảnh dài (Dọc - 1 cột): các trang xếp thẳng hàng từ trên xuống dưới."""
        images = render_pdf_to_images(self.sample_pdf, dpi=100.0, max_dim_per_page=800)
        stitched = stitch_images(
            images,
            layout="vertical",
            spacing=20,
            padding=30,
            bg_color=(255, 255, 255),
            draw_border=True,
        )
        self.assertIsInstance(stitched, np.ndarray)
        # Tổng chiều cao phải xấp xỉ tổng các trang + spacing + padding
        total_page_h = sum(img.shape[0] for img in images)
        expected_h = total_page_h + 4 * 20 + 2 * 30
        self.assertEqual(stitched.shape[0], expected_h)
        # Chiều rộng bằng chiều rộng trang + 2 * padding
        max_page_w = max(img.shape[1] for img in images)
        self.assertEqual(stitched.shape[1], max_page_w + 2 * 30)

    def test_stitch_grid_3_cols_5_pages(self):
        """Kiểm tra đúng yêu cầu: 5 trang với 3 cột -> Hàng 1 có 3 trang, Hàng 2 có 2 trang."""
        images = render_pdf_to_images(self.sample_pdf, dpi=100.0, max_dim_per_page=800)
        stitched = stitch_images(
            images,
            layout="grid",
            cols=3,
            spacing=20,
            padding=30,
            bg_color=(255, 255, 255),
            draw_border=True,
            last_row_align="center",
        )
        self.assertIsInstance(stitched, np.ndarray)
        col_w = max(img.shape[1] for img in images)
        expected_w = 3 * col_w + 2 * 20 + 2 * 30
        self.assertEqual(stitched.shape[1], expected_w)
        # 5 trang chia 3 cột = 2 hàng
        page_h = images[0].shape[0]
        expected_h = 2 * page_h + 1 * 20 + 2 * 30
        self.assertEqual(stitched.shape[0], expected_h)

    def test_stitch_horizontal(self):
        """Kiểm tra ghép ngang (1 hàng): các trang xếp từ trái sang phải."""
        images = render_pdf_to_images(self.sample_pdf, dpi=100.0, max_dim_per_page=800)
        stitched = stitch_images(
            images,
            layout="horizontal",
            spacing=20,
            padding=30,
            bg_color=(240, 240, 240),
            draw_border=False,
        )
        self.assertIsInstance(stitched, np.ndarray)
        total_page_w = sum(img.shape[1] for img in images)
        expected_w = total_page_w + 4 * 20 + 2 * 30
        self.assertEqual(stitched.shape[1], expected_w)

    def test_encode_and_preview(self):
        """Kiểm tra mã hóa JPEG, PNG và tạo preview thu nhỏ nhanh."""
        images = render_pdf_to_images(self.sample_pdf, dpi=100.0, max_dim_per_page=600)
        stitched = stitch_images(images, layout="grid", cols=3)

        jpg_bytes, mime_jpg = encode_stitched_image(stitched, format="jpeg", quality=85)
        self.assertEqual(mime_jpg, "image/jpeg")
        self.assertGreater(len(jpg_bytes), 1000)

        png_bytes, mime_png = encode_stitched_image(stitched, format="png")
        self.assertEqual(mime_png, "image/png")
        self.assertGreater(len(png_bytes), 1000)

        preview_bytes = make_stitched_preview(stitched, max_preview_dim=800)
        self.assertIsInstance(preview_bytes, bytes)
        self.assertGreater(len(preview_bytes), 500)

    def test_api_stitch_preview_upload(self):
        """Kiểm tra gọi API /api/stitch-preview-upload với file PDF tải lên."""
        response = self.client.post(
            "/api/stitch-preview-upload",
            files={"file": ("test_doc.pdf", self.sample_pdf, "application/pdf")},
            data={"layout": "grid", "cols": "3", "spacing": "20", "last_row_align": "center"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("content-type"), "image/jpeg")
        self.assertEqual(response.headers.get("x-total-pages"), "5")
        self.assertEqual(response.headers.get("x-cols"), "3")
        self.assertEqual(response.headers.get("x-rows"), "2")

    def test_api_stitch_export_upload(self):
        """Kiểm tra gọi API /api/stitch-export-upload tải về ảnh kết quả."""
        response = self.client.post(
            "/api/stitch-export-upload",
            files={"file": ("test_doc.pdf", self.sample_pdf, "application/pdf")},
            data={
                "layout": "vertical",
                "cols": "1",
                "format": "jpeg",
                "quality": "85",
                "doc_name": "Test-Export",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("content-type"), "image/jpeg")
        self.assertIn("attachment", response.headers.get("content-disposition", ""))
        self.assertIn("Test-Export.jpg", response.headers.get("content-disposition", ""))


if __name__ == "__main__":
    unittest.main()
