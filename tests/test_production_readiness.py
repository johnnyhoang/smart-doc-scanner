"""
tests/test_production_readiness.py — Khoá lại các lỗi chặn phát hành đã tìm ra khi audit.

Khác với `test_document_object.py` (bảo vệ mô hình dữ liệu), bộ này bảo vệ những
điều kiện để ứng dụng giao được cho người dùng thật:

  1. Ghi đĩa thất bại (ổ đầy, tệp bị khoá) PHẢI báo lỗi, tuyệt đối không báo thành công.
  2. Thư mục "Kho chưa duyệt" trùng lặp phải được gộp, và không ảnh nào bị ẩn khỏi giao diện.
  3. Không mở CORS cho mọi nguồn — máy chủ chạy nội bộ, mở ra là lộ toàn bộ tài liệu.
  4. Tác vụ nặng không được chạy trên event loop (làm đóng băng mọi yêu cầu khác).
  5. Có giới hạn dung lượng / độ phân giải ảnh nhập vào.

Chạy:  python tests/test_production_readiness.py
"""

import inspect
import os
import shutil
import sys
import tempfile

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402
from core import pagestore as ps  # noqa: E402

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE_IMAGE = os.path.join(PROJECT_DIR, "test_input.jpg")


class Project:
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="docscan_prod_")
        self.client = TestClient(server.app)
        self.client.post("/api/scan-directory", json={"path": self.root})

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def import_page(self, name, rel=""):
        with open(SAMPLE_IMAGE, "rb") as f:
            blob = f.read()
        res = self.client.post(
            "/api/import",
            files={"file": (name, blob, "image/jpeg")},
            data={"relative_path": rel},
        )
        assert res.status_code == 200, res.text
        return res.json()


# ==========================================================
# 1. GHI ĐĨA THẤT BẠI PHẢI BÁO LỖI
# ==========================================================

def test_ghi_dia_that_bai_phai_bao_loi_khong_duoc_bao_thanh_cong():
    """
    Đây là kịch bản mất dữ liệu thầm lặng nguy hiểm nhất: máy chủ nuốt lỗi ghi đĩa,
    trả success, giao diện xoá cờ "chưa lưu" và người dùng mất trắng công chỉnh sửa.
    """
    p = Project()
    real_write = ps.write_edited_bytes
    try:
        pages = [p.import_page(f"Trang {i}.jpg") for i in range(1, 4)]

        def disk_full(*_a, **_k):
            raise OSError(28, "There is not enough space on the disk")

        ps.write_edited_bytes = disk_full
        payload = [{"filename": x["filename"], "corners": x["corners"],
                    "rotation": 0, "settings": x["settings"]} for x in pages]

        res = p.client.post("/api/save-folder", json={
            "relative_path": "", "pages": payload, "save_pdf": True, "pdf_name": "HoSo"})
        assert res.status_code >= 400, f"ghi đĩa hỏng mà vẫn trả HTTP {res.status_code}"
        assert "đầy" in res.json().get("detail", ""), res.json()

        res2 = p.client.post("/api/save-project", json={"folders": [
            {"relative_path": "", "pages": payload, "save_pdf": True}]})
        assert res2.status_code >= 400, "save-project báo thành công dù không ghi được gì"
    finally:
        ps.write_edited_bytes = real_write
        p.close()


def test_luu_mot_phan_phai_liet_ke_dung_trang_thanh_cong():
    """Lưu được một phần thì phải nói rõ trang nào xong, trang nào chưa."""
    p = Project()
    real_write = ps.write_edited_bytes
    try:
        pages = [p.import_page(f"Trang {i}.jpg") for i in range(1, 4)]
        hong = pages[1]["filename"]

        def fail_one(root, rel, filename, data):
            if filename == hong:
                raise OSError(13, "Permission denied")
            return real_write(root, rel, filename, data)

        ps.write_edited_bytes = fail_one
        res = p.client.post("/api/save-folder", json={
            "relative_path": "",
            "pages": [{"filename": x["filename"], "corners": x["corners"],
                       "rotation": 0, "settings": x["settings"]} for x in pages],
            "save_pdf": False})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["saved_pages"] == 2, body
        assert hong not in body["saved_filenames"], "trang ghi hỏng lại bị coi là đã lưu"
        assert len(body["failed_pages"]) == 1
        assert body["failed_pages"][0]["filename"] == hong
        assert "quyền" in body["failed_pages"][0]["reason"], body["failed_pages"]
    finally:
        ps.write_edited_bytes = real_write
        p.close()


# ==========================================================
# 2. KHÔNG ẢNH NÀO ĐƯỢC BIẾN MẤT KHỎI GIAO DIỆN
# ==========================================================

def test_gop_kho_chua_duyet_co_du_lieu_that():
    """Thư mục của người dùng được tôn trọng, không tự ý di chuyển hay xoá."""
    p = Project()
    try:
        alias = os.path.join(p.root, "Kho ảnh chưa duyệt")
        os.makedirs(alias, exist_ok=True)
        p.import_page("Hoa Don.jpg", rel="Kho ảnh chưa duyệt")

        res = p.client.post("/api/scan-directory", json={"path": p.root}).json()

        assert os.path.isdir(alias), "thư mục của người dùng không được tự ý xoá hay gộp ngầm"
        jpgs = [f for f in os.listdir(alias) if f.lower().endswith(".jpg")]
        assert jpgs, "ảnh trong thư mục của người dùng phải được giữ nguyên"
    finally:
        p.close()


def test_khong_anh_nao_bi_an_khoi_giao_dien():
    """
    Mọi trang trả về đều phải thuộc một thư mục mà giao diện biết.
    Trang trỏ vào thư mục không tồn tại = ảnh có thật trên đĩa mà người dùng không thấy.
    """
    p = Project()
    try:
        for folder in (ps.UNAPPROVED_DIR, "Kho ảnh chưa duyệt"):
            os.makedirs(os.path.join(p.root, folder), exist_ok=True)
            p.import_page(f"Anh {folder[:6]}.jpg", rel=folder)

        res = p.client.post("/api/scan-directory", json={"path": p.root}).json()
        known = {f["id"] for f in res["folders"]}
        hidden = [pg["filename"] for pg in res["pages"] if pg["folderId"] not in known]
        assert not hidden, f"ảnh bị ẩn khỏi giao diện: {hidden}"
        assert len(res["pages"]) == 2, f"mất trang: chỉ thấy {len(res['pages'])}/2"
    finally:
        p.close()


# ==========================================================
# 3. BẢO MẬT: KHÔNG MỞ CORS CHO MỌI NGUỒN
# ==========================================================

def test_khong_mo_cors_cho_moi_nguon():
    """
    Máy chủ chạy ở localhost. Nếu bật Access-Control-Allow-Origin: * thì bất kỳ
    trang web nào người dùng đang mở cũng đọc được toàn bộ tài liệu đã quét.
    """
    p = Project()
    try:
        res = p.client.get(
            "/api/image?kind=thumb&rel=&file=khong-co.jpg",
            headers={"Origin": "https://trang-web-la.example"},
        )
        acao = res.headers.get("access-control-allow-origin")
        assert acao != "*", "máy chủ đang cho phép MỌI website đọc tài liệu của người dùng"

        names = [m.cls.__name__ for m in server.app.user_middleware]
        assert "CORSMiddleware" not in names, f"CORS vẫn được bật: {names}"
    finally:
        p.close()


# ==========================================================
# 4. TÁC VỤ NẶNG KHÔNG ĐƯỢC CHẠY TRÊN EVENT LOOP
# ==========================================================

def test_endpoint_nang_khong_chan_event_loop():
    """
    FastAPI chạy handler `async def` ngay trên event loop. Một lần kết xuất ảnh hoặc
    ghép PDF sẽ đóng băng mọi yêu cầu khác (thumbnail, xem trước...). Các endpoint
    nặng CPU phải khai báo `def` thường để được đẩy sang threadpool.
    """
    nang = [
        "get_image", "process_preview", "auto_detect", "api_commit_page",
        "save_folder", "save_project", "export_pdf", "export_project_pdf",
        "export_images_zip", "download_single", "ai_suggest_name", "scan_directory",
    ]
    vi_pham = [n for n in nang
               if inspect.iscoroutinefunction(getattr(server, n, None))]
    assert not vi_pham, f"các endpoint nặng vẫn chạy trên event loop: {vi_pham}"


# ==========================================================
# 5. GIỚI HẠN TÀI NGUYÊN KHI NHẬP ẢNH
# ==========================================================

def test_chan_tep_qua_lon():
    p = Project()
    try:
        oversized = b"\xff\xd8\xff" + b"\x00" * (server.MAX_UPLOAD_BYTES + 1024)
        res = p.client.post(
            "/api/import",
            files={"file": ("khong-lo.jpg", oversized, "image/jpeg")},
            data={"relative_path": ""},
        )
        assert res.status_code == 413, f"tệp vượt giới hạn vẫn được nhận (HTTP {res.status_code})"
        assert "quá lớn" in res.json().get("detail", "")
    finally:
        p.close()


def test_tu_choi_tep_khong_phai_anh():
    p = Project()
    try:
        res = p.client.post(
            "/api/import",
            files={"file": ("tai-lieu.jpg", b"day khong phai anh", "image/jpeg")},
            data={"relative_path": ""},
        )
        assert res.status_code == 400, res.status_code
        assert "ảnh" in res.json().get("detail", "")
    finally:
        p.close()


# ==========================================================
# 6. THÔNG BÁO LỖI KHÔNG ĐƯỢC LỘ CHI TIẾT KỸ THUẬT
# ==========================================================

def test_thong_bao_loi_la_tieng_viet_khong_lo_ky_thuat():
    p = Project()
    try:
        cases = [
            p.client.post("/api/rename-page", json={
                "relative_path": "", "filename": "khong-co.jpg", "new_name": ""}),
            p.client.post("/api/create-folder", json={
                "relative_path": "", "folder_name": ""}),
            p.client.post("/api/delete-folder", json={"relative_path": ""}),
            p.client.get("/api/image?kind=edited&rel=&file=khong-co.jpg"),
        ]
        for res in cases:
            assert res.status_code >= 400
            detail = str(res.json().get("detail", ""))
            for xau in ("Traceback", "Errno", "Exception", "None", "\\\\"):
                assert xau not in detail, f"lộ chi tiết kỹ thuật: {detail}"
            assert detail.strip(), "thông báo lỗi rỗng"
    finally:
        p.close()



# ==========================================================
# 7. XUẤT TỆP: NGƯỜI DÙNG CHỌN NƠI LƯU, LƯU ẢNH KHÔNG GHÉP PDF
# ==========================================================

def test_luu_anh_khong_tu_sinh_tep_pdf():
    """
    Lưu = ghi ảnh + metadata. Ghép PDF phải đọc lại TOÀN BỘ ảnh của thư mục nên
    chi phí tăng theo số trang dù chỉ sửa một trang (đo được: 20 trang -> 668 ms/lần lưu).
    PDF là việc xuất bản riêng, chỉ chạy khi người dùng chủ động yêu cầu.
    """
    p = Project()
    try:
        pages = [p.import_page(f"Trang {i}.jpg") for i in range(1, 4)]
        body = [{"filename": x["filename"], "corners": x["corners"],
                 "rotation": 0, "settings": x["settings"]} for x in pages]
        p.client.post("/api/save-folder", json={"relative_path": "", "pages": body})
        p.client.post("/api/save-project", json={"folders": [
            {"relative_path": "", "pages": body}]})

        pdfs = [f for f in os.listdir(p.root) if f.lower().endswith(".pdf")]
        assert pdfs == [], f"lưu ảnh vẫn tự sinh tệp PDF: {pdfs}"
    finally:
        p.close()


def test_tu_choi_ghi_tep_ra_duong_dan_tuy_y():
    """
    `save_path` chỉ được chấp nhận nếu do hộp thoại hệ điều hành vừa cấp.
    Nhận đường dẫn tuỳ ý từ yêu cầu HTTP = biến máy chủ thành công cụ ghi tệp bất kỳ.
    """
    p = Project()
    try:
        page = p.import_page("Trang.jpg")
        outside = os.path.join(tempfile.gettempdir(), "docscan_khong_duoc_ghi.pdf")
        res = p.client.post("/api/export-pdf", json={
            "relative_path": "", "filenames": [page["filename"]], "save_path": outside})
        assert res.status_code == 400, f"đường dẫn tuỳ ý vẫn được nhận (HTTP {res.status_code})"
        assert not os.path.exists(outside), "đã ghi ra tệp ở đường dẫn không được phép"
    finally:
        p.close()


def test_xuat_pdf_zip_anh_vao_noi_nguoi_dung_chon():
    """Cả 3 lệnh xuất đều ghi thẳng vào đường dẫn người dùng chọn và báo lại nơi đã lưu."""
    p = Project()
    try:
        pages = [p.import_page(f"Trang {i}.jpg") for i in range(1, 3)]
        names = [x["filename"] for x in pages]

        for endpoint, target_name, body in [
            ("/api/export-pdf", "Bo Ho So.pdf",
             {"relative_path": "", "filenames": names}),
            ("/api/export-images-zip", "Bo Anh.zip",
             {"relative_path": "", "filenames": names}),
            ("/api/download-single", "Anh Tai Ve.png",
             {"relative_path": "", "filename": names[0], "format": "png"}),
        ]:
            target = os.path.join(p.root, target_name)
            server._remember_save_path(target)   # mô phỏng người dùng chọn trong hộp thoại
            res = p.client.post(endpoint, json={**body, "save_path": target})
            assert res.status_code == 200, f"{endpoint}: {res.text[:150]}"
            assert os.path.exists(target), f"{endpoint}: không tạo ra tệp {target_name}"
            assert res.json().get("saved_to") == target, f"{endpoint}: không báo nơi đã lưu"
    finally:
        p.close()


def test_don_pdf_cu_chi_cham_dung_khuon_ten_ban_cu():
    """
    Dọn PDF cũ là thao tác XOÁ TỆP không hoàn tác được, nên phạm vi phải cực hẹp:
    chỉ những tệp trùng đúng khuôn tên mà bản cũ tự sinh. PDF do người dùng tự đặt tên
    tuyệt đối không được chạm tới.
    """
    p = Project()
    try:
        sub = os.path.join(p.root, "Hop Dong")
        os.makedirs(sub, exist_ok=True)
        p.import_page("Trang 1.jpg", rel="Hop Dong")
        p.client.post("/api/scan-directory", json={"path": p.root})

        auto_pdf = os.path.join(sub, "Hop Dong.pdf")             # khuôn bản cũ tự sinh
        user_pdf = os.path.join(sub, "Ban Hop Dong Da Ky.pdf")   # người dùng tự đặt
        for path in (auto_pdf, user_pdf):
            with open(path, "wb") as f:
                f.write(b"%PDF-1.4\n%%EOF\n")

        found = p.client.post("/api/legacy-pdfs", json={"confirm": False}).json()
        listed = {f["filename"] for f in found["files"]}
        assert listed == {"Hop Dong.pdf"}, f"liệt kê sai phạm vi: {listed}"
        assert os.path.exists(auto_pdf), "đã xoá khi chỉ mới liệt kê"

        p.client.post("/api/legacy-pdfs", json={"confirm": True})
        assert not os.path.exists(auto_pdf), "chưa xoá được tệp PDF cũ"
        assert os.path.exists(user_pdf), "đã xoá PDF do người dùng tự đặt tên"
    finally:
        p.close()


def test_six_point_book_spread_transform():
    """Kiểm tra tính năng nắn phẳng ảnh tài liệu 2 trang dính nhau với 6 điểm mốc."""
    import numpy as np
    from core import renderer as rd
    from core.detector import four_point_transform

    img = np.zeros((600, 800, 3), dtype=np.uint8)
    cv2_corners = [
        [20.0, 30.0],
        [400.0, 70.0],  # Điểm gáy trên
        [780.0, 35.0],
        [770.0, 560.0],
        [400.0, 520.0],  # Điểm gáy dưới
        [30.0, 570.0],
    ]
    warped = four_point_transform(img, np.array(cv2_corners, dtype=np.float32))
    assert warped is not None
    assert warped.shape[0] > 100
    assert warped.shape[1] > 200

    rendered = rd.render_page(img, cv2_corners, 0, {"mode": "natural", "dewarp_enabled": False})
    assert rendered is not None
    assert rendered.shape[:2] == warped.shape[:2]


def test_aspect_ratio_and_directional_expansion():
    """Kiểm tra co giãn đa giác theo chiều ngang, chiều dọc và căn tỉ lệ A4, 2:3, 16:9."""
    import numpy as np
    from core.detector import expand_quad_directional, fit_quad_aspect_ratio

    # Hình chữ nhật 400 x 600
    pts = np.array([
        [100.0, 100.0],
        [500.0, 100.0],
        [500.0, 700.0],
        [100.0, 700.0],
    ], dtype=np.float32)

    # 1. Giãn ngang factor_x = 1.1, factor_y = 1.0
    exp_x = expand_quad_directional(pts, (800, 800), factor_x=1.1, factor_y=1.0)
    w_orig = pts[1, 0] - pts[0, 0]
    w_new = exp_x[1, 0] - exp_x[0, 0]
    assert np.isclose(w_new, w_orig * 1.1, atol=1e-2)
    assert np.isclose(exp_x[2, 1] - exp_x[1, 1], pts[2, 1] - pts[1, 1], atol=1e-2)

    # 2. Giãn dọc factor_x = 1.0, factor_y = 1.2
    exp_y = expand_quad_directional(pts, (800, 800), factor_x=1.0, factor_y=1.2)
    h_orig = pts[2, 1] - pts[1, 1]
    h_new = exp_y[2, 1] - exp_y[1, 1]
    assert np.isclose(h_new, h_orig * 1.2, atol=1e-2)
    assert np.isclose(exp_y[1, 0] - exp_y[0, 0], pts[1, 0] - pts[0, 0], atol=1e-2)

    # 3. Căn tỉ lệ A4 đứng (1 / sqrt(2) ≈ 0.7071)
    a4_quad = fit_quad_aspect_ratio(pts, (800, 800), target_ratio=1.0 / np.sqrt(2), expand=True)
    a4_w = a4_quad[1, 0] - a4_quad[0, 0]
    a4_h = a4_quad[2, 1] - a4_quad[1, 1]
    assert np.isclose(a4_w / a4_h, 1.0 / np.sqrt(2), atol=1e-3)

    # 4. Căn tỉ lệ 16:9
    w16_quad = fit_quad_aspect_ratio(pts, (2000, 2000), target_ratio=16.0 / 9.0, expand=True)
    w16_w = w16_quad[1, 0] - w16_quad[0, 0]
    w16_h = w16_quad[2, 1] - w16_quad[1, 1]
    assert np.isclose(w16_w / w16_h, 16.0 / 9.0, atol=1e-3)


def test_filter_intensity_blending():
    """Kiểm tra thanh kéo mức độ áp dụng bộ lọc (0% -> 100%)."""
    import numpy as np
    from core.enhancer import enhance_document

    img = np.full((100, 100, 3), 120, dtype=np.uint8)
    # Thêm một vùng màu đỏ để kiểm tra bộ lọc
    img[20:80, 20:80] = [30, 40, 200]

    # 1. 100% bộ lọc ma thuật
    res_100 = enhance_document(img, mode="magic_color", filter_intensity=1.0)
    # 2. 0% bộ lọc ma thuật (phải bằng ảnh gốc cân bằng)
    res_0 = enhance_document(img, mode="magic_color", filter_intensity=0.0)
    # 3. 50% bộ lọc ma thuật
    res_50 = enhance_document(img, mode="magic_color", filter_intensity=0.5)

    assert res_100 is not None
    assert res_0 is not None
    assert res_50 is not None
    assert res_100.shape == img.shape
    assert res_50.shape == img.shape

    # Ở 50%, giá trị pixel phải nằm giữa 0% và 100%
    expected_mid = (res_100.astype(np.float32) * 0.5 + res_0.astype(np.float32) * 0.5).astype(np.uint8)
    diff = np.abs(res_50.astype(np.int16) - expected_mid.astype(np.int16))
    assert np.mean(diff) <= 2.0  # Chênh lệch do làm tròn số nguyên không vượt quá 2 giá trị


def test_apply_page_format_presets():
    """Kiểm tra Bước 2: Khổ ảnh chuẩn (A4, Passport, 16:9...)."""
    import numpy as np
    from core.renderer import apply_page_format, render_page

    img = np.zeros((1000, 800, 3), dtype=np.uint8)

    # 1. Khổ A4 đứng (1 : 1.4142)
    a4_out = apply_page_format(img, preset="a4", orientation="portrait", fit_mode="fit")
    assert a4_out is not None
    r_a4 = a4_out.shape[1] / float(a4_out.shape[0])
    assert np.isclose(r_a4, 1.0 / 1.41421356, atol=1e-2)

    # 2. Khổ Passport 35x45mm (35 : 45 = 0.7778)
    pass_out = apply_page_format(img, preset="passport", orientation="portrait", fit_mode="fit")
    assert pass_out is not None
    r_pass = pass_out.shape[1] / float(pass_out.shape[0])
    assert np.isclose(r_pass, 35.0 / 45.0, atol=1e-2)

    # 3. Khổ 16:9 ngang (16 : 9 = 1.7778)
    w169_out = apply_page_format(img, preset="ratio_16_9", orientation="landscape", fit_mode="fill")
    assert w169_out is not None
    r_169 = w169_out.shape[1] / float(w169_out.shape[0])
    assert np.isclose(r_169, 16.0 / 9.0, atol=1e-2)

    # 4. Tích hợp render_page với page_size_preset
    corners = [[0, 0], [800, 0], [800, 1000], [0, 1000]]
    rendered = render_page(img, corners, 0, {
        "page_size_preset": "a4",
        "page_orientation": "portrait",
        "page_fit_mode": "fill",
        "mode": "natural",
    })
    assert rendered is not None
    r_rend = rendered.shape[1] / float(rendered.shape[0])
    assert np.isclose(r_rend, 1.0 / 1.41421356, atol=1e-2)

    # 5. Kiểm tra co giãn trực tiếp ảnh (không phủ lề): ảnh có màu nền xanh 100%, không bị chèn viền trắng
    blue_img = np.full((1000, 800, 3), [255, 0, 0], dtype=np.uint8)
    a4_blue = apply_page_format(blue_img, preset="a4", orientation="portrait", fit_mode="fill")
    assert np.all(a4_blue[:, :, 0] == 255)
    assert np.all(a4_blue[:, :, 1] == 0)

    # 6. Kiểm tra giãn ngang & dọc trực tiếp (stretch_x, stretch_y)
    stretch_out = apply_page_format(img, preset="original", stretch_x=1.2, stretch_y=1.1)
    assert stretch_out.shape[1] == int(round(800 * 1.2))
    assert stretch_out.shape[0] == int(round(1000 * 1.1))


if __name__ == "__main__":
    cases = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in cases:
        try:
            fn()
            print(f"  OK   {name}")
        except AssertionError as e:
            failed += 1
            print(f" FAIL  {name}: {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f" LOI   {name}: {type(e).__name__}: {e}")
    print(f"\n{len(cases) - failed}/{len(cases)} bai kiem thu dat.")
    sys.exit(1 if failed else 0)
