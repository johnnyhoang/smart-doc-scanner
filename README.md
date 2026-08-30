# DocScan Studio - Ứng dụng Quét & Tinh Chỉnh Tài Liệu Chuyên Nghiệp

Ứng dụng xử lý ảnh chụp tài liệu thông minh thay thế hoàn hảo cho **CamScanner, Adobe Scan, vFlat Scan và Microsoft Lens**.

> 📖 **Dành cho Lập trình viên & AI Assistant:**  
> Xem toàn bộ bộ tài liệu đặc tả kiến trúc, thuật toán và API tại: [**docs/specs/CORE_SPECS.md**](file:///d:/Hoa%20Hoang/Apps/refine_docs/docs/specs/CORE_SPECS.md).

---

## 🌟 Các Tính Năng Nổi Bật

1. **Căn chỉnh góc nghiêng & Cắt viền thông minh (Perspective Transform)**:
   - Tự động nhận diện 4 góc mép giấy bằng thuật toán nhận diện biên đa tầng (Multi-pass Edge Detection).
   - Cho phép kéo thả trực tiếp 4 góc trên Canvas với **Kính lúp phóng to (Magnifier Lens 2.5x)** định vị từng pixel.
   - **Tự động mở rộng viền ngoài 2%** giúp chống lẹm méo vào phần chữ gần mép giấy.
   - Hỗ trợ xoay ảnh 90°, 180°, 270°.

2. **Làm phẳng trang cong & nhăn (Dewarping / Page Uncurling)**:
   - Khắc phục độ cong của trang sách mở, tài liệu gấp nếp, giấy nhăn.
   - Tùy chỉnh mức độ làm phẳng linh hoạt.

3. **Làm rõ chữ, giữ nguyên 100% màu sắc gốc (Smart Text Clarifier & Illumination Balancing)**:
   - Cân bằng độ sáng cục bộ (LAB space illumination normalization), triệt tiêu bóng tay chụp hoặc bóng đèn.
   - Làm sắc nét chữ bằng Unsharp Masking trên kênh sáng mà **không gây đổi màu chữ, màu tiêu đề, con dấu hay chữ ký**.
   - 5 Chế độ hiển thị:
     - 🍃 **Tự nhiên nâng cao (Mặc định)**: Giữ màu gốc, cân bằng sáng, viền chữ sắc nét.
     - 📄 **Nền sạch sáng**: Làm trắng tinh nền giấy, giữ màu sắc nét chữ & con dấu.
     - ✍️ **Rõ nét chữ mờ**: Tăng tương phản cho chữ nhạt, bút chì.
     - 🖨️ **Trắng đen rõ nét**: Đơn sắc chuẩn hóa in ấn văn phòng.
     - 🖼️ **Ảnh gốc cắt phẳng**: Chỉ nắn thẳng, không đổi màu.

4. **Nén thông minh & Xuất file tối ưu in ấn (Smart Compression & PDF Export)**:
   - Tự động chuẩn hóa kích thước in chuẩn A4 (300 DPI) giúp giảm 60-85% dung lượng đối với ảnh chụp 4K/siêu nặng.
   - Khử nhiễu và làm sắc nét cho ảnh chất lượng thấp.
   - Xuất trọn bộ tài liệu nhiều trang thành **file PDF chuẩn in** hoặc tải từng trang ảnh **JPG / PNG / WebP**.

---

## 🚀 Hướng Dẫn Khởi Chạy

### Cách 1: Khởi chạy nhanh bằng file Batch (Khuyên dùng trên Windows)
- Nhấp đúp vào file `run.bat`. Trình duyệt web sẽ tự động mở tại địa chỉ `http://127.0.0.1:8000`.

### Cách 2: Khởi chạy bằng dòng lệnh
```bash
python main.py
```
Hoặc:
```bash
python server.py
```
Truy cập: `http://127.0.0.1:8000`
