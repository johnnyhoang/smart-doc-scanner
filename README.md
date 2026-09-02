# DocScan Studio - Ứng dụng Quét & Tinh Chỉnh Tài Liệu Chuyên Nghiệp

Ứng dụng xử lý ảnh chụp tài liệu thông minh thay thế hoàn hảo cho **CamScanner, Adobe Scan, vFlat Scan và Microsoft Lens**.

> 📖 **Dành cho Lập trình viên & AI Assistant:**  
> Xem toàn bộ bộ tài liệu đặc tả kiến trúc, thuật toán và API tại: [**docs/specs/CORE_SPECS.md**](file:///d:/Hoa%20Hoang/Apps/refine_docs/docs/specs/CORE_SPECS.md).

---

## 🧩 Cách Ứng Dụng Tổ Chức Dữ Liệu

Mỗi trang tài liệu là **một đối tượng trọn vẹn** gồm đúng 3 phần trên ổ cứng của bạn:

```
Thư mục của bạn/
├── _goc/Hợp Đồng Thuê Nhà_goc.jpg   📷 Ảnh gốc — không bao giờ bị ghi đè ngầm
├── Hợp Đồng Thuê Nhà.jpg            ✨ Ảnh đã chỉnh sửa
├── .docscan_meta.json               ⚙️ Tình trạng: 4 góc, bộ lọc, lịch sử hoàn tác
└── Thư mục của bạn.pdf              📑 PDF tổng hợp theo đúng thứ tự bạn sắp xếp
```

- Bắt đầu từ **bất kỳ thư mục nào** trên máy cũng cho kết quả như nhau: ảnh vừa thêm được lưu
  đủ bộ ba ngay lập tức, tắt app đột ngột không mất dữ liệu.
- **Đổi tên tài liệu là đổi cả 3 phần cùng lúc** — không bao giờ để lại tệp thừa hay trang nhân bản.
- Tên tệp **giữ nguyên dấu tiếng Việt**, đúng như bạn gõ trên giao diện.

---

## 🌟 Các Tính Năng Nổi Bật

1. **Căn chỉnh góc nghiêng & Cắt viền thông minh (Perspective Transform)**:
   - Tự động nhận diện 4 góc mép giấy bằng thuật toán nhận diện biên đa tầng (Multi-pass Edge Detection).
   - Kéo thả trực tiếp 4 góc trên Canvas với **Kính lúp phóng to 2.5x** định vị từng pixel.
   - **Tự động mở rộng viền ngoài 2%** chống lẹm vào chữ gần mép giấy.
   - Xoay ảnh 90°, 180°, 270°.

2. **Làm phẳng trang cong & nhăn (Dewarping)**:
   - Khắc phục độ cong của trang sách mở, tài liệu gấp nếp, giấy nhăn, có thể tùy chỉnh mức độ.

3. **Làm rõ chữ, giữ nguyên màu gốc (Smart Text Clarifier)**:
   - Cân bằng độ sáng cục bộ trong không gian màu LAB, triệt tiêu bóng tay và bóng đèn.
   - Làm sắc nét chữ bằng Unsharp Masking **không làm phai màu con dấu đỏ hay chữ ký xanh**.
   - **10 chế độ màu**: Tự nhiên · Ma thuật · Nền sạch · Rõ nét chữ mờ · Trắng đen · Làm nổi dấu &
     chữ ký · Tẩy ố giấy cũ · Khử thấu quang mặt sau · Hóa đơn nhiệt · Ảnh gốc cắt phẳng.

4. **Xem trước tức thì & so sánh trung thực**:
   - Ảnh xem trước được dựng ở độ phân giải rút gọn, mỗi lần chỉ **~0,1 – 0,3 giây**, không chặn màn hình.
   - Thanh trượt so sánh đặt **cùng một khung cắt** trước và sau khi làm nét, khớp đúng từng dòng chữ.

5. **Lưu an toàn, luôn biết trạng thái**:
   - Tự động lưu sau 60 giây, nút **`💾 Lưu vào máy`** (hoặc `Ctrl + S`) lưu toàn bộ dự án trong 1 chạm.
   - Thanh trạng thái luôn hiển thị `Đã lưu` hoặc `N trang chưa lưu`.
   - Hoàn tác 30 bước mỗi trang, **lưu bền vững** — tắt app mở lại vẫn `Ctrl + Z` được.

6. **Nén thông minh & Xuất PDF chuẩn in**:
   - Chuẩn hóa kích thước in A4 300 DPI, giảm 60–85% dung lượng với ảnh chụp 4K.
   - Xuất PDF theo từng thư mục hoặc toàn bộ dự án; tải từng trang dạng JPG / PNG / WebP.

7. **Chạy offline 100%** bằng OpenCV & NumPy. Gợi ý tên bằng OCR là tùy chọn, chỉ chạy khi bạn bấm.

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
