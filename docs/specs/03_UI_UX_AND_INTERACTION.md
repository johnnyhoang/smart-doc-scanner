# 🎨 03. Đặc Tả Giao Diện & Trải Nghiệm Người Dùng (UI/UX & Interaction Spec)

## 🎯 Mục Đích
Tài liệu này đặc tả cấu trúc layout, cơ chế tương tác Canvas trực quan, trải nghiệm xem một cửa sổ chuẩn Apple (Unified Single Viewport), kính lúp phóng đại định vị pixel và luồng tương tác phím tắt.

---

## 🖥️ 1. Cấu Trúc Bố Cục Giao Diện (Layout Hierarchy)

```
+-----------------------------------------------------------------------------------------------+
| 🏷️ HEADER: Logo | Tên Dự Án (Dropdown) | [Chọn Thư Mục Root] [Mở Explorer] | [Xuất Toàn Bộ PDF] |
+-----------------------+-------------------------------------------------------+---------------+
| 📁 SIDEBAR TRÁI       | 🖼️ KHUNG XEM TRUNG TÂM (UNIFIED STAGE)               | 🎛️ BẢNG ĐIỀU  |
|                       |                                                       |     KHIỂN     |
| [Cây Thư Mục]         | ----------------------------------------------------- |               |
|  ├─ 📁 Thư mục 1      |  [✨ Đã chỉnh sửa] [📷 Ảnh gốc]  | [🔍 Nhấn giữ so sánh]| [Tên tài liệu]|
|  └─ 📥 Kho chưa duyệt | ----------------------------------------------------- | [AI Gợi ý tên]|
|                       |                                                       |               |
| ====== SPLITTER ===== |  CANVAS DUY NHẤT:                                     | [Bộ lọc màu]  |
| [Danh sách Trang Ảnh] |  - Hiển thị ảnh đã xử lý nét hoặc ảnh gốc             |  ├─ Tự nhiên  |
|  ┌───┐ ┌───┐ ┌───┐    |  - 4 Tay cầm góc (Handles) định vị mép giấy           |  ├─ Nền sạch  |
|  │ 1 │ │ 2 │ │ 3 │    |  - Kính lúp (Magnifier Lens 2.5x) khi kéo góc         |  └─ Trắng đen |
|  └───┘ └───┘ └───┘    |                                                       |               |
|                       | ----------------------------------------------------- | [Thanh trượt] |
|                       | 📊 STATUS BAR: Kích thước | Dung lượng | 💾 Đã tự lưu |  - Khử bóng   |
+-----------------------+-------------------------------------------------------+  - Làm nét    |
                                                                                |  - Làm phẳng  |
                                                                                +---------------+
```

---

## 🔍 2. Khung Xem Đơn Chuẩn Apple (Unified Stage & Hold-to-Compare)

1. **Một khung nhìn duy nhất (Single Viewport):**
   - Loại bỏ hoàn toàn mô hình 2 cửa sổ chia đôi gây rối mắt.
   - Luôn hiển thị ảnh trong một khung Canvas trung tâm duy nhất (`#cropCanvasWrapper`).
2. **Nút chuyển đổi Segmented Control:**
   - **`[ ✨ Đã chỉnh sửa ]`**: Hiển thị kết quả đã cắt góc, làm phẳng và làm nét.
   - **`[ 📷 Ảnh gốc ]`**: Hiển thị ảnh chụp ban đầu kèm 4 tay cầm định vị góc.
3. **Tính năng Nhấn Giữ Để So Sánh (Hold-to-Compare):**
   - **Bằng chuột:** Nhấn và giữ nút **`[ 👁️ Nhấn giữ xem ảnh gốc ]`** -> ảnh gốc hiện ra; thả chuột -> tự động chuyển lại ảnh đã chỉnh sửa.
   - **Bằng phím tắt:** Nhấn giữ **Phím Space (Cách)** hoặc **Phím `\`** -> tức thì chuyển sang ảnh gốc; thả phím -> lập tức quay lại ảnh đẹp.

---

## 🎯 3. Tương Tác Kéo 4 Góc & Kính Lúp Phóng Đại (Loupe Magnifier)

1. **Tay cầm 4 góc (Interactive Handles):**
   - 4 điểm chốt tròn màu xanh Cyan rực rỡ (`#38bdf8`) với viền trắng, dễ nhìn trên mọi nền ảnh.
   - Đường nối 4 góc hiển thị mượt mà định hình khung trang tài liệu.
2. **Kính lúp phóng to 2.5x (Magnifier Loupe):**
   - Khi người dùng nhấn chuột và kéo một trong 4 góc:
   - Kính lúp tròn đường kính 140px xuất hiện ngay phía trên ngón tay/con trỏ chuột.
   - Phóng to vùng ảnh bên dưới điểm kéo **2.5 lần** kèm tâm ngắm chữ thập màu đỏ (`crosshair`), cho phép đặt góc chính xác từng pixel mà không bị ngón tay hay chuột che khuất.
   - Khi thả chuột: Kính lúp tự động ẩn, hệ thống ghi nhận một bước Undo mới và kích hoạt auto-save sau 60s.

---

## ⏪ 4. Cơ Chế Hoàn Tác & Làm Lại (Undo / Redo State Machine)

- **Độ sâu lịch sử:** Lưu trữ tối đa **30 bước** cho mỗi trang tài liệu độc lập (`historyMap`).
- **Nội dung snapshot:** Tọa độ 4 góc, góc xoay (0/90/180/270), toàn bộ thông số bộ lọc (mode, shadow, sharpness, dewarp, margin).
- **Phím tắt hỗ trợ:**
  - `Ctrl + Z`: Hoàn tác (Undo).
  - `Ctrl + Y` hoặc `Ctrl + Shift + Z`: Làm lại (Redo).
- **Lưu trữ xuyên suốt (Persistence):** Ngăn xếp Undo/Redo được tự động lưu vào tệp `.docscan_meta.json` trên ổ đĩa. Khi khởi động lại máy, người dùng vẫn có thể bấm `Ctrl + Z` hoàn tác các bước trước đó.

---

## 📏 5. Khung Điều Chỉnh Kích Thước Linh Hoạt (Resizable Splitters)

- **Vertical Splitter:** Cho phép kéo chuột mở rộng / thu hẹp bề ngang Sidebar danh mục tài liệu.
- **Horizontal Splitter (Bên trong Sidebar):** Cho phép kéo thay đổi tỉ lệ chiều cao giữa Cây thư mục (phía trên) và Khung xem trước các trang ảnh Thumbnail (phía dưới).

---

## 🚫 6. Nguyên Tắc Trải Nghiệm Thân Thiện (Global Rule Compliance)

> **QUY TẮC BẮT BUỘC:**
> Tuyệt đối không bao giờ hiển thị thông tin kỹ thuật nội bộ (UUIDs, DB IDs như `prof-1783747340279-spcaecc`, raw stack traces, error codes tiếng Anh thô) trên bất kỳ phần tử UI nào.
> 
> Luôn hiển thị:
> - Tên file rõ ràng (`Hop_Dong_Trang_1.jpg`).
> - Dung lượng thân thiện (`2.4 MB`, `850 KB`).
> - Thông báo tiếng Việt rõ ràng, dễ hiểu và chuyên nghiệp.
