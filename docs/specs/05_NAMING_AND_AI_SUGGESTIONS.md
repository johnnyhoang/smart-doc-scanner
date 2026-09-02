# 🏷️ 05. Đặc Tả Đặt Tên Tài Liệu & Gợi Ý AI On-Demand (Naming & AI Suggestions Spec)

## 🎯 Mục Đích
Tài liệu này đặc tả quy tắc sinh tên tệp tài liệu thông minh theo chuẩn lưu trữ điện tử, cùng với chính sách tích hợp mô hình ngôn ngữ lớn (Gemini Vision AI) tối ưu chi phí và bảo toàn quyền riêng tư.

---

## 🛑 1. Chính Sách Tiết Kiệm Token & Tôn Trọng Người Dùng (Token Conservation Policy)

> **NGUYÊN TẮC BẮT BUỘC:**
> Tuyệt đối **KHÔNG BAO GIỜ** tự động gửi ảnh lên Cloud AI trong mọi thao tác quét/tải ảnh để tránh tiêu tốn chi phí token của người dùng.
> 
> AI chỉ được phép kích hoạt **KHI VÀ CHỈ KHI** người dùng chủ động nhấn nút **`[ ✨ AI gợi ý tên ]`** ngay cạnh ô tên tài liệu.

- **Vị trí tập trung duy nhất:** Nút `[ ✨ AI gợi ý tên ]` nằm liền kề bên phải ô nhập tên tài liệu trên Header.
- **Trải nghiệm tương tác:**
  - Nhấp nút `[ ✨ AI gợi ý tên ]`: Gửi ảnh đang mở lên backend phân tích bằng Gemini Vision / OCR.
  - Tự động điền gợi ý phù hợp nhất vào ô tên tài liệu.
  - Đồng thời mở Menu Dropdown gợi ý hiển thị các tên thay thế khác và nút `[ ↻ Quét lại với AI ]`.

---

## ⚡ 2. Quy Tắc Đặt Tên Tệp (`core/pagestore.sanitize_component`)

> **NGUYÊN TẮC:** Tên người dùng nhìn thấy trên giao diện **chính là tên tệp trên ổ đĩa**.
> Không có "tên hiển thị" và "tên tệp" khác nhau.

1. **Giữ nguyên dấu tiếng Việt.** `Hợp Đồng Thuê Nhà` được lưu đúng như vậy trên đĩa.
   Chỉ các ký tự hệ điều hành cấm (`< > : " / \ | ? *`) mới bị thay bằng `_`; độ dài tối đa 120 ký tự.

2. **Đổi tên là đổi cả bộ ba.** Xem `01_STORAGE_AND_FILE_SYSTEM.md` §7.

3. **Chống trùng tên:** `unique_stem()` tự thêm hậu tố `_2`, `_3`… thay vì ghi đè trang khác.

4. **Tên khởi tạo khi nhập ảnh:** lấy từ tên tệp nguồn; nếu ảnh dán từ clipboard thì
   `get_basic_document_name()` sinh tên theo mẫu `Tai-Lieu-[YYYY-MM-DD]-[Index]`.

---

## 🧠 3. Tích Hợp Gemini Vision AI Naming (`core/namer.py`)

1. **Cấu hình API Key:**
   - Đọc từ biến môi trường `GEMINI_API_KEY` hoặc cấu hình nội bộ.
2. **Prompt định hướng chuyên dụng:**
   - Trích xuất tiêu đề chính của tài liệu (ví dụ: *Hóa đơn giá trị gia tăng, Căn cước công dân, Hợp đồng kinh tế, Đơn xin nghỉ phép...*).
   - Trả về JSON chứa:
     - `primary_name`: Tên ngắn gọn chuẩn có dấu hoặc không dấu tiếng Việt.
     - `suggestions`: Mảng các gợi ý tên biến thể.
3. **Cơ chế Fallback thông minh:**
   - Nếu mất mạng Internet hoặc API Key chưa được cấu hình: Hệ thống tự động trả về tên cơ bản mà không gây lỗi ứng dụng (Graceful Degradation).