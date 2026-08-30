import os
import io
import json
import datetime
import uuid
import base64
import cv2
import numpy as np
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from core.detector import detect_document_corners, four_point_transform, rotate_image, expand_quad
from core.enhancer import enhance_document
from core.dewarp import dewarp_page, ai_auto_unwrinkle, remap_mesh_dense, generate_unwrinkle_mesh
from core.compressor import compress_image_to_bytes, generate_pdf_from_images
from core.namer import suggest_document_name, clean_slug_title, get_basic_document_name, ai_ocr_suggest_document_name

app = FastAPI(title="DocScan Studio API", version="2.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

IMAGE_STORE = {}

def format_file_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.2f} MB"

class ProcessRequest(BaseModel):
    image_id: str
    corners: Optional[List[List[float]]] = None
    rotation: int = 0
    margin_percent: float = 0.02
    dewarp_enabled: bool = False
    dewarp_strength: float = 0.8
    custom_mesh: Optional[List[List[float]]] = None
    mode: str = "natural"
    shadow_reduction: float = 0.6
    sharpness: float = 0.6
    contrast: float = 0.2
    brightness: float = 0.0
    quality: int = 85
    format: str = "jpeg"
    normalize_res: bool = True

class PdfExportRequest(BaseModel):
    image_ids: List[str]
    doc_name: Optional[str] = "Tai-Lieu-Scan"
    quality: int = 85
    normalize_res: bool = True

class SaveDiskItem(BaseModel):
    image_id: str
    doc_name: Optional[str] = None
    filename: Optional[str] = None
    corners: Optional[List[List[float]]] = None
    rotation: Optional[int] = 0
    settings: Optional[dict] = None
    history: Optional[dict] = None

class SaveToDiskRequest(BaseModel):
    root_path: str
    relative_path: Optional[str] = ""
    items: List[SaveDiskItem]
    save_original: bool = True
    save_edited: bool = True
    save_pdf: bool = True
    pdf_name: Optional[str] = None
    quality: int = 85
    normalize_res: bool = True

class PageMetadata(BaseModel):
    filename: str
    doc_name: Optional[str] = None
    corners: Optional[List[List[float]]] = None
    rotation: Optional[int] = 0
    settings: Optional[dict] = None
    history: Optional[dict] = None

class SaveMetadataRequest(BaseModel):
    root_path: str
    relative_path: Optional[str] = ""
    pages: List[PageMetadata]

class OpenFolderRequest(BaseModel):
    path: str

class CreateFolderRequest(BaseModel):
    root_path: str
    relative_path: Optional[str] = ""
    folder_name: str

class RenameFolderRequest(BaseModel):
    root_path: str
    old_relative_path: Optional[str] = ""
    new_folder_name: str

class DeleteFolderRequest(BaseModel):
    root_path: str
    relative_path: str

class AiSuggestRequest(BaseModel):
    image_id: str
    page_index: Optional[int] = 1

class ScanDirectoryRequest(BaseModel):
    path: str
    load_images: Optional[bool] = True

class ApplyAsOriginalRequest(BaseModel):
    image_id: str
    root_path: Optional[str] = None
    relative_path: Optional[str] = ""
    doc_name: Optional[str] = None

def image_to_base64(img_bytes: bytes, mime: str = "image/jpeg") -> str:
    return f"data:{mime};base64,{base64.b64encode(img_bytes).decode('utf-8')}"

@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        file_size_bytes = len(contents)
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            raise HTTPException(status_code=400, detail="Không thể giải mã hình ảnh tải lên.")

        image_id = str(uuid.uuid4())
        
        # Fast, 0-cost initial name (No OCR/AI run automatically)
        primary_name, name_suggestions = get_basic_document_name(
            filename=file.filename,
            page_index=len(IMAGE_STORE) + 1
        )

        IMAGE_STORE[image_id] = {
            "original": img,
            "filename": file.filename or "document.jpg",
            "suggested_name": primary_name,
            "orig_size_bytes": file_size_bytes,
            "last_processed": None
        }

        h, w = img.shape[:2]
        mp = (w * h) / 1_000_000.0
        corners, detected = detect_document_corners(img, margin_percent=0.02)

        # Fast thumbnail
        preview_scale = min(1.0, 1400.0 / max(h, w))
        preview_w, preview_h = int(w * preview_scale), int(h * preview_scale)
        preview_img = cv2.resize(img, (preview_w, preview_h), interpolation=cv2.INTER_AREA)
        _, preview_buf = cv2.imencode(".jpg", preview_img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        preview_b64 = image_to_base64(preview_buf.tobytes())

        return {
            "image_id": image_id,
            "filename": file.filename,
            "suggested_name": primary_name,
            "name_suggestions": name_suggestions,
            "width": w,
            "height": h,
            "megapixels": f"{mp:.1f} MP",
            "file_size": file_size_bytes,
            "file_size_human": format_file_size(file_size_bytes),
            "corners": corners.tolist(),
            "detected": detected,
            "preview_url": preview_b64
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/detect")
async def detect_corners_endpoint(
    image_id: str = Form(...),
    margin_percent: float = Form(0.02)
):
    if image_id not in IMAGE_STORE:
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh.")

    img = IMAGE_STORE[image_id]["original"]
    corners, detected = detect_document_corners(img, margin_percent=margin_percent)
    return {
        "image_id": image_id,
        "corners": corners.tolist(),
        "detected": detected
    }

@app.post("/api/process")
async def process_document(req: ProcessRequest):
    if req.image_id not in IMAGE_STORE:
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh.")

    orig_entry = IMAGE_STORE[req.image_id]
    orig = orig_entry["original"]
    orig_bytes = orig_entry.get("orig_size_bytes", 1)

    # 1. Perspective Transform with outpainting
    if req.corners and len(req.corners) == 4:
        pts = np.array(req.corners, dtype=np.float32)
    else:
        pts, _ = detect_document_corners(orig, margin_percent=req.margin_percent)

    warped = four_point_transform(orig, pts)

    # 2. Rotation
    if req.rotation != 0:
        warped = rotate_image(warped, req.rotation)

    # 3. Optional Dewarping
    if req.dewarp_enabled and req.dewarp_strength > 0.05:
        warped, _, _ = ai_auto_unwrinkle(warped, strength=req.dewarp_strength)

    # 4. Color & Crease Enhancement
    enhanced = enhance_document(
        warped,
        mode=req.mode,
        shadow_reduction=req.shadow_reduction,
        sharpness=req.sharpness,
        contrast=req.contrast,
        brightness=req.brightness
    )

    IMAGE_STORE[req.image_id]["last_processed"] = enhanced

    # 5. Compress & Normalize
    data_bytes, size_bytes, (out_w, out_h) = compress_image_to_bytes(
        enhanced,
        format=req.format,
        quality=req.quality,
        normalize_res=req.normalize_res
    )

    mime_type = "image/png" if req.format.lower() == "png" else (
        "image/webp" if req.format.lower() == "webp" else "image/jpeg"
    )

    b64_str = image_to_base64(data_bytes, mime_type)
    saving_ratio = max(0, int((1.0 - (size_bytes / float(max(1, orig_bytes)))) * 100))

    return {
        "image_id": req.image_id,
        "width": out_w,
        "height": out_h,
        "megapixels": f"{(out_w * out_h)/1_000_000.0:.1f} MP",
        "file_size": size_bytes,
        "file_size_human": format_file_size(size_bytes),
        "saving_ratio": f"{saving_ratio}%",
        "image_data": b64_str
    }

@app.post("/api/export-pdf")
async def export_pdf(req: PdfExportRequest):
    if not req.image_ids:
        raise HTTPException(status_code=400, detail="Danh sách trang trống.")

    images_to_export = []
    for iid in req.image_ids:
        if iid in IMAGE_STORE:
            img = IMAGE_STORE[iid].get("last_processed")
            if img is None:
                img = IMAGE_STORE[iid]["original"]
            images_to_export.append(img)

    if not images_to_export:
        raise HTTPException(status_code=400, detail="Không có trang nào hợp lệ để xuất PDF.")

    pdf_bytes = generate_pdf_from_images(
        images_to_export,
        quality=req.quality,
        normalize_res=req.normalize_res
    )

    clean_name = clean_slug_title(req.doc_name or "Tai-Lieu-Scan")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={clean_name}.pdf"}
    )

@app.get("/api/download/{image_id}")
async def download_image(
    image_id: str, 
    format: str = "jpeg", 
    quality: int = 90,
    doc_name: Optional[str] = None
):
    if image_id not in IMAGE_STORE:
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh.")

    entry = IMAGE_STORE[image_id]
    img = entry.get("last_processed")
    if img is None:
        img = entry["original"]

    data, _, _ = compress_image_to_bytes(img, format=format, quality=quality, normalize_res=True)
    ext = "jpg" if format.lower() == "jpeg" else format.lower()

    file_title = clean_slug_title(doc_name or entry.get("suggested_name") or "scan")

    return Response(
        content=data,
        media_type=f"image/{format.lower()}",
        headers={"Content-Disposition": f"attachment; filename={file_title}.{ext}"}
    )

@app.post("/api/pick-directory")
async def pick_directory():
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        selected_path = filedialog.askdirectory(title="Chọn Thư Mục Root cho Dự Án")
        root.destroy()
        if selected_path:
            norm = os.path.normpath(selected_path)
            return {"success": True, "path": norm}
        return {"success": False, "path": ""}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.post("/api/save-to-disk")
async def save_to_disk(req: SaveToDiskRequest):
    if not req.root_path:
        raise HTTPException(status_code=400, detail="Chưa chỉ định thư mục gốc (Root path).")
    
    clean_rel = req.relative_path.strip("/\\") if req.relative_path else ""
    target_dir = os.path.normpath(os.path.join(req.root_path, clean_rel))
    os.makedirs(target_dir, exist_ok=True)
    
    saved_files = []
    images_for_pdf = []
    
    for idx, item in enumerate(req.items):
        if item.image_id in IMAGE_STORE:
            entry = IMAGE_STORE[item.image_id]
            clean_name = clean_slug_title(item.doc_name or f"trang_{idx+1}")
            
            # 1. Save original raw image into _goc subfolder
            if req.save_original:
                orig_dir = os.path.join(target_dir, "_goc")
                os.makedirs(orig_dir, exist_ok=True)
                orig_img = entry["original"]
                orig_filename = f"{clean_name}_goc.jpg"
                orig_filepath = os.path.join(orig_dir, orig_filename)
                cv2.imwrite(orig_filepath, orig_img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
                saved_files.append(f"_goc/{orig_filename}")
            
            # 2. Save edited & enhanced image into main folder
            edited_img = entry.get("last_processed")
            if edited_img is None:
                edited_img = entry["original"]
            
            if req.save_edited:
                edited_bytes, _, _ = compress_image_to_bytes(
                    edited_img,
                    format="jpeg",
                    quality=req.quality,
                    normalize_res=req.normalize_res
                )
                edited_filename = f"{clean_name}.jpg"
                edited_filepath = os.path.join(target_dir, edited_filename)
                with open(edited_filepath, "wb") as f:
                    f.write(edited_bytes)
                saved_files.append(edited_filename)
            
            images_for_pdf.append(edited_img)
    
    # 3. Save PDF if requested
    if req.save_pdf and images_for_pdf:
        pdf_title = clean_slug_title(req.pdf_name or "Tai-Lieu")
        pdf_filename = f"{pdf_title}.pdf"
        pdf_filepath = os.path.join(target_dir, pdf_filename)
        pdf_bytes = generate_pdf_from_images(
            images_for_pdf,
            quality=req.quality,
            normalize_res=req.normalize_res
        )
        with open(pdf_filepath, "wb") as f:
            f.write(pdf_bytes)
        saved_files.append(pdf_filename)
        
    # 4. Save metadata .docscan_meta.json
    try:
        update_folder_metadata(target_dir, [item.dict() for item in req.items])
    except Exception as me:
        print(f"Error updating metadata in save_to_disk: {me}")

    return {
        "success": True,
        "target_dir": target_dir,
        "saved_files": saved_files,
        "count": len(saved_files)
    }

@app.post("/api/open-folder")
async def open_folder_in_explorer(req: OpenFolderRequest):
    if os.path.exists(req.path):
        os.startfile(os.path.normpath(req.path))
        return {"success": True}
    raise HTTPException(status_code=404, detail="Thư mục không tồn tại trên máy.")

@app.post("/api/ai-suggest-name")
async def api_ai_suggest_name(req: AiSuggestRequest):
    if req.image_id not in IMAGE_STORE:
        raise HTTPException(status_code=404, detail="Không tìm thấy tài liệu.")
    
    entry = IMAGE_STORE[req.image_id]
    img = entry.get("last_processed")
    if img is None:
        img = entry["original"]
        
    primary_name, suggestions = ai_ocr_suggest_document_name(
        image=img,
        filename=entry.get("filename"),
        page_index=req.page_index or 1
    )
    entry["suggested_name"] = primary_name
    return {
        "success": True,
        "primary_name": primary_name,
        "suggestions": suggestions
    }

def update_folder_metadata(folder_path: str, pages_data: list):
    try:
        meta_path = os.path.join(folder_path, ".docscan_meta.json")
        existing = {}
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except Exception:
                existing = {}
        
        pages_map = existing.get("pages", {})
        for p in pages_data:
            key = p.get("filename") or p.get("doc_name")
            if key:
                pages_map[key] = {
                    "doc_name": p.get("doc_name"),
                    "filename": p.get("filename") or key,
                    "corners": p.get("corners"),
                    "rotation": p.get("rotation", 0),
                    "settings": p.get("settings", {}),
                    "history": p.get("history", {})
                }
        
        meta_obj = {
            "version": "1.0",
            "updated_at": datetime.datetime.now().isoformat(),
            "pages": pages_map
        }
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta_obj, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Error saving metadata in {folder_path}: {e}")

@app.post("/api/create-folder")
async def api_create_folder(req: CreateFolderRequest):
    if not req.root_path or not os.path.exists(req.root_path):
        raise HTTPException(status_code=400, detail="Thư mục gốc không tồn tại.")
    
    clean_name = req.folder_name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Tên thư mục không được để trống.")
        
    for c in r'<>:"/\|?*':
        clean_name = clean_name.replace(c, '_')
        
    parent_rel = (req.relative_path or "").replace("/", "\\").strip("\\")
    parent_dir = os.path.normpath(os.path.join(req.root_path, parent_rel)) if parent_rel else req.root_path
    
    target_dir = os.path.join(parent_dir, clean_name)
    try:
        os.makedirs(target_dir, exist_ok=True)
        rel = os.path.relpath(target_dir, req.root_path)
        fid = 'folder_' + rel.replace('\\', '_').replace('/', '_')
        return {
            "success": True,
            "folder_id": fid,
            "folder_name": clean_name,
            "relative_path": rel,
            "target_dir": target_dir
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Không thể tạo thư mục trên máy tính: {str(e)}")

@app.post("/api/rename-folder")
async def api_rename_folder(req: RenameFolderRequest):
    if not req.root_path or not os.path.exists(req.root_path):
        raise HTTPException(status_code=400, detail="Thư mục gốc không tồn tại.")
    
    clean_name = req.new_folder_name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Tên thư mục không được để trống.")
    for c in r'<>:"/\|?*':
        clean_name = clean_name.replace(c, '_')
        
    old_rel = (req.old_relative_path or "").replace("/", "\\").strip("\\")
    if not old_rel:
        raise HTTPException(status_code=400, detail="Không thể đổi tên thư mục gốc.")
        
    old_dir = os.path.normpath(os.path.join(req.root_path, old_rel))
    if not os.path.exists(old_dir):
        raise HTTPException(status_code=404, detail="Thư mục cũ không tồn tại.")
        
    parent_dir = os.path.dirname(old_dir)
    new_dir = os.path.join(parent_dir, clean_name)
    
    try:
        os.rename(old_dir, new_dir)
        rel = os.path.relpath(new_dir, req.root_path)
        fid = 'folder_' + rel.replace('\\', '_').replace('/', '_')
        return {
            "success": True,
            "folder_id": fid,
            "folder_name": clean_name,
            "relative_path": rel
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Không thể đổi tên thư mục: {str(e)}")

@app.post("/api/delete-folder")
async def api_delete_folder(req: DeleteFolderRequest):
    if not req.root_path or not os.path.exists(req.root_path):
        raise HTTPException(status_code=400, detail="Thư mục gốc không tồn tại.")
    
    rel = (req.relative_path or "").replace("/", "\\").strip("\\")
    if not rel:
        raise HTTPException(status_code=400, detail="Không thể xóa thư mục gốc.")
        
    target_dir = os.path.normpath(os.path.join(req.root_path, rel))
    if os.path.exists(target_dir):
        try:
            import shutil
            shutil.rmtree(target_dir)
            return {"success": True}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Không thể xóa thư mục: {str(e)}")
    return {"success": True}

@app.post("/api/save-metadata")
async def save_metadata(req: SaveMetadataRequest):
    if not req.root_path or not os.path.exists(req.root_path):
        raise HTTPException(status_code=400, detail="Thư mục gốc không tồn tại.")
    
    clean_rel = (req.relative_path or "").replace("/", "\\").strip("\\")
    target_dir = os.path.normpath(os.path.join(req.root_path, clean_rel)) if clean_rel else req.root_path
    os.makedirs(target_dir, exist_ok=True)
    
    update_folder_metadata(target_dir, [p.dict() for p in req.pages])
    return {"success": True}

@app.post("/api/scan-directory")
async def scan_directory(req: ScanDirectoryRequest):
    if not req.path:
        raise HTTPException(status_code=400, detail="Chưa chỉ định đường dẫn thư mục.")
    
    root_path = os.path.normpath(req.path)
    if not os.path.exists(root_path):
        try:
            os.makedirs(root_path, exist_ok=True)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Không thể truy cập thư mục: {str(e)}")

    root_name = os.path.basename(root_path) or root_path
    IGNORE_DIRS = {'__pycache__', '.git', '.gemini', 'node_modules', 'venv', '.venv', '.idea', '.vscode', 'tmp', 'temp', '_goc', '.goc'}
    
    scanned_folders = []
    loaded_pages = []

    for current_root, dirs, files in os.walk(root_path):
        dirs[:] = [d for d in sorted(dirs) if d not in IGNORE_DIRS and not d.startswith('.')]
        
        rel = os.path.relpath(current_root, root_path)
        if rel == '.':
            rel = ''
            
        fid = 'folder_root' if rel == '' else 'folder_' + rel.replace('\\', '_').replace('/', '_')
        
        parent_rel = os.path.dirname(rel)
        if parent_rel == '.':
            parent_rel = ''
        parent_id = None if rel == '' else ('folder_root' if parent_rel == '' else 'folder_' + parent_rel.replace('\\', '_').replace('/', '_'))
        
        folder_name = os.path.basename(current_root) if rel != '' else root_name
        img_filenames = [f for f in sorted(files) if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.bmp'))]
        
        # Check if folder has persistent metadata
        meta_path = os.path.join(current_root, ".docscan_meta.json")
        meta_data = {}
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as mf:
                    meta_data = json.load(mf).get("pages", {})
            except Exception:
                meta_data = {}

        folder_image_ids = []
        if req.load_images:
            for fname in img_filenames:
                full_img_path = os.path.join(current_root, fname)
                try:
                    img_id = str(uuid.uuid4())
                    stem = os.path.splitext(fname)[0]
                    
                    # Look up persistent metadata
                    page_meta = meta_data.get(fname) or meta_data.get(stem) or meta_data.get(f"{stem}.jpg") or {}
                    
                    # Check if there is a raw original in _goc subfolder
                    orig_subfolder_path = os.path.join(current_root, "_goc", f"{stem}_goc.jpg")
                    
                    if os.path.exists(orig_subfolder_path):
                        raw_orig_img = cv2.imread(orig_subfolder_path)
                        processed_img = cv2.imread(full_img_path)
                    else:
                        raw_orig_img = cv2.imread(full_img_path)
                        processed_img = None

                    if raw_orig_img is not None:
                        h, w = raw_orig_img.shape[:2]
                        mp = (w * h) / 1_000_000.0
                        fsize = os.path.getsize(full_img_path)
                        
                        # Restore corners from metadata or auto-detect
                        if page_meta.get("corners") and len(page_meta["corners"]) == 4:
                            corners = np.array(page_meta["corners"], dtype=np.float32)
                            detected = True
                        else:
                            corners, detected = detect_document_corners(raw_orig_img, margin_percent=0.02)
                        
                        preview_scale = min(1.0, 1400.0 / max(h, w))
                        preview_w, preview_h = int(w * preview_scale), int(h * preview_scale)
                        preview_img = cv2.resize(raw_orig_img, (preview_w, preview_h), interpolation=cv2.INTER_AREA)
                        _, preview_buf = cv2.imencode(".jpg", preview_img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
                        preview_b64 = image_to_base64(preview_buf.tobytes())
                        
                        # Processed preview if available
                        proc_b64 = None
                        if processed_img is not None:
                            _, proc_buf = cv2.imencode(".jpg", processed_img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
                            proc_b64 = image_to_base64(proc_buf.tobytes())

                        primary_name, name_suggestions = get_basic_document_name(filename=fname, page_index=len(folder_image_ids) + 1)
                        doc_name = page_meta.get("doc_name") or stem or primary_name
                        
                        IMAGE_STORE[img_id] = {
                            "original": raw_orig_img,
                            "filename": fname,
                            "suggested_name": doc_name,
                            "orig_size_bytes": fsize,
                            "last_processed": processed_img
                        }
                        
                        folder_image_ids.append(img_id)
                        loaded_pages.append({
                            "id": img_id,
                            "filename": fname,
                            "suggested_name": doc_name,
                            "name_suggestions": name_suggestions,
                            "width": w,
                            "height": h,
                            "megapixels": f"{mp:.1f} MP",
                            "file_size": fsize,
                            "file_size_human": format_file_size(fsize),
                            "corners": corners.tolist(),
                            "detected": detected,
                            "preview_url": preview_b64,
                            "processed_url": proc_b64,
                            "folderId": fid,
                            "rotation": page_meta.get("rotation", 0),
                            "settings": page_meta.get("settings"),
                            "history": page_meta.get("history")
                        })
                except Exception as ex:
                    print(f"Error loading {full_img_path}: {ex}")

        scanned_folders.append({
            "id": fid,
            "name": folder_name,
            "parentId": parent_id,
            "relativePath": rel,
            "imageIds": folder_image_ids,
            "isExpanded": True
        })

    return {
        "success": True,
        "root_path": root_path,
        "root_name": root_name,
        "folders": scanned_folders,
        "pages": loaded_pages,
        "total_folders": len(scanned_folders),
        "total_images": len(loaded_pages)
    }

@app.post("/api/apply-as-original")
async def apply_as_original(req: ApplyAsOriginalRequest):
    if req.image_id not in IMAGE_STORE:
        raise HTTPException(status_code=404, detail="Không tìm thấy tài liệu.")
    
    entry = IMAGE_STORE[req.image_id]
    processed = entry.get("last_processed")
    if processed is None:
        raise HTTPException(status_code=400, detail="Tài liệu chưa qua xử lý làm nét.")
    
    # Overwrite original in memory with the processed image
    entry["original"] = processed.copy()
    entry["last_processed"] = None
    
    h, w = processed.shape[:2]
    mp = (w * h) / 1_000_000.0
    
    # Reset full-frame corners for the new original
    corners = np.array([
        [0.0, 0.0],
        [float(w), 0.0],
        [float(w), float(h)],
        [0.0, float(h)]
    ], dtype=np.float32)
    
    # Generate new preview base64
    preview_scale = min(1.0, 1400.0 / max(h, w))
    preview_w, preview_h = int(w * preview_scale), int(h * preview_scale)
    preview_img = cv2.resize(processed, (preview_w, preview_h), interpolation=cv2.INTER_AREA)
    _, preview_buf = cv2.imencode(".jpg", preview_img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    preview_b64 = image_to_base64(preview_buf.tobytes())
    
    # If root_path provided, overwrite on disk in _goc
    if req.root_path and os.path.exists(req.root_path):
        try:
            rel = (req.relative_path or "").replace("/", "\\").strip("\\")
            target_dir = os.path.join(req.root_path, rel) if rel else req.root_path
            orig_dir = os.path.join(target_dir, "_goc")
            os.makedirs(orig_dir, exist_ok=True)
            clean_name = clean_slug_title(req.doc_name or "Tai-Lieu")
            orig_filepath = os.path.join(orig_dir, f"{clean_name}_goc.jpg")
            cv2.imwrite(orig_filepath, processed, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        except Exception as e:
            print(f"Error updating original on disk: {e}")
            
    return {
        "success": True,
        "image_id": req.image_id,
        "width": w,
        "height": h,
        "megapixels": f"{mp:.1f} MP",
        "corners": corners.tolist(),
        "preview_url": preview_b64
    }

static_dir = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
