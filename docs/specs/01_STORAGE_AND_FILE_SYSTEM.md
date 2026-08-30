# 📁 01. Đặc Tả Lưu Trữ & Hệ Thống Tệp Tin (Storage & File System Spec)

## 🎯 Mục Đích
Tài liệu này đặc tả toàn diện cách thức tổ chức dữ liệu trên đĩa cứng vật lý (Disk Storage) và trong bộ nhớ RAM (In-Memory Store), đảm bảo bảo toàn dữ liệu, chống mất mát và đồng bộ trạng thái chỉnh sửa xuyên suốt các phiên làm việc.

---

## 1. Cấu Trúc Thư Mục Trên Đĩa Cứng (Physical Disk Layout)

Mỗi khi người dùng chọn một Thư mục Gốc (Root Directory), cây thư mục trên máy tính được ánh xạ 1:1 như sau:

```
[Root_Folder_Path]/
├── Hop_Dong_2026/                       # Thư mục chứa tài liệu theo nhóm
│   ├── _goc/                            # [BẮT BUỘC] Thư mục chứa ảnh chụp gốc nguyên bản
│   │   ├── Trang_01_goc.jpg
│   │   └── Trang_02_goc.jpg
│   ├── .docscan_meta.json               # [ẨN] Tệp JSON lưu tọa độ, góc xoay, bộ lọc & Undo stack
│   ├── Trang_01.jpg                     # Ảnh đã xử lý cắt góc, làm nét, làm phẳng
│   ├── Trang_02.jpg                     # Ảnh đã xử lý
│   └── Hop_Dong_2026.pdf                # File PDF tổng hợp các trang trong thư mục
│
├── Kho_Chua_Duyet/                      # [KHO CHỨA TỰ DO] Thư mục chứa ảnh thô chưa phân loại
│   ├── anh_chup_ngoai_01.jpg            # Lưu độc lập, không cần thư mục _goc/
│   └── anh_chup_ngoai_02.png
│
└── .docscan_meta.json                   # Metadata cho các ảnh nằm ngay tại Root (nếu có)
```

---

## 2. Thư Mục Bản Gốc `_goc/` & Tính Năng Thay Thế Bản Gốc

1. **Nguyên tắc bất biến:**
   - Khi lưu ảnh đã xử lý vào đĩa (`/api/save-to-disk`), ứng dụng luôn lưu file ảnh chụp ban đầu vào thư mục con `_goc/[Tên-Trang]_goc.jpg` với chất lượng JPEG 95%.
   - Nhờ vậy, người dùng có thể quay lại ảnh gốc bất kỳ lúc nào bằng nút **`↶ Về ảnh gốc`**.
2. **Tính năng "Lưu làm ảnh gốc mới" (`/api/apply-as-original`):**
   - Khi người dùng đã căn chỉnh và hài lòng với bản sửa, bấm **`Lưu làm ảnh gốc mới`**.
   - Backend sẽ ghi đè ảnh đã xử lý vào `_goc/[Tên-Trang]_goc.jpg`, cập nhật `IMAGE_STORE[image_id]["original"]` và reset 4 góc về viền ngoài cùng.
   - Xóa sạch lịch sử Undo/Redo cũ vì đây đã trở thành mốc gốc mới.

---

## 3. Cấu Trúc Tệp Siêu Dữ Liệu `.docscan_meta.json`

Tệp `.docscan_meta.json` nằm tại mỗi thư mục để lưu trữ trạng thái chỉnh sửa chi tiết:

```json
{
  "updated_at": "2026-08-30T23:15:00.000Z",
  "pages": {
    "Trang_01.jpg": {
      "doc_name": "Trang_01",
      "corners": [
        [45.2, 38.1],
        [1820.5, 42.0],
        [1810.0, 2450.8],
        [50.1, 2440.2]
      ],
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
      },
      "history": {
        "undo": [
          {
            "corners": [[0,0],[1920,0],[1920,2500],[0,2500]],
            "rotation": 0,
            "settings": { "mode": "natural", "shadow_reduction": 0.6, "sharpness": 0.6, "contrast": 0.2, "brightness": 0, "margin_percent": 0.02, "dewarp_enabled": false, "dewarp_strength": 0.8 },
            "description": "Tự động nhận diện 4 góc"
          }
        ],
        "redo": []
      }
    }
  }
}
```

---

## 4. Xử Lý Ảnh Lẻ Chưa Có Bản Gốc (Orphan Images)

Khi quét thư mục mở lên (`/api/scan-directory`), nếu phát hiện file ảnh trong thư mục nhưng **không tồn tại file tương ứng trong `_goc/`**:
- Gán cờ `has_raw_original: false`.
- Khi người dùng click chọn ảnh đó (và thư mục hiện tại không phải `Kho_Chua_Duyet`), giao diện hiển thị Hộp thoại 4 lựa chọn:

| Lựa chọn | Hành động kỹ thuật |
| :--- | :--- |
| **`Sửa ảnh & Tạo bản gốc (Yes)`** | Gọi `POST /api/adopt-as-original` -> Tạo bản sao vào `_goc/[Tên]_goc.jpg`, chuyển `has_raw_original = true` và mở stage chỉnh sửa. |
| **`📥 Chuyển vào Kho chưa duyệt`** | Gọi `POST /api/move-to-unapproved` -> Tạo thư mục `Kho_Chua_Duyet` (nếu chưa có), di chuyển file vật lý vào đó. Không cần tạo cặp `_goc/`. |
| **`Xóa (Delete)`** | Gọi `POST /api/delete-disk-file` -> Xóa file ảnh vật lý khỏi ổ đĩa và gỡ khỏi danh sách UI. |
| **`Bỏ qua (Cancel)`** | Đóng hộp thoại, giữ nguyên tệp tin. |

---

## 5. Cơ Chế Tự Động Lưu Sau 1 Phút (Auto-Save 60s)

1. **Trigger:** Bất kỳ thao tác chỉnh sửa nào (kéo góc trên canvas, xoay ảnh, kéo thanh trượt bộ lọc, gõ đổi tên tài liệu, bấm undo/redo).
2. **Timer:** Kích hoạt `scheduleAutoSave(60000)` (hủy timer cũ nếu có).
3. **Execution:** Sau 60 giây không có thao tác mới, frontend gọi `saveFolderToDiskById(activeFolderId, quiet = true)`:
   - Gửi yêu cầu lưu ngầm toàn bộ ảnh đã xử lý + PDF + metadata vào đĩa cứng.
   - Không hiển thị loading overlay chặn màn hình.
   - Cập nhật dòng trạng thái êm ái: `💾 Đã tự động lưu vào máy tính lúc hh:mm:ss`.

---

## 6. Thao Tác Thư Mục Tức Thì (Instant Physical Folder Operations)

- **Tạo thư mục con (`/api/create-folder`):** Gọi `os.makedirs` lập tức khi user nhấn xác nhận tạo trong modal hoặc inline move dialog.
- **Đổi tên thư mục (`/api/rename-folder`):** Gọi `os.rename` trực tiếp trên ổ cứng.
- **Xóa thư mục (`/api/delete-folder`):** Gọi `shutil.rmtree` xóa sạch thư mục và các nhánh con trên đĩa cứng.
