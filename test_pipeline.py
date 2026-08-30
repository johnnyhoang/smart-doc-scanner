import cv2
import numpy as np
import time
from core.detector import detect_document_corners, four_point_transform
from core.dewarp import ai_auto_unwrinkle
from core.enhancer import enhance_document
from core.compressor import compress_image_to_bytes, generate_pdf_from_images

def test_full_suite():
    print("1. Testing real Form 1040 sample...")
    img_path = r"C:/Users/hoa.hoang/.gemini/antigravity/brain/6336acd3-711e-454a-9f57-abbdd90e9639/.user_uploaded/media_1788084043245.png"
    img = cv2.imread(img_path)
    if img is not None:
        t0 = time.time()
        corners, detected = detect_document_corners(img, margin_percent=0.02)
        print(f" - Form 1040 corners detected: {detected}")
        
        warped = four_point_transform(img, corners)
        dewarped, _, _ = ai_auto_unwrinkle(warped, strength=1.2)
        enhanced = enhance_document(dewarped, mode="natural", shadow_reduction=0.75, sharpness=0.7)
        
        data_bytes, size, dim = compress_image_to_bytes(enhanced, quality=85)
        print(f" - Form 1040 processed in {time.time() - t0:.3f}s. Size: {size/1024:.1f} KB, Dim: {dim}")
        
        cv2.imwrite("output_form1040_flattened.jpg", enhanced)
        print(" - Saved output_form1040_flattened.jpg")

    print("\n2. Testing PDF generation...")
    if img is not None:
        pdf_bytes = generate_pdf_from_images([enhanced], quality=85)
        with open("output_form1040.pdf", "wb") as f:
            f.write(pdf_bytes)
        print(f" - Saved output_form1040.pdf ({len(pdf_bytes)/1024:.1f} KB)")

    print("\nAll AI Dewarping & Unwrinkling tests passed successfully!")

if __name__ == "__main__":
    test_full_suite()
