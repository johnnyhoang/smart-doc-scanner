# 🔌 04. Đặc Tả Giao Tiếp API Backend (API Specification Spec)

## 🎯 Mục Đích
Tài liệu này đặc tả toàn diện danh sách tất cả các điểm cuối (REST Endpoints), dữ liệu gửi đi (Request Payloads), dữ liệu phản hồi (Response Payloads), mã trạng thái HTTP và quy ước xử lý lỗi của máy chủ FastAPI `server.py`.

---

## 📋 Danh Mục Các Điểm Cuối (API Endpoints Overview)

| Phương thức | Đường dẫn API | Mô tả chức năng |
| :--- | :--- | :--- |
| `POST` | `/api/upload` | Tải ảnh lên bộ nhớ RAM, tự động nhận diện 4 góc và sinh tên gợi ý. |
| `POST` | `/api/process` | Nắn góc, làm phẳng (dewarp), cân bằng sáng và áp dụng bộ lọc màu. |
| `POST` | `/api/auto-detect` | Nhận diện lại 4 góc mép giấy với tỉ lệ mở rộng viền tùy chọn. |
| `POST` | `/api/save-to-disk` | Lưu ảnh đã xử lý, ảnh gốc `_goc/` và file PDF vào thư mục máy tính. |
| `POST` | `/api/save-metadata` | Lưu tọa độ, góc xoay, bộ lọc và lịch sử Undo/Redo vào `.docscan_meta.json`. |
| `POST` | `/api/scan-directory` | Quét cây thư mục đĩa cứng và nạp toàn bộ ảnh cùng metadata. |
| `POST` | `/api/create-folder` | Tạo thư mục vật lý tức thì trên ổ đĩa (`os.makedirs`). |
| `POST` | `/api/rename-folder` | Đổi tên thư mục vật lý trên ổ đĩa (`os.rename`). |
| `POST` | `/api/delete-folder` | Xóa thư mục vật lý và các nhánh con trên ổ đĩa (`shutil.rmtree`). |
| `POST` | `/api/apply-as-original` | Thay thế ảnh gốc `_goc/` bằng ảnh đã chỉnh sửa hiện tại. |
| `POST` | `/api/adopt-as-original` | Tạo bản sao lưu ảnh gốc vào `_goc/` cho ảnh lẻ có sẵn trong thư mục. |
| `POST` | `/api/delete-disk-file` | Xóa tệp ảnh đơn lẻ khỏi ổ đĩa máy tính. |
| `POST` | `/api/move-to-unapproved` | Chuyển file ảnh vào thư mục `Kho_Chua_Duyet` (tự tạo nếu chưa có). |
| `POST` | `/api/export-pdf` | Ghép nhiều ảnh thành tệp PDF chuẩn in ấn và tải về trình duyệt. |
| `POST` | `/api/download-single` | Tải về 1 trang ảnh đã xử lý ở định dạng JPG, PNG hoặc WebP. |
| `POST` | `/api/ai-suggest-name` | Gọi Gemini AI nhận diện văn bản OCR để gợi ý tên tài liệu chuẩn. |

---

## 🛠️ Chi Tiết Các Điểm Cuối Nổi Bật

### 1. `POST /api/save-to-disk`
- **Request Body:**
```json
{
  "root_path": "C:\\DocScan_Projects",
  "relative_path": "Hop_Dong_2026",
  "items": [
    {
      "image_id": "uuid-string",
      "filename": "Trang_01.jpg",
      "doc_name": "Hop_Dong_Trang_01",
      "corners": [[0,0], [1000,0], [1000,1500], [0,1500]],
      "rotation": 0,
      "settings": { "mode": "natural", "sharpness": 0.6 },
      "history": { "undo": [], "redo": [] }
    }
  ],
  "save_original": true,
  "save_edited": true,
  "save_pdf": true,
  "pdf_name": "Hop_Dong_2026",
  "quality": 85,
  "normalize_res": true
}
```
- **Response (200 OK):**
```json
{
  "success": true,
  "target_dir": "C:\\DocScan_Projects\\Hop_Dong_2026",
  "count": 2,
  "pdf_saved": true
}
```

---

### 2. `POST /api/adopt-as-original`
- **Mục đích:** Hợp thức hóa ảnh lẻ thành cặp ảnh có bản gốc `_goc/`.
- **Request Body:**
```json
{
  "root_path": "C:\\DocScan_Projects",
  "relative_path": "Hop_Dong_2026",
  "filename": "anh_chup.jpg",
  "image_id": "uuid-string"
}
```
- **Response (200 OK):**
```json
{
  "success": true,
  "filename": "anh_chup.jpg",
  "goc_path": "C:\\DocScan_Projects\\Hop_Dong_2026\\_goc\\anh_chup_goc.jpg",
  "has_raw_original": true
}
```

---

### 3. `POST /api/move-to-unapproved`
- **Mục đích:** Chuyển file ảnh vào kho chứa ảnh chưa duyệt tự do.
- **Request Body:**
```json
{
  "root_path": "C:\\DocScan_Projects",
  "relative_path": "Hop_Dong_2026",
  "filename": "anh_chup.jpg",
  "image_id": "uuid-string",
  "unapproved_folder_name": "Kho_Chua_Duyet"
}
```
- **Response (200 OK):**
```json
{
  "success": true,
  "folder_id": "folder_Kho_Chua_Duyet",
  "folder_name": "Kho ảnh chưa duyệt",
  "relative_path": "Kho_Chua_Duyet",
  "filename": "anh_chup.jpg"
}
```

---

### 4. `POST /api/process`
- **Request Body:**
```json
{
  "image_id": "uuid-string",
  "corners": [[45.0, 38.0], [1820.0, 42.0], [1810.0, 2450.0], [50.0, 2440.0]],
  "rotation": 0,
  "settings": {
    "mode": "natural",
    "shadow_reduction": 0.6,
    "sharpness": 0.6,
    "contrast": 0.2,
    "brightness": 0.0,
    "margin_percent": 0.02,
    "dewarp_enabled": false,
    "dewarp_strength": 0.8,
    "quality": 85,
    "normalize_res": true
  }
}
```
- **Response (200 OK):**
```json
{
  "success": true,
  "processed_url": "data:image/jpeg;base64,...",
  "width": 1780,
  "height": 2410,
  "out_dim": "1780 x 2410 px",
  "out_size_human": "1.2 MB",
  "saving_ratio": "-45%"
}
```
