import base64
import json
import os
import shutil
import sys
import tempfile
import cv2
import numpy as np
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server
from core import pagestore as ps
from core import renderer as rd


def test_bake_all_annotation_types():
    img = np.full((600, 800, 3), 255, dtype=np.uint8)

    patch_img = np.zeros((40, 40, 3), dtype=np.uint8)
    patch_img[:] = [100, 150, 200]
    _, buf = cv2.imencode('.png', patch_img)
    patch_b64 = 'data:image/png;base64,' + base64.b64encode(buf).decode('ascii')

    annotations = [
        {'id': 'a1', 'type': 'rect', 'x': 0.1, 'y': 0.1, 'w': 0.2, 'h': 0.15, 'color': '#ef4444', 'strokeWidth': 3},
        {'id': 'a2', 'type': 'ellipse', 'x': 0.35, 'y': 0.1, 'w': 0.2, 'h': 0.15, 'color': '#10b981', 'strokeWidth': 2},
        {'id': 'a3', 'type': 'line', 'x1': 0.1, 'y1': 0.35, 'x2': 0.3, 'y2': 0.35, 'color': '#3b82f6', 'strokeWidth': 4, 'strokeStyle': 'dashed'},
        {'id': 'a4', 'type': 'arrow', 'x1': 0.4, 'y1': 0.35, 'x2': 0.65, 'y2': 0.35, 'color': '#f59e0b', 'strokeWidth': 4, 'text': 'Mui ten'},
        {'id': 'a5', 'type': 'highlighter', 'x': 0.1, 'y': 0.45, 'w': 0.4, 'h': 0.08, 'color': '#facc15'},
        {'id': 'a6', 'type': 'text', 'x': 0.1, 'y': 0.6, 'text': 'Ghi chu tai lieu quan trong', 'color': '#ef4444', 'fontSize': 20},
        {'id': 'a7', 'type': 'callout', 'x': 0.55, 'y': 0.55, 'w': 0.25, 'h': 0.12, 'tailX': 0.45, 'tailY': 0.5, 'text': 'Xem diem nay', 'fillColor': '#0284c7'},
        {'id': 'a8', 'type': 'step', 'x': 0.85, 'y': 0.2, 'radius': 20, 'stepNumber': 1, 'color': '#ef4444'},
        {'id': 'a9', 'type': 'step', 'x': 0.85, 'y': 0.35, 'radius': 20, 'stepNumber': 2, 'color': '#ef4444'},
        {'id': 'a10', 'type': 'blur', 'x': 0.1, 'y': 0.75, 'w': 0.3, 'h': 0.1},
        {'id': 'a11', 'type': 'whiteout', 'x': 0.45, 'y': 0.75, 'w': 0.2, 'h': 0.1},
        {'id': 'a12', 'type': 'image_patch', 'x': 0.7, 'y': 0.75, 'w': 0.15, 'h': 0.1, 'patchDataUrl': patch_b64},
    ]

    out = rd.bake_annotations(img, annotations)
    assert out is not None
    assert out.shape == (600, 800, 3)
    assert out.dtype == np.uint8
    assert np.mean(out) < 255.0


def test_pagestore_annotations_stale_detection():
    settings = ps.merged_settings({})
    fp1 = ps.state_fingerprint(None, 0, settings, [{'id': '1', 'type': 'rect', 'x': 0.1, 'y': 0.1, 'w': 0.2, 'h': 0.2}])
    fp2 = ps.state_fingerprint(None, 0, settings, [])
    assert fp1 != fp2

    # entry với committed_fingerprint khớp fp1
    entry_stale = {
        'committed_fingerprint': fp2,
        'corners': None,
        'rotation': 0,
        'settings': {},
        'annotations': [{'id': '1', 'type': 'rect', 'x': 0.1, 'y': 0.1, 'w': 0.2, 'h': 0.2}]
    }
    assert ps.is_stale(entry_stale) is True

    entry_clean = {
        'committed_fingerprint': fp1,
        'corners': None,
        'rotation': 0,
        'settings': {},
        'annotations': [{'id': '1', 'type': 'rect', 'x': 0.1, 'y': 0.1, 'w': 0.2, 'h': 0.2}]
    }
    assert ps.is_stale(entry_clean) is False


def test_server_process_with_annotations():
    client = TestClient(server.app)
    tmpdir = tempfile.mkdtemp(prefix='docscan_ann_test_')
    try:
        client.post('/api/scan-directory', json={'path': tmpdir})

        sample_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'test_input.jpg')
        if not os.path.exists(sample_path):
            img = np.full((300, 400, 3), 240, dtype=np.uint8)
            cv2.imwrite(sample_path, img)

        with open(sample_path, 'rb') as f:
            blob = f.read()

        imp = client.post('/api/import', files={'file': ('page1.jpg', blob, 'image/jpeg')}, data={'relative_path': ''})
        assert imp.status_code == 200, imp.text

        res = client.post('/api/process', json={
            'relative_path': '',
            'filename': 'page1.jpg',
            'corners': [[0, 0], [400, 0], [400, 300], [0, 300]],
            'rotation': 0,
            'settings': {'mode': 'natural'},
            'annotations': [
                {'id': 'a1', 'type': 'rect', 'x': 0.1, 'y': 0.1, 'w': 0.3, 'h': 0.3, 'color': '#ef4444', 'strokeWidth': 2}
            ]
        })
        assert res.status_code == 200
        assert res.headers['content-type'] == 'image/jpeg'
        assert len(res.content) > 0
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == '__main__':
    test_bake_all_annotation_types()
    test_pagestore_annotations_stale_detection()
    test_server_process_with_annotations()
    print('ALL ANNOTATION TESTS PASSED!')