"""
tests/test_document_object.py — Kiểm thử bất biến "Đối Tượng Tài Liệu".

Mỗi trang tài liệu phải luôn là một bộ ba trọn vẹn trên đĩa:
    _goc/<tên>_goc.jpg  +  <tên>.jpg  +  mục trong .docscan_meta.json

Bộ kiểm thử này khóa lại các lỗi đã từng làm bộ ba bị lệch nhau:
  - đổi tên tài liệu sinh ra bản sao và bỏ lại tệp cũ
  - thao tác lưu gửi payload thiếu trường làm xóa trắng góc cắt / lịch sử
  - tự động lưu một trang làm tệp PDF nhiều trang co lại còn một trang
  - trang đổi tên bị đẩy xuống cuối thứ tự in
  - tắt ứng dụng giữa chừng khiến ảnh trên đĩa cũ hơn metadata mà không ai biết

Chạy:  python tests/test_document_object.py     (hoặc)   python -m pytest tests/ -v
"""

import json
import os
import shutil
import sys
import tempfile

import fitz
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402
from core import pagestore as ps  # noqa: E402

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE_IMAGE = os.path.join(PROJECT_DIR, "test_input.jpg")


class Project:
    """Một thư mục dự án tạm kèm client đã trỏ sẵn vào đó."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="docscan_test_")
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

    def scan(self, rel=None):
        pages = self.client.post("/api/scan-directory", json={"path": self.root}).json()["pages"]
        return pages if rel is None else [p for p in pages if p["relativePath"] == ps.normalize_rel(rel)]

    def meta(self, rel=""):
        with open(os.path.join(ps.folder_dir(self.root, rel), ps.META_FILE), encoding="utf-8") as f:
            return json.load(f)

    def path(self, rel, *parts):
        return os.path.join(ps.folder_dir(self.root, rel), *parts)

    def goc_path(self, rel, filename):
        return self.path(rel, ps.GOC_DIR, f"{ps.stem_of(filename)}{ps.GOC_SUFFIX}.jpg")


# ==========================================================
# BỘ BA TRỌN VẸN
# ==========================================================

def test_import_ghi_ngay_du_bo_ba():
    """Ảnh vừa nhập phải có ngay cả 3 thành phần — tắt app đột ngột không mất gì."""
    p = Project()
    try:
        page = p.import_page("Hóa Đơn GTGT.jpg")
        name = page["filename"]
        assert os.path.exists(p.path("", name)), "thiếu ảnh đang sửa"
        assert os.path.exists(p.goc_path("", name)), "thiếu ảnh gốc trong _goc/"
        assert os.path.exists(p.path("", ps.META_FILE)), "thiếu tệp metadata"
        assert page["has_raw_original"] is True
        assert len(page["corners"]) == 4
    finally:
        p.close()


def test_ten_giu_nguyen_dau_tieng_viet():
    p = Project()
    try:
        page = p.import_page("Hợp Đồng Thuê Nhà.jpg")
        assert page["filename"] == "Hợp Đồng Thuê Nhà.jpg", page["filename"]
    finally:
        p.close()


def test_nhap_trung_ten_khong_ghi_de():
    p = Project()
    try:
        a = p.import_page("Trang.jpg")
        b = p.import_page("Trang.jpg")
        assert a["filename"] != b["filename"], "ảnh thứ hai đã ghi đè ảnh thứ nhất"
        assert len(p.scan("")) == 2
    finally:
        p.close()


# ==========================================================
# ĐỔI TÊN — PHẢI ĐỔI CẢ BỘ BA
# ==========================================================

def test_doi_ten_doi_ca_bo_ba_khong_de_lai_ban_sao():
    p = Project()
    try:
        old = p.import_page("anh_chup.jpg")["filename"]
        new = p.client.post("/api/rename-page", json={
            "relative_path": "", "filename": old, "new_name": "Hợp Đồng Thuê Nhà",
        }).json()["filename"]

        assert new == "Hợp Đồng Thuê Nhà.jpg"
        assert not os.path.exists(p.path("", old)), "còn sót ảnh mang tên cũ"
        assert not os.path.exists(p.goc_path("", old)), "còn sót ảnh gốc mang tên cũ"
        assert os.path.exists(p.path("", new))
        assert os.path.exists(p.goc_path("", new))

        pages = p.meta("")["pages"]
        assert new in pages and old not in pages, list(pages)
        assert pages[new]["corners"], "đổi tên làm mất góc cắt"
    finally:
        p.close()


def test_doi_ten_giu_nguyen_vi_tri_trong_thu_tu_in():
    """Trang đổi tên không được bị đẩy xuống cuối tệp PDF."""
    p = Project()
    try:
        names = [p.import_page(f"Trang {i}.jpg")["filename"] for i in range(1, 5)]
        custom = list(reversed(names))
        p.client.post("/api/save-metadata", json={"relative_path": "", "pages": [], "order": custom})
        assert [x["filename"] for x in p.scan("")] == custom

        renamed = p.client.post("/api/rename-page", json={
            "relative_path": "", "filename": custom[1], "new_name": "Phụ Lục",
        }).json()["filename"]

        after = [x["filename"] for x in p.scan("")]
        assert after[1] == renamed, f"trang đổi tên nhảy khỏi vị trí: {after}"
    finally:
        p.close()


# ==========================================================
# METADATA — KHÔNG BAO GIỜ BỊ XÓA TRẮNG
# ==========================================================

def test_payload_thieu_truong_khong_xoa_du_lieu_cu():
    """Lưu với payload chỉ có tên tài liệu vẫn phải giữ nguyên góc cắt và bộ lọc."""
    p = Project()
    try:
        name = p.import_page("Biên Bản.jpg")["filename"]
        p.client.post("/api/save-metadata", json={
            "relative_path": "", "pages": [{"filename": name, "doc_name": "Biên Bản"}],
        })
        entry = p.meta("")["pages"][name]
        assert entry["corners"], "góc cắt bị xóa trắng"
        assert entry["settings"]["mode"], "bộ lọc bị xóa trắng"
    finally:
        p.close()


def test_luu_toan_du_an_giu_nguyen_metadata():
    p = Project()
    try:
        pages = [p.import_page(f"Trang {i}.jpg") for i in range(1, 4)]
        p.client.post("/api/save-project", json={"folders": [{
            "relative_path": "",
            "pages": [{"filename": x["filename"], "corners": x["corners"],
                       "rotation": 0, "settings": x["settings"]} for x in pages],
            "save_pdf": True,
        }]})
        for entry in p.meta("")["pages"].values():
            assert entry["corners"], "lưu toàn dự án làm mất góc cắt"
    finally:
        p.close()


# ==========================================================
# PDF — LUÔN ĐỦ TRANG
# ==========================================================

def test_tu_dong_luu_mot_trang_khong_lam_hut_pdf():
    p = Project()
    try:
        pages = [p.import_page(f"Trang {i}.jpg") for i in range(1, 4)]
        payload = [{"filename": x["filename"], "corners": x["corners"],
                    "rotation": 0, "settings": x["settings"]} for x in pages]
        p.client.post("/api/save-folder", json={
            "relative_path": "", "pages": payload, "save_pdf": True, "pdf_name": "HoSo"})

        pdf = p.path("", "HoSo.pdf")
        with fitz.open(pdf) as doc:
            assert doc.page_count == 3

        one = pages[1]
        p.client.post("/api/save-folder", json={
            "relative_path": "",
            "pages": [{"filename": one["filename"], "corners": one["corners"],
                       "rotation": 90, "settings": one["settings"]}],
            "save_pdf": True, "pdf_name": "HoSo"})
        with fitz.open(pdf) as doc:
            assert doc.page_count == 3, "PDF bị co lại còn đúng trang vừa lưu"
    finally:
        p.close()


# ==========================================================
# ẢNH TRÊN ĐĨA CŨ HƠN METADATA
# ==========================================================

def test_phat_hien_anh_cu_hon_metadata_va_tu_khoi_phuc():
    """Tắt app giữa chừng: lần mở sau phải biết ảnh chưa khớp và lưu lại được."""
    p = Project()
    try:
        page = p.import_page("Đơn Xin Phép.jpg")
        name = page["filename"]
        assert p.scan("")[0]["is_stale"] is False

        # Người dùng đổi bộ lọc (metadata ghi ngay) rồi tắt app trước khi ảnh kịp dựng lại
        p.client.post("/api/save-metadata", json={"relative_path": "", "pages": [
            {"filename": name, "settings": {**page["settings"], "mode": "bw_scan"}}]})
        assert p.scan("")[0]["is_stale"] is True, "không phát hiện ảnh cũ hơn metadata"

        p.client.post("/api/save-folder", json={"relative_path": "", "pages": [
            {"filename": name, "corners": page["corners"], "rotation": 0,
             "settings": {**page["settings"], "mode": "bw_scan"}}], "save_pdf": False})
        after = p.scan("")[0]
        assert after["is_stale"] is False
        assert after["settings"]["mode"] == "bw_scan"
    finally:
        p.close()


# ==========================================================
# ẢNH LẺ & VÒNG ĐỜI TRANG
# ==========================================================

def test_anh_le_duoc_danh_dau_va_nhan_nuoi_khong_tu_cat():
    """Nhận nuôi ảnh lẻ không được tự ý cắt tấm ảnh sẵn có của người dùng."""
    p = Project()
    try:
        shutil.copy(SAMPLE_IMAGE, p.path("", "anh_le.jpg"))
        found = [x for x in p.scan("") if x["filename"] == "anh_le.jpg"][0]
        assert found["has_raw_original"] is False

        adopted = p.client.post("/api/adopt-as-original", json={
            "relative_path": "", "filename": "anh_le.jpg"}).json()
        assert adopted["has_raw_original"] is True
        assert adopted["is_stale"] is False

        w, h = float(adopted["width"]), float(adopted["height"])
        corners = [[float(a) for a in pt] for pt in adopted["corners"]]
        assert corners == [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]], \
            "nhận nuôi đã tự cắt ảnh sẵn có của người dùng"
    finally:
        p.close()


def test_chuyen_trang_mang_theo_anh_goc_va_metadata():
    p = Project()
    try:
        page = p.import_page("Hóa Đơn.jpg")
        moved = p.client.post("/api/move-to-unapproved", json={
            "relative_path": "", "filename": page["filename"]}).json()
        rel = ps.UNAPPROVED_DIR
        assert os.path.exists(p.path(rel, moved["filename"])), "thiếu ảnh sau khi chuyển"
        assert os.path.exists(p.goc_path(rel, moved["filename"])), "ảnh gốc không đi cùng"
        assert moved["folder_name"] == ps.UNAPPROVED_LABEL
        assert p.meta(rel)["pages"][moved["filename"]]["corners"], "metadata không đi cùng"
    finally:
        p.close()


def test_xoa_trang_xoa_sach_ca_bo_ba():
    p = Project()
    try:
        name = p.import_page("Bỏ Đi.jpg")["filename"]
        p.client.post("/api/delete-page", json={"relative_path": "", "filename": name})
        assert not os.path.exists(p.path("", name))
        assert not os.path.exists(p.goc_path("", name))
        assert name not in p.meta("")["pages"]
    finally:
        p.close()


def test_dinh_danh_trang_on_dinh_giua_cac_lan_quet():
    """Định danh phải tất định, nếu không bộ nhớ máy chủ sẽ phình sau mỗi lần quét lại."""
    p = Project()
    try:
        p.import_page("Trang.jpg")
        assert [x["id"] for x in p.scan("")] == [x["id"] for x in p.scan("")]
    finally:
        p.close()


def test_chan_duong_dan_thoat_ra_ngoai_du_an():
    p = Project()
    try:
        res = p.client.post("/api/create-folder", json={
            "relative_path": "../../hack", "folder_name": "x"})
        assert res.status_code >= 400, "đường dẫn thoát ra ngoài dự án không bị chặn"
    finally:
        p.close()


def test_tu_dong_gop_kho_chua_duyet_trung_lap():
    p = Project()
    try:
        # Tạo 2 thư mục trùng lặp alias trên đĩa
        dir1 = os.path.join(p.root, "Kho_Chua_Duyet")
        dir2 = os.path.join(p.root, "Kho ảnh chưa duyệt")
        os.makedirs(dir1, exist_ok=True)
        os.makedirs(dir2, exist_ok=True)

        res = p.client.post("/api/scan-directory", json={"path": p.root})
        assert res.status_code == 200
        folders = res.json()["folders"]
        unapproved_folders = [f for f in folders if f.get("isUnapproved") or f.get("name") == "Kho ảnh chưa duyệt"]
        assert len(unapproved_folders) == 1, f"Có {len(unapproved_folders)} thư mục Kho chưa duyệt, phải là đúng 1"
    finally:
        p.close()


def test_xuat_anh_zip_va_xuat_pdf_theo_danh_sach_chon():
    import zipfile
    import io
    p = Project()
    try:
        p.import_page("Trang_1.jpg")
        p.import_page("Trang_2.jpg")

        # Test Xuất PDF 1 trang được chọn
        res_pdf = p.client.post("/api/export-pdf", json={
            "relative_path": "",
            "filenames": ["Trang_1.jpg"],
            "doc_name": "Don_1_Trang",
        })
        assert res_pdf.status_code == 200
        assert res_pdf.headers["content-type"] == "application/pdf"
        assert len(res_pdf.content) > 1000

        # Test Tải ảnh ZIP
        res_zip = p.client.post("/api/export-images-zip", json={
            "relative_path": "",
            "filenames": ["Trang_1.jpg", "Trang_2.jpg"],
            "zip_name": "Bo_Anh_Test",
        })
        assert res_zip.status_code == 200
        assert res_zip.headers["content-type"] == "application/zip"
        with zipfile.ZipFile(io.BytesIO(res_zip.content)) as zf:
            names = zf.namelist()
            assert len(names) == 2
            assert any("01_" in n for n in names)
            assert any("02_" in n for n in names)
    finally:
        p.close()


def test_import_pdf_quy_doi_ve_anh():
    """Tệp PDF (scan, export từ word hay in) quy đổi trọn vẹn thành ảnh trong bộ ba."""
    p = Project()
    try:
        doc = fitz.open()
        p1 = doc.new_page(width=300, height=400)
        p1.draw_rect([10, 10, 80, 80], color=(1, 0, 0))
        p2 = doc.new_page(width=300, height=400)
        p2.draw_rect([20, 20, 90, 90], color=(0, 1, 0))
        pdf_bytes = doc.tobytes()

        res = p.client.post(
            "/api/import",
            files={"file": ("Tài Liệu Hợp Đồng.pdf", pdf_bytes, "application/pdf")},
            data={"relative_path": ""},
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert isinstance(data, list) and len(data) == 2, "PDF 2 trang phải sinh 2 trang ảnh"

        for page in data:
            fname = page["filename"]
            assert fname.endswith(".jpg")
            assert os.path.exists(p.path("", fname)), f"thiếu ảnh {fname}"
            assert os.path.exists(p.goc_path("", fname)), f"thiếu ảnh gốc cho {fname}"
            assert page["has_raw_original"] is True
            assert len(page["corners"]) == 4

        # Quét lại phải đủ 2 trang
        scanned = p.scan("")
        assert len(scanned) == 2
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
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    print(f"\n{len(cases) - failed}/{len(cases)} test cases passed.")
    sys.exit(1 if failed else 0)
