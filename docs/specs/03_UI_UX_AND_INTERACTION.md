# 🎨 03. Đặc Tả Giao Diện & Trải Nghiệm Người Dùng (UI/UX & Interaction Spec)

## 🎯 Mục Đích
Đặc tả bố cục, cơ chế tương tác Canvas, và các nguyên tắc trải nghiệm giữ cho ứng dụng **đơn giản, dễ đoán, không gây rối** cho người dùng.

---

## 🧭 0. Bốn Nguyên Tắc Trải Nghiệm Bắt Buộc

1. **Mở là thấy ngay.** Mở một trang chỉ hiển thị tệp ảnh đã có sẵn trên đĩa — không xử lý lại, không chờ đợi. Việc xử lý chỉ chạy khi người dùng thực sự thay đổi điều gì đó.
2. **Không bao giờ chặn màn hình vì việc nhỏ.** Kéo thanh trượt, đổi bộ lọc → chỉ hiện một chỉ báo nhỏ `Đang dựng ảnh…` trên thanh trạng thái. Lớp phủ toàn màn hình **chỉ** dành cho thao tác dài và có chủ đích: mở dự án, lưu toàn bộ, xuất PDF.
3. **Luôn cho biết dữ liệu đã an toàn hay chưa.** Thanh trạng thái hiện `Đã lưu` (xanh) hoặc `N trang chưa lưu` (cam); thumbnail chưa lưu có chấm cam. Nút `[ 💾 Lưu thay đổi ]` chỉ sáng khi có trang chưa lưu (`dirtyPages > 0`).
4. **Không lộ thông tin kỹ thuật.** Không hiển thị UUID, mã lỗi tiếng Anh, stack trace. 100% sử dụng hộp thoại xác nhận tùy biến (Custom Modal) thay cho `confirm()` hệ thống. Chỉ hiện tên tệp rõ ràng, dung lượng thân thiện (`2.4 MB`), tỷ lệ tiết kiệm (`Tiết kiệm 35%`) và câu tiếng Việt dễ hiểu.

---

## 🖥️ 1. Bố Cục Giao Diện

```
+-----------------------------------------------------------------------------------------------+
| 🏷️ HEADER: Logo | [Tên tài liệu ✏️][✨ AI gợi ý tên] | Hoàn tác/Làm lại | 💾 Lưu thay đổi | 📄 Xuất PDF | 📥 Tải ảnh |
+-----------------------+-------------------------------------------------------+---------------+
| 📁 SIDEBAR TRÁI       | 🖼️ KHUNG XEM TRUNG TÂM (UNIFIED STAGE)               | 🎛️ BẢNG ĐIỀU  |
|                       |                                                       |     KHIỂN     |
| [Thư mục gốc máy]     | [✂️ Chỉnh sửa][◫ So sánh]   [🔍 -][+ ][Vừa khung][1:1] | (Tự vô hiệu   |
| [Cây thư mục]         | ----------------------------------------------------- |  khi chưa có  |
|  ├─ 📁 Hợp Đồng       |                                                       |  ảnh mở)      |
|  └─ 📥 Kho chưa duyệt |   CANVAS DUY NHẤT                                     | [Thông số]    |
|                       |   - 4 tay cầm góc + kính lúp 2.5x                     |  ├─ Tiết kiệm%|
| ====== SPLITTER ===== |                                                       | [Bộ lọc màu]  |
| [Danh sách Trang]     | ----------------------------------------------------- |  ├─ Tự nhiên  |
|  [🗹 Chọn all][Sắp xếp]| [↺ Về gốc][🔲 Trọn ảnh][⛶ Tự nhận góc][➕ Mở][➖ Thu] |  ├─ Ma thuật  |
|  [📄 Xuất(N)][📥 Tải] | [↶ Xoay trái][↷ Xoay phải]                           |  └─ …         |
|  ┌───┐ ┌───┐ ┌───┐    | ----------------------------------------------------- | [Thanh trượt] |
|  │☑1 │ │☐2●│ │☑3⚠│   | 📊 Trạng thái | ⏳Đang dựng | 💾Đã lưu | Tiết kiệm %   |  - Khử bóng   |
|  └───┘ └───┘ └───┘    |                                                       |  - Làm nét    |
+-----------------------+-------------------------------------------------------+---------------+
```

- `●` chấm cam = trang có thay đổi chưa lưu · `⚠` = trang chưa có ảnh gốc trong `_goc/`
- **Một thư mục gốc = một dự án.** Người dùng chỉ cần hiểu đúng một khái niệm: thư mục trên máy của họ.

---

## 🔍 2. Hai Chế Độ Làm Việc Rõ Ràng (Two Clear Operating Modes)

Đặt ở đầu khung xem, chuyển đổi 1-click rõ ràng, trực quan:

| Nút | Mục đích & Trải nghiệm |
| :--- | :--- |
| **`[ ✂️ Chỉnh sửa ]`** | **Mode Chỉnh sửa:** Toàn khung hiển thị ảnh chụp gốc kèm 4 tay cầm định vị mép giấy, kính lúp 2.5x và thanh công cụ nổi 7 nút. Dành cho người dùng nắn mép giấy và tinh chỉnh hình học. |
| **`[ ◫ So sánh ]`** (Mặc định) | **Mode So sánh:** Toàn khung hiển thị thanh trượt chia đôi Before / After với nút `◀ ▶`. Trái là ảnh chưa làm nét/ảnh gốc, phải là ảnh đã làm nét & cân bằng ánh sáng. Tự động ẩn 4 góc để người dùng soi chất lượng trang tài liệu sạch sẽ, trực quan. |

### 2.1. So sánh phải trung thực (quan trọng)
Hai nửa của thanh trượt dùng **cùng một khung cắt, cùng kích thước**:
- Nửa trái = ảnh gốc đã cắt phẳng nhưng **chưa áp bộ lọc** (dựng với `mode: original`).
- Nửa phải = bản đã áp đủ bộ lọc và làm nét.

### 2.2. Nhấn giữ thumbnail
Nhấn giữ chuột lên bất kỳ thumbnail nào ở danh sách trang → hiện ảnh gốc; thả ra → về bản đã sửa.

---

## 🎯 3. Thanh Công Cụ Nổi (Floating Toolbar) & Kính Lúp

Thanh công cụ nổi 7 nút được sắp xếp theo đúng luồng tư duy thao tác:
1. **`[ ↺ Về ảnh gốc ]`**: Đặt lại 4 góc và hướng xoay về bản chụp gốc; chỉ sáng khi trang đã có tùy chỉnh so với gốc.
2. **`[ 🔲 Trọn ảnh ]`**: Bao trọn 100% khung hình ảnh chụp.
3. **`[ ⛶ Tự nhận góc ]`**: Nhận diện chuẩn xác 100% mép giấy thật (`margin_percent = 0.0`).
4. **`[ ➕ Mở lề 2% ]`**: Nới rộng 4 góc ra ngoài 2% để bảo toàn nét chữ sát mép.
5. **`[ ➖ Thu lề 2% ]`**: Thu hẹp 4 góc vào trong 2% để gọt bỏ viền nền mặt bàn.
6. **`[ ↶ Xoay trái ]`** & **`[ ↷ Xoay phải ]`**: Xoay hướng ảnh 90°.

- **Kính lúp 2.5x:** vòng tròn 140px kèm tâm ngắm chữ thập, hiện khi kéo góc.
- **Thu phóng & Kéo ảnh mượt mà:**
  - `zoomAt(factor, x, y)` tự động neo tâm thu phóng theo vị trí trỏ chuột.
  - Phân biệt rõ **`[ 🔲 Vừa khung ]`** (vừa khít cửa sổ) và **`[ 🔍 1:1 ]`** (đúng kích thước điểm ảnh thực 100% của tệp).

---

## ⚡ 4. Phản Hồi Khi Chỉnh Sửa & Bảng Điều Khiển

| Thao tác | Phản hồi |
| :--- | :--- |
| Kéo thanh trượt bộ lọc | Chờ 160ms rồi dựng ảnh; yêu cầu cũ bị **hủy ngay** (`AbortController`) nên kéo liên tục không xếp hàng. |
| Đổi bộ lọc màu | Dựng lại ngay. |
| Kéo góc | Vẽ lại canvas tức thì; dựng ảnh sau khi thả chuột. |

- Ảnh xem trước được xử lý ở **cạnh dài tối đa 1600px** → mỗi lần khoảng **0,1 – 0,3 giây**. Độ phân giải đầy đủ chỉ dùng khi lưu đĩa và xuất PDF.
- **Bảng điều khiển Inspector bên phải:** Tự động vô hiệu hóa (`.control-panel.disabled`) khi chưa có ảnh nào được mở trong khung soạn thảo.
- **Tối ưu dung lượng:** Hiển thị tỷ lệ phần trăm tiết kiệm thực tế (`Tiết kiệm X%` hoặc `Tăng X%`) so với ảnh gốc trên cả thanh trạng thái và thẻ thông số.

---

## ⏪ 5. Hoàn Tác / Làm Lại & Trạng Thái Lưu

- **Độ sâu:** 30 bước cho mỗi trang, độc lập nhau.
- **Phím tắt:** `Ctrl + Z` hoàn tác · `Ctrl + Y` / `Ctrl + Shift + Z` làm lại · `Ctrl + S` lưu thay đổi.
- **Nút "Lưu thay đổi" trên Top Bar:** Chỉ sáng (Enable) khi `dirtyPages.size > 0`, tự động mờ khi tất cả đã lưu.
- **Hộp thoại xác nhận tùy biến (Custom Modal):** 100% không dùng `confirm()` của trình duyệt. Hỏi lưu trước khi chuyển trang/thư mục nếu có thay đổi chưa lưu.

---

## 🏷️ 6. Đặt Tên Tài Liệu & Gợi Ý AI On-Demand

- Ô nhập tên nằm giữa Header, kèm nút duy nhất **`[ ✨ AI gợi ý tên ]`**.
- Khi bấm, AI đọc nội dung tài liệu để tự động đặt tên chuẩn hóa, đồng thời mở danh sách gợi ý trong menu thả xuống để người dùng có thể nhấp chọn ngay hoặc quét lại.
- Tên tệp **giữ nguyên dấu tiếng Việt**; gõ tên và bấm Enter sẽ đổi tên đồng thời cả bộ ba.

---

## 🗹 7. Khu Vực Thumbnail & Xuất Bản

- Mọi thumbnail luôn có ô checkbox sẵn sàng; nhấp vào ảnh để mở xem/chỉnh sửa ngay.
- Nút **`[ 🗹 Chọn tất cả ]`** / **`[ ☐ Bỏ chọn ]`** trên toolbar danh sách trang.
- Hai nút **`[ 📄 Xuất PDF (N) ]`** và **`[ 📥 Tải ảnh (N) ]`** ở khu thumbnail **chỉ thao tác trên các trang được tích chọn**, và tự động vô hiệu hóa khi chưa có trang nào được chọn.
- Hai nút **`[ 📄 Xuất PDF ]`** và **`[ 📥 Tải ảnh ]`** trên Top Bar là thao tác trực tiếp 1-click cho **duy nhất trang hiện tại đang mở**.