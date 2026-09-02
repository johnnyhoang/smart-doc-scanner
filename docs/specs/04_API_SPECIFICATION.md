# 🔌 04. Đặc Tả Giao Tiếp API Backend (API Specification Spec)

## 🎯 Mục Đích
Đặc tả toàn bộ điểm cuối REST của `server.py`, dữ liệu gửi/nhận và quy ước xử lý lỗi.

---

## 📐 Quy Ước Chung

### Định danh trang
Mọi endpoint thao tác trên trang đều nhận cặp **`relative_path` + `filename`** — chính là danh tính
của đối tượng tài liệu trên đĩa. Không còn `image_id` tạm thời kiểu UUID như phiên bản cũ.

Trường `id` trong dữ liệu trả về là mã tất định sinh từ `(đường dẫn, tên tệp)`, chỉ dùng để giao diện
đánh dấu phần tử; nó **ổn định giữa các lần quét lại**.

### Thư mục dự án
`POST /api/scan-directory` ghi nhớ thư mục dự án cho phiên làm việc. Các endpoint sau đó không cần
gửi lại đường dẫn tuyệt đối (có thể ghi đè bằng `root_path` khi cần).
Mọi đường dẫn đều được kiểm tra **không được thoát ra ngoài thư mục dự án**.

### Xử lý lỗi
Lỗi trả về `HTTPException` với `detail` là **câu tiếng Việt dễ hiểu, không lộ chi tiết kỹ thuật**.
Chi tiết kỹ thuật chỉ ghi ra console máy chủ.

```json
{ "detail": "Không đổi được tên tệp. Có thể tệp đang mở ở ứng dụng khác." }
```

| Mã | Ý nghĩa |
| :--- | :--- |
| `400` | Dữ liệu vào không hợp lệ / chưa chọn thư mục dự án |
| `404` | Không tìm thấy tệp hoặc thư mục |
| `500` | Lỗi ghi đĩa, quyền truy cập, tệp đang bị khóa |

### Bản ghi trang (Page Payload)
Dạng dữ liệu chuẩn mà các endpoint trả về cho một trang:

```json
{
  "id": "a1b2c3d4e5f607182930",
  "filename": "Hợp Đồng Thuê Nhà.jpg",
  "folderId": "folder_Hop_Dong_2026",
  "relativePath": "Hop_Dong_2026",
  "doc_name": "Hợp Đồng Thuê Nhà",
  "width": 1600, "height": 1200,
  "megapixels": "1.9 MP",
  "file_size": 205100,
  "file_size_human": "200.3 KB",
  "corners": [[45,38],[1820,42],[1810,2450],[50,2440]],
  "rotation": 0,
  "settings": { "mode": "natural", "sharpness": 0.6, "...": "..." },
  "history": { "undo": [], "redo": [] },
  "has_raw_original": true,
  "version": 1756612800
}
```

`version` là thời điểm sửa tệp, dùng làm tham số phá bộ đệm ảnh của trình duyệt.

---

## 📋 Danh Mục Điểm Cuối

### Dự án & thư mục

| Phương thức | Đường dẫn | Chức năng |
| :--- | :--- | :--- |
| `POST` | `/api/pick-directory` | Mở hộp thoại chọn thư mục của hệ điều hành. |
| `POST` | `/api/scan-directory` | Quét cây thư mục, tự động gộp kho chưa duyệt trùng, trả dữ liệu **nhẹ** (không kèm điểm ảnh). |
| `POST` | `/api/open-folder` | Mở thư mục trong File Explorer. |
| `POST` | `/api/create-folder` | Tạo thư mục thật trên ổ đĩa. |
| `POST` | `/api/rename-folder` | Đổi tên thư mục thật. |
| `POST` | `/api/delete-folder` | Xóa thư mục và toàn bộ nhánh con. |

### Ảnh & xử lý

| Phương thức | Đường dẫn | Chức năng |
| :--- | :--- | :--- |
| `GET` | `/api/image` | Trả tệp ảnh (`kind` = `original` / `edited` / `thumb` / `thumb_original`). |
| `POST` | `/api/import` | Nhập ảnh mới, **ghi ngay đủ bộ ba** xuống đĩa. |
| `POST` | `/api/process` | Dựng ảnh **xem trước** rút gọn (1600px), trả thẳng byte JPEG. |
| `POST` | `/api/auto-detect` | Nhận diện lại 4 góc mép giấy (`margin_percent = 0.0` chuẩn xác). |

### Lưu trữ

| Phương thức | Đường dẫn | Chức năng |
| :--- | :--- | :--- |
| `POST` | `/api/commit-page` | Kết xuất đầy đủ 1 trang và ghi đè ảnh đang sửa. |
| `POST` | `/api/save-folder` | Lưu 1 thư mục: ảnh + metadata + PDF. |
| `POST` | `/api/save-project` | Lưu toàn bộ mọi nhánh thư mục có thay đổi chưa lưu. |
| `POST` | `/api/save-metadata` | Lưu nhanh tình trạng & thứ tự trang (không dựng lại ảnh). |

### Vòng đời trang

| Phương thức | Đường dẫn | Chức năng |
| :--- | :--- | :--- |
| `POST` | `/api/rename-page` | Đổi tên **cả ảnh gốc + ảnh sửa + metadata + vị trí thứ tự**. |
| `POST` | `/api/move-page` | Chuyển trang sang thư mục khác, mang theo cả bộ ba. |
| `POST` | `/api/move-to-unapproved` | Chuyển vào `Kho_Chua_Duyet`. |
| `POST` | `/api/apply-as-original` | Lưu ảnh sửa thành ảnh gốc mới (`_goc/`). |
| `POST` | `/api/adopt-as-original` | Tạo bản gốc cho ảnh lẻ chưa có `_goc/`. |
| `POST` | `/api/delete-page` | Xóa vĩnh viễn cả bộ ba. |

### Xuất bản

| Phương thức | Đường dẫn | Chức năng |
| :--- | :--- | :--- |
| `POST` | `/api/export-pdf` | Xuất PDF của một thư mục (hoặc danh sách trang được chọn). |
| `POST` | `/api/export-images-zip` | Đóng gói và tải danh sách ảnh đã chọn dạng ZIP. |
| `POST` | `/api/export-project-pdf` | Xuất PDF gộp toàn bộ dự án. |
| `GET` | `/api/download-single` | Tải một trang dạng JPG / PNG / WebP. |
| `POST` | `/api/ai-suggest-name` | Gợi ý tên tài liệu bằng OCR/AI — **chỉ chạy khi người dùng bấm**. |

---

## 🛠️ Chi Tiết Các Điểm Cuối Nổi Bật

### 1. `POST /api/scan-directory`

```json
{ "path": "D:\\Tài Liệu Scan" }
```

**Phản hồi 200:**
```json
{
  "success": true,
  "root_path": "D:\\Tài Liệu Scan",
  "root_name": "Tài Liệu Scan",
  "folders": [
    { "id": "folder_root", "name": "Tài Liệu Scan", "parentId": null,
      "relativePath": "", "imageIds": [], "isUnapproved": false }
  ],
  "pages": [ "<bản ghi trang>" ],
  "total_folders": 3,
  "total_images": 42
}
```

---

### 2. `GET /api/image`

| Tham số | Bắt buộc | Ý nghĩa |
| :--- | :--- | :--- |
| `file` | ✅ | Tên tệp của trang |
| `rel` | | Đường dẫn thư mục tương đối |
| `kind` | | `edited` (mặc định) / `original` / `thumb` / `thumb_original` |
| `v` | | Số hiệu phiên bản để phá bộ đệm trình duyệt |

---

### 3. `POST /api/process` — Xem trước nhanh

```json
{
  "relative_path": "Hop_Dong_2026",
  "filename": "Hợp Đồng Thuê Nhà.jpg",
  "corners": [[45,38],[1820,42],[1810,2450],[50,2440]],
  "rotation": 0,
  "settings": { "mode": "natural", "sharpness": 0.6, "...": "..." }
}
```

**Phản hồi 200:** thân là **byte JPEG thô** (không phải base64), kèm header:
- `X-Out-Width` / `X-Out-Height`: Kích thước ước tính của bản kết xuất đầy đủ.
- `X-Preview-Width` / `X-Preview-Height`: Kích thước thật của ảnh xem trước.

---

### 4. `POST /api/export-images-zip` — Tải ZIP ảnh theo danh sách chọn

```json
{
  "relative_path": "Hop_Dong_2026",
  "filenames": ["Trang_1.jpg", "Trang_2.jpg"],
  "zip_name": "Hop_Dong_2026_2_anh"
}
```

**Phản hồi 200:** byte tệp `.zip` đính kèm header tải về (`Content-Disposition: attachment`).

---

### 5. `POST /api/export-pdf` — Xuất PDF theo danh sách chọn

```json
{
  "relative_path": "Hop_Dong_2026",
  "filenames": ["Trang_1.jpg", "Trang_2.jpg"],
  "doc_name": "Hop_Dong_2026_2_trang"
}
```

**Phản hồi 200:** byte tệp `.pdf` đính kèm header tải về.

---

### 6. `POST /api/apply-as-original` — Lưu ảnh sửa thành ảnh gốc

```json
{ "relative_path": "Hop_Dong_2026", "filename": "Hợp Đồng Thuê Nhà.jpg" }
```

Ghi đè `_goc/`, đặt lại 4 góc về trọn khung, xóa lịch sử hoàn tác (mốc gốc mới), dựng lại ảnh đang sửa, trả về bản ghi trang mới.