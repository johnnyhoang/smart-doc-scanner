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
    """Thư mục trùng lặp CÓ ảnh + metadata phải được gộp trọn vẹn, không sót tệp."""
    p = Project()
    try:
        os.makedirs(os.path.join(p.root, ps.UNAPPROVED_DIR), exist_ok=True)
        alias = os.path.join(p.root, "Kho ảnh chưa duyệt")
        os.makedirs(alias, exist_ok=True)
        p.import_page("Hoa Don.jpg", rel="Kho ảnh chưa duyệt")

        res = p.client.post("/api/scan-directory", json={"path": p.root}).json()

        assert not os.path.isdir(alias), "thư mục trùng lặp chưa được dọn sau khi gộp"
        canon = os.path.join(p.root, ps.UNAPPROVED_DIR)
        jpgs = [f for f in os.listdir(canon) if f.lower().endswith(".jpg")]
        assert jpgs, "ảnh không được chuyển sang thư mục chuẩn"
        assert os.path.isdir(os.path.join(canon, ps.GOC_DIR)), "ảnh gốc không đi cùng"

        unapproved = [f for f in res["folders"] if f["isUnapproved"]]
        assert len(unapproved) == 1, f"còn {len(unapproved)} thư mục Kho chưa duyệt"
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
