import os
import re
import datetime
import cv2
import numpy as np
from unidecode import unidecode
from typing import List, Tuple, Optional

# Lazy-loaded RapidOCR engine
_OCR_ENGINE = None

def get_ocr_engine():
    global _OCR_ENGINE
    if _OCR_ENGINE is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
            _OCR_ENGINE = RapidOCR()
        except Exception as e:
            print(f"[Warning] Could not initialize RapidOCR: {e}")
            _OCR_ENGINE = False
    return _OCR_ENGINE if _OCR_ENGINE is not False else None


DOCUMENT_PATTERNS = [
    # Tax & Government Forms
    (r"\b(1040|w2|w-2|w4|w-4|1099|tax\s*return|irs|individual\s*income)\b", "Form-1040-Tax-Return"),
    (r"\b(to\s*khai|quyet\s*toan\s*thue|dong\s*thue|thue\s*gtgt|thue\s*tncn|tax\s*declaration)\b", "To-Khai-Thue"),

    # Contracts & Agreements
    (r"\b(thue\s*nha|thue\s*dat|thue\s*mat\s*bang|lease|rent|rental)\b", "Hop-Dong-Thue-Nha"),
    (r"\b(lao\s*dong|employment|labor|nhan\s*su)\b", "Hop-Dong-Lao-Dong"),
    (r"\b(mua\s*ban|purchase|sales|chuyen\s*nhuong)\b", "Hop-Dong-Mua-Ban"),
    (r"\b(dich\s*vu|service|cung\s*ung)\b", "Hop-Dong-Dich-Vu"),
    (r"\b(hop\s*dong|contract|agreement|thoa\s*thuan|hdkt|hdld)\b", "Hop-Dong-Kinh-Te"),

    # Invoices, Receipts & Financial Documents
    (r"\b(hoa\s*don|invoice|gtgt|vat|bill|e-invoice)\b", "Hoa-Don-GTGT"),
    (r"\b(phieu\s*thu|receipt|receipts|phieu\s*xac\s*nhan\s*thu)\b", "Phieu-Thu-Tien"),
    (r"\b(phieu\s*chi|payment\s*voucher|phieu\s*chi\s*tien)\b", "Phieu-Chi-Tien"),
    (r"\b(bien\s*lai|chung\s*tu|giay\s*bao\s*co|giay\s*bao\s*no)\b", "Chung-Tu-Thanh-Toan"),
    (r"\b(bao\s*cao\s*tai\s*chinh|financial\s*statement|balance\s*sheet)\b", "Bao-Cao-Tai-Chinh"),
    (r"\b(bang\s*ke|bang\s*luong|payroll|payslip)\b", "Bang-Luong-Chi-Tiet"),

    # Identification & Personal Records
    (r"\b(can\s*cuoc\s*cong\s*dan|cccd|the\s*can\s*cuoc|identity\s*card|id\s*card)\b", "Can-Cuoc-Cong-Dan"),
    (r"\b(chung\s*minh\s*nhan\s*dan|cmnd|chung\s*minh\s*thu)\b", "Chung-Minh-Nhan-Dan"),
    (r"\b(ho\s*chieu|passport)\b", "Ho-Chieu-Passport"),
    (r"\b(bang\s*lai|driver|gplx|giay\s*phep\s*lai\s*xe|driving\s*licence)\b", "Giay-Phep-Lai-Xe"),
    (r"\b(so\s*ho\s*khau|ho\s*khau|household\s*registration)\b", "So-Ho-Khau"),
    (r"\b(giay\s*khai\s*sinh|birth\s*certificate)\b", "Giay-Khai-Sinh"),
    (r"\b(the\s*sinh\s*vien|student\s*card)\b", "The-Sinh-Vien"),
    (r"\b(the\s*bao\s*hiem|bhyt|insurance\s*card)\b", "The-Bao-Hiem-Y-Te"),

    # Minutes, Certificates & Applications
    (r"\b(bien\s*ban\s*ban\s*giao|handover\s*minutes)\b", "Bien-Ban-Ban-Giao"),
    (r"\b(bien\s*ban\s*nghiem\s*thu|acceptance\s*minutes)\b", "Bien-Ban-Nghiem-Thu"),
    (r"\b(bien\s*ban|minutes|meeting\s*minutes)\b", "Bien-Ban-Lam-Viec"),
    (r"\b(giay\s*chung\s*nhan|certificate|chung\s*chi|chung\s*nhan)\b", "Giay-Chung-Nhan"),
    (r"\b(bang\s*tot\s*nghiep|diploma|degree)\b", "Bang-Tot-Nghiep"),
    (r"\b(bang\s*diem|hoc\s*ba|transcript)\b", "Bang-Diem-Hoc-Tap"),
    (r"\b(don\s*xin\s*viec|job\s*application|cv|resume)\b", "Don-Xin-Viec"),
    (r"\b(don\s*xin|application|de\s*nghi|to\s*trinh)\b", "Don-Xin-Phep"),
    (r"\b(quyet\s*dinh|decision|resolution)\b", "Quyet-Dinh"),
    (r"\b(thong\s*bao|notice|announcement)\b", "Thong-Bao-Van-Ban"),
    (r"\b(don\s*thuoc|benh\s*an|medical\s*record|prescription)\b", "Ho-So-Benh-An"),
    (r"\b(giay\s*xac\s*nhan|confirmation|verification)\b", "Giay-Xac-Nhan"),
]


def clean_slug_title(text: str) -> str:
    """Converts raw text into a clean Title-Case-With-Hyphens string."""
    ascii_text = unidecode(text)
    # Remove special characters
    cleaned = re.sub(r"[^a-zA-Z0-9\s_-]", " ", ascii_text)
    cleaned = cleaned.replace("_", " ").replace("-", " ")
    words = [w.capitalize() for w in cleaned.split() if len(w) > 0]
    if not words:
        return "Tai-Lieu-Scan"
    return "-".join(words[:6])


def is_technical_or_random_string(text: str) -> bool:
    """Detects if a string is a technical UUID, hash, camera ID or random digits."""
    if not text:
        return True
    
    clean = text.strip()
    # Long hex or numeric strings (e.g. 1787500843039-8580363393284745665-G7923670403162756644...)
    if re.search(r"[0-9a-fA-F]{12,}", clean):
        return True
    
    # Generic camera / screenshot names
    if re.match(r"^(img|image|photo|scan|screenshot|capture|dsc|pic|media|file|document|pasted|anh)[\d\s_-]*$", clean, re.I):
        return True
    
    # Check if ratio of digits + hyphens is too high
    digits_and_symbols = sum(1 for c in clean if c.isdigit() or c in "-_")
    if len(clean) > 8 and (digits_and_symbols / len(clean)) > 0.6:
        return True
    
    return False


def extract_ocr_text_from_image(image: np.ndarray) -> List[str]:
    """Runs OCR on the header portion of the document image to extract text lines."""
    engine = get_ocr_engine()
    if engine is None or image is None:
        return []

    try:
        h, w = image.shape[:2]
        # Crop top 45% where headers, titles and form names are placed
        header_crop = image[0:int(h * 0.45), :]
        result, _ = engine(header_crop)

        lines = []
        if result:
            for item in result:
                confidence = item[2]
                if confidence > 0.45:
                    raw_line = unidecode(item[1]).strip()
                    if len(raw_line) >= 2:
                        lines.append(raw_line)
        return lines
    except Exception as e:
        print(f"[Warning] OCR extraction error: {e}")
        return []


def detect_document_category_from_text(lines: List[str]) -> Tuple[Optional[str], Optional[str]]:
    """
    Analyzes OCR text lines to determine:
    1. Standard category name (e.g. Form-1040-Tax-Return)
    2. Specific title headline if found (e.g. Hop-Dong-Kinh-Te-So-123)
    """
    if not lines:
        return None, None

    combined_text = " ".join(lines).lower()
    detected_category = None
    specific_title = None

    # Check for Tax Form 1040 with Year
    if "1040" in combined_text or ("tax" in combined_text and "return" in combined_text):
        year_match = re.search(r"\b(202[0-9]|201[0-9])\b", combined_text)
        if year_match:
            detected_category = f"Form-1040-Tax-Return-{year_match.group(1)}"
        else:
            detected_category = "Form-1040-Tax-Return"

    # Check matching patterns
    if not detected_category:
        for pattern, cat_name in DOCUMENT_PATTERNS:
            if re.search(pattern, combined_text):
                detected_category = cat_name
                break

    # Look for a prominent headline in the first 3 lines
    for line in lines[:3]:
        cleaned_line = clean_slug_title(line)
        # Ensure it's not too short and not a random technical string
        if 4 <= len(cleaned_line) <= 40 and not is_technical_or_random_string(cleaned_line):
            if any(k in line.lower() for k in ["hop dong", "hoa don", "bien ban", "giay", "to khai", "form", "tax", "report", "chung nhan", "don xin"]):
                specific_title = cleaned_line
                break

    return detected_category, specific_title


def get_basic_document_name(
    filename: Optional[str] = None,
    page_index: int = 1
) -> Tuple[str, List[str]]:
    """
    Fast, 0-cost local name generator without invoking OCR/AI.
    """
    today_str = datetime.date.today().strftime("%Y-%m-%d")
    detected_category = None

    if filename:
        raw_name = os.path.splitext(filename)[0]
        if not is_technical_or_random_string(raw_name):
            norm_name = unidecode(raw_name).lower().replace("_", " ").replace("-", " ")
            for pattern, cat_name in DOCUMENT_PATTERNS:
                if re.search(pattern, norm_name):
                    detected_category = cat_name
                    break
            if not detected_category:
                detected_category = clean_slug_title(raw_name)

    if not detected_category:
        detected_category = "Tai-Lieu-Scan"

    primary = f"{detected_category}_Trang-{page_index}" if page_index > 1 else detected_category
    suggestions = [
        primary,
        f"{detected_category}_{today_str}",
        f"{detected_category}_Trang-{page_index}",
        detected_category
    ]
    unique_suggestions = list(dict.fromkeys(suggestions))
    return unique_suggestions[0], unique_suggestions


def ai_ocr_suggest_document_name(
    image: Optional[np.ndarray] = None,
    filename: Optional[str] = None, 
    page_index: int = 1
) -> Tuple[str, List[str]]:
    """
    On-Demand AI / OCR document text reader:
    Only executed when explicitly requested by user to conserve resources/token costs.
    """
    today_str = datetime.date.today().strftime("%Y-%m-%d")
    today_short = datetime.date.today().strftime("%d%m%y")

    detected_category = None
    specific_title = None

    # Read actual document content via OCR
    if image is not None:
        ocr_lines = extract_ocr_text_from_image(image)
        if ocr_lines:
            detected_category, specific_title = detect_document_category_from_text(ocr_lines)

    if not detected_category and filename:
        raw_name = os.path.splitext(filename)[0]
        if not is_technical_or_random_string(raw_name):
            norm_name = unidecode(raw_name).lower().replace("_", " ").replace("-", " ")
            for pattern, cat_name in DOCUMENT_PATTERNS:
                if re.search(pattern, norm_name):
                    detected_category = cat_name
                    break
            if not detected_category:
                detected_category = clean_slug_title(raw_name)

    if not detected_category:
        detected_category = "Tai-Lieu-Scan"

    # Build smart, clean suggestions
    suggestions = []
    if detected_category:
        suggestions.append(f"{detected_category}")
        suggestions.append(f"{detected_category}_{today_str}")

    if specific_title and specific_title != detected_category:
        suggestions.append(specific_title)
        suggestions.append(f"{specific_title}_{today_str}")

    suggestions.append(f"{detected_category}_Trang-{page_index}")
    suggestions.append(f"{detected_category}_{today_short}")

    unique_suggestions = list(dict.fromkeys(suggestions))
    return unique_suggestions[0], unique_suggestions


def suggest_document_name(
    filename: Optional[str] = None, 
    image: Optional[np.ndarray] = None,
    page_index: int = 1
) -> Tuple[str, List[str]]:
    """Alias pointing to basic generator to prevent automatic token/CPU consumption on upload."""
    return get_basic_document_name(filename=filename, page_index=page_index)
