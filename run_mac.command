#!/bin/bash
# ========================================================
# DocScan Studio — Launcher cho macOS
# ========================================================

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "========================================================"
echo "       DocScan Studio — Quét & Tinh Chỉnh Tài Liệu"
echo "========================================================"

# Kiểm tra môi trường ảo .venv
if [ ! -d ".venv" ]; then
    echo "Đang tạo môi trường ảo Python (.venv)..."
    python3 -m venv .venv
    .venv/bin/python3 -m pip install --upgrade pip
fi

# Kiểm tra thư viện chính
if ! .venv/bin/python3 -c "import fastapi, uvicorn, cv2" 2>/dev/null; then
    echo "Đang cài đặt thư viện phụ thuộc..."
    .venv/bin/pip install -r requirements.txt
fi

echo "Đang khởi động ứng dụng và mở trình duyệt..."
.venv/bin/python3 main.py
