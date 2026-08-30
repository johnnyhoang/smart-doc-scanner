# 📖 DocScan Studio - Core Specifications

> 📌 **Tài liệu đặc tả trung tâm chính thức được lưu trữ tại:**  
> 👉 [**docs/specs/CORE_SPECS.md**](file:///d:/Hoa%20Hoang/Apps/refine_docs/docs/specs/CORE_SPECS.md)

---

## 🗺️ Bản Đồ Bộ Đặc Tả Chi Tiết (Full Specs Suite)

Mọi AI Assistant và kỹ sư phát triển khi làm việc trên codebase này **BẮT BUỘC** phải đọc và tuân thủ các tài liệu đặc tả dưới đây:

1. [**Core Specs (Đặc tả trung tâm)**](file:///d:/Hoa%20Hoang/Apps/refine_docs/docs/specs/CORE_SPECS.md)
2. [**01. Lưu Trữ & Hệ Thống Tệp Tin (Storage & File System Spec)**](file:///d:/Hoa%20Hoang/Apps/refine_docs/docs/specs/01_STORAGE_AND_FILE_SYSTEM.md)
3. [**02. Pipeline Xử Lý Ảnh Thuật Toán (Image Processing Pipeline Spec)**](file:///d:/Hoa%20Hoang/Apps/refine_docs/docs/specs/02_IMAGE_PROCESSING_PIPELINE.md)
4. [**03. Giao Diện & Trải Nghiệm Người Dùng (UI/UX & Interaction Spec)**](file:///d:/Hoa%20Hoang/Apps/refine_docs/docs/specs/03_UI_UX_AND_INTERACTION.md)
5. [**04. Đặc Tả Giao Tiếp API Backend (API Specification Spec)**](file:///d:/Hoa%20Hoang/Apps/refine_docs/docs/specs/04_API_SPECIFICATION.md)
6. [**05. Đặt Tên Tài Liệu & Gợi Ý AI On-Demand (Naming & AI Suggestions Spec)**](file:///d:/Hoa%20Hoang/Apps/refine_docs/docs/specs/05_NAMING_AND_AI_SUGGESTIONS.md)
7. [**06. Quy Chuẩn Đồng Bộ & Bảo Trì Code - Specs (Developer & AI Guidelines)**](file:///d:/Hoa%20Hoang/Apps/refine_docs/docs/specs/06_DEVELOPER_AND_AI_SYNC_GUIDELINES.md)

---

## 🛑 Nguyên Tắc Đồng Bộ Bắt Buộc (Synchronization Contract)
- **Mọi thay đổi trong code (`NEW`, `IMPROVE`, `CHANGE`)** đều phải được cập nhật lại tương ứng vào các file specs trên trong cùng phiên làm việc.
- **Không bao giờ hiển thị thông tin kỹ thuật nội bộ (UUIDs, DB IDs, raw errors)** lên giao diện người dùng (UI).
