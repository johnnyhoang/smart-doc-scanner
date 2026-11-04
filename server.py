"""
server.py — DocScan Studio Backend (FastAPI).

MÔ HÌNH TRUNG TÂM
    Một "trang tài liệu" luôn là một bộ ba trên đĩa, định danh bằng (thư_mục, tên_tệp):

        <thư_mục>/_goc/<stem>_goc.jpg  -> ảnh gốc (bất biến)
        <thư_mục>/<stem>.jpg           -> ảnh đang sửa (dựng lại được từ metadata)
        <thư_mục>/.docscan_meta.json   -> tình trạng hiện tại của trang

    Không có "trang chỉ nằm trong RAM": ảnh vừa nhập được ghi đủ bộ ba ngay lập tức,
    nên người dùng bắt đầu từ thư mục nào cũng thấy dữ liệu nhất quán như nhau.

    Mọi thao tác ghi đĩa đi qua core/pagestore.py; mọi kết xuất ảnh đi qua core/renderer.py.
"""

import errno
import json
import math
import os
import subprocess
import sys
import threading
from collections import OrderedDict
from typing import List, Optional, Dict, Any

import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel

from core import pagestore as ps
from core import renderer as rd
from core.detector import detect_document_corners, imread_unicode
from core.compressor import generate_pdf_from_images
from core.namer import get_basic_document_name, ai_ocr_suggest_document_name
from core.pdf_stitcher import (
    render_pdf_to_images,
    stitch_images,
    encode_stitched_image,
    make_stitched_preview,
    parse_color_hex,
)

app = FastAPI(title="DocScan Studio API", version="3.0.0")

# KHÔNG bật CORS. Giao diện được phục vụ cùng nguồn (same-origin) nên không cần,
# mà mở "allow_origins=*" trên một máy chủ chạy nội bộ sẽ cho phép BẤT KỲ trang web nào
# người dùng đang mở đọc được toàn bộ tài liệu đã quét của họ qua localhost.


# ==========================================================
# PHIÊN LÀM VIỆC & BỘ NHỚ ĐỆM ĐIỂM ẢNH
# ==========================================================

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".docscan_config.json")


def load_saved_root() -> str:
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding="utf-8") as fp:
                data = json.load(fp)
                path = data.get("last_root")
                if path and os.path.isdir(path):
                    return os.path.abspath(path)
    except Exception:
        pass
    default_dir = os.path.join(os.path.expanduser("~"), "Documents", "DocScan_Projects")
    try:
        os.makedirs(default_dir, exist_ok=True)
    except Exception:
        pass
    return os.path.abspath(default_dir)


def save_active_root(root: str):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as fp:
            json.dump({"last_root": os.path.abspath(root)}, fp, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[config-save] {e}")


SESSION: Dict[str, Optional[str]] = {"root": load_saved_root()}

# Chặn ảnh quá khổ làm cạn RAM máy người dùng.
MAX_UPLOAD_BYTES = 80 * 1024 * 1024     # 80 MB cho một tệp ảnh
MAX_UPLOAD_PIXELS = 80_000_000          # ~80 megapixel sau khi giải mã

# Chỉ cho phép ghi tệp xuất ra những đường dẫn mà CHÍNH hộp thoại hệ điều hành vừa cấp.
# Nếu nhận đường dẫn tuỳ ý từ yêu cầu HTTP thì đó là một công cụ ghi tệp bất kỳ trên máy.
_ALLOWED_SAVE_PATHS: "OrderedDict[str, bool]" = OrderedDict()
_MAX_ALLOWED_SAVE_PATHS = 32


def _remember_save_path(path: str) -> None:
    key = os.path.normcase(os.path.abspath(path))
    _ALLOWED_SAVE_PATHS[key] = True
    while len(_ALLOWED_SAVE_PATHS) > _MAX_ALLOWED_SAVE_PATHS:
        _ALLOWED_SAVE_PATHS.popitem(last=False)


def _checked_save_path(path: Optional[str]) -> Optional[str]:
    """Trả về đường dẫn nếu nó do hộp thoại cấp; ngược lại từ chối."""
    if not path:
        return None
    key = os.path.normcase(os.path.abspath(path))
    if key not in _ALLOWED_SAVE_PATHS:
        raise HTTPException(
            status_code=400,
            detail="Đường dẫn lưu không hợp lệ. Vui lòng chọn lại nơi lưu tệp.",
        )
    return os.path.abspath(path)


def _write_export(path: str, data: bytes, what: str) -> Dict[str, Any]:
    """Ghi tệp xuất ra và báo lỗi bằng câu tiếng Việt nếu thất bại."""
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except OSError as e:
        print(f"[export] {path}: {e!r}")
        raise HTTPException(
            status_code=507 if e.errno == errno.ENOSPC else 500,
            detail=f"Không lưu được {what}. {_friendly_write_error(e)}",
        )
    return {
        "success": True,
        "saved_to": path,
        "folder": os.path.dirname(path),
        "filename": os.path.basename(path),
        "file_size": len(data),
        "file_size_human": ps.format_file_size(len(data)),
    }


def active_root(explicit: Optional[str] = None) -> str:
    root = explicit or SESSION.get("root")
    if not root:
        raise HTTPException(status_code=400, detail="Chưa chọn thư mục dự án trên máy tính.")
    if not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="Thư mục dự án không còn tồn tại trên máy tính.")
    return root


class PixelCache:
    """
    Bộ nhớ đệm ảnh gốc đã giải mã, giới hạn số lượng (LRU).
    Thay cho kho ảnh vô hạn của phiên bản cũ vốn phình to sau mỗi lần quét lại.
    """

    def __init__(self, max_items: int = 8):
        self._items: "OrderedDict[str, np.ndarray]" = OrderedDict()
        self._max = max_items
        self._lock = threading.RLock()

    def get(self, key: str) -> Optional[np.ndarray]:
        with self._lock:
            if key in self._items:
                self._items.move_to_end(key)
                return self._items[key]
            return None

    def put(self, key: str, img: np.ndarray) -> None:
        with self._lock:
            self._items[key] = img
            self._items.move_to_end(key)
            while len(self._items) > self._max:
                self._items.popitem(last=False)

    def drop(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


ORIGINALS = PixelCache(max_items=8)


def load_original(root: str, rel: str, filename: str) -> np.ndarray:
    """Nạp ảnh gốc theo yêu cầu (lazy), có đệm để thao tác liên tiếp không đọc lại đĩa."""
    key = ps.make_page_id(root, rel, filename)
    cached = ORIGINALS.get(key)
    if cached is not None:
        return cached
    img = ps.read_original(root, rel, filename)
    if img is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy tệp ảnh của trang này trên máy.")
    ORIGINALS.put(key, img)
    return img


def invalidate(root: str, rel: str, filename: str) -> None:
    ORIGINALS.drop(ps.make_page_id(root, rel, filename))


def disk_version(root: str, rel: str, filename: str) -> int:
    try:
        return int(os.path.getmtime(ps.edited_path(root, rel, filename)))
    except OSError:
        return 0


# ==========================================================
# MÔ HÌNH DỮ LIỆU
# ==========================================================

class PageState(BaseModel):
    filename: str
    doc_name: Optional[str] = None
    corners: Optional[List[List[float]]] = None
    rotation: Optional[int] = 0
    settings: Optional[dict] = None
    annotations: Optional[List[dict]] = None
    history: Optional[dict] = None


class PageRef(BaseModel):
    relative_path: Optional[str] = ""
    filename: str
    root_path: Optional[str] = None


class ProcessRequest(BaseModel):
    relative_path: Optional[str] = ""
    filename: str
    corners: Optional[List[List[float]]] = None
    rotation: int = 0
    settings: Optional[dict] = None
    annotations: Optional[List[dict]] = None
    root_path: Optional[str] = None


class AutoDetectRequest(BaseModel):
    relative_path: Optional[str] = ""
    filename: str
    margin_percent: float = 0.0
    root_path: Optional[str] = None


class RenamePageRequest(BaseModel):
    relative_path: Optional[str] = ""
    filename: str
    new_name: str
    root_path: Optional[str] = None


class MovePageRequest(BaseModel):
    relative_path: Optional[str] = ""
    filename: str
    target_relative_path: Optional[str] = ""
    root_path: Optional[str] = None


class SaveFolderRequest(BaseModel):
    relative_path: Optional[str] = ""
    pages: List[PageState]
    # Mặc định TẮT: lưu là ghi ảnh + metadata. Ghép PDF là việc xuất bản riêng,
    # chỉ chạy khi người dùng chủ động yêu cầu. Ghép PDF phải đọc lại TOÀN BỘ ảnh
    # trong thư mục nên chi phí tăng theo số trang dù chỉ sửa đúng một trang.
    save_pdf: bool = False
    pdf_name: Optional[str] = None
    root_path: Optional[str] = None


class SaveProjectRequest(BaseModel):
    folders: List[SaveFolderRequest]
    root_path: Optional[str] = None


class CommitPageRequest(BaseModel):
    relative_path: Optional[str] = ""
    page: PageState
    root_path: Optional[str] = None


class SaveMetadataRequest(BaseModel):
    relative_path: Optional[str] = ""
    pages: List[PageState]
    order: Optional[List[str]] = None
    root_path: Optional[str] = None


class ScanDirectoryRequest(BaseModel):
    path: str


class FolderRequest(BaseModel):
    relative_path: Optional[str] = ""
    folder_name: Optional[str] = None
    root_path: Optional[str] = None


class ExportPdfRequest(BaseModel):
    relative_path: Optional[str] = ""
    filenames: List[str]
    doc_name: Optional[str] = None
    save_path: Optional[str] = None
    root_path: Optional[str] = None


class ExportProjectPdfRequest(BaseModel):
    doc_name: Optional[str] = None
    save_path: Optional[str] = None
    root_path: Optional[str] = None


class ExportImagesZipRequest(BaseModel):
    relative_path: Optional[str] = ""
    filenames: List[str]
    zip_name: Optional[str] = None
    save_path: Optional[str] = None
    root_path: Optional[str] = None


class DownloadSingleRequest(BaseModel):
    relative_path: Optional[str] = ""
    filename: str
    format: str = "jpeg"
    doc_name: Optional[str] = None
    quality: Optional[int] = None
    save_path: Optional[str] = None
    root_path: Optional[str] = None


class PickSavePathRequest(BaseModel):
    relative_path: Optional[str] = ""      # thư mục mặc định trong dự án
    suggested_name: str                    # tên tệp gợi ý (chưa có phần mở rộng)
    extension: str = "pdf"                 # pdf / zip / jpg / png / webp
    title: Optional[str] = None            # tiêu đề hộp thoại
    root_path: Optional[str] = None


class CleanupLegacyPdfRequest(BaseModel):
    confirm: bool = False                  # False = chỉ liệt kê, True = xoá thật
    root_path: Optional[str] = None


class OpenFolderRequest(BaseModel):
    relative_path: Optional[str] = ""
    root_path: Optional[str] = None


class AiSuggestRequest(BaseModel):
    relative_path: Optional[str] = ""
    filename: str
    page_index: Optional[int] = 1
    root_path: Optional[str] = None


class StitchPreviewRequest(BaseModel):
    relative_path: Optional[str] = ""
    filenames: Optional[List[str]] = None
    layout: str = "grid"
    cols: int = 3
    spacing: int = 24
    padding: int = 32
    bg_color: str = "#ffffff"
    draw_border: bool = True
    last_row_align: str = "center"
    scale: float = 1.0
    root_path: Optional[str] = None


class StitchExportRequest(BaseModel):
    relative_path: Optional[str] = ""
    filenames: Optional[List[str]] = None
    layout: str = "grid"
    cols: int = 3
    spacing: int = 24
    padding: int = 32
    bg_color: str = "#ffffff"
    draw_border: bool = True
    last_row_align: str = "center"
    scale: float = 1.0
    format: str = "jpeg"
    quality: int = 88
    doc_name: Optional[str] = None
    save_path: Optional[str] = None
    import_to_project: bool = False
    root_path: Optional[str] = None


def page_payload(root: str, rel: str, filename: str) -> Dict[str, Any]:
    """Bản ghi trang chuẩn gửi cho giao diện — luôn phản ánh đúng đĩa + metadata."""
    entry = ps.get_page_meta(root, rel, filename)
    full = ps.edited_path(root, rel, filename)
    try:
        size = os.path.getsize(full)
    except OSError:
        size = 0
    goc = ps.find_original_path(root, rel, filename)
    width, height = ps.read_image_dimensions(goc or full)
    return {
        "id": ps.make_page_id(root, rel, filename),
        "filename": filename,
        "folderId": ps.folder_id_of(rel),
        "relativePath": ps.normalize_rel(rel),
        "doc_name": entry.get("doc_name") or ps.stem_of(filename),
        "width": width,
        "height": height,
        "megapixels": f"{(width * height) / 1_000_000.0:.1f} MP",
        "file_size": size,
        "file_size_human": ps.format_file_size(size),
        "corners": entry.get("corners"),
        "rotation": entry.get("rotation", 0),
        "settings": ps.merged_settings(entry.get("settings")),
        "history": entry.get("history") or {"undo": [], "redo": []},
        "has_raw_original": goc is not None,
        "is_stale": ps.is_stale(entry),
        "version": disk_version(root, rel, filename),
    }


# ==========================================================
# QUÉT & CHỌN THƯ MỤC DỰ ÁN
# ==========================================================

@app.post("/api/pick-directory")
async def pick_directory():
    """Mở hộp thoại chọn thư mục gốc của hệ điều hành."""
    if sys.platform == "darwin":
        try:
            cmd = ['osascript', '-e', 'POSIX path of (choose folder with prompt "Chọn thư mục dự án cho DocScan Studio")']
            res = subprocess.run(cmd, capture_output=True, text=True, check=True)
            path = res.stdout.strip()
            if path:
                return {"success": True, "path": os.path.normpath(path)}
            return {"success": False, "path": ""}
        except Exception:
            pass  # Fallback to tkinter

    try:
        import tkinter as tk
        from tkinter import filedialog
        win = tk.Tk()
        win.withdraw()
        win.attributes("-topmost", True)
        selected = filedialog.askdirectory(title="Chọn thư mục dự án cho DocScan Studio")
        win.destroy()
        if selected:
            return {"success": True, "path": os.path.normpath(selected)}
        return {"success": False, "path": ""}
    except Exception as e:
        print(f"[pick-directory] {e}")
        raise HTTPException(status_code=500, detail="Không mở được hộp thoại chọn thư mục trên máy tính.")


@app.post("/api/pick-save-path")
async def pick_save_path(req: PickSavePathRequest):
    """
    Mở hộp thoại "Lưu tệp" của hệ điều hành để người dùng tự chọn nơi lưu.
    Thư mục mặc định là thư mục tài liệu đang mở — nơi người dùng mong muốn nhất,
    thay vì lặng lẽ ném tệp vào Downloads của trình duyệt rồi phải đi tìm.
    """
    root = active_root(req.root_path)
    try:
        initial_dir = ps.folder_dir(root, req.relative_path)
    except ValueError:
        initial_dir = root
    if not os.path.isdir(initial_dir):
        initial_dir = root

    ext = (req.extension or "pdf").lower().lstrip(".")
    labels = {
        "pdf": ("Tệp PDF", "*.pdf"),
        "zip": ("Tệp nén ZIP", "*.zip"),
        "jpg": ("Ảnh JPG", "*.jpg"),
        "png": ("Ảnh PNG", "*.png"),
        "webp": ("Ảnh WebP", "*.webp"),
    }
    label, pattern = labels.get(ext, (f"Tệp {ext.upper()}", f"*.{ext}"))
    suggested = f"{ps.sanitize_component(req.suggested_name) or 'Tai-Lieu'}.{ext}"

    if sys.platform == "darwin":
        try:
            script = f'''
            set initialFolder to POSIX file "{initial_dir}"
            set savePath to choose file name with prompt "Chọn nơi lưu {label}" default name "{suggested}" default location initialFolder
            return POSIX path of savePath
            '''
            res = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, check=True)
            chosen = res.stdout.strip()
            if chosen:
                if not chosen.lower().endswith(f".{ext}"):
                    chosen += f".{ext}"
                return {"success": True, "path": chosen, "filename": os.path.basename(chosen)}
            return {"success": False, "path": "", "filename": ""}
        except Exception:
            pass  # Fallback to tkinter

    try:
        import tkinter as tk
        from tkinter import filedialog
        win = tk.Tk()
        win.withdraw()
        win.attributes("-topmost", True)
        chosen = filedialog.asksaveasfilename(
            title=req.title or f"Chọn nơi lưu {label}",
            initialdir=initial_dir,
            initialfile=suggested,
            defaultextension=f".{ext}",
            filetypes=[(label, pattern), ("Tất cả tệp", "*.*")],
        )
        win.destroy()
    except Exception as e:
        print(f"[pick-save-path] {e}")
        raise HTTPException(status_code=500, detail="Không mở được hộp thoại chọn nơi lưu tệp.")

    if not chosen:
        return {"success": False, "path": ""}

    path = os.path.abspath(os.path.normpath(chosen))
    if not path.lower().endswith(f".{ext}"):
        path = f"{path}.{ext}"
    _remember_save_path(path)
    return {"success": True, "path": path, "folder": os.path.dirname(path),
            "filename": os.path.basename(path)}


@app.post("/api/scan-directory")
def scan_directory(req: ScanDirectoryRequest):
    """
    Quét cây thư mục và trả về danh sách trang ở dạng NHẸ (không kèm điểm ảnh).
    Giao diện tải ảnh xem trước theo yêu cầu qua /api/image nên mở dự án lớn vẫn tức thì.
    """
    if not req.path:
        raise HTTPException(status_code=400, detail="Chưa chỉ định đường dẫn thư mục.")

    root = os.path.abspath(os.path.normpath(req.path))
    if not os.path.isdir(root):
        try:
            os.makedirs(root, exist_ok=True)
        except OSError as e:
            print(f"[scan-directory] {e}")
            raise HTTPException(status_code=400, detail="Không thể tạo hoặc truy cập thư mục này trên máy tính.")

    SESSION["root"] = root
    save_active_root(root)
    ORIGINALS.clear()

    try:
        folders, pages = ps.scan_tree(root)
    except OSError as e:
        print(f"[scan-directory] {e}")
        raise HTTPException(status_code=500, detail="Không đọc được nội dung thư mục. Vui lòng kiểm tra quyền truy cập ổ đĩa.")

    return {
        "success": True,
        "root_path": root,
        "root_name": os.path.basename(root) or root,
        "folders": folders,
        "pages": pages,
        "total_folders": len(folders),
        "total_images": len(pages),
    }


@app.get("/api/session")
def get_session():
    """Lấy đường dẫn thư mục dự án đang mở để giao diện khôi phục tức thì khi tải lại trang."""
    root = active_root()
    return {
        "root_path": root,
        "root_name": os.path.basename(root) or root,
    }


@app.post("/api/open-folder")
def open_folder(req: OpenFolderRequest):
    root = active_root(req.root_path)
    try:
        target = ps.folder_dir(root, req.relative_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not os.path.isdir(target):
        raise HTTPException(status_code=404, detail="Thư mục không tồn tại trên máy.")
    if sys.platform == "win32":
        os.startfile(target)
    elif sys.platform == "darwin":
        subprocess.run(["open", target])
    else:
        subprocess.run(["xdg-open", target])
    return {"success": True}


# ==========================================================
# PHỤC VỤ ẢNH THEO YÊU CẦU
# ==========================================================

@app.get("/api/image")
def get_image(
    file: str = Query(...),
    rel: str = Query(""),
    kind: str = Query("edited"),
    v: Optional[str] = Query(None),
):
    """
    Trả về tệp ảnh của một trang.
      kind=original -> ảnh gốc trong _goc/
      kind=edited   -> ảnh đang sửa
      kind=thumb    -> ảnh nhỏ cho danh sách trang
    Tham số `v` chỉ dùng để phá bộ đệm trình duyệt khi tệp thay đổi.
    """
    root = active_root()
    try:
        if kind in ("original", "thumb_original"):
            path = ps.find_original_path(root, rel, file) or ps.edited_path(root, rel, file)
        else:
            path = ps.edited_path(root, rel, file)
            if not os.path.exists(path):
                path = ps.find_original_path(root, rel, file) or path
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Không tìm thấy tệp ảnh trên máy.")

    headers = {"Cache-Control": "private, max-age=31536000" if v else "no-cache"}

    if kind.startswith("thumb"):
        img = imread_unicode(path)
        if img is None:
            raise HTTPException(status_code=400, detail="Không đọc được tệp ảnh.")
        return Response(content=rd.make_thumbnail(img), media_type="image/jpeg", headers=headers)

    if kind == "original":
        img = imread_unicode(path)
        if img is None:
            raise HTTPException(status_code=400, detail="Không đọc được tệp ảnh.")
        view, _ = rd.scale_to_max(img, rd.ORIGINAL_VIEW_MAX_DIM)
        return Response(content=rd.encode_preview(view, quality=90), media_type="image/jpeg", headers=headers)

    with open(path, "rb") as f:
        data = f.read()
    ext = os.path.splitext(path)[1].lower()
    mime = {".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp"}.get(ext, "image/jpeg")
    return Response(content=data, media_type=mime, headers=headers)


# ==========================================================
# NHẬP ẢNH — GHI NGAY ĐỦ BỘ BA XUỐNG ĐĨA
# ==========================================================
# NHẬP ẢNH & PDF — GHI NGAY ĐỦ BỘ BA XUỐNG ĐĨA
# ==========================================================

def _convert_pdf_to_images(contents: bytes, dpi: float = 150.0) -> List[np.ndarray]:
    """
    Quy đổi toàn bộ các trang của tệp PDF (scan, export từ Word, in ảo, v.v.)
    thành danh sách ảnh numpy BGR chuẩn để xử lý như ảnh thông thường.
    Độ phân giải dựng (rasterize) đạt chuẩn 150 DPI tối ưu (cạnh dài tối đa 1800px).
    """
    try:
        import fitz
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="Máy chủ chưa cài đặt thư viện đọc PDF (PyMuPDF).",
        )

    try:
        doc = fitz.open(stream=contents, filetype="pdf")
    except Exception as e:
        print(f"[pdf-decode] {e}")
        raise HTTPException(status_code=400, detail="Tệp PDF bị hỏng hoặc không đúng định dạng.")

    if len(doc) == 0:
        raise HTTPException(status_code=400, detail="Tệp PDF rỗng, không có trang nào.")

    images: List[np.ndarray] = []
    for page_idx in range(len(doc)):
        page = doc[page_idx]
        rect = page.rect
        w_pt, h_pt = float(rect.width), float(rect.height)
        if w_pt <= 0 or h_pt <= 0:
            continue

        # Đặt chuẩn 150 DPI (hệ số 150/72 ~ 2.083), giới hạn cạnh dài 1800px
        # đảm bảo tài liệu nhẹ mượt, xử lý nhanh mà văn bản vẫn rõ ràng.
        max_dim_target = 1800.0
        scale = min(dpi / 72.0, max_dim_target / max(w_pt, h_pt))
        scale = max(scale, 100.0 / 72.0)

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
        raise HTTPException(status_code=400, detail="Không thể trích xuất trang nào từ tệp PDF.")

    return images


def _save_imported_image(
    root: str,
    rel: str,
    img: np.ndarray,
    source_name: Optional[str],
    overwrite: bool = False,
) -> Dict[str, Any]:
    if img.shape[0] * img.shape[1] > MAX_UPLOAD_PIXELS:
        raise HTTPException(
            status_code=413,
            detail=f"Ảnh có độ phân giải quá lớn ({img.shape[1]} × {img.shape[0]} px). "
                   "Vui lòng giảm kích thước trước khi thêm vào.",
        )

    base_name, name_suggestions = get_basic_document_name(
        filename=source_name, page_index=len(ps.list_page_files(ps.folder_dir(root, rel))) + 1
    )
    source_stem = ps.stem_of(source_name or "") or base_name
    if overwrite:
        stem = ps.sanitize_component(source_stem) or "Tai-Lieu"
    else:
        stem = ps.unique_stem(root, rel, source_stem)
    filename = ps.edited_filename(stem)

    # Chỉ lưu file ảnh trực tiếp vào thư mục. KHÔNG tự tạo _goc và KHÔNG tự tạo metadata khi nhập.
    data, _size, _dim = rd.encode_final(img, ps.default_settings())
    ps.write_edited_bytes(root, rel, filename, data)

    invalidate(root, rel, filename)
    payload = page_payload(root, rel, filename)
    payload["name_suggestions"] = name_suggestions
    return payload


@app.post("/api/import")
async def import_image(
    file: UploadFile = File(...),
    relative_path: str = Form(""),
    root_path: Optional[str] = Form(None),
    overwrite: bool = Form(False),
):
    """
    Nhập một ảnh hoặc tệp PDF vào thư mục đang mở và lưu ngay:
        _goc/<stem>_goc.jpg  +  <stem>.jpg  +  .docscan_meta.json
    Tất cả các tệp (kể cả PDF scan hay PDF từ Word/In) đều được quy về ảnh.
    Nhờ vậy dữ liệu an toàn kể cả khi tắt ứng dụng đột ngột.
    """
    root = active_root(root_path)
    rel = ps.normalize_rel(relative_path)

    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Tệp quá lớn ({ps.format_file_size(len(contents))}). "
                   f"Giới hạn là {ps.format_file_size(MAX_UPLOAD_BYTES)} cho mỗi tệp.",
        )

    # Phần còn lại nặng CPU -> đẩy sang luồng riêng để không đóng băng các yêu cầu khác.
    return await run_in_threadpool(_import_decoded, root, rel, file.filename, contents, overwrite)


def _import_decoded(root: str, rel: str, source_name: Optional[str], contents: bytes, overwrite: bool = False) -> Any:
    # 1. Nhận diện tệp PDF theo đuôi hoặc magic bytes (%PDF)
    is_pdf = False
    if source_name and source_name.lower().endswith(".pdf"):
        is_pdf = True
    elif contents.startswith(b"%PDF-"):
        is_pdf = True

    if is_pdf:
        images = _convert_pdf_to_images(contents)
        base_stem = ps.stem_of(source_name or "Tai_Lieu")
        results = []
        for idx, img in enumerate(images, start=1):
            page_name = f"{base_stem}_trang_{idx}" if len(images) > 1 else base_stem
            payload = _save_imported_image(root, rel, img, page_name, overwrite=overwrite)
            results.append(payload)
        return results if len(results) > 1 else results[0]

    # 2. Xử lý ảnh tiêu chuẩn (JPG, PNG, WEBP, BMP...)
    img = cv2.imdecode(np.frombuffer(contents, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Tệp không phải là ảnh hoặc PDF hợp lệ hoặc đã hỏng.")

    return _save_imported_image(root, rel, img, source_name, overwrite=overwrite)


# ==========================================================
# XỬ LÝ & KẾT XUẤT
# ==========================================================

@app.post("/api/process")
def process_preview(req: ProcessRequest):
    """
    Dựng ảnh XEM TRƯỚC ở độ phân giải rút gọn để thao tác kéo trượt phản hồi tức thì.
    Trả thẳng byte JPEG (không base64) — nhẹ hơn ~33% và trình duyệt giải mã nhanh hơn.
    Số liệu kích thước/dung lượng ước tính nằm ở phần đầu phản hồi (headers).
    """
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    settings = ps.merged_settings(req.settings)

    annotations = req.annotations
    if annotations is None:
        stored = ps.get_page_meta(root, rel, req.filename)
        annotations = stored.get("annotations")

    original = load_original(root, rel, req.filename)
    preview = rd.render_page(original, req.corners, req.rotation, settings, max_dim=rd.PREVIEW_MAX_DIM, annotations=annotations)
    quality = int(settings.get("quality", 85))
    data = rd.encode_preview(preview, quality=quality)

    # Ước tính kích thước bản kết xuất đầy đủ theo tỉ lệ thu nhỏ đã áp dụng và chuẩn hóa DPI.
    oh, ow = original.shape[:2]
    ph, pw = preview.shape[:2]
    scale_back = max(1.0, max(oh, ow) / float(rd.PREVIEW_MAX_DIM))
    raw_w, raw_h = int(round(pw * scale_back)), int(round(ph * scale_back))

    normalize_res = bool(settings.get("normalize_res", True))
    if normalize_res and max(raw_w, raw_h) > 1800:
        scale_print = 1800.0 / float(max(raw_w, raw_h))
        est_w = int(round(raw_w * scale_print))
        est_h = int(round(raw_h * scale_print))
    else:
        est_w = raw_w
        est_h = raw_h

    pixel_ratio = (float(est_w) * float(est_h)) / float(max(1, pw * ph))
    # Sử dụng hàm mũ 0.72 phù hợp với đặc tính nén JPEG của văn bản/scan để sai số ước tính < 3%
    est_bytes = int(round(len(data) * (pixel_ratio ** 0.72)))

    return Response(
        content=data,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Out-Width": str(est_w),
            "X-Out-Height": str(est_h),
            "X-Out-Size": str(est_bytes),
            "X-Preview-Width": str(pw),
            "X-Preview-Height": str(ph),
        },
    )


@app.post("/api/auto-detect")
def auto_detect(req: AutoDetectRequest):
    """Nhận diện lại 4 góc mép giấy trên ảnh gốc."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    original = load_original(root, rel, req.filename)
    corners, detected = detect_document_corners(original, margin_percent=req.margin_percent)
    return {"success": True, "corners": corners.tolist(), "detected": bool(detected)}


def _load_edited_images(root: str, rel: str, filenames: List[str]) -> List[np.ndarray]:
    images = []
    for name in filenames:
        path = ps.edited_path(root, rel, name)
        if not os.path.exists(path):
            path = ps.find_original_path(root, rel, name) or path
        img = imread_unicode(path)
        if img is not None:
            images.append(img)
    return images


def commit_page(root: str, rel: str, state: PageState) -> Dict[str, Any]:
    """
    Kết xuất đầy đủ độ phân giải từ tình trạng hiện tại, ghi đè ảnh đang sửa
    và cập nhật metadata. Ảnh trên đĩa vì thế luôn khớp với thứ đang hiển thị.
    """
    filename = state.filename
    stored = ps.get_page_meta(root, rel, filename)
    settings = ps.merged_settings(state.settings if state.settings is not None else stored.get("settings"))
    corners = state.corners if state.corners is not None else stored.get("corners")
    rotation = state.rotation if state.rotation is not None else stored.get("rotation", 0)
    annotations = state.annotations if state.annotations is not None else stored.get("annotations")

    original = load_original(root, rel, filename)

    # NẾU CHƯA CÓ ẢNH GỐC TRONG _goc/: SAO LƯU ẢNH GỐC NGAY TRƯỚC KHI GHI ĐÈ
    if ps.find_original_path(root, rel, filename) is None:
        ps.write_original(root, rel, filename, original)

    rendered = rd.render_page(original, corners, rotation, settings, annotations=annotations)
    data, size, (out_w, out_h) = rd.encode_final(rendered, settings)
    ps.write_edited_bytes(root, rel, filename, data)

    ps.patch_page_meta(root, rel, filename, {
        "doc_name": state.doc_name,
        "corners": corners,
        "rotation": rotation,
        "settings": settings,
        "annotations": annotations or [],
        "history": state.history,
        "committed_fingerprint": ps.state_fingerprint(corners, rotation, settings, annotations),
    })

    return {
        "filename": filename,
        "width": out_w,
        "height": out_h,
        "file_size": size,
        "file_size_human": ps.format_file_size(size),
        "version": disk_version(root, rel, filename),
    }


@app.post("/api/commit-page")
def api_commit_page(req: CommitPageRequest):
    """Kết xuất đầy đủ 1 trang và ghi đè tệp ảnh đang sửa trên đĩa."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    result = commit_page(root, rel, req.page)
    return {"success": True, **result}


def _raise_if_nothing_saved(failed: List[Dict[str, str]], saved: int) -> None:
    """Không ghi được trang nào mà lại báo thành công là kịch bản mất dữ liệu thầm lặng."""
    if failed and saved == 0:
        reason = failed[0].get("reason") or "Không ghi được tệp xuống ổ đĩa."
        raise HTTPException(
            status_code=507 if "đầy" in reason else 500,
            detail=f"Không lưu được trang nào. {reason}",
        )


@app.post("/api/save-folder")
def save_folder(req: SaveFolderRequest):
    """Lưu toàn bộ một thư mục: ảnh đang sửa + metadata + tệp PDF tổng hợp."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    result = _save_one_folder(root, rel, req)
    _raise_if_nothing_saved(result["failed_pages"], result["saved_pages"])
    return {"success": True, **result}


def _friendly_write_error(exc: Exception) -> str:
    """Đổi lỗi hệ thống thành câu tiếng Việt nói đúng việc người dùng cần làm."""
    if isinstance(exc, OSError):
        if exc.errno == errno.ENOSPC:
            return "Ổ đĩa đã đầy, không còn chỗ để ghi tệp."
        if exc.errno in (errno.EACCES, errno.EPERM):
            return "Không có quyền ghi vào thư mục này."
        if exc.errno == errno.EBUSY:
            return "Tệp đang được mở ở ứng dụng khác."
    return "Không ghi được tệp xuống ổ đĩa."


def _save_one_folder(root: str, rel: str, req: SaveFolderRequest) -> Dict[str, Any]:
    saved: List[str] = []
    saved_details: Dict[str, Any] = {}
    failed: List[Dict[str, str]] = []

    for state in req.pages:
        try:
            # Không giữ lại ảnh đã kết xuất: lưu một thư mục lớn sẽ ngốn hết bộ nhớ.
            # Tệp PDF bên dưới đọc lại từ đĩa theo từng trang.
            res = commit_page(root, rel, state)
            saved.append(state.filename)
            saved_details[state.filename] = res
        except HTTPException:
            raise
        except Exception as e:
            # Lỗi ghi đĩa TUYỆT ĐỐI không được nuốt: nếu báo thành công, giao diện sẽ
            # xoá cờ "chưa lưu" và người dùng mất trắng công chỉnh sửa mà không hay biết.
            print(f"[save-folder] {rel}/{state.filename}: {e!r}")
            failed.append({"filename": state.filename, "reason": _friendly_write_error(e)})

    pdf_saved = False
    if req.save_pdf and saved:
        folder = ps.folder_dir(root, rel)
        title = ps.sanitize_component(req.pdf_name or os.path.basename(folder) or "Tai-Lieu")
        try:
            # PDF phải gồm TOÀN BỘ trang của thư mục theo đúng thứ tự đã lưu.
            # Nếu chỉ ghép các trang vừa kết xuất thì một lần tự động lưu 1 trang
            # sẽ thu tệp PDF nhiều trang xuống còn đúng trang đó.
            names = ps.order_page_files(
                ps.list_page_files(folder),
                ps.read_meta(root, rel).get("order") or [],
            )
            all_images = _load_edited_images(root, rel, names)
            if all_images:
                pdf_bytes = generate_pdf_from_images(all_images, quality=85, normalize_res=True)
                with open(os.path.join(folder, f"{title}.pdf"), "wb") as f:
                    f.write(pdf_bytes)
                pdf_saved = True
        except Exception as e:
            print(f"[save-folder pdf] {rel}: {e}")

    ps.prune_meta_to_existing(root, rel)
    return {
        "relative_path": rel,
        "saved_pages": len(saved),
        "saved_filenames": saved,
        "saved_details": saved_details,
        "failed_pages": failed,
        "pdf_saved": pdf_saved,
        "target_dir": ps.folder_dir(root, rel),
    }


@app.post("/api/save-project")
def save_project(req: SaveProjectRequest):
    """Lưu 1 lần toàn bộ các nhánh thư mục của dự án."""
    root = active_root(req.root_path)
    folders_saved = 0
    pages_saved = 0
    pdfs = 0

    saved_filenames: List[str] = []
    saved_details: Dict[str, Any] = {}
    failed_pages: List[Dict[str, str]] = []

    for folder_req in req.folders:
        if not folder_req.pages:
            continue
        rel = ps.normalize_rel(folder_req.relative_path)
        outcome = _save_one_folder(root, rel, folder_req)
        saved_filenames.extend(outcome["saved_filenames"])
        saved_details.update(outcome.get("saved_details", {}))
        failed_pages.extend(outcome["failed_pages"])
        if outcome["saved_pages"]:
            folders_saved += 1
            pages_saved += outcome["saved_pages"]
            if outcome["pdf_saved"]:
                pdfs += 1

    _raise_if_nothing_saved(failed_pages, pages_saved)
    return {
        "success": True,
        "root_path": root,
        "folders_saved": folders_saved,
        "pages_saved": pages_saved,
        "pdfs_saved": pdfs,
        "saved_filenames": saved_filenames,
        "saved_details": saved_details,
        "failed_pages": failed_pages,
    }


@app.post("/api/save-metadata")
def save_metadata(req: SaveMetadataRequest):
    """
    Lưu nhanh tình trạng chỉnh sửa (góc, xoay, bộ lọc, undo/redo) mà không kết xuất lại ảnh.
    Cập nhật hợp nhất theo từng trường nên không bao giờ xóa mất dữ liệu đã có.
    """
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    for page in req.pages:
        ps.patch_page_meta(root, rel, page.filename, {
            "doc_name": page.doc_name,
            "corners": page.corners,
            "rotation": page.rotation,
            "settings": ps.merged_settings(page.settings) if page.settings else None,
            "annotations": page.annotations,
            "history": page.history,
        })
    if req.order is not None:
        ps.set_folder_order(root, rel, req.order)
    return {"success": True, "count": len(req.pages)}


# ==========================================================
# VÒNG ĐỜI TRANG: ĐỔI TÊN, GỐC MỚI, DI CHUYỂN, XÓA
# ==========================================================

@app.post("/api/rename-page")
def api_rename_page(req: RenamePageRequest):
    """Đổi tên NGUYÊN BỘ BA (ảnh sửa + ảnh gốc + metadata) — không tạo bản sao thừa."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    new_stem = ps.sanitize_component(req.new_name)
    if not new_stem:
        raise HTTPException(status_code=400, detail="Tên tài liệu không được để trống.")

    try:
        outcome = ps.rename_page(root, rel, req.filename, new_stem)
    except OSError as e:
        print(f"[rename-page] {e}")
        raise HTTPException(status_code=500, detail="Không đổi được tên tệp. Có thể tệp đang mở ở ứng dụng khác.")

    invalidate(root, rel, req.filename)
    return {"success": True, **page_payload(root, rel, outcome["filename"])}


@app.post("/api/apply-as-original")
def apply_as_original(req: PageRef):
    """
    Nâng bản đang sửa lên thành ảnh gốc mới (người dùng bấm xác nhận rõ ràng).
    Ghi đè _goc/, đặt lại 4 góc về trọn khung và xóa lịch sử vì đây là mốc gốc mới.
    """
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    filename = req.filename

    stored = ps.get_page_meta(root, rel, filename)
    settings = ps.merged_settings(stored.get("settings"))
    original = load_original(root, rel, filename)
    rendered = rd.render_page(original, stored.get("corners"), stored.get("rotation", 0), settings)

    ps.write_original(root, rel, filename, rendered)
    invalidate(root, rel, filename)

    h, w = rendered.shape[:2]
    full_frame = [[0.0, 0.0], [float(w), 0.0], [float(w), float(h)], [0.0, float(h)]]
    reset_settings = ps.default_settings()
    reset_settings["mode"] = settings.get("mode", "natural")

    data, _size, _dim = rd.encode_final(
        rd.render_page(rendered, full_frame, 0, reset_settings), reset_settings
    )
    ps.write_edited_bytes(root, rel, filename, data)
    ps.patch_page_meta(root, rel, filename, {
        "corners": full_frame,
        "rotation": 0,
        "settings": reset_settings,
        "history": {"undo": [], "redo": []},
        "committed_fingerprint": ps.state_fingerprint(full_frame, 0, reset_settings),
    })

    return {"success": True, **page_payload(root, rel, filename)}


@app.post("/api/adopt-as-original")
def adopt_as_original(req: PageRef):
    """Hợp thức hóa một ảnh lẻ: tạo bản gốc trong _goc/ và khởi tạo metadata."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    filename = req.filename

    path = ps.edited_path(root, rel, filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Không tìm thấy tệp ảnh trên máy.")

    img = imread_unicode(path)
    if img is None:
        raise HTTPException(status_code=400, detail="Không đọc được tệp ảnh này.")

    ps.write_original(root, rel, filename, img)
    invalidate(root, rel, filename)

    # Ảnh lẻ được giữ nguyên khung ban đầu: bản gốc vừa tạo chính là ảnh đang hiển thị,
    # nên 4 góc mặc định bao trọn khung để không tự ý cắt mất phần nào của người dùng.
    h, w = img.shape[:2]
    corners = [[0.0, 0.0], [float(w), 0.0], [float(w), float(h)], [0.0, float(h)]]
    settings = ps.default_settings()
    ps.patch_page_meta(root, rel, filename, {
        "doc_name": ps.stem_of(filename),
        "corners": corners,
        "rotation": 0,
        "settings": settings,
        "history": {"undo": [], "redo": []},
        "committed_fingerprint": ps.state_fingerprint(corners, 0, settings),
    })
    return {"success": True, **page_payload(root, rel, filename)}


@app.post("/api/move-page")
def api_move_page(req: MovePageRequest):
    """Di chuyển trang sang thư mục khác, mang theo cả ảnh gốc và metadata."""
    root = active_root(req.root_path)
    src = ps.normalize_rel(req.relative_path)
    dst = ps.normalize_rel(req.target_relative_path)
    try:
        outcome = ps.move_page(root, src, req.filename, dst)
    except OSError as e:
        print(f"[move-page] {e}")
        raise HTTPException(status_code=500, detail="Không di chuyển được tệp. Có thể tệp đang được mở ở ứng dụng khác.")

    invalidate(root, src, req.filename)
    return {"success": True, "target_relative_path": dst, **page_payload(root, dst, outcome["filename"])}


@app.post("/api/move-to-unapproved")
def move_to_unapproved(req: PageRef):
    """Chuyển ảnh vào Kho ảnh chưa duyệt (tự tạo thư mục nếu chưa có)."""
    root = active_root(req.root_path)
    src = ps.normalize_rel(req.relative_path)
    os.makedirs(ps.folder_dir(root, ps.UNAPPROVED_DIR), exist_ok=True)
    outcome = ps.move_page(root, src, req.filename, ps.UNAPPROVED_DIR)
    invalidate(root, src, req.filename)
    return {
        "success": True,
        "folder_id": ps.folder_id_of(ps.UNAPPROVED_DIR),
        "folder_name": ps.UNAPPROVED_LABEL,
        "target_relative_path": ps.UNAPPROVED_DIR,
        **page_payload(root, ps.UNAPPROVED_DIR, outcome["filename"]),
    }


@app.post("/api/delete-page")
def delete_page(req: PageRef):
    """Xóa vĩnh viễn cả ảnh sửa, ảnh gốc và mục metadata của trang."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    try:
        deleted = ps.delete_page_files(root, rel, req.filename)
    except OSError as e:
        print(f"[delete-page] {e}")
        raise HTTPException(status_code=500, detail="Không xóa được tệp. Có thể tệp đang được mở ở ứng dụng khác.")
    invalidate(root, rel, req.filename)
    return {"success": True, "deleted": deleted}


# ==========================================================
# THAO TÁC THƯ MỤC VẬT LÝ
# ==========================================================

@app.post("/api/create-folder")
def create_folder(req: FolderRequest):
    root = active_root(req.root_path)
    name = ps.sanitize_component(req.folder_name or "")
    if not name:
        raise HTTPException(status_code=400, detail="Tên thư mục không được để trống.")
    try:
        parent = ps.folder_dir(root, req.relative_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    target = os.path.join(parent, name)
    if os.path.isdir(target):
        raise HTTPException(status_code=400, detail=f"Thư mục '{name}' đã tồn tại.")
    try:
        os.makedirs(target, exist_ok=True)
    except OSError as e:
        print(f"[create-folder] {e}")
        raise HTTPException(status_code=500, detail="Không tạo được thư mục. Vui lòng kiểm tra quyền truy cập ổ đĩa.")

    rel = os.path.relpath(target, root)
    return {
        "success": True,
        "folder_id": ps.folder_id_of(rel),
        "folder_name": name,
        "relative_path": ps.normalize_rel(rel),
        "parent_id": ps.folder_id_of(req.relative_path),
    }


@app.post("/api/rename-folder")
def rename_folder(req: FolderRequest):
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    if not rel:
        raise HTTPException(status_code=400, detail="Không thể đổi tên thư mục gốc của dự án.")
    name = ps.sanitize_component(req.folder_name or "")
    if not name:
        raise HTTPException(status_code=400, detail="Tên thư mục không được để trống.")

    old_dir = ps.folder_dir(root, rel)
    if not os.path.isdir(old_dir):
        raise HTTPException(status_code=404, detail="Thư mục cần đổi tên không còn tồn tại.")

    new_dir = os.path.join(os.path.dirname(old_dir), name)
    if os.path.exists(new_dir):
        raise HTTPException(status_code=400, detail=f"Thư mục '{name}' đã tồn tại.")
    try:
        os.rename(old_dir, new_dir)
    except OSError as e:
        print(f"[rename-folder] {e}")
        raise HTTPException(status_code=500, detail="Không đổi được tên thư mục. Có thể thư mục đang mở ở ứng dụng khác.")

    ORIGINALS.clear()
    new_rel = os.path.relpath(new_dir, root)
    return {
        "success": True,
        "folder_id": ps.folder_id_of(new_rel),
        "folder_name": name,
        "relative_path": ps.normalize_rel(new_rel),
    }


@app.post("/api/delete-folder")
def delete_folder(req: FolderRequest):
    import shutil
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    if not rel:
        raise HTTPException(status_code=400, detail="Không thể xóa thư mục gốc của dự án.")
    target = ps.folder_dir(root, rel)
    if os.path.isdir(target):
        try:
            shutil.rmtree(target)
        except OSError as e:
            print(f"[delete-folder] {e}")
            raise HTTPException(status_code=500, detail="Không xóa được thư mục. Có thể thư mục đang mở ở ứng dụng khác.")
    ORIGINALS.clear()
    return {"success": True}


# ==========================================================
# XUẤT PDF & TẢI VỀ
# ==========================================================

@app.post("/api/export-pdf")
def export_pdf(req: ExportPdfRequest):
    """Ghép các trang đã xử lý của một thư mục thành PDF và tải về."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    images = _load_edited_images(root, rel, req.filenames)
    if not images:
        raise HTTPException(status_code=400, detail="Thư mục này chưa có trang nào để xuất PDF.")

    pdf_bytes = generate_pdf_from_images(images, quality=85, normalize_res=True)
    title = ps.sanitize_component(req.doc_name or os.path.basename(ps.folder_dir(root, rel)) or "Tai-Lieu-Scan")

    target = _checked_save_path(req.save_path)
    if target:
        return {**_write_export(target, pdf_bytes, "tệp PDF"), "pages": len(images)}

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{title}.pdf"'},
    )


@app.post("/api/export-project-pdf")
def export_project_pdf(req: ExportProjectPdfRequest):
    """Ghép toàn bộ trang của mọi thư mục trong dự án thành một tệp PDF."""
    root = active_root(req.root_path)
    folders, _pages = ps.scan_tree(root)
    images: List[np.ndarray] = []
    for folder in folders:
        rel = folder["relativePath"]
        names = ps.order_page_files(
            ps.list_page_files(ps.folder_dir(root, rel)),
            ps.read_meta(root, rel).get("order") or [],
        )
        images.extend(_load_edited_images(root, rel, names))

    if not images:
        raise HTTPException(status_code=400, detail="Dự án chưa có trang nào để xuất PDF.")

    pdf_bytes = generate_pdf_from_images(images, quality=85, normalize_res=True)
    title = ps.sanitize_component(req.doc_name or os.path.basename(root) or "Tai-Lieu-Scan")

    target = _checked_save_path(req.save_path)
    if target:
        return {**_write_export(target, pdf_bytes, "tệp PDF"), "pages": len(images)}

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{title}.pdf"'},
    )


@app.post("/api/export-images-zip")
def export_images_zip(req: ExportImagesZipRequest):
    """Đóng gói các ảnh đã xử lý thành tệp ZIP và tải về máy."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    fdir = ps.folder_dir(root, rel)

    import zipfile
    import io

    zip_buffer = io.BytesIO()
    count = 0
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for idx, fname in enumerate(req.filenames, start=1):
            edited_f = ps.edited_path(root, rel, fname)
            meta = ps.get_page_meta(root, rel, fname) or {}
            doc_name = meta.get("doc_name") or ps.stem_of(fname)
            safe_name = f"{idx:02d}_{ps.sanitize_component(doc_name)}.jpg"

            if os.path.exists(edited_f):
                with open(edited_f, "rb") as fp:
                    zf.writestr(safe_name, fp.read())
                count += 1
            else:
                goc_path = ps.find_original_path(root, rel, fname)
                if goc_path and os.path.exists(goc_path):
                    orig = imread_unicode(goc_path)
                    if orig is not None:
                        rendered = rd.render_page(
                            orig, meta.get("corners"), meta.get("rotation", 0),
                            ps.merged_settings(meta.get("settings")),
                        )
                        raw_bytes, _, _ = rd.encode_final(rendered, meta.get("settings") or {})
                        zf.writestr(safe_name, raw_bytes)
                        count += 1

    zip_bytes = zip_buffer.getvalue()
    if count == 0:
        raise HTTPException(status_code=400, detail="Không có ảnh nào để tải về.")

    title = ps.sanitize_component(req.zip_name or os.path.basename(fdir) or "Bo-Anh-Scan")

    target = _checked_save_path(req.save_path)
    if target:
        return {**_write_export(target, zip_bytes, "tệp ZIP"), "images": count}

    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{title}.zip"'},
    )


@app.post("/api/download-single")
def download_single(req: DownloadSingleRequest):
    """Lưu một trang đã xử lý ra JPG / PNG / WebP vào nơi người dùng chọn."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    path = ps.edited_path(root, rel, req.filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Trang này chưa được lưu trên máy.")

    stored = ps.get_page_meta(root, rel, req.filename) or {}
    page_settings = stored.get("settings") or {}

    quality = req.quality if req.quality is not None else int(page_settings.get("quality", 85))
    normalize_res = bool(page_settings.get("normalize_res", True))

    fmt = (req.format or "jpeg").lower()
    ext = "jpg" if fmt in ("jpg", "jpeg") else fmt

    # Nếu xuất file JPG và chất lượng trùng với bản đã commit trên đĩa,
    # đọc trực tiếp tệp để bảo đảm dung lượng chính xác từng byte khớp với thông số xem trước.
    saved_quality = int(page_settings.get("quality", 85))
    if ext == "jpg" and (req.quality is None or req.quality == saved_quality):
        with open(path, "rb") as fp:
            data = fp.read()
    else:
        img = imread_unicode(path)
        if img is None:
            raise HTTPException(status_code=400, detail="Không đọc được tệp ảnh.")
        from core.compressor import compress_image_to_bytes
        data, _size, _dim = compress_image_to_bytes(img, format=fmt, quality=quality, normalize_res=normalize_res)

    title = ps.sanitize_component(req.doc_name or ps.stem_of(req.filename))

    target = _checked_save_path(req.save_path)
    if target:
        return _write_export(target, data, f"ảnh {ext.upper()}")

    return Response(
        content=data,
        media_type=f"image/{'jpeg' if ext == 'jpg' else ext}",
        headers={"Content-Disposition": f'attachment; filename="{title}.{ext}"'},
    )


@app.post("/api/legacy-pdfs")
def legacy_pdfs(req: CleanupLegacyPdfRequest):
    """
    Liệt kê (và tuỳ chọn xoá) các tệp PDF do bản trước TỰ SINH mỗi lần lưu.
    Từ nay PDF chỉ được tạo khi người dùng chủ động bấm xuất, nên những tệp này
    không còn được cập nhật và nội dung sẽ lệch dần so với ảnh trong thư mục.

    Phạm vi rất hẹp — chỉ những tệp trùng đúng khuôn tên mà bản cũ đặt ra:
        <tên thư mục>.pdf   |   Kho ảnh chưa duyệt.pdf   |   Tai-Lieu.pdf
    Tệp PDF do người dùng tự đặt tên khác sẽ KHÔNG bao giờ bị chạm tới.
    """
    root = active_root(req.root_path)
    folders, _pages = ps.scan_tree(root)

    found: List[Dict[str, Any]] = []
    for folder in folders:
        rel = folder["relativePath"]
        fdir = ps.folder_dir(root, rel)
        dir_name = os.path.basename(fdir) or os.path.basename(root)
        candidates = {
            f"{ps.sanitize_component(dir_name)}.pdf",
            f"{ps.sanitize_component(folder['name'])}.pdf",
            "Tai-Lieu.pdf",
        }
        for name in sorted(candidates):
            path = os.path.join(fdir, name)
            if not os.path.isfile(path):
                continue
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            found.append({
                "relative_path": rel,
                "folder_name": folder["name"],
                "filename": name,
                "file_size": size,
                "file_size_human": ps.format_file_size(size),
                "path": path,
            })

    if not req.confirm:
        return {"success": True, "deleted": 0, "files": found, "total": len(found)}

    deleted, failed = 0, []
    for item in found:
        try:
            os.remove(item["path"])
            deleted += 1
        except OSError as e:
            print(f"[legacy-pdfs] {item['path']}: {e!r}")
            failed.append({"filename": item["filename"], "reason": _friendly_write_error(e)})

    return {"success": True, "deleted": deleted, "failed": failed,
            "files": found, "total": len(found)}


# ==========================================================
# GHÉP FILE PDF THÀNH 1 ẢNH (DÀI HOẶC LƯỚI / GRID)
# ==========================================================

@app.post("/api/stitch-preview-upload")
async def stitch_preview_upload(
    file: UploadFile = File(...),
    layout: str = Form("grid"),
    cols: int = Form(3),
    spacing: int = Form(24),
    padding: int = Form(32),
    bg_color: str = Form("#ffffff"),
    draw_border: bool = Form(True),
    last_row_align: str = Form("center"),
    scale: float = Form(1.0),
):
    """Tạo nhanh ảnh xem trước từ file PDF được tải lên."""
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Tệp quá lớn ({ps.format_file_size(len(contents))}).",
        )

    def _process():
        images = render_pdf_to_images(contents, dpi=150.0, max_dim_per_page=1600)
        c_bgr = parse_color_hex(bg_color, (255, 255, 255))
        stitched = stitch_images(
            images,
            layout=layout,
            cols=cols,
            spacing=spacing,
            padding=padding,
            bg_color=c_bgr,
            draw_border=draw_border,
            last_row_align=last_row_align,
            scale=scale,
            max_total_dim=8000,
        )
        sh, sw = stitched.shape[:2]
        preview_bytes = make_stitched_preview(stitched, max_preview_dim=1600, quality=80)
        return preview_bytes, sw, sh, len(images)

    preview_bytes, sw, sh, num_pages = await run_in_threadpool(_process)

    return Response(
        content=preview_bytes,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Out-Width": str(sw),
            "X-Out-Height": str(sh),
            "X-Total-Pages": str(num_pages),
            "X-Cols": str(cols),
            "X-Rows": str(math.ceil(num_pages / max(1, cols)) if layout == "grid" else (num_pages if layout == "vertical" else 1)),
        },
    )


@app.post("/api/stitch-preview-pages")
async def stitch_preview_pages(req: StitchPreviewRequest):
    """Tạo nhanh ảnh xem trước từ các trang đã có trong dự án."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    filenames = req.filenames or ps.order_page_files(
        ps.list_page_files(ps.folder_dir(root, rel)),
        ps.read_meta(root, rel).get("order") or [],
    )
    if not filenames:
        raise HTTPException(status_code=400, detail="Không có trang nào được chọn để ghép.")

    def _process():
        images = _load_edited_images(root, rel, filenames)
        if not images:
            raise HTTPException(status_code=400, detail="Không tải được dữ liệu ảnh của các trang đã chọn.")
        c_bgr = parse_color_hex(req.bg_color, (255, 255, 255))
        stitched = stitch_images(
            images,
            layout=req.layout,
            cols=req.cols,
            spacing=req.spacing,
            padding=req.padding,
            bg_color=c_bgr,
            draw_border=req.draw_border,
            last_row_align=req.last_row_align,
            scale=req.scale,
            max_total_dim=8000,
        )
        sh, sw = stitched.shape[:2]
        preview_bytes = make_stitched_preview(stitched, max_preview_dim=1600, quality=80)
        return preview_bytes, sw, sh, len(images)

    preview_bytes, sw, sh, num_pages = await run_in_threadpool(_process)

    return Response(
        content=preview_bytes,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Out-Width": str(sw),
            "X-Out-Height": str(sh),
            "X-Total-Pages": str(num_pages),
            "X-Cols": str(req.cols),
            "X-Rows": str(math.ceil(num_pages / max(1, req.cols)) if req.layout == "grid" else (num_pages if req.layout == "vertical" else 1)),
        },
    )


@app.post("/api/stitch-export-upload")
async def stitch_export_upload(
    file: UploadFile = File(...),
    layout: str = Form("grid"),
    cols: int = Form(3),
    spacing: int = Form(24),
    padding: int = Form(32),
    bg_color: str = Form("#ffffff"),
    draw_border: bool = Form(True),
    last_row_align: str = Form("center"),
    scale: float = Form(1.0),
    format: str = Form("jpeg"),
    quality: int = Form(88),
    doc_name: Optional[str] = Form(None),
    save_path: Optional[str] = Form(None),
    import_to_project: bool = Form(False),
    relative_path: Optional[str] = Form(""),
    root_path: Optional[str] = Form(None),
):
    """Xuất ảnh ghép đầy đủ độ phân giải từ file PDF tải lên."""
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Tệp quá lớn ({ps.format_file_size(len(contents))}).",
        )

    def _process():
        images = render_pdf_to_images(contents, dpi=200.0, max_dim_per_page=2400)
        c_bgr = parse_color_hex(bg_color, (255, 255, 255))
        stitched = stitch_images(
            images,
            layout=layout,
            cols=cols,
            spacing=spacing,
            padding=padding,
            bg_color=c_bgr,
            draw_border=draw_border,
            last_row_align=last_row_align,
            scale=scale,
        )
        return stitched, len(images)

    stitched, num_pages = await run_in_threadpool(_process)

    fmt = (format or "jpeg").lower()
    ext = "png" if fmt == "png" else "jpg"
    title = ps.sanitize_component(doc_name or ps.stem_of(file.filename or "Ghep-PDF") or "Ghep-PDF")

    # 1. Thêm trực tiếp vào thư mục dự án
    if import_to_project:
        root = active_root(root_path)
        rel = ps.normalize_rel(relative_path)
        page_name = f"{title}_ghep"
        payload = _save_imported_image(root, rel, stitched, page_name)
        return {"success": True, "imported": True, "page": payload, "pages": num_pages}

    data, mime = encode_stitched_image(stitched, format=fmt, quality=quality)

    # 2. Ghi ra nơi người dùng chọn
    target = _checked_save_path(save_path)
    if target:
        result = _write_export(target, data, f"ảnh ghép {ext.upper()}")
        return {**result, "pages": num_pages, "width": stitched.shape[1], "height": stitched.shape[0]}

    # 3. Phản hồi tệp tải về
    return Response(
        content=data,
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{title}.{ext}"'},
    )


@app.post("/api/stitch-export-pages")
async def stitch_export_pages(req: StitchExportRequest):
    """Xuất ảnh ghép đầy đủ độ phân giải từ các trang trong dự án."""
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    filenames = req.filenames or ps.order_page_files(
        ps.list_page_files(ps.folder_dir(root, rel)),
        ps.read_meta(root, rel).get("order") or [],
    )
    if not filenames:
        raise HTTPException(status_code=400, detail="Không có trang nào được chọn để ghép.")

    def _process():
        images = _load_edited_images(root, rel, filenames)
        if not images:
            raise HTTPException(status_code=400, detail="Không tải được dữ liệu ảnh của các trang đã chọn.")
        c_bgr = parse_color_hex(req.bg_color, (255, 255, 255))
        stitched = stitch_images(
            images,
            layout=req.layout,
            cols=req.cols,
            spacing=req.spacing,
            padding=req.padding,
            bg_color=c_bgr,
            draw_border=req.draw_border,
            last_row_align=req.last_row_align,
            scale=req.scale,
        )
        return stitched, len(images)

    stitched, num_pages = await run_in_threadpool(_process)

    fmt = (req.format or "jpeg").lower()
    ext = "png" if fmt == "png" else "jpg"
    folder_name = os.path.basename(ps.folder_dir(root, rel)) or "Tai-Lieu"
    title = ps.sanitize_component(req.doc_name or f"{folder_name}_{num_pages}_trang_ghep")

    # 1. Thêm trực tiếp vào thư mục dự án
    if req.import_to_project:
        payload = _save_imported_image(root, rel, stitched, title)
        return {"success": True, "imported": True, "page": payload, "pages": num_pages}

    data, mime = encode_stitched_image(stitched, format=fmt, quality=req.quality)

    # 2. Ghi ra nơi người dùng chọn
    target = _checked_save_path(req.save_path)
    if target:
        result = _write_export(target, data, f"ảnh ghép {ext.upper()}")
        return {**result, "pages": num_pages, "width": stitched.shape[1], "height": stitched.shape[0]}

    # 3. Phản hồi tệp tải về
    return Response(
        content=data,
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{title}.{ext}"'},
    )


# ==========================================================
# GỢI Ý TÊN BẰNG AI (chỉ chạy khi người dùng bấm)
# ==========================================================

@app.post("/api/ai-suggest-name")
def ai_suggest_name(req: AiSuggestRequest):
    root = active_root(req.root_path)
    rel = ps.normalize_rel(req.relative_path)
    path = ps.edited_path(root, rel, req.filename)
    img = imread_unicode(path) if os.path.exists(path) else load_original(root, rel, req.filename)
    if img is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh của trang này.")

    primary, suggestions = ai_ocr_suggest_document_name(
        image=img, filename=req.filename, page_index=req.page_index or 1
    )
    return {"success": True, "primary_name": primary, "suggestions": suggestions}


# ==========================================================
# GIAO DIỆN TĨNH
# ==========================================================

@app.middleware("http")
async def revalidate_ui_assets(request, call_next):
    """
    Bắt trình duyệt kiểm tra lại HTML/CSS/JS ở mỗi lần tải (rất rẻ vì chạy nội bộ).
    Nếu không, sau khi cập nhật ứng dụng người dùng sẽ vẫn thấy giao diện cũ và
    tưởng bản cập nhật không có tác dụng. Ảnh trong /api/image vẫn giữ bộ đệm dài hạn.
    """
    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/api/") and (
        path in ("", "/") or path.endswith((".html", ".css", ".js"))
    ):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


static_dir = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
