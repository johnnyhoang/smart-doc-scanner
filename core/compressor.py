import io
import cv2
import numpy as np
from PIL import Image
import fitz  # PyMuPDF
from typing import List, Tuple, Optional


def normalize_resolution_for_print(
    image: np.ndarray,
    target_long_edge: int = 2400,
    min_long_edge: int = 1600
) -> np.ndarray:
    """
    Normalizes document resolution:
    - If image is ultra-high resolution (> 2400px): scales down to 2400px (~300 DPI for A4) to drastically cut file size while preserving 100% print readability.
    - If image is low resolution (< 1600px): upscales with bicubic/Lanczos interpolation and applies edge enhancement to improve print clarity.
    """
    h, w = image.shape[:2]
    long_edge = max(h, w)

    if long_edge > target_long_edge:
        scale = target_long_edge / float(long_edge)
        new_w = int(w * scale)
        new_h = int(h * scale)
        # INTER_AREA is best for shrinking without moire or aliasing
        return cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)

    elif long_edge < min_long_edge:
        scale = min_long_edge / float(long_edge)
        new_w = int(w * scale)
        new_h = int(h * scale)
        # Upscale with INTER_CUBIC and subtle unsharp
        upscaled = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
        
        # Denoise & sharpen low-res artifacts
        denoised = cv2.fastNlMeansDenoisingColored(upscaled, None, 3, 3, 7, 21)
        blur = cv2.GaussianBlur(denoised, (0, 0), 1.0)
        sharp = cv2.addWeighted(denoised, 1.4, blur, -0.4, 0)
        return sharp

    return image


def compress_image_to_bytes(
    image: np.ndarray,
    format: str = "JPEG",
    quality: int = 82,
    normalize_res: bool = True
) -> Tuple[bytes, int, Tuple[int, int]]:
    """
    Compresses OpenCV BGR image into optimized bytes.
    Returns (image_bytes, file_size_bytes, (width, height)).
    """
    if normalize_res:
        processed = normalize_resolution_for_print(image)
    else:
        processed = image

    # Convert BGR to RGB for PIL
    rgb = cv2.cvtColor(processed, cv2.COLOR_BGR2RGB)
    pil_img = Image.fromarray(rgb)

    output = io.BytesIO()
    fmt_upper = format.upper()

    if fmt_upper in ["JPG", "JPEG"]:
        pil_img.save(
            output,
            format="JPEG",
            quality=quality,
            optimize=True,
            subsampling=1  # 4:2:2 or 4:2:0 subsampling
        )
    elif fmt_upper == "WEBP":
        pil_img.save(
            output,
            format="WEBP",
            quality=quality,
            method=4
        )
    elif fmt_upper == "PNG":
        pil_img.save(
            output,
            format="PNG",
            optimize=True
        )
    else:
        pil_img.save(output, format="JPEG", quality=quality, optimize=True)

    data = output.getvalue()
    return data, len(data), (pil_img.width, pil_img.height)


def generate_pdf_from_images(
    images: List[np.ndarray],
    quality: int = 82,
    normalize_res: bool = True
) -> bytes:
    """
    Builds a multi-page PDF with optimized image streams using PyMuPDF (fitz).
    Each page matches standard A4 proportions (595.3 x 841.9 points) or exact aspect ratio.
    """
    pdf_doc = fitz.open()

    for idx, img in enumerate(images):
        img_bytes, _, (w, h) = compress_image_to_bytes(
            img, format="JPEG", quality=quality, normalize_res=normalize_res
        )

        # Standard A4 size in points: 595.28 x 841.89
        # Fit image to standard A4 rect preserving aspect ratio
        a4_w, a4_h = 595.28, 841.89
        
        # Determine page orientation based on image aspect ratio
        if w > h:
            page_w, page_h = a4_h, a4_w  # Landscape A4
        else:
            page_w, page_h = a4_w, a4_h  # Portrait A4

        page = pdf_doc.new_page(width=page_w, height=page_h)
        rect = fitz.Rect(0, 0, page_w, page_h)
        
        # Insert compressed image
        page.insert_image(rect, stream=img_bytes)

    pdf_bytes = pdf_doc.write(deflate=True, garbage=3)
    pdf_doc.close()
    return pdf_bytes
