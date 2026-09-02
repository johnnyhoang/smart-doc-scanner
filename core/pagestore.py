"""
core/pagestore.py — Nguồn sự thật duy nhất cho "Đối Tượng Tài Liệu" (Document Object).

MÔ HÌNH BẤT BIẾN:
    Mỗi trang tài liệu = 1 bộ ba không thể tách rời, định danh bởi `stem` trong 1 thư mục:

        <thư_mục>/_goc/<stem>_goc.jpg   -> Ảnh gốc (bất biến, không bao giờ ghi đè ngầm)
        <thư_mục>/<stem>.jpg            -> Ảnh đang sửa (kết quả render từ metadata)
        <thư_mục>/.docscan_meta.json    -> pages["<stem>.jpg"] = tình trạng hiện tại

    Mọi thao tác ghi đĩa BẮT BUỘC đi qua module này để 3 thành phần không bao giờ lệch nhau.
    Đổi tên = đổi cả 3 (rename_page), không bao giờ tạo bản sao dưới tên mới.
"""

import os
import json
import shutil
import hashlib
import datetime
import threading
from typing import Optional, Tuple, List, Dict, Any

import cv2
import numpy as np

from core.detector import imread_unicode, imwrite_unicode

# ==========================================================
# HẰNG SỐ CẤU TRÚC ĐĨA
# ==========================================================

GOC_DIR = "_goc"
GOC_SUFFIX = "_goc"
META_FILE = ".docscan_meta.json"
UNAPPROVED_DIR = "Kho_Chua_Duyet"
UNAPPROVED_LABEL = "Kho ảnh chưa duyệt"

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
EDITED_EXT = ".jpg"
ORIGINAL_QUALITY = 95

IGNORE_DIRS = {
    "__pycache__", ".git", ".gemini", "node_modules", "venv", ".venv",
    ".idea", ".vscode", "tmp", "temp", GOC_DIR, ".goc",
}

DEFAULT_SETTINGS: Dict[str, Any] = {
    "mode": "natural",
    "shadow_reduction": 0.6,
    "sharpness": 0.6,
    "contrast": 0.2,
    "brightness": 0.0,
    "margin_percent": 0.02,
    "dewarp_enabled": False,
    "dewarp_strength": 0.8,
    "quality": 85,
    "normalize_res": True,
}


def default_settings() -> Dict[str, Any]:
    return dict(DEFAULT_SETTINGS)


def merged_settings(raw: Optional[dict]) -> Dict[str, Any]:
    """Luôn trả về bộ thiết lập đầy đủ, các khóa thiếu lấy giá trị mặc định."""
    out = dict(DEFAULT_SETTINGS)
    if isinstance(raw, dict):
        for k, v in raw.items():
            if v is not None:
                out[k] = v
    return out


# ==========================================================
# ĐƯỜNG DẪN AN TOÀN (chống thoát khỏi thư mục gốc)
# ==========================================================

def normalize_rel(rel: Optional[str]) -> str:
    """Chuẩn hóa đường dẫn tương đối về dạng dùng dấu \\ , không có dấu ở hai đầu."""
    if not rel:
        return ""
    cleaned = str(rel).replace("/", os.sep).replace("\\", os.sep).strip(os.sep)
    if cleaned in (".", ""):
        return ""
    return cleaned


def folder_dir(root: str, rel: Optional[str]) -> str:
    """Ghép root + rel và đảm bảo kết quả vẫn nằm trong root."""
    if not root:
        raise ValueError("Chưa chỉ định thư mục gốc.")
    root_abs = os.path.abspath(os.path.normpath(root))
    rel_clean = normalize_rel(rel)
    target = os.path.abspath(os.path.normpath(os.path.join(root_abs, rel_clean)))
    if target != root_abs and not target.startswith(root_abs + os.sep):
        raise ValueError("Đường dẫn nằm ngoài thư mục dự án.")
    return target


def stem_of(filename: str) -> str:
    return os.path.splitext(os.path.basename(filename or ""))[0]


def edited_filename(stem: str) -> str:
    return f"{stem}{EDITED_EXT}"


def edited_path(root: str, rel: Optional[str], filename: str) -> str:
    return os.path.join(folder_dir(root, rel), os.path.basename(filename))


def goc_dir_path(root: str, rel: Optional[str]) -> str:
    return os.path.join(folder_dir(root, rel), GOC_DIR)


def original_path(root: str, rel: Optional[str], filename: str) -> str:
    """Đường dẫn chuẩn của ảnh gốc: _goc/<stem>_goc.jpg"""
    return os.path.join(goc_dir_path(root, rel), f"{stem_of(filename)}{GOC_SUFFIX}.jpg")


def find_original_path(root: str, rel: Optional[str], filename: str) -> Optional[str]:
    """
    Tìm ảnh gốc theo quy ước chuẩn, có dò các biến thể cũ do phiên bản trước để lại
    (khắc phục dữ liệu lệch tên đã tồn tại trên máy người dùng).
    """
    stem = stem_of(filename)
    gdir = goc_dir_path(root, rel)
    if not os.path.isdir(gdir):
        return None

    candidates = [f"{stem}{GOC_SUFFIX}.jpg", f"{stem}.jpg", f"{stem}{GOC_SUFFIX}.jpeg", f"{stem}.jpeg"]
    for name in candidates:
        p = os.path.join(gdir, name)
        if os.path.exists(p):
            return p

    # Dò không phân biệt hoa thường (Windows thường không phân biệt, nhưng dữ liệu cũ có thể lệch)
    try:
        lower_map = {f.lower(): f for f in os.listdir(gdir)}
        for name in candidates:
            actual = lower_map.get(name.lower())
            if actual:
                return os.path.join(gdir, actual)
    except OSError:
        pass
    return None


def meta_path(root: str, rel: Optional[str]) -> str:
    return os.path.join(folder_dir(root, rel), META_FILE)


def make_page_id(root: str, rel: Optional[str], filename: str) -> str:
    """
    Định danh ổn định của một trang: luôn giống nhau giữa các lần quét lại,
    nhờ đó bộ nhớ đệm không bị phình và tham chiếu phía giao diện không hỏng.
    """
    key = f"{os.path.abspath(root).lower()}|{normalize_rel(rel).lower()}|{filename.lower()}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:20]


def folder_id_of(rel: Optional[str]) -> str:
    rel_clean = normalize_rel(rel)
    if not rel_clean:
        return "folder_root"
    return "folder_" + rel_clean.replace(os.sep, "_")


UNAPPROVED_ALIASES = {
    "kho_chua_duyet",
    "kho ảnh chưa duyệt",
    "kho anh chua duyet",
    "kho_anh_chua_duyet",
    "kho chua duyet",
    "unapproved",
}


def is_unapproved_name(name: Optional[str]) -> bool:
    if not name:
        return False
    cleaned = str(name).strip().lower().replace("-", "_")
    if cleaned in UNAPPROVED_ALIASES:
        return True
    cleaned_spaces = str(name).strip().lower().replace("_", " ")
    return cleaned_spaces in UNAPPROVED_ALIASES


def display_folder_name(raw_name: str, rel: Optional[str]) -> str:
    rel_clean = normalize_rel(rel)
    if is_unapproved_name(rel_clean) or is_unapproved_name(raw_name):
        return UNAPPROVED_LABEL
    return raw_name


def merge_unapproved_folders_if_needed(root_abs: str) -> List[str]:
    """
    Gộp các thư mục "Kho chưa duyệt" trùng lặp (ví dụ tồn tại đồng thời
    'Kho_Chua_Duyet' và 'Kho ảnh chưa duyệt' do các bản cũ tạo ra) về một thư mục
    chuẩn duy nhất là UNAPPROVED_DIR.

    Trả về danh sách cảnh báo (rỗng nếu không có gì phải làm hoặc đã gộp xong).
    KHÔNG được nuốt lỗi im lặng: nếu gộp thất bại, thư mục trùng vẫn phải hiển thị
    đầy đủ trên giao diện, tuyệt đối không để ảnh của người dùng biến mất khỏi app.
    """
    warnings: List[str] = []
    canonical_dir = os.path.join(root_abs, UNAPPROVED_DIR)

    try:
        entries = sorted(os.listdir(root_abs))
    except OSError as e:
        print(f"[merge-unapproved] không đọc được thư mục dự án: {e}")
        return warnings

    for item in entries:
        item_path = os.path.join(root_abs, item)
        if item == UNAPPROVED_DIR or not os.path.isdir(item_path):
            continue
        if not is_unapproved_name(item):
            continue

        try:
            _merge_one_unapproved_dir(root_abs, item, item_path, canonical_dir)
        except OSError as e:
            # Ghi log rõ ràng và báo lên trên; giao diện vẫn thấy cả hai thư mục.
            print(f"[merge-unapproved] không gộp được '{item}': {e}")
            warnings.append(
                f"Không gộp được thư mục '{item}' vào '{UNAPPROVED_DIR}'. "
                "Có thể tệp đang mở ở ứng dụng khác."
            )

    return warnings


def _merge_one_unapproved_dir(root_abs: str, item: str, item_path: str, canonical_dir: str) -> None:
    """Chuyển toàn bộ nội dung của một thư mục trùng lặp vào thư mục chuẩn."""
    os.makedirs(canonical_dir, exist_ok=True)

    for name in sorted(os.listdir(item_path)):
        src = os.path.join(item_path, name)

        if os.path.isdir(src):
            if name == GOC_DIR:
                dst_goc = os.path.join(canonical_dir, GOC_DIR)
                os.makedirs(dst_goc, exist_ok=True)
                for gf in sorted(os.listdir(src)):
                    target = os.path.join(dst_goc, gf)
                    if not os.path.exists(target):
                        shutil.move(os.path.join(src, gf), target)
                shutil.rmtree(src, ignore_errors=True)
            else:
                target = os.path.join(canonical_dir, name)
                if not os.path.exists(target):
                    shutil.move(src, target)
            continue

        if name == META_FILE:
            # Hợp nhất metadata: mục của thư mục chuẩn được ưu tiên giữ lại.
            old_pages = read_meta(root_abs, item).get("pages", {})
            meta = read_meta(root_abs, UNAPPROVED_DIR)
            pages = meta.get("pages", {})
            for key, value in old_pages.items():
                pages.setdefault(key, value)
            _write_meta(root_abs, UNAPPROVED_DIR, pages)
            os.remove(src)   # đã hợp nhất xong, bỏ bản cũ để thư mục rỗng và xoá được
            continue

        target = os.path.join(canonical_dir, name)
        if not os.path.exists(target):
            shutil.move(src, target)

    # Chỉ xoá thư mục cũ khi đã rỗng — còn tệp nào là còn dữ liệu người dùng.
    remaining = os.listdir(item_path)
    if remaining:
        raise OSError(f"còn {len(remaining)} tệp chưa chuyển được: {remaining[:3]}")
    os.rmdir(item_path)


def sanitize_component(name: str) -> str:
    """Làm sạch tên file/thư mục cho hệ điều hành, GIỮ NGUYÊN dấu tiếng Việt."""
    cleaned = (name or "").strip()
    for ch in '<>:"/\\|?*':
        cleaned = cleaned.replace(ch, "_")
    cleaned = cleaned.replace("\n", " ").replace("\r", " ").strip(" .")
    return cleaned[:120]


# ==========================================================
# SIÊU DỮ LIỆU .docscan_meta.json (đọc / ghi hợp nhất)
# ==========================================================

_meta_lock = threading.RLock()


def read_meta(root: str, rel: Optional[str]) -> Dict[str, Any]:
    path = meta_path(root, rel)
    if not os.path.exists(path):
        return {"version": "2.0", "pages": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"version": "2.0", "pages": {}}
        data.setdefault("pages", {})
        if not isinstance(data["pages"], dict):
            data["pages"] = {}
        return data
    except (OSError, ValueError):
        return {"version": "2.0", "pages": {}}


def _write_meta(root: str, rel: Optional[str], pages: Dict[str, Any],
                order: Optional[List[str]] = None) -> None:
    folder = folder_dir(root, rel)
    os.makedirs(folder, exist_ok=True)
    # order=None nghĩa là giữ nguyên thứ tự đã lưu; tên không còn tệp sẽ được lọc lúc quét.
    payload = {
        "version": "2.0",
        "updated_at": datetime.datetime.now().isoformat(),
        "order": order if order is not None else (read_meta(root, rel).get("order") or []),
        "pages": pages,
    }
    path = meta_path(root, rel)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def find_meta_entry(meta_pages: dict, filename: str) -> dict:
    """Tra cứu bản ghi metadata an toàn (hỗ trợ cả tên file, stem và không phân biệt hoa thường)."""
    if not isinstance(meta_pages, dict):
        return {}
    if filename in meta_pages:
        entry = meta_pages[filename]
        return entry if isinstance(entry, dict) else {}
    stem = stem_of(filename)
    if stem in meta_pages:
        entry = meta_pages[stem]
        return entry if isinstance(entry, dict) else {}
    if f"{stem}.jpg" in meta_pages:
        entry = meta_pages[f"{stem}.jpg"]
        return entry if isinstance(entry, dict) else {}
    # Tra cứu dự phòng không phân biệt hoa/thường (tương thích tệp trên Windows)
    fn_lower = filename.lower()
    stem_lower = stem.lower()
    for k, v in meta_pages.items():
        if k.lower() in (fn_lower, stem_lower, f"{stem_lower}.jpg"):
            return v if isinstance(v, dict) else {}
    return {}


def get_page_meta(root: str, rel: Optional[str], filename: str) -> Dict[str, Any]:
    """Lấy trạng thái của 1 trang, có dò khóa cũ (theo stem) để tương thích ngược."""
    pages = read_meta(root, rel).get("pages", {})
    return find_meta_entry(pages, filename)


def patch_page_meta(root: str, rel: Optional[str], filename: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    """
    Cập nhật HỢP NHẤT theo từng trường. Trường có giá trị None hoặc vắng mặt
    sẽ GIỮ NGUYÊN giá trị cũ — tuyệt đối không bao giờ xóa trắng trạng thái đã lưu.
    """
    with _meta_lock:
        meta = read_meta(root, rel)
        pages = meta.get("pages", {})
        stem = stem_of(filename)

        # Gom khóa cũ (nếu có) về khóa chuẩn là tên file
        existing = find_meta_entry(pages, filename)
        current = dict(existing) if existing else {}

        # Dọn các alias cũ nếu có
        for legacy in list(pages.keys()):
            if legacy != filename and legacy.lower() in (filename.lower(), stem.lower(), f"{stem.lower()}.jpg"):
                pages.pop(legacy, None)

        for key, value in (patch or {}).items():
            if value is not None:
                current[key] = value

        current["filename"] = filename
        current.setdefault("doc_name", stem)
        current.setdefault("settings", default_settings())
        current.setdefault("rotation", 0)
        current.setdefault("history", {"undo": [], "redo": []})
        current["updated_at"] = datetime.datetime.now().isoformat()

        pages[filename] = current
        _write_meta(root, rel, pages)
        return current


def set_folder_order(root: str, rel: Optional[str], order: List[str]) -> None:
    """Lưu thứ tự trang do người dùng sắp xếp, để mở lại app vẫn đúng thứ tự in PDF."""
    with _meta_lock:
        pages = read_meta(root, rel).get("pages", {})
        _write_meta(root, rel, pages, [str(x) for x in (order or [])])


def _order_with_rename(root: str, rel: Optional[str], old_name: str,
                       new_name: Optional[str]) -> List[str]:
    """
    Thay tên cũ bằng tên mới NGAY TẠI VỊ TRÍ CŨ trong danh sách thứ tự.
    Nếu new_name là None thì bỏ hẳn khỏi danh sách (trường hợp xóa / chuyển đi).
    Không làm bước này thì trang vừa đổi tên sẽ bị đẩy xuống cuối tệp PDF.
    """
    order = list(read_meta(root, rel).get("order") or [])
    if old_name not in order:
        if new_name and new_name not in order:
            order.append(new_name)
        return order
    idx = order.index(old_name)
    if new_name:
        order[idx] = new_name
    else:
        order.pop(idx)
    return order


def remove_page_meta(root: str, rel: Optional[str], filename: str) -> None:
    with _meta_lock:
        meta = read_meta(root, rel)
        pages = meta.get("pages", {})
        stem = stem_of(filename)
        for key in (filename, stem, f"{stem}.jpg"):
            pages.pop(key, None)
        _write_meta(root, rel, pages, _order_with_rename(root, rel, filename, None))


def prune_meta_to_existing(root: str, rel: Optional[str]) -> None:
    """Dọn các mục siêu dữ liệu trỏ tới file đã không còn trên đĩa."""
    with _meta_lock:
        folder = folder_dir(root, rel)
        if not os.path.isdir(folder):
            return
        meta = read_meta(root, rel)
        pages = meta.get("pages", {})
        alive = {k: v for k, v in pages.items() if os.path.exists(os.path.join(folder, k))}
        if len(alive) != len(pages):
            _write_meta(root, rel, alive)


# ==========================================================
# GHI BỘ BA XUỐNG ĐĨA
# ==========================================================

def unique_stem(root: str, rel: Optional[str], desired_stem: str) -> str:
    """Tìm stem chưa bị chiếm dụng trong thư mục (kiểm tra cả ảnh sửa lẫn ảnh gốc)."""
    folder = folder_dir(root, rel)
    base = sanitize_component(desired_stem) or "Tai-Lieu"
    candidate = base
    index = 1
    while True:
        taken = os.path.exists(os.path.join(folder, edited_filename(candidate))) or \
            find_original_path(root, rel, edited_filename(candidate)) is not None
        if not taken:
            return candidate
        index += 1
        candidate = f"{base}_{index}"


def write_original(root: str, rel: Optional[str], filename: str, img: np.ndarray) -> str:
    """Ghi ảnh gốc vào _goc/. Chỉ được gọi khi nhập ảnh mới hoặc user xác nhận rõ ràng."""
    gdir = goc_dir_path(root, rel)
    os.makedirs(gdir, exist_ok=True)
    path = original_path(root, rel, filename)
    imwrite_unicode(path, img, [int(cv2.IMWRITE_JPEG_QUALITY), ORIGINAL_QUALITY])
    return path


def write_edited_bytes(root: str, rel: Optional[str], filename: str, data: bytes) -> str:
    folder = folder_dir(root, rel)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, os.path.basename(filename))
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return path


def read_original(root: str, rel: Optional[str], filename: str) -> Optional[np.ndarray]:
    """Đọc ảnh gốc; nếu trang chưa có bản gốc thì đọc chính ảnh đang hiển thị."""
    path = find_original_path(root, rel, filename)
    if path is None:
        path = edited_path(root, rel, filename)
    if not os.path.exists(path):
        return None
    return imread_unicode(path)


def rename_page(root: str, rel: Optional[str], old_filename: str, new_stem: str) -> Dict[str, Any]:
    """
    Đổi tên NGUYÊN BỘ BA (ảnh sửa + ảnh gốc + khóa siêu dữ liệu) trong một thao tác.
    Đây là cách DUY NHẤT được phép đổi tên một trang tài liệu.
    """
    with _meta_lock:
        old_stem = stem_of(old_filename)
        desired = sanitize_component(new_stem) or old_stem
        if desired == old_stem:
            return {"filename": old_filename, "renamed": False}

        target_stem = unique_stem(root, rel, desired)
        new_name = edited_filename(target_stem)

        old_edited = edited_path(root, rel, old_filename)
        new_edited = edited_path(root, rel, new_name)
        if os.path.exists(old_edited):
            os.replace(old_edited, new_edited)

        old_goc = find_original_path(root, rel, old_filename)
        if old_goc and os.path.exists(old_goc):
            new_goc = original_path(root, rel, new_name)
            os.makedirs(os.path.dirname(new_goc), exist_ok=True)
            os.replace(old_goc, new_goc)

        meta = read_meta(root, rel)
        pages = meta.get("pages", {})
        entry = None
        for key in (old_filename, old_stem, f"{old_stem}.jpg"):
            if key in pages:
                entry = pages.pop(key)
                break
        if not isinstance(entry, dict):
            entry = {}
        entry["filename"] = new_name
        entry["doc_name"] = target_stem
        entry["updated_at"] = datetime.datetime.now().isoformat()
        pages[new_name] = entry
        _write_meta(root, rel, pages, _order_with_rename(root, rel, old_filename, new_name))

        return {"filename": new_name, "doc_name": target_stem, "renamed": True}


def delete_page_files(root: str, rel: Optional[str], filename: str) -> bool:
    """Xóa vĩnh viễn cả ảnh sửa, ảnh gốc và mục siêu dữ liệu của một trang."""
    deleted = False
    target = edited_path(root, rel, filename)
    if os.path.exists(target):
        os.remove(target)
        deleted = True
    goc = find_original_path(root, rel, filename)
    if goc and os.path.exists(goc):
        os.remove(goc)
        deleted = True
    remove_page_meta(root, rel, filename)
    return deleted


def move_page(root: str, src_rel: Optional[str], filename: str, dst_rel: Optional[str]) -> Dict[str, Any]:
    """Di chuyển nguyên bộ ba sang thư mục khác, giữ đúng quan hệ gốc/sửa/metadata."""
    with _meta_lock:
        src_dir = folder_dir(root, src_rel)
        dst_dir = folder_dir(root, dst_rel)
        os.makedirs(dst_dir, exist_ok=True)
        if os.path.abspath(src_dir) == os.path.abspath(dst_dir):
            return {"filename": filename, "moved": False}

        target_stem = unique_stem(root, dst_rel, stem_of(filename))
        new_name = edited_filename(target_stem)

        src_edited = os.path.join(src_dir, filename)
        if os.path.exists(src_edited):
            shutil.move(src_edited, os.path.join(dst_dir, new_name))

        src_goc = find_original_path(root, src_rel, filename)
        if src_goc and os.path.exists(src_goc):
            dst_goc = original_path(root, dst_rel, new_name)
            os.makedirs(os.path.dirname(dst_goc), exist_ok=True)
            shutil.move(src_goc, dst_goc)

        state = get_page_meta(root, src_rel, filename)
        remove_page_meta(root, src_rel, filename)
        if state:
            state.pop("filename", None)
            patch_page_meta(root, dst_rel, new_name, state)

        dst_order = list(read_meta(root, dst_rel).get("order") or [])
        if dst_order and new_name not in dst_order:
            dst_order.append(new_name)
            set_folder_order(root, dst_rel, dst_order)

        return {"filename": new_name, "doc_name": target_stem, "moved": True}


# ==========================================================
# DẤU VÂN TRẠNG THÁI (tránh render lại khi không cần)
# ==========================================================

def is_stale(entry: Dict[str, Any]) -> bool:
    """
    Ảnh đang sửa trên đĩa có còn khớp với metadata không?

    Metadata được ghi rất nhanh sau mỗi thao tác, còn tệp ảnh chỉ được kết xuất lại khi lưu.
    Nếu người dùng tắt ứng dụng ở giữa hai mốc đó, tệp ảnh sẽ cũ hơn metadata. Cờ này giúp
    lần mở sau nhận ra và tự xếp trang vào hàng chờ lưu, thay vì im lặng hiển thị bản cũ.
    """
    committed = entry.get("committed_fingerprint")
    if not committed:
        return False
    current = state_fingerprint(
        entry.get("corners"), entry.get("rotation", 0), merged_settings(entry.get("settings"))
    )
    return current != committed


def state_fingerprint(corners, rotation, settings) -> str:
    payload = {
        "c": [[round(float(x), 2), round(float(y), 2)] for x, y in (corners or [])],
        "r": int(rotation or 0),
        "s": {k: settings.get(k) for k in sorted(settings or {})},
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


# ==========================================================
# QUÉT THƯ MỤC (nhẹ — không nạp điểm ảnh)
# ==========================================================

def read_image_dimensions(path: str) -> Tuple[int, int]:
    """Đọc kích thước ảnh mà không giải mã toàn bộ khung hình."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            return int(im.width), int(im.height)
    except Exception:
        img = imread_unicode(path)
        if img is None:
            return 0, 0
        h, w = img.shape[:2]
        return int(w), int(h)


def format_file_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes / (1024 * 1024):.2f} MB"


def list_page_files(folder: str) -> List[str]:
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    return sorted(
        f for f in names
        if f.lower().endswith(IMAGE_EXTS) and os.path.isfile(os.path.join(folder, f))
    )


def order_page_files(filenames: List[str], saved_order: List[str]) -> List[str]:
    """Áp thứ tự người dùng đã sắp xếp; tệp mới xuất hiện được xếp về cuối."""
    if not saved_order:
        return filenames
    known = set(filenames)
    ordered = [name for name in saved_order if name in known]
    ordered += [name for name in filenames if name not in set(ordered)]
    return ordered


def scan_tree(root: str) -> Tuple[List[dict], List[dict]]:
    """
    Quét cây thư mục và trả về (folders, pages) ở dạng NHẸ:
    không nạp điểm ảnh, không base64 — giao diện tải ảnh theo yêu cầu qua URL.
    """
    root_abs = os.path.abspath(os.path.normpath(root))
    merge_warnings = merge_unapproved_folders_if_needed(root_abs)
    if merge_warnings:
        for w in merge_warnings:
            print(f"[scan-tree] {w}")
    root_name = os.path.basename(root_abs) or root_abs
    folders: List[dict] = []
    pages: List[dict] = []

    for current, dirs, _files in os.walk(root_abs):
        dirs[:] = [d for d in sorted(dirs) if d not in IGNORE_DIRS and not d.startswith(".")]

        rel = os.path.relpath(current, root_abs)
        rel = "" if rel == "." else rel
        fid = folder_id_of(rel)

        parent_rel = os.path.dirname(rel)
        parent_id = None if rel == "" else folder_id_of(parent_rel)

        raw_name = os.path.basename(current) if rel else root_name
        rel_clean = normalize_rel(rel)
        is_unapproved = is_unapproved_name(rel_clean) or is_unapproved_name(raw_name)

        folder_meta = read_meta(root_abs, rel)
        meta_pages = folder_meta.get("pages", {})
        saved_order = folder_meta.get("order") or []
        image_ids: List[str] = []

        for fname in order_page_files(list_page_files(current), saved_order):
            full = os.path.join(current, fname)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            stem = stem_of(fname)
            entry = find_meta_entry(meta_pages, fname)

            width, height = read_image_dimensions(full)
            goc = find_original_path(root_abs, rel, fname)
            if goc:
                gw, gh = read_image_dimensions(goc)
                if gw and gh:
                    width, height = gw, gh

            orig_size = size
            if goc and os.path.exists(goc):
                try:
                    orig_size = os.path.getsize(goc)
                except OSError:
                    orig_size = size

            pid = make_page_id(root_abs, rel, fname)
            image_ids.append(pid)
            pages.append({
                "id": pid,
                "filename": fname,
                "folderId": fid,
                "relativePath": rel_clean,
                "doc_name": entry.get("doc_name") or stem,
                "width": width,
                "height": height,
                "megapixels": f"{(width * height) / 1_000_000.0:.1f} MP",
                "file_size": orig_size,
                "file_size_human": format_file_size(orig_size),
                "orig_size": orig_size,
                "orig_size_human": format_file_size(orig_size),
                "edited_size": size,
                "edited_size_human": format_file_size(size),
                "corners": entry.get("corners"),
                "rotation": entry.get("rotation", 0),
                "settings": merged_settings(entry.get("settings")),
                "history": entry.get("history") or {"undo": [], "redo": []},
                "has_raw_original": goc is not None,
                "is_stale": is_stale(entry),
                "version": int(os.path.getmtime(full)),
            })

        folders.append({
            "id": fid,
            "name": display_folder_name(raw_name, rel),
            "parentId": parent_id,
            "relativePath": rel_clean,
            "imageIds": image_ids,
            "isUnapproved": is_unapproved,
            "isExpanded": True,
        })

    # Chỉ loại trùng theo định danh. TUYỆT ĐỐI không loại bớt thư mục "Kho chưa duyệt"
    # trùng lặp ở đây: nếu bước gộp phía trên thất bại, việc giấu bớt một thư mục sẽ
    # khiến ảnh có thật trên đĩa biến mất khỏi giao diện mà người dùng không hề biết.
    unique_folders = []
    seen_ids = set()
    for f in folders:
        if f["id"] not in seen_ids:
            seen_ids.add(f["id"])
            unique_folders.append(f)

    # Chốt an toàn: mọi trang trả về đều phải thuộc một thư mục mà giao diện biết.
    known = {f["id"] for f in unique_folders}
    visible_pages = [pg for pg in pages if pg["folderId"] in known]
    if len(visible_pages) != len(pages):
        missing = {pg["folderId"] for pg in pages if pg["folderId"] not in known}
        print(f"[scan-tree] CẢNH BÁO: bỏ sót {len(pages) - len(visible_pages)} trang "
              f"thuộc thư mục không có trong cây: {missing}")

    return unique_folders, visible_pages
