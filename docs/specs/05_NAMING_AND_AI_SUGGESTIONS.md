# 🏷️ 05. Đặc Tả Đặt Tên Tài Liệu & Gợi Ý AI On-Demand (Naming & AI Suggestions Spec)

## 🎯 Mục Đích
Tài liệu này đặc tả quy tắc sinh tên tệp tài liệu thông minh theo chuẩn lưu trữ lưu trữ điện tử, cùng với chính sách tích hợp mô hình ngôn ngữ lớn (Gemini Vision AI) tối ưu chi phí và bảo toàn quyền riêng tư.

---

## 🛑 1. Chính Sách Tiết Kiệm Token & Tôn Trọng Người Dùng (Token Conservation Policy)

> **NGUYÊN TẮC BẮT BUỘC:**
> Tuyệt đối **KHÔNG BAO GIỜ** tự động gửi ảnh lên Cloud AI trong mọi thao tác quét/tải ảnh để tránh tiêu tốn chi phí token của người dùng.
> 
> AI chỉ được phép kích hoạt **KHI VÀ CHỈ KHI** người dùng chủ động nhấn nút **`[ 🤖 Gợi ý tên bằng AI ]`**.

- **Banner gợi ý:** Khi mở một trang chưa được AI phân tích, app hiển thị một thanh banner nhẹ nhàng:
  - Nút **`[ 🤖 Phân tích tên AI ]`**: Gửi ảnh lên backend gọi Gemini Vision.
  - Nút **`[ ✕ Bỏ qua ]`**: Đóng banner và không nhắc lại đối với trang đó (`page.aiDismissed = true`).

---

## ⚡ 2. Thuật Toán Đặt Tên Cục Bộ Cơ Bản (Rule-Based Namer - `core/namer.py`)

Khi không sử dụng AI (chạy Offline 100%), hệ thống tự động sinh tên chuẩn hóa:

1. **Quy tắc làm sạch Slug (`clean_slug_title`):**
   - Loại bỏ các ký tự đặc biệt nguy hiểm trên hệ điều hành (`\ / : * ? " < > |`).
   - Thay thế khoảng trắng và dấu gạch dưới liên tiếp thành dấu gạch ngang đơn `-`.
   - Giữ nguyên dấu tiếng Việt hoặc chuyển không dấu tùy cấu hình.
2. **Quy tắc sinh tên theo ngữ cảnh:**
   - Nếu có tên file gốc: `Hop_Dong_Thue_Nha.jpg` -> `Hop-Dong-Thue-Nha`.
   - Nếu ảnh chụp mới: `Tai-Lieu-[YYYY-MM-DD]-[Index]`.
   - Tự động sinh danh sách 3 gợi ý phụ trong dropdown:
     - `Hop-Dong-Thue-Nha-Trang-1`
     - `Hop-Dong-Thue-Nha-Scan`
     - `Hop-Dong-Thue-Nha-2026`

---

## 🧠 3. Tích Hợp Gemini Vision AI Naming (`core/namer.py`)

1. **Cấu hình API Key:**
   - Đọc từ biến môi trường `GEMINI_API_KEY` hoặc cấu hình nội bộ.
2. **Prompt định hướng chuyên dụng:**
   - Trích xuất tiêu đề chính của tài liệu (ví dụ: *Hóa đơn giá trị gia tăng, Căn cước công dân, Hợp đồng kinh tế, Đơn xin nghỉ phép...*).
   - Trả về JSON chứa:
     - `primary_name`: Tên ngắn gọn chuẩn slug (dưới 40 ký tự).
     - `suggestions`: Mảng 3 gợi ý tên biến thể.
3. **Cơ chế Fallback thông minh:**
   - Nếu mất mạng Internet hoặc API Key chưa được cấu hình: Hệ thống tự động trả về tên cơ bản mà không gây lỗi ứng dụng (Graceful Degradation).
