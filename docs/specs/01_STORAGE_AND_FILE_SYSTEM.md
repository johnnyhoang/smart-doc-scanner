# 📁 01. Đặc Tả Lưu Trữ & Hệ Thống Tệp Tin (Storage & File System Spec)

## 🎯 Mục Đích
Tài liệu này đặc tả cách tổ chức dữ liệu trên ổ cứng và trong bộ nhớ, đảm bảo mỗi trang tài liệu luôn là **một đối tượng trọn vẹn, nhất quán**, không bao giờ bị tách rời hay lệch trạng thái.

> **Module thực thi:** toàn bộ quy tắc trong tài liệu này được cài đặt tập trung tại `core/pagestore.py`.
> Không một đoạn code nào khác được phép tự ghép đường dẫn hay tự ghi tệp của một trang.

---

## 1. 🔒 BẤT BIẾN TRUNG TÂM: Đối Tượng Tài Liệu (Document Object)

Mỗi trang tài liệu được định danh bởi cặp **(thư mục, tên tệp)** và **BẮT BUỘC** gồm đủ 3 thành phần:

| Thành phần | Đường dẫn | Vai trò |
| :--- | :--- | :--- |
| 📷 **Ảnh gốc** | `<thư_mục>/_goc/<tên>_goc.jpg` | Bản chụp nguyên bản. Chỉ bị thay thế khi người dùng bấm xác nhận rõ ràng. |
| ✨ **Ảnh đang sửa** | `<thư_mục>/<tên>.jpg` | Kết quả dựng ra từ ảnh gốc + metadata. Luôn dựng lại được. |
| ⚙️ **Metadata** | `<thư_mục>/.docscan_meta.json` → `pages["<tên>.jpg"]` | Tình trạng hiện tại: 4 góc, góc xoay, bộ lọc, lịch sử hoàn tác. |

### 1.1. Ba hệ quả bắt buộc

1. **Một quy ước tên duy nhất.** Ảnh gốc luôn là `<stem>_goc.jpg` với `stem` lấy từ chính tên ảnh đang sửa.
   Mọi endpoint ghi `_goc/` đều gọi `pagestore.write_original()` — không có quy ước thứ hai.
2. **Không có trang chỉ nằm trong RAM.** Ảnh vừa nhập được ghi đủ bộ ba xuống đĩa ngay lập tức
   (`POST /api/import`). Người dùng mở app từ bất kỳ thư mục nào cũng thấy dữ liệu như nhau.
3. **Đổi tên là đổi cả bộ ba.** `pagestore.rename_page()` đổi tên ảnh sửa + ảnh gốc + khóa metadata
   + vị trí trong danh sách thứ tự, trong cùng một thao tác. **Tuyệt đối không** ghi bản sao dưới tên
   mới rồi bỏ lại tệp cũ (lỗi này từng sinh ra trang nhân bản và mất góc cắt).

### 1.2. Ảnh đang sửa là hàm thuần của metadata

```
anh_dang_sua = render(anh_goc, corners, rotation, settings)
```

Khi lưu, hệ thống **dựng lại từ metadata** rồi mới ghi đè (`core/renderer.render_page`), chứ không ghi
lại kết quả xử lý gần nhất còn trong bộ nhớ. Nhờ vậy tệp trên đĩa luôn khớp đúng thứ metadata mô tả.

---

## 2. Cấu Trúc Thư Mục Trên Đĩa (Physical Disk Layout)

```
[Thư_mục_dự_án]/
├── Hop_Dong_2026/
│   ├── _goc/                            # [BẮT BUỘC] Ảnh chụp gốc nguyên bản
│   │   ├── Hợp Đồng Thuê Nhà_goc.jpg
│   │   └── Phụ Lục_goc.jpg
│   ├── .docscan_meta.json               # [ẨN] Tình trạng + thứ tự trang
│   ├── Hợp Đồng Thuê Nhà.jpg            # Ảnh đã cắt góc, làm phẳng, làm nét
│   ├── Phụ Lục.jpg
│   └── Hop_Dong_2026.pdf                # [TUỲ CHỌN] Chỉ có khi người dùng bấm Lưu PDF
│
├── Kho_Chua_Duyet/                      # Kho ảnh chưa phân loại (hiển thị: "Kho ảnh chưa duyệt")
│   └── anh_chup_ngoai_01.jpg
│
└── .docscan_meta.json                   # Metadata cho ảnh nằm ngay tại thư mục dự án
```

- **Tệp PDF không thuộc bộ ba.** Nó là sản phẩm xuất bản, chỉ sinh ra khi người dùng chủ động
  bấm `[ 📄 Lưu PDF ]` và **do người dùng chọn nơi lưu** (mặc định là chính thư mục tài liệu).
  Xoá tệp PDF đi không làm mất gì — dựng lại lúc nào cũng được từ ảnh.
- Thư mục `_goc/` và các thư mục kỹ thuật (`.git`, `__pycache__`, `node_modules`, …) bị bỏ qua khi quét cây.
- Tên tệp **giữ nguyên dấu tiếng Việt**; chỉ các ký tự hệ điều hành cấm (`< > : " / \ | ? *`) mới bị thay bằng `_`.

---

## 3. Cấu Trúc Tệp `.docscan_meta.json`

```json
{
  "version": "2.0",
  "updated_at": "2026-08-31T10:15:00.000Z",
  "order": ["Hợp Đồng Thuê Nhà.jpg", "Phụ Lục.jpg"],
  "pages": {
    "Hợp Đồng Thuê Nhà.jpg": {
      "filename": "Hợp Đồng Thuê Nhà.jpg",
      "doc_name": "Hợp Đồng Thuê Nhà",
      "corners": [[45.2, 38.1], [1820.5, 42.0], [1810.0, 2450.8], [50.1, 2440.2]],
      "rotation": 0,
      "settings": {
        "mode": "natural", "shadow_reduction": 0.6, "sharpness": 0.6,
        "contrast": 0.2, "brightness": 0.0, "margin_percent": 0.02,
        "dewarp_enabled": false, "dewarp_strength": 0.8,
        "quality": 85, "normalize_res": true
      },
      "history": { "undo": [ { "corners": [], "rotation": 0, "settings": {}, "description": "Kéo chỉnh góc mép giấy" } ], "redo": [] },
      "fingerprint": "a1b2c3d4e5f60718",
      "updated_at": "2026-08-31T10:15:00.000Z"
    }
  }
}
```

### 3.1. Quy tắc ghi hợp nhất (Field-wise Merge) & Tra cứu an toàn — CHỐNG MẤT DỮ LIỆU

`pagestore.patch_page_meta()` chỉ ghi đè những trường **có giá trị thật**. Trường vắng mặt hoặc `null`
sẽ **giữ nguyên giá trị cũ**. Tra cứu `find_meta_entry()` kiểm tra an toàn đa tầng trên cả tên tệp và stem,
không phân biệt hoa/thường (tương thích 100% với hệ thống tệp Windows).

> ⚠️ **Lý do bắt buộc:** trước đây một payload lưu thiếu trường (ví dụ nút "Lưu thay đổi" chỉ gửi `doc_name`)
> sẽ ghi `corners: null` đè lên dữ liệu cũ, xóa trắng toàn bộ góc cắt và lịch sử của cả dự án.

### 3.2. Trường `order` — Thứ tự trang bền vững

- Lưu thứ tự do người dùng kéo thả / sắp xếp, quyết định thứ tự trang trong tệp PDF.
- Được cập nhật đồng bộ khi đổi tên, di chuyển, xóa trang (trang đổi tên **ở nguyên vị trí cũ**).
- Khi quét, tệp mới xuất hiện trên đĩa được xếp về cuối; tên không còn tệp bị bỏ qua.

---

## 4. Quét Thư Mục Theo Kiểu Nhẹ (Lazy Scan)

`POST /api/scan-directory` **không nạp điểm ảnh và không trả base64**. Nó chỉ trả về:
cây thư mục + bản ghi trang nhẹ (tên, kích thước, 4 góc, bộ lọc, cờ có ảnh gốc, số hiệu phiên bản).

Ảnh được tải theo yêu cầu qua `GET /api/image` với 3 dạng:

| `kind` | Nội dung | Dùng ở đâu |
| :--- | :--- | :--- |
| `thumb` | Ảnh nhỏ cạnh dài 320px | Danh sách trang bên trái |
| `thumb_original` | Ảnh gốc thu nhỏ | Nhấn giữ thumbnail để xem nhanh ảnh gốc |
| `original` | Ảnh gốc, cạnh dài tối đa 2000px | Khung canvas khi căn 4 góc |
| `edited` | Nguyên tệp ảnh đang sửa | Khung canvas chế độ "Đã chỉnh sửa" |

> Trình duyệt tự đệm theo tham số `v` (thời điểm sửa tệp), nên chuyển qua lại giữa các trang gần như tức thì.
> Đây là thay đổi quyết định giúp mở dự án hàng trăm trang không còn treo máy.

**Bộ nhớ máy chủ:** `PixelCache` (LRU, tối đa 8 ảnh gốc đã giải mã). Định danh trang được sinh **tất định**
từ `(đường dẫn, tên tệp)` nên quét lại nhiều lần không làm phình bộ nhớ.

### 4.1. 🔒 Không ảnh nào được biến mất khỏi giao diện

`scan_tree()` kết thúc bằng một chốt an toàn: **mọi trang trả về đều phải thuộc một thư mục có trong cây**.
Trang nào không thoả sẽ được ghi cảnh báo ra console thay vì âm thầm bị bỏ.

Thư mục "Kho chưa duyệt" trùng lặp (`Kho_Chua_Duyet` và `Kho ảnh chưa duyệt` cùng tồn tại do bản cũ tạo)
được **gộp thật** bởi `merge_unapproved_folders_if_needed()`:

- Chuyển ảnh, thư mục `_goc/` và hợp nhất metadata sang thư mục chuẩn `Kho_Chua_Duyet`.
- Chỉ xoá thư mục cũ **khi nó đã rỗng** — còn tệp nào là còn dữ liệu người dùng.
- Gộp thất bại thì **ghi log và vẫn hiển thị cả hai thư mục**, tuyệt đối không giấu bớt.

> Trước khi sửa: hàm gộp gọi nhầm một hàm không tồn tại, lỗi bị `except Exception: pass` nuốt mất,
> rồi bước loại trùng lại xoá bớt thư mục khỏi cây trong khi vẫn trả về trang của nó —
> kết quả là **ảnh có thật trên đĩa nhưng không bao giờ hiện ra trên ứng dụng**.

---

## 5. Xử Lý Ảnh Lẻ Chưa Có Bản Gốc (Orphan Images)

Khi quét thấy tệp ảnh không có bản tương ứng trong `_goc/` → gán `has_raw_original: false`, hiển thị dấu
cảnh báo ⚠ trên thumbnail. Khi người dùng mở trang đó (và không phải trong `Kho_Chua_Duyet`), hộp thoại 4 lựa chọn:

| Lựa chọn | Hành động |
| :--- | :--- |
| **Sửa ảnh & Tạo bản gốc (Yes)** | `POST /api/adopt-as-original` → sao chép vào `_goc/`, khởi tạo metadata, mở chỉnh sửa. |
| **📥 Chuyển vào Kho chưa duyệt** | `POST /api/move-to-unapproved` → tạo `Kho_Chua_Duyet` nếu chưa có, chuyển nguyên bộ ba. |
| **Xóa (Delete)** | `POST /api/delete-page` → xóa cả ảnh sửa, ảnh gốc và mục metadata. |
| **Bỏ qua (Cancel)** | Đóng hộp thoại, không hỏi lại trong phiên này. |

---

## 6. Cơ Chế Lưu (Save Model)

Có 3 mức lưu, tách bạch theo chi phí:

| Mức | Kích hoạt | Nội dung | Endpoint |
| :--- | :--- | :--- | :--- |
| **Lưu tình trạng** | 1,2 giây sau thao tác cuối | Chỉ ghi metadata, không dựng lại ảnh (rất nhẹ) | `/api/save-metadata` |
| **Tự động lưu 60s** | 60 giây không thao tác | Dựng lại & ghi ảnh của các trang đang sửa dở | `/api/save-folder` |
| **Lưu 1 chạm** | Nút `[💾 Lưu thay đổi]` hoặc `Ctrl + S` | Lưu **chỉ những trang đang có thay đổi** ở mọi nhánh thư mục | `/api/save-project` |

> ⚠️ **Chỉ gửi trang có thay đổi.** Với dự án hàng trăm trang, kết xuất lại toàn bộ ở độ phân giải
> đầy đủ sẽ treo máy hàng phút mà không đổi gì. `saveProject()` lọc theo `dirtyPages` trước khi gửi.

> ⚠️ **Lưu KHÔNG ghép PDF.** Ghép PDF phải đọc lại **toàn bộ** ảnh của thư mục nên chi phí tăng theo
> số trang dù chỉ sửa đúng một trang. Đo thực tế khi lưu 1 trang:
>
> | Thư mục | Không ghép PDF | Có ghép PDF |
> | :--- | ---: | ---: |
> | 5 trang | 73 ms | 227 ms |
> | 20 trang | 72 ms | **668 ms** |
>
> `save_pdf` mặc định là `False`. PDF là việc xuất bản riêng, chỉ chạy khi người dùng bấm.

- **Chỉ báo trực quan:** thanh trạng thái hiện `Đã lưu` (xanh) hoặc `N trang chưa lưu` (cam);
  thumbnail của trang chưa lưu có chấm cam. Người dùng luôn biết dữ liệu đã an toàn hay chưa.
  Nút `[💾 Lưu thay đổi]` chỉ sáng (Enable) khi `dirtyPages > 0`.
- Rời trang / đổi thư mục sẽ **hiển thị hộp thoại hỏi lưu** nếu trang đang có chỉnh sửa dở.
  Riêng thao tác **thêm ảnh** thì không hỏi — nó không làm mất gì, hệ thống chỉ lặng lẽ ghi nốt rồi tiếp tục.
- Rời trình duyệt khi còn thay đổi chưa lưu sẽ được trình duyệt cảnh báo.

### 6.1. 🔒 Ghi đĩa thất bại PHẢI báo lỗi (bất biến chống mất dữ liệu thầm lặng)

> **TUYỆT ĐỐI:** không thao tác lưu nào được phép trả về "thành công" khi chưa ghi được byte nào.

| Tình huống | Máy chủ trả về | Giao diện xử lý |
| :--- | :--- | :--- |
| Ghi được hết | `saved_filenames` đủ, `failed_pages: []` | Xoá cờ chưa lưu, hiện `Đã lưu` |
| Ghi được một phần | `saved_filenames` + `failed_pages` | **Chỉ** xoá cờ cho trang trong `saved_filenames`; báo rõ số trang chưa lưu và lý do |
| Không ghi được gì | HTTP `507` (ổ đầy) hoặc `500` kèm lý do tiếng Việt | Giữ nguyên toàn bộ cờ chưa lưu, nút `[💾 Lưu thay đổi]` vẫn sáng để thử lại |

Lý do được dịch sang câu người dùng hiểu được: *"Ổ đĩa đã đầy, không còn chỗ để ghi tệp."*,
*"Không có quyền ghi vào thư mục này."*, *"Tệp đang được mở ở ứng dụng khác."*

> Trước khi sửa, `_save_one_folder` nuốt lỗi ghi đĩa rồi trả `success: true`; giao diện xoá sạch cờ
> "chưa lưu" và hiện `Đã lưu` màu xanh trong khi **không có byte nào được ghi**.

---

## 6.2. Xuất Bản: PDF & Ảnh (người dùng chọn nơi lưu)

Mọi lệnh xuất đều mở **hộp thoại "Lưu tệp" của hệ điều hành** trước khi làm gì:

| Lệnh | Nội dung | Tên gợi ý |
| :--- | :--- | :--- |
| `[ 📄 Lưu PDF ]` (header) | Trang đang mở → 1 tệp PDF | `<tên tài liệu>.pdf` |
| `[ 📄 Lưu PDF (N) ]` (thư mục) | N trang đã tích chọn → 1 tệp PDF | `<tên thư mục>_N_trang.pdf` |
| `Xuất PDF toàn bộ dự án` | Mọi trang của mọi thư mục | `<tên dự án>.pdf` |
| `[ ⬇ Lưu ảnh ]` (header) | Trang đang mở → JPG / PNG / WebP | `<tên tài liệu>.<đuôi>` |
| `[ ⬇ Lưu ảnh (N) ]` (thư mục) | N ảnh đã chọn → 1 tệp ZIP | `<tên thư mục>_N_anh.zip` |

- **Thư mục mặc định là thư mục tài liệu đang mở** — nơi người dùng mong muốn nhất, thay vì ném
  vào Downloads của trình duyệt rồi phải đi tìm.
- Bấm **Huỷ** trong hộp thoại thì không có gì được tạo ra và không hiện lỗi.
- Sau khi lưu, thông báo nêu **đường dẫn đầy đủ** của tệp vừa tạo.

### 🔒 Chỉ ghi vào đường dẫn do hộp thoại cấp

`save_path` chỉ được chấp nhận nếu chính `/api/pick-save-path` vừa cấp nó trong phiên làm việc
(sổ ghi LRU 32 mục). Nhận đường dẫn tuỳ ý từ một yêu cầu HTTP sẽ biến máy chủ thành công cụ
ghi tệp bất kỳ lên máy người dùng.

### Dọn tệp PDF cũ do bản trước tự sinh

Bản trước ghi `<tên thư mục>.pdf` vào thư mục ở **mọi** lần lưu. Những tệp đó nay không còn được
cập nhật nên nội dung lệch dần so với ảnh. Khi mở dự án lần đầu sau khi cập nhật, ứng dụng
**liệt kê rõ từng tệp** rồi hỏi có xoá không (`/api/legacy-pdfs`).

Phạm vi cực hẹp — chỉ những tệp trùng đúng khuôn tên bản cũ đặt ra
(`<tên thư mục>.pdf`, `Kho ảnh chưa duyệt.pdf`, `Tai-Lieu.pdf`).
**PDF do người dùng tự đặt tên khác tuyệt đối không bị chạm tới.**

---

## 7. Thao Tác Vòng Đời Trang (Page Lifecycle)

Mọi thao tác dưới đây tác động **đồng thời lên cả 3 thành phần** của đối tượng tài liệu:

| Thao tác | Endpoint | Hàm lõi |
| :--- | :--- | :--- |
| Nhập ảnh mới | `POST /api/import` | ghi `_goc/` + ảnh sửa + metadata |
| Đổi tên | `POST /api/rename-page` | `pagestore.rename_page()` |
| Di chuyển sang thư mục khác | `POST /api/move-page` | `pagestore.move_page()` |
| Lưu ảnh sửa thành ảnh gốc | `POST /api/apply-as-original` | ghi đè `_goc/`, đặt lại 4 góc & xóa lịch sử |
| Xóa trang | `POST /api/delete-page` | `pagestore.delete_page_files()` |

---

## 8. Thao Tác Thư Mục Tức Thì

- **Tạo** (`/api/create-folder`) → `os.makedirs`, báo lỗi rõ nếu tên đã tồn tại.
- **Đổi tên** (`/api/rename-folder`) → `os.rename`.
- **Xóa** (`/api/delete-folder`) → `shutil.rmtree`, có hộp thoại xác nhận nêu rõ số trang sẽ mất.

Mọi đường dẫn đều đi qua `pagestore.folder_dir()` — hàm này **chặn đường dẫn thoát ra ngoài thư mục dự án**.

---

## 9. Xử Lý Đường Dẫn Unicode Tiếng Việt (Windows)

`cv2.imread` / `cv2.imwrite` không đọc được đường dẫn có dấu tiếng Việt trên Windows.
Bắt buộc dùng `imread_unicode` / `imwrite_unicode` (`core/detector.py`):
đọc/ghi qua luồng nhị phân rồi `cv2.imdecode` / `cv2.imencode`.

Tệp metadata được ghi theo kiểu **ghi tệp tạm rồi thay thế** (`os.replace`) để không bao giờ để lại
tệp JSON hỏng dở nếu ứng dụng bị tắt giữa chừng.
