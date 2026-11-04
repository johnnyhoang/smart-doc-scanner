/**
 * DocScan Studio — Frontend Controller
 *
 * MÔ HÌNH LÀM VIỆC (khớp 1:1 với backend):
 *   Một trang tài liệu = (thư mục, tên tệp) và luôn gồm đủ 3 phần trên ổ cứng:
 *       _goc/<tên>_goc.jpg   ảnh gốc      -> nền để chỉnh sửa, không bao giờ bị ghi đè ngầm
 *       <tên>.jpg            ảnh đang sửa -> kết quả dựng từ metadata
 *       .docscan_meta.json   metadata     -> 4 góc, góc xoay, bộ lọc, lịch sử hoàn tác
 *
 *   Giao diện KHÔNG giữ ảnh trong bộ nhớ: ảnh được tải theo yêu cầu qua /api/image
 *   nên mở thư mục hàng trăm trang vẫn nhẹ và tức thì.
 */

const WORKFLOW_TAB = { CROP: 'crop', PAGESIZE: 'pagesize', COLOR: 'color', ANNOTATE: 'annotate' };
const VIEW = { EDIT: 'edit', COMPARE: 'compare', ANNOTATE: 'annotate' };
const AUTOSAVE_MS = 60000;
const META_SAVE_MS = 1200;
const PREVIEW_DEBOUNCE_MS = 160;
const MAX_HISTORY = 30;

const $ = (id) => document.getElementById(id);
const on = (el, evt, fn, opts) => { if (el) el.addEventListener(evt, fn, opts); };

const DEFAULT_SETTINGS = {
    mode: 'natural',
    shadow_reduction: 0.6,
    sharpness: 0.6,
    contrast: 0.2,
    brightness: 0.0,
    filter_intensity: 1.0,
    page_size_preset: 'original',
    page_orientation: 'auto',
    page_fit_mode: 'fill',
    page_margin_pct: 0.0,
    page_scale_x: 1.0,
    page_scale_y: 1.0,
    margin_percent: 0.02,
    dewarp_enabled: false,
    dewarp_strength: 0.8,
    quality: 85,
    normalize_res: true,
};

/** Gọi API JSON kèm thông báo lỗi tiếng Việt thân thiện. */
async function apiJson(url, body, method = 'POST') {
    const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
        let detail = 'Thao tác không thực hiện được. Vui lòng thử lại.';
        try {
            const err = await res.json();
            if (err && err.detail) detail = err.detail;
        } catch (_) { /* giữ thông báo mặc định */ }
        throw new Error(detail);
    }
    return res.json();
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Không tải được ảnh.'));
        img.src = src;
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function formatBytes(bytes) {
    if (!bytes) return '--';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function estimateQualitySize(baseBytes, targetQuality, baseQuality = 85) {
    if (!baseBytes || baseBytes <= 0) return 0;
    const curve = (q) => {
        if (q <= 85) {
            return 1.0 + (q - 85) * 0.013;
        } else {
            return 1.0 + (q - 85) * 0.045 + Math.pow(q - 85, 2) * 0.0035;
        }
    };
    const ratio = curve(targetQuality) / curve(baseQuality);
    return Math.max(1024, Math.round(baseBytes * ratio));
}



class DocScanApp {
    constructor() {
        this.rootPath = localStorage.getItem('docscan_root_path') || '';
        this.rootName = '';

        this.folders = [];
        this.pages = new Map();
        this.activeFolderId = 'folder_root';
        this.activeImageId = null;

        this.viewMode = VIEW.COMPARE;
        this.activeTab = WORKFLOW_TAB.COLOR;
        this.holdingCompare = false;
        this.showHandles = true;
        this.sliderPos = 0.5;

        // Snagit-Style Annotation Suite State
        this.activeAnnTool = 'select';
        this.annColor = '#ef4444';
        this.annStrokeWidth = 4;
        this.annStrokeStyle = 'solid';
        this.annFontSize = 18;
        this.annStepCount = 1;
        this.annCutMode = 'move';
        this.selectedAnnotationId = null;
        this.activeDrawingAnnotation = null;
        this.isDraggingAnnotation = false;
        this.isResizingAnnotation = false;
        this.selectedHandle = null;
        this.dragStartAnnPos = null;
        this.cutSelectionBox = null;
        this.patchImagesCache = new Map();

        this.dirtyPages = new Set();
        this.selectedPageIds = new Set();
        this.selectMode = false;
        this.previewController = null;
        this.previewUrl = null;
        this.baselineImg = null;
        this.baselineKey = null;
        this.baselineUrl = null;

        this.canvas = document.getElementById('cropCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.originalImg = null;
        this.editedImg = null;

        this.draggingCornerIndex = -1;
        this.isSliding = false;
        this.isPanning = false;
        this.handleRadius = 14;
        this.canvasPaddingRatio = 0.12;

        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;

        this.magCanvas = document.getElementById('magnifierCanvas');
        this.magCtx = this.magCanvas.getContext('2d');
        this.magLens = document.getElementById('magnifierLens');
        this.lensLabel = document.getElementById('lensLabel');

        this.folderModalState = { mode: 'create', targetFolderId: null };
        this.moveModalState = { imageId: null, targetFolderId: null };
        this.pendingOrphanId = null;
        this.draggedImageId = null;

        this.initElements();
        this.bindEvents();
        this.initSidebarResizers();
        this.renderFolderTree();
        this.updateFolderHeader();
        this.updateHistoryButtons();
        this.updateFolderActionButtons();

        this.initSession();
    }

    async initSession() {
        let path = localStorage.getItem('docscan_root_path');
        if (!path) {
            try {
                const res = await apiJson('/api/session');
                if (res && res.root_path) {
                    path = res.root_path;
                    localStorage.setItem('docscan_root_path', path);
                }
            } catch (e) {}
        }
        if (path) {
            await this.loadProject(path, false);
        } else {
            this.setStatus('Hãy chọn thư mục tài liệu trên máy để bắt đầu.', 'info');
        }
    }

    // ======================================================
    // 🔗 THAM CHIẾU PHẦN TỬ GIAO DIỆN
    // ======================================================

    initElements() {
        this.pageSidebar = $('pageSidebar');
        this.folderSection = $('folderSection');
        this.pagesSection = $('pagesSection');
        this.sidebarDividerH = $('sidebarDividerH');
        this.sidebarResizerV = $('sidebarResizerV');

        this.btnUndo = $('btnUndo');
        this.btnRedo = $('btnRedo');

        this.btnPickRootDir = $('btnPickRootDir');
        this.btnOpenExplorer = $('btnOpenExplorer');
        this.lblRootPath = $('lblRootPath');

        this.docNameWrapper = $('docNameWrapper');
        this.txtDocName = $('txtDocName');
        this.btnMagicSuggest = $('btnMagicSuggest');
        this.suggestMenu = $('suggestMenu');

        this.fileInput = $('fileInput');
        this.heroFileInput = $('heroFileInput');
        this.btnSaveToDisk = $('btnSaveToDisk');
        this.btnPanelApplyAsOriginal = $('btnPanelApplyAsOriginal');

        this.btnExportPdf = $('btnExportPdf');
        this.btnStitchPdf = $('btnStitchPdf');
        this.btnCopyCurrent = $('btnCopyCurrent');
        this.btnDownloadCurrent = $('btnDownloadCurrent');

        this.emptyState = $('emptyState');
        this.editorStage = $('editorStage');
        this.dropZone = $('dropZone');

        this.folderTreeContainer = $('folderTreeContainer');
        this.btnAddSubfolder = $('btnAddSubfolder');
        this.activeFolderName = $('activeFolderName');
        this.pageCount = $('pageCount');
        this.pageListContainer = $('pageListContainer');

        this.btnToggleSelectAll = $('btnToggleSelectAll');
        this.lblToggleSelectAll = $('lblToggleSelectAll');
        this.btnSortMenu = $('btnSortMenu');
        this.sortDropdown = $('sortDropdown');
        this.btnExportFolderPdf = $('btnExportFolderPdf');
        this.lblExportPdf = $('lblExportPdf');
        this.btnStitchFolderPages = $('btnStitchFolderPages');
        this.lblStitchFolder = $('lblStitchFolder');
        this.btnDownloadFolderZip = $('btnDownloadFolderZip');
        this.lblDownloadZip = $('lblDownloadZip');
        this.controlPanel = $('controlPanel');

        this.stitchPdfModal = $('stitchPdfModal');
        this.stitchState = {
            source: 'upload',
            file: null,
            layout: 'grid',
            cols: 3,
            lastRowAlign: 'center',
            spacing: 24,
            bgColor: '#ffffff',
            scale: 1.0,
            format: 'jpeg',
            drawBorder: true,
            zoom: 'fit',
        };

        this.selectionActionBar = $('selectionActionBar');
        this.selectionCount = $('selectionCount');
        this.btnSelectAllPages = $('btnSelectAllPages');
        this.btnDeselectAllPages = $('btnDeselectAllPages');

        this.btnTabCrop = $('btnTabCrop') || $('btnModeEdit');
        this.btnTabPageSize = $('btnTabPageSize');
        this.btnTabColor = $('btnTabColor') || $('btnModeCompare');
        this.btnTabAnnotate = $('btnTabAnnotate');

        this.sectionPageSize = $('sectionPageSize');
        this.selPageSizePreset = $('selPageSizePreset');
        this.segPageOrientation = $('segPageOrientation');
        this.segPageFitMode = $('segPageFitMode');
        this.rngPageMargin = $('rngPageMargin');
        this.valPageMargin = $('valPageMargin');
        this.lblPageSizeMetric = $('lblPageSizeMetric');
        this.btnStep2ShrinkX = $('btnStep2ShrinkX');
        this.btnStep2ExpandX = $('btnStep2ExpandX');
        this.valStep2ScaleX = $('valStep2ScaleX');
        this.btnStep2ShrinkY = $('btnStep2ShrinkY');
        this.btnStep2ExpandY = $('btnStep2ExpandY');
        this.valStep2ScaleY = $('valStep2ScaleY');
        this.btnStep2ResetStretch = $('btnStep2ResetStretch');
        this.btnModeEdit = this.btnTabCrop;
        this.btnModeCompare = this.btnTabColor;

        this.annotationBarContainer = $('annotationBarContainer');
        this.annotationPropsRow = $('annotationPropsRow');
        this.canvasInlineTextEditor = $('canvasInlineTextEditor');
        this.btnDeleteSelectedAnn = $('btnDeleteSelectedAnn');
        this.btnDuplicateSelectedAnn = $('btnDuplicateSelectedAnn');
        this.btnClearAllAnn = $('btnClearAllAnn');
        this.lblNextStepNum = $('lblNextStepNum');
        this.btnResetStepCount = $('btnResetStepCount');
        this.annCustomColorPicker = $('annCustomColorPicker');
        this.propStrokeWidthItem = $('propStrokeWidthItem');
        this.propStrokeStyleItem = $('propStrokeStyleItem');
        this.propFontSizeItem = $('propFontSizeItem');
        this.propStepItem = $('propStepItem');
        this.propCutPasteItem = $('propCutPasteItem');

        this.canvasViewport = $('canvasViewport');
        this.canvasTransformBox = $('canvasTransformBox');
        this.resultInfoText = $('resultInfoText');
        this.statusIcon = $('statusIcon');
        this.processingPill = $('processingPill');
        this.saveStatePill = $('saveStatePill');

        this.btnZoomIn = $('btnZoomIn');
        this.btnZoomOut = $('btnZoomOut');
        this.btnZoomFit = $('btnZoomFit');
        this.btnZoom100 = $('btnZoom100');
        this.lblZoomLevel = $('lblZoomLevel');

        this.btnResetToRawOriginal = $('btnResetToRawOriginal');
        this.btnResetCorners = $('btnResetCorners');
        this.btnAutoDetect = $('btnAutoDetect');
        this.btnToggleBookSpread = $('btnToggleBookSpread');
        this.lblToggleBookSpread = $('lblToggleBookSpread');
        this.selAspectPreset = $('selAspectPreset');
        this.btnExpandX = $('btnExpandX');
        this.btnShrinkX = $('btnShrinkX');
        this.btnExpandY = $('btnExpandY');
        this.btnShrinkY = $('btnShrinkY');
        this.btnExpandMargin = $('btnExpandMargin');
        this.btnShrinkMargin = $('btnShrinkMargin');
        this.btnRotateLeft = $('btnRotateLeft');
        this.btnRotateRight = $('btnRotateRight');

        this.modeCards = document.querySelectorAll('.mode-card');
        this.chkDewarp = $('chkDewarp');
        this.dewarpStrengthGroup = $('dewarpStrengthGroup');
        this.filterIntensityGroup = $('filterIntensityGroup');
        this.rngFilterIntensity = $('rngFilterIntensity');
        this.valFilterIntensity = $('valFilterIntensity');
        this.rngDewarp = $('rngDewarp');
        this.valDewarp = $('valDewarp');
        this.rngShadow = $('rngShadow');
        this.valShadow = $('valShadow');
        this.rngSharpness = $('rngSharpness');
        this.valSharpness = $('valSharpness');
        this.rngMargin = $('rngMargin');
        this.valMargin = $('valMargin');
        this.rngContrast = $('rngContrast');
        this.valContrast = $('valContrast');
        this.rngQuality = $('rngQuality');
        this.valQuality = $('valQuality');
        this.chkNormalizeDpi = $('chkNormalizeDpi');

        this.metaOrigDim = $('metaOrigDim');
        this.metaOrigSize = $('metaOrigSize');
        this.metaOutDim = $('metaOutDim');
        this.metaOutSize = $('metaOutSize');
        this.savingPill = $('savingPill');
        this.cardFileName = $('cardFileName');
        this.cardOrigDim = $('cardOrigDim');
        this.cardOrigSize = $('cardOrigSize');
        this.cardOutSize = $('cardOutSize');
        this.cardSavingsPct = $('cardSavingsPct');
        this.cardOriginalState = $('cardOriginalState');

        this.toast = $('toast');
        this.toastMsg = $('toastMsg');
        this.toastIcon = $('toastIcon');
        this.loadingOverlay = $('loadingOverlay');
        this.loadingText = $('loadingText');

        this.folderNameModal = $('folderNameModal');
        this.folderModalTitle = $('folderModalTitle');
        this.folderModalLabel = $('folderModalLabel');
        this.txtFolderModalName = $('txtFolderModalName');
        this.folderModalHint = $('folderModalHint');
        this.btnCloseFolderModal = $('btnCloseFolderModal');
        this.btnCancelFolderModal = $('btnCancelFolderModal');
        this.btnSubmitFolderModal = $('btnSubmitFolderModal');

        this.moveImageModal = $('moveImageModal');
        this.moveImageDesc = $('moveImageDesc');
        this.moveFolderPicker = $('moveFolderPicker');
        this.btnMoveModalNewFolder = $('btnMoveModalNewFolder');
        this.moveInlineCreateBox = $('moveInlineCreateBox');
        this.txtInlineNewFolder = $('txtInlineNewFolder');
        this.btnConfirmInlineFolder = $('btnConfirmInlineFolder');
        this.btnCancelInlineFolder = $('btnCancelInlineFolder');
        this.btnCloseMoveModal = $('btnCloseMoveModal');
        this.btnCancelMoveModal = $('btnCancelMoveModal');
        this.btnSubmitMoveModal = $('btnSubmitMoveModal');

        this.orphanImageModal = $('orphanImageModal');
        this.orphanFileName = $('orphanFileName');
        this.orphanFolderPath = $('orphanFolderPath');
        this.orphanFileSize = $('orphanFileSize');
        this.orphanPreviewImg = $('orphanPreviewImg');
        this.btnOrphanAdopt = $('btnOrphanAdopt');
        this.btnOrphanDelete = $('btnOrphanDelete');
        this.btnOrphanMoveToUnapproved = $('btnOrphanMoveToUnapproved');
        this.btnOrphanCancel = $('btnOrphanCancel');
        this.btnCloseOrphanModal = $('btnCloseOrphanModal');
    }

    // ======================================================
    // 🎛️ GẮN SỰ KIỆN
    // ======================================================

    bindEvents() {
        // --- Nhập ảnh ---
        on(this.fileInput, 'change', (e) => this.importFiles(e.target.files));
        on(this.heroFileInput, 'change', (e) => this.importFiles(e.target.files));
        window.addEventListener('paste', (e) => this.handleClipboardPaste(e));

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
            on(this.dropZone, evt, (e) => { e.preventDefault(); e.stopPropagation(); });
        });
        on(this.dropZone, 'dragover', () => this.dropZone.classList.add('dragover'));
        on(this.dropZone, 'dragleave', () => this.dropZone.classList.remove('dragover'));
        on(this.dropZone, 'drop', (e) => {
            this.dropZone.classList.remove('dragover');
            if (e.dataTransfer.files?.length) this.importFiles(e.dataTransfer.files);
        });

        // --- Thư mục gốc trên máy ---
        on(this.btnPickRootDir, 'click', () => this.pickRootDirectory());
        on(this.btnOpenExplorer, 'click', () => this.openActiveFolderInExplorer());
        on(this.lblRootPath, 'click', () => this.pickRootDirectory());

        // --- Tên tài liệu: Enter / rời ô = đổi tên cả bộ ba ---
        on(this.txtDocName, 'keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.txtDocName.blur(); }
            if (e.key === 'Escape') {
                const page = this.getActivePage();
                if (page) this.txtDocName.value = page.docName;
                this.txtDocName.blur();
            }
        });
        on(this.txtDocName, 'blur', () => this.commitDocumentName());

        on(this.btnMagicSuggest, 'click', (e) => {
            e.stopPropagation();
            const page = this.getActivePage();
            if (!page) return;
            if (page.nameSuggestions && page.nameSuggestions.length > 0) {
                this.suggestMenu.classList.toggle('open');
            } else {
                this.runAiNaming();
            }
        });

        window.addEventListener('click', () => {
            this.suggestMenu?.classList.remove('open');
            document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
        });

        // --- Hoàn tác / Làm lại ---
        on(this.btnUndo, 'click', () => this.undo());
        on(this.btnRedo, 'click', () => this.redo());

        window.addEventListener('keydown', (e) => {
            const typing = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                e.preventDefault(); this.undo();
            } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
                e.preventDefault(); this.redo();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault(); this.saveProject();
            } else if (!typing && ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd')) {
                e.preventDefault(); this.duplicateSelectedAnnotation();
            } else if (!typing && !window.getSelection()?.toString() && ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c')) {
                if (this.getActivePage()) { e.preventDefault(); this.copyCurrentPageImage(); }
            } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
                if (this.selectedAnnotationId) { e.preventDefault(); this.deleteSelectedAnnotation(); }
            } else if (e.key === 'Escape') {
                if (this.canvasInlineTextEditor && this.canvasInlineTextEditor.style.display !== 'none') {
                    this.cancelInlineTextEditor();
                } else if (this.selectedAnnotationId) {
                    this.selectedAnnotationId = null;
                    this.updateAnnotationActionButtons();
                    this.drawCanvas();
                }
            } else if (!typing && (e.code === 'Space' || e.key === '\\')) {
                if (!this.holdingCompare) { e.preventDefault(); this.setHoldingCompare(true); }
            }
        });
        window.addEventListener('keyup', (e) => {
            if ((e.code === 'Space' || e.key === '\\') && this.holdingCompare) this.setHoldingCompare(false);
        });

        // --- 3 Tab Quy trình làm việc (Khung & Góc, Lọc & Màu sắc, Chú thích & Biên tập) ---
        on(this.btnTabCrop, 'click', () => this.setWorkflowTab(WORKFLOW_TAB.CROP));
        on(this.btnTabPageSize, 'click', () => this.setWorkflowTab(WORKFLOW_TAB.PAGESIZE));
        on(this.btnTabColor, 'click', () => this.setWorkflowTab(WORKFLOW_TAB.COLOR));
        on(this.btnTabAnnotate, 'click', () => this.setWorkflowTab(WORKFLOW_TAB.ANNOTATE));

        const bindSlider = (input, label, apply, formatter) => {
            if (!input) return;
            let startSnap = null;
            let hasChanged = false;

            const onStart = () => {
                const page = this.getActivePage();
                if (page) {
                    startSnap = this.snapshot(page);
                    hasChanged = false;
                }
            };

            on(input, 'pointerdown', onStart);
            on(input, 'keydown', (e) => {
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) {
                    if (!startSnap) onStart();
                }
            });

            on(input, 'input', (e) => {
                const page = this.getActivePage();
                if (label) label.textContent = formatter(e.target.value);
                if (!page) return;
                if (!startSnap) onStart();
                hasChanged = true;
                apply(page, e.target.value);
                if (this.viewMode !== VIEW.COMPARE) this.setViewMode(VIEW.COMPARE);
                this.requestPreview();
            });

            on(input, 'change', () => {
                const page = this.getActivePage();
                if (page && hasChanged && startSnap) {
                    page.history.undo.push({ ...startSnap, description: 'Chỉnh thanh trượt' });
                    if (page.history.undo.length > MAX_HISTORY) page.history.undo.shift();
                    page.history.redo = [];
                    this.updateHistoryButtons();
                    this.scheduleMetaSave();
                }
                startSnap = null;
                hasChanged = false;
            });
        };


        on(this.selPageSizePreset, 'change', (e) => {
            const page = this.getActivePage();
            if (!page) return;
            const val = e.target.value;
            this.pushHistory(`Chọn khổ ảnh: ${e.target.options[e.target.selectedIndex]?.text || val}`);
            page.settings.page_size_preset = val;
            this.updatePageSizeMetric(page);
            this.clearBaseline();
            this.requestPreview();
        });

        document.querySelectorAll('#segPageOrientation .ann-seg-btn').forEach(btn => {
            on(btn, 'click', () => {
                const page = this.getActivePage();
                if (!page) return;
                document.querySelectorAll('#segPageOrientation .ann-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                page.settings.page_orientation = btn.dataset.orientation;
                this.pushHistory(`Hướng trang: ${btn.textContent.trim()}`);
                this.updatePageSizeMetric(page);
                this.clearBaseline();
                this.requestPreview();
            });
        });

        document.querySelectorAll('#segPageFitMode .ann-seg-btn').forEach(btn => {
            on(btn, 'click', () => {
                const page = this.getActivePage();
                if (!page) return;
                document.querySelectorAll('#segPageFitMode .ann-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                page.settings.page_fit_mode = btn.dataset.fit;
                this.pushHistory(`Kiểu co giãn: ${btn.textContent.trim()}`);
                this.updatePageSizeMetric(page);
                this.clearBaseline();
                this.requestPreview();
            });
        });

        const step2Nudge = (dx, dy) => {
            const page = this.getActivePage();
            if (!page) return;
            const desc = dx ? (dx > 0 ? 'Giãn rộng chiều ngang ảnh 2%' : 'Thu hẹp chiều ngang ảnh 2%') : (dy > 0 ? 'Giãn rộng chiều dọc ảnh 2%' : 'Thu hẹp chiều dọc ảnh 2%');
            this.pushHistory(desc);
            if (dx) {
                const cur = Math.round((page.settings.page_scale_x ?? 1.0) * 100);
                const next = Math.max(50, Math.min(250, cur + dx));
                page.settings.page_scale_x = next / 100;
            }
            if (dy) {
                const cur = Math.round((page.settings.page_scale_y ?? 1.0) * 100);
                const next = Math.max(50, Math.min(250, cur + dy));
                page.settings.page_scale_y = next / 100;
            }
            this.syncInspector(page.settings);
            this.clearBaseline();
            this.requestPreview();
            this.scheduleMetaSave();
        };

        on(this.btnStep2ShrinkX, 'click', () => step2Nudge(-2, 0));
        on(this.btnStep2ExpandX, 'click', () => step2Nudge(+2, 0));
        on(this.btnStep2ShrinkY, 'click', () => step2Nudge(0, -2));
        on(this.btnStep2ExpandY, 'click', () => step2Nudge(0, +2));
        on(this.btnStep2ResetStretch, 'click', () => {
            const page = this.getActivePage();
            if (!page) return;
            this.pushHistory('Đặt lại tỉ lệ co giãn ảnh 100%');
            page.settings.page_scale_x = 1.0;
            page.settings.page_scale_y = 1.0;
            this.syncInspector(page.settings);
            this.clearBaseline();
            this.requestPreview();
            this.scheduleMetaSave();
        });

        bindSlider(this.rngPageMargin, this.valPageMargin,
            (p, v) => { p.settings.page_margin_pct = parseFloat(v) / 100; this.clearBaseline(); },
            (v) => `${v}%`);

        // --- Snagit Annotation Suite Events ---
        document.querySelectorAll('.ann-tool-btn').forEach(btn => {
            on(btn, 'click', () => this.setAnnTool(btn.dataset.tool));
        });
        document.querySelectorAll('.ann-color-swatch').forEach(sw => {
            on(sw, 'click', () => this.setAnnColor(sw.dataset.color));
        });
        on(this.annCustomColorPicker, 'input', (e) => this.setAnnColor(e.target.value));
        document.querySelectorAll('#segStrokeWidth .ann-seg-btn').forEach(btn => {
            on(btn, 'click', () => this.setAnnStrokeWidth(parseInt(btn.dataset.width)));
        });
        document.querySelectorAll('#segStrokeStyle .ann-seg-btn').forEach(btn => {
            on(btn, 'click', () => this.setAnnStrokeStyle(btn.dataset.style));
        });
        document.querySelectorAll('#segFontSize .ann-seg-btn').forEach(btn => {
            on(btn, 'click', () => this.setAnnFontSize(parseInt(btn.dataset.size)));
        });
        document.querySelectorAll('#segCutMode .ann-seg-btn').forEach(btn => {
            on(btn, 'click', () => this.setAnnCutMode(btn.dataset.cut));
        });
        on(this.btnResetStepCount, 'click', () => this.resetStepCount());
        on(this.btnDeleteSelectedAnn, 'click', () => this.deleteSelectedAnnotation());
        on(this.btnDuplicateSelectedAnn, 'click', () => this.duplicateSelectedAnnotation());
        on(this.btnClearAllAnn, 'click', () => this.clearAllAnnotations());

        // Inline text editor overlay
        on(this.canvasInlineTextEditor, 'blur', () => this.commitInlineTextEditor());
        on(this.canvasInlineTextEditor, 'keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.cancelInlineTextEditor();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.commitInlineTextEditor();
            }
        });
        on(this.canvasViewport, 'dblclick', (e) => this.onCanvasDoubleClick(e));

        // --- Thu phóng & kéo ---
        on(this.btnZoomIn, 'click', () => this.setZoom(this.zoom * 1.25));
        on(this.btnZoomOut, 'click', () => this.setZoom(this.zoom / 1.25));
        on(this.btnZoomFit, 'click', () => this.zoomFit());
        on(this.btnZoom100, 'click', () => this.zoom100());
        on(this.canvasViewport, 'wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.15 : 0.85;
            this.zoomAt(factor, e.clientX, e.clientY);
        }, { passive: false });

        on(this.canvasViewport, 'mousedown', (e) => this.onPointerDown(e));
        on(this.canvasViewport, 'touchstart', (e) => {
            if (e.touches.length === 1) this.onPointerDown(e.touches[0]);
        }, { passive: false });
        on(this.canvasViewport, 'touchmove', (e) => {
            if (e.touches.length === 1) {
                if (this.draggingCornerIndex !== -1 || this.isPanning || this.isSliding) e.preventDefault();
                this.onPointerMove(e.touches[0]);
            }
        }, { passive: false });
        on(this.canvasViewport, 'touchend', () => this.onPointerUp());
        window.addEventListener('mousemove', (e) => this.onPointerMove(e));
        window.addEventListener('mouseup', () => this.onPointerUp());

        // --- Công cụ ảnh ---
        on(this.btnResetToRawOriginal, 'click', () => this.resetToOriginal());
        on(this.btnResetCorners, 'click', () => this.setCornersToFullFrame());
        on(this.btnAutoDetect, 'click', () => this.autoDetectCorners());
        on(this.btnToggleBookSpread, 'click', () => this.toggleBookSpread());
        on(this.selAspectPreset, 'change', (e) => {
            const val = e.target.value;
            if (val) {
                this.applyAspectRatio(val);
                this.selAspectPreset.value = '';
            }
        });
        on(this.btnExpandX, 'click', (e) => {
            if (e.altKey || e.shiftKey) this.shrinkHorizontal();
            else this.expandHorizontal();
        });
        on(this.btnShrinkX, 'click', () => this.shrinkHorizontal());
        on(this.btnExpandY, 'click', (e) => {
            if (e.altKey || e.shiftKey) this.shrinkVertical();
            else this.expandVertical();
        });
        on(this.btnShrinkY, 'click', () => this.shrinkVertical());
        on(this.btnExpandMargin, 'click', () => this.expandMargin());
        on(this.btnShrinkMargin, 'click', () => this.shrinkMargin());
        on(this.btnRotateLeft, 'click', () => this.rotate(-90));
        on(this.btnRotateRight, 'click', () => this.rotate(90));
        on(this.btnPanelApplyAsOriginal, 'click', () => this.applyAsOriginal());

        // --- Bộ lọc & thanh trượt ---
        this.modeCards.forEach(card => {
            on(card, 'click', () => {
                const page = this.getActivePage();
                if (!page) return;
                this.pushHistory(`Đổi bộ lọc: ${card.querySelector('.mode-title')?.textContent || ''}`);
                page.settings.mode = card.dataset.mode;
                this.modeCards.forEach(c => c.classList.toggle('active', c === card));
                if (this.filterIntensityGroup) {
                    this.filterIntensityGroup.style.opacity = (card.dataset.mode === 'original') ? '0.4' : '1';
                    if (this.rngFilterIntensity) this.rngFilterIntensity.disabled = (card.dataset.mode === 'original');
                }
                if (this.viewMode !== VIEW.COMPARE) this.setViewMode(VIEW.COMPARE);
                this.requestPreview();
            });
        });


        bindSlider(this.rngFilterIntensity, this.valFilterIntensity,
            (p, v) => { p.settings.filter_intensity = v / 100; }, (v) => `${v}%`);
        bindSlider(this.rngDewarp, this.valDewarp,
            (p, v) => { p.settings.dewarp_strength = parseFloat(v); }, (v) => v);
        bindSlider(this.rngShadow, this.valShadow,
            (p, v) => { p.settings.shadow_reduction = v / 100; }, (v) => `${v}%`);
        bindSlider(this.rngSharpness, this.valSharpness,
            (p, v) => { p.settings.sharpness = v / 100; }, (v) => `${v}%`);
        bindSlider(this.rngContrast, this.valContrast,
            (p, v) => { p.settings.contrast = v / 100; }, (v) => `${v}%`);
        bindSlider(this.rngQuality, this.valQuality,
            (p, v) => {
                const q = parseInt(v, 10);
                p.settings.quality = q;
                // Cập nhật tức thời số liệu dung lượng khi đang kéo chuột/ngón tay (Zero latency)
                const base = p.baseQualitySize || p.outSize || p.editedSize || p.origSize || 0;
                const baseQ = p.baseQualityRef || 85;
                if (base > 0) {
                    p.outSize = estimateQualitySize(base, q, baseQ);
                    p.outSizeHuman = formatBytes(p.outSize);
                    this.updateMetrics(p);
                }
            }, (v) => `${v}%`);
        bindSlider(this.rngMargin, this.valMargin,
            (p, v) => { p.settings.margin_percent = parseFloat(v) / 100; },
            (v) => `${parseFloat(v).toFixed(1)}%`);

        on(this.chkDewarp, 'change', (e) => {
            this.dewarpStrengthGroup.style.display = e.target.checked ? 'flex' : 'none';
            const page = this.getActivePage();
            if (!page) return;
            this.pushHistory(e.target.checked ? 'Bật làm phẳng trang' : 'Tắt làm phẳng trang');
            page.settings.dewarp_enabled = e.target.checked;
            if (this.viewMode !== VIEW.COMPARE) this.setViewMode(VIEW.COMPARE);
            this.requestPreview();
        });

        on(this.chkNormalizeDpi, 'change', (e) => {
            const page = this.getActivePage();
            if (!page) return;
            this.pushHistory(e.target.checked ? 'Bật chuẩn hóa độ phân giải' : 'Tắt chuẩn hóa độ phân giải');
            page.settings.normalize_res = e.target.checked;
            this.markDirty(page);

            // Cập nhật dự kiến tức thì dung lượng & kích thước trên UI
            const origW = page.width || 2000;
            const origH = page.height || 2800;
            const maxDim = Math.max(origW, origH);
            if (e.target.checked && maxDim > 1800) {
                const scale = 1800.0 / maxDim;
                const newW = Math.round(origW * scale);
                const newH = Math.round(origH * scale);
                page.outDim = `${newW} × ${newH} px`;
                const pxRatio = (newW * newH) / (origW * origH);
                page.outSize = Math.max(1024, Math.round((page.outSize || page.origSize || 100000) * Math.pow(pxRatio, 0.72)));
                page.outSizeHuman = formatBytes(page.outSize);
                page.baseQualitySize = page.outSize;
            } else if (!e.target.checked) {
                page.outDim = `${origW} × ${origH} px`;
                const curMax = Math.min(1800, maxDim);
                const scaleBack = maxDim / Math.max(1, curMax);
                const pxRatio = scaleBack * scaleBack;
                page.outSize = Math.max(1024, Math.round((page.outSize || page.origSize || 100000) * Math.pow(pxRatio, 0.72)));
                page.outSizeHuman = formatBytes(page.outSize);
                page.baseQualitySize = page.outSize;
            }
            this.updateMetrics(page);
            this.requestPreview();
            this.scheduleMetaSave();
        });

        // --- Lưu & xuất trên thanh Top Bar (phục vụ trực tiếp cho trang đang mở) ---
        on(this.btnSaveToDisk, 'click', () => this.saveProject());
        on(this.btnExportPdf, 'click', () => this.exportCurrentPagePdf());
        on(this.btnStitchPdf, 'click', () => this.openStitchModal('upload'));
        on(this.btnCopyCurrent, 'click', () => this.copyCurrentPageImage());
        on(this.btnDownloadCurrent, 'click', () => this.downloadCurrentPage('jpeg'));

        // --- Xuất theo Thư mục (ở thanh công cụ Thumbnail) ---
        on(this.btnExportFolderPdf, 'click', () => this.exportFolderPdf(this.activeFolderId));
        on(this.btnStitchFolderPages, 'click', () => this.openStitchModal('folder'));
        on(this.btnDownloadFolderZip, 'click', () => this.downloadFolderZip(this.activeFolderId));
        this.initStitchPdfModal();

        // --- Chọn ảnh đa mục tiêu ---
        on(this.btnToggleSelectAll, 'click', () => this.toggleSelectAll());
        on(this.btnSelectAllPages, 'click', () => this.selectAllPages());
        on(this.btnDeselectAllPages, 'click', () => this.deselectAllPages());

        // --- Sắp xếp trang ---
        on(this.btnSortMenu, 'click', (e) => {
            e.stopPropagation();
            this.btnSortMenu.parentElement.classList.toggle('open');
        });
        this.sortDropdown?.querySelectorAll('a').forEach(item => {
            on(item, 'click', (e) => { e.preventDefault(); this.sortActiveFolder(item.dataset.sort); });
        });

        // --- Thư mục ---
        on(this.btnAddSubfolder, 'click', () => this.openFolderModal('create', this.activeFolderId));
        on(this.btnCloseFolderModal, 'click', () => this.closeFolderModal());
        on(this.btnCancelFolderModal, 'click', () => this.closeFolderModal());
        on(this.btnSubmitFolderModal, 'click', () => this.submitFolderModal());
        on(this.txtFolderModalName, 'keydown', (e) => {
            if (e.key === 'Enter') this.submitFolderModal();
            if (e.key === 'Escape') this.closeFolderModal();
        });

        // --- Chuyển ảnh sang thư mục khác ---
        on(this.btnCloseMoveModal, 'click', () => this.closeMoveModal());
        on(this.btnCancelMoveModal, 'click', () => this.closeMoveModal());
        on(this.btnSubmitMoveModal, 'click', () => this.submitMoveModal());
        on(this.btnMoveModalNewFolder, 'click', () => this.showInlineFolderBox());
        on(this.btnConfirmInlineFolder, 'click', () => this.confirmInlineFolder());
        on(this.btnCancelInlineFolder, 'click', () => this.hideInlineFolderBox());
        on(this.txtInlineNewFolder, 'keydown', (e) => {
            if (e.key === 'Enter') this.confirmInlineFolder();
            if (e.key === 'Escape') this.hideInlineFolderBox();
        });

        // --- Ảnh lẻ chưa có bản gốc ---
        on(this.btnOrphanAdopt, 'click', () => this.adoptOrphan());
        on(this.btnOrphanDelete, 'click', () => this.deleteOrphan());
        on(this.btnOrphanMoveToUnapproved, 'click', () => this.moveOrphanToUnapproved());
        on(this.btnOrphanCancel, 'click', () => this.closeOrphanPrompt(true));
        on(this.btnCloseOrphanModal, 'click', () => this.closeOrphanPrompt(true));

        window.addEventListener('resize', () => { if (this.getActivePage()) this.layoutCanvas(); });
        // Đóng tab: gửi nốt tình trạng đang chỉnh bằng sendBeacon (không chặn người dùng).
        // Không cần hộp thoại "rời trang?" vì tình trạng đã nằm trên đĩa, còn tệp ảnh nào
        // chưa kịp kết xuất lại sẽ được đánh dấu và tự lưu ở lần mở sau.
        window.addEventListener('pagehide', () => this.beaconMetadata());
    }

    // ======================================================
    // 📁 DỰ ÁN & CÂY THƯ MỤC
    // ======================================================

    async loadProject(path, notify = true) {
        if (!path) return;
        if (this.activeImageId && this.dirtyPages.has(this.activeImageId)) {
            const allowed = await this.confirmUnsavedChanges();
            if (!allowed) return;
        }
        this.showLoading('Đang mở thư mục tài liệu…');
        try {
            const data = await apiJson('/api/scan-directory', { path });

            this.rootPath = data.root_path;
            this.rootName = data.root_name;
            this.activeImageId = null;
            this.originalImg = null;
            this.editedImg = null;
            this.editorStage.style.display = 'none';
            this.emptyState.style.display = 'flex';
            this.docNameWrapper.style.display = 'none';
            if (this.btnCopyCurrent) this.btnCopyCurrent.disabled = true;
            if (this.btnDownloadCurrent) this.btnDownloadCurrent.disabled = true;
            this.updateHistoryButtons();
            localStorage.setItem('docscan_root_path', data.root_path);

            this.folders = data.folders.map(f => ({ ...f, isExpanded: true }));
            this.pages.clear();
            this.dirtyPages.clear();
            data.pages.forEach(p => {
                const page = this.toPage(p);
                this.pages.set(page.id, page);
                if (page.isStale) this.dirtyPages.add(page.id);
            });

            this.activeImageId = null;
            this.originalImg = null;
            this.editedImg = null;
            this.editorStage.style.display = 'none';
            this.emptyState.style.display = 'flex';
            this.docNameWrapper.style.display = 'none';

            this.lblRootPath.textContent = data.root_path;
            this.lblRootPath.title = data.root_path;
            this.renderFolderTree();

            const stored = localStorage.getItem('docscan_active_folder');
            const target = this.folders.find(f => f.id === stored) || this.folders.find(f => !f.parentId) || this.folders[0];
            if (target) {
                await this.selectFolder(target.id);
                const storedPage = localStorage.getItem('docscan_active_page');
                const pageIds = target.imageIds || [];
                const pageToOpen = (storedPage && pageIds.includes(storedPage)) ? storedPage : (pageIds[0] || null);
                if (pageToOpen && this.activeImageId !== pageToOpen) {
                    await this.selectPage(pageToOpen);
                }
            }

            this.updateSaveState();
            if (notify) {
                this.toastOk(`Đã mở ${data.total_folders} thư mục · ${data.total_images} trang tài liệu.`);
            }
            this.offerLegacyPdfCleanup();
        } catch (err) {
            this.toastErr(err.message);
        } finally {
            this.hideLoading();
        }
    }

    /**
     * Dọn các tệp PDF do bản trước TỰ SINH mỗi lần lưu.
     *
     * Từ nay PDF chỉ được tạo khi người dùng chủ động bấm xuất, nên những tệp cũ này
     * không còn được cập nhật và nội dung sẽ lệch dần so với ảnh trong thư mục.
     * Vì xoá tệp là việc không hoàn tác được, luôn liệt kê rõ từng tệp trước khi xoá.
     */
    async offerLegacyPdfCleanup() {
        const seenKey = `docscan_legacy_pdf_done_${this.rootPath}`;
        if (localStorage.getItem(seenKey)) return;

        let found;
        try {
            found = await apiJson('/api/legacy-pdfs', { confirm: false });
        } catch (_) { return; }

        if (!found.total) {
            localStorage.setItem(seenKey, '1');
            return;
        }

        const list = found.files
            .map(f => `• ${f.relative_path ? f.relative_path + ' / ' : ''}${f.filename}  (${f.file_size_human})`)
            .join('\n');
        const agreed = await this.askConfirm(
            'Dọn tệp PDF cũ',
            `Tìm thấy ${found.total} tệp PDF do phiên bản trước tự sinh ra mỗi lần lưu.\n\n` +
            `${list}\n\n` +
            'Từ nay PDF chỉ được tạo khi bạn chủ động bấm xuất, nên các tệp này sẽ không còn ' +
            'được cập nhật và nội dung sẽ lệch dần so với ảnh.\n\nXoá chúng khỏi ổ đĩa?',
            true, `Xoá ${found.total} tệp`, 'Giữ lại',
        );

        localStorage.setItem(seenKey, '1');
        if (!agreed) return;

        try {
            const res = await apiJson('/api/legacy-pdfs', { confirm: true });
            const failed = (res.failed || []).length;
            if (failed) {
                this.toastErr(`Đã xoá ${res.deleted} tệp, còn ${failed} tệp không xoá được.`);
            } else {
                this.toastOk(`Đã xoá ${res.deleted} tệp PDF cũ khỏi ổ đĩa.`);
            }
        } catch (err) {
            this.toastErr(err.message);
        }
    }

    /** Chuyển bản ghi từ máy chủ thành đối tượng trang của giao diện. */
    toPage(raw) {
        return {
            id: raw.id,
            filename: raw.filename,
            folderId: raw.folderId,
            relativePath: raw.relativePath || '',
            docName: raw.doc_name || raw.filename,
            width: raw.width,
            height: raw.height,
            megapixels: raw.megapixels,
            fileSize: raw.file_size,
            fileSizeHuman: raw.file_size_human,
            origSize: raw.orig_size || raw.file_size || 0,
            origSizeHuman: raw.orig_size_human || raw.file_size_human || '--',
            editedSize: raw.edited_size || raw.file_size || 0,
            editedSizeHuman: raw.edited_size_human || raw.file_size_human || '--',
            outSize: raw.edited_size || raw.file_size || 0,
            outSizeHuman: raw.edited_size_human || raw.file_size_human || '--',
            corners: raw.corners || this.fullFrameCorners(raw.width, raw.height),
            rotation: raw.rotation || 0,
            settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
            annotations: JSON.parse(JSON.stringify(raw.annotations || [])),
            history: (raw.history && (raw.history.undo || raw.history.redo))
                ? { undo: [...(raw.history.undo || [])], redo: [...(raw.history.redo || [])] }
                : { undo: [], redo: [] },
            hasOriginal: raw.has_raw_original !== false,
            isStale: raw.is_stale === true,
            version: raw.version || 0,
            nameSuggestions: raw.name_suggestions || [],
            outDim: null,
            aiDismissed: false,
            orphanHandled: false,
        };
    }

    fullFrameCorners(w, h) {
        const width = Math.max(1, w || 1);
        const height = Math.max(1, h || 1);
        return [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]];
    }

    async pickRootDirectory() {
        try {
            const data = await apiJson('/api/pick-directory');
            if (data.success && data.path) await this.loadProject(data.path, true);
        } catch (err) {
            this.toastErr(err.message);
        }
    }

    async openActiveFolderInExplorer() {
        const folder = this.getFolder(this.activeFolderId);
        try {
            await apiJson('/api/open-folder', { relative_path: folder ? folder.relativePath : '' });
        } catch (err) {
            this.toastErr(err.message);
        }
    }

    getFolder(id) { return this.folders.find(f => f.id === id); }
    getActiveFolder() { return this.getFolder(this.activeFolderId) || this.folders[0]; }
    getActivePage() { return this.activeImageId ? this.pages.get(this.activeImageId) : null; }
    getFolderChildren(id) { return this.folders.filter(f => f.parentId === id); }

    getFolderPath(folderId) {
        const folder = this.getFolder(folderId);
        return folder ? (folder.relativePath || '') : '';
    }

    getFolderBreadcrumb(folderId) {
        const parts = [];
        let cur = this.getFolder(folderId);
        while (cur) {
            parts.unshift(cur.name);
            cur = cur.parentId ? this.getFolder(cur.parentId) : null;
        }
        return parts.join(' / ');
    }

    async selectFolder(folderId) {
        if (this.activeFolderId !== folderId) {
            if (this.activeImageId && this.dirtyPages.has(this.activeImageId)) {
                const allowed = await this.confirmUnsavedChanges();
                if (!allowed) return;
            }
        }
        this.activeFolderId = folderId;
        localStorage.setItem('docscan_active_folder', folderId);
        this.renderFolderTree();
        this.updateFolderHeader();
        this.renderPageList();

        const ids = this.getFolderImageIds();
        if (!ids.includes(this.activeImageId)) {
            const storedPage = localStorage.getItem('docscan_active_page');
            const targetPageId = (storedPage && ids.includes(storedPage)) ? storedPage : (ids[0] || null);
            if (targetPageId) {
                await this.selectPage(targetPageId);
            } else {
                this.activeImageId = null;
                this.editorStage.style.display = 'none';
                this.emptyState.style.display = 'flex';
                this.docNameWrapper.style.display = 'none';
                this.updateHistoryButtons();
            }
        }
        this.updateFolderActionButtons();
    }

    getFolderImageIds() {
        const folder = this.getActiveFolder();
        return folder ? (folder.imageIds || []) : [];
    }

    renderFolderTree() {
        if (!this.folderTreeContainer) return;
        this.folderTreeContainer.innerHTML = '';
        const roots = this.folders.filter(f => !f.parentId);
        roots.forEach(root => this.renderFolderNode(root, 0, this.folderTreeContainer));
        if (this.folders.length === 0) {
            this.folderTreeContainer.innerHTML =
                '<div class="tree-empty-msg">Chưa mở thư mục nào. Nhấn <strong>Đổi</strong> để chọn thư mục tài liệu trên máy.</div>';
        }
    }

    renderFolderNode(folder, level, container) {
        const children = this.getFolderChildren(folder.id);
        const count = (folder.imageIds || []).length;
        const isActive = folder.id === this.activeFolderId;

        const node = document.createElement('div');
        node.className = `tree-node ${isActive ? 'active' : ''}`;
        node.dataset.level = Math.min(4, level);
        node.innerHTML = `
            <span class="tree-expander ${children.length ? (folder.isExpanded ? 'expanded' : '') : 'empty'}">
                <i class="fa-solid fa-chevron-right"></i>
            </span>
            <i class="tree-icon fa-solid ${folder.isUnapproved ? 'fa-inbox' : (folder.isExpanded && children.length ? 'fa-folder-open' : 'fa-folder')}"></i>
            <span class="tree-title" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</span>
            <span class="tree-badge">${count}</span>
            <span class="tree-actions">
                <button class="tree-action-btn add-sub" title="Tạo thư mục con"><i class="fa-solid fa-folder-plus"></i></button>
                <button class="tree-action-btn edit-name" title="Đổi tên thư mục"><i class="fa-solid fa-pen"></i></button>
                <button class="tree-action-btn export-pdf" title="Xuất PDF thư mục này"><i class="fa-solid fa-file-pdf"></i></button>
                <button class="tree-action-btn delete" title="Xóa thư mục khỏi máy"><i class="fa-solid fa-trash-can"></i></button>
            </span>`;

        node.addEventListener('click', () => this.selectFolder(folder.id));
        node.querySelector('.tree-expander').addEventListener('click', (e) => {
            e.stopPropagation();
            folder.isExpanded = !folder.isExpanded;
            this.renderFolderTree();
        });
        node.querySelector('.add-sub').addEventListener('click', (e) => {
            e.stopPropagation(); this.openFolderModal('create', folder.id);
        });
        node.querySelector('.edit-name').addEventListener('click', (e) => {
            e.stopPropagation(); this.openFolderModal('rename', folder.id);
        });
        node.querySelector('.export-pdf').addEventListener('click', (e) => {
            e.stopPropagation(); this.exportFolderPdf(folder.id);
        });
        node.querySelector('.delete').addEventListener('click', (e) => {
            e.stopPropagation(); this.deleteFolder(folder.id);
        });

        container.appendChild(node);
        if (folder.isExpanded) children.forEach(c => this.renderFolderNode(c, level + 1, container));
    }

    updateFolderHeader() {
        const folder = this.getActiveFolder();
        if (this.activeFolderName) {
            this.activeFolderName.textContent = folder ? folder.name : 'Thư mục gốc';
            this.activeFolderName.title = folder ? this.getFolderBreadcrumb(folder.id) : '';
        }
        if (this.pageCount) this.pageCount.textContent = folder ? (folder.imageIds || []).length : 0;
        const hasPages = folder && (folder.imageIds || []).length > 0;
        if (this.btnExportPdf) this.btnExportPdf.disabled = !hasPages;
        // Nút "Lưu thay đổi" chỉ có một quy tắc duy nhất: sáng khi còn trang chưa lưu.
        if (this.btnSaveToDisk) this.btnSaveToDisk.disabled = this.dirtyPages.size === 0;
    }

    // ======================================================
    // 🗂️ HỘP THOẠI THƯ MỤC
    // ======================================================

    openFolderModal(mode, folderId) {
        this.folderModalState = { mode, targetFolderId: folderId };
        const folder = this.getFolder(folderId);
        if (mode === 'rename') {
            if (!folder || !folder.parentId) {
                this.toastErr('Không thể đổi tên thư mục gốc của dự án.');
                return;
            }
            this.folderModalTitle.innerHTML = '<i class="fa-solid fa-pen text-accent"></i> Đổi tên thư mục';
            this.folderModalLabel.textContent = 'Tên mới của thư mục:';
            this.folderModalHint.textContent = 'Thư mục trên ổ đĩa sẽ được đổi tên ngay lập tức.';
            this.txtFolderModalName.value = folder.name;
        } else {
            this.folderModalTitle.innerHTML = '<i class="fa-solid fa-folder-plus text-accent"></i> Tạo thư mục con';
            this.folderModalLabel.textContent = `Tên thư mục con trong "${folder ? folder.name : ''}":`;
            this.folderModalHint.textContent = 'Thư mục được tạo thật trên ổ đĩa và có tệp PDF riêng.';
            this.txtFolderModalName.value = '';
        }
        this.folderNameModal.style.display = 'flex';
        setTimeout(() => this.txtFolderModalName.focus(), 50);
    }

    closeFolderModal() { this.folderNameModal.style.display = 'none'; }

    async submitFolderModal() {
        const name = this.txtFolderModalName.value.trim();
        if (!name) { this.toastErr('Vui lòng nhập tên thư mục.'); return; }
        const { mode, targetFolderId } = this.folderModalState;

        try {
            if (mode === 'rename') {
                await apiJson('/api/rename-folder', {
                    relative_path: this.getFolderPath(targetFolderId),
                    folder_name: name,
                });
                this.toastOk(`Đã đổi tên thư mục thành "${name}".`);
            } else {
                await apiJson('/api/create-folder', {
                    relative_path: this.getFolderPath(targetFolderId),
                    folder_name: name,
                });
                this.toastOk(`Đã tạo thư mục "${name}" trên máy tính.`);
            }
            this.closeFolderModal();
            await this.loadProject(this.rootPath, false);
        } catch (err) {
            this.toastErr(err.message);
        }
    }

    async deleteFolder(folderId) {
        const folder = this.getFolder(folderId);
        if (!folder || !folder.parentId) { this.toastErr('Không thể xóa thư mục gốc của dự án.'); return; }
        const count = (folder.imageIds || []).length;
        const ok = await this.askConfirm(
            `Xóa thư mục "${folder.name}"`,
            `${count} trang tài liệu, ảnh gốc và các thư mục con bên trong sẽ bị xóa vĩnh viễn khỏi máy tính.`,
            true,
            'Xóa thư mục'
        );
        if (!ok) return;

        try {
            await apiJson('/api/delete-folder', { relative_path: folder.relativePath });
            this.toastOk(`Đã xóa thư mục "${folder.name}".`);
            localStorage.removeItem('docscan_active_folder');
            localStorage.removeItem('docscan_active_page');
            await this.loadProject(this.rootPath, false);
        } catch (err) {
            this.toastErr(err.message);
        }
    }

    // ======================================================
    // 🖼️ NHẬP ẢNH
    // ======================================================

    async importFiles(files) {
        if (!files || files.length === 0) return;
        if (!this.rootPath) {
            this.toastErr('Hãy chọn thư mục tài liệu trên máy trước khi thêm ảnh.');
            return this.pickRootDirectory();
        }
        // Thêm ảnh không làm mất gì của trang đang mở, nên KHÔNG chất vấn người dùng
        // bằng hộp thoại "chưa lưu" ở đây — chỉ lặng lẽ ghi nốt rồi tiếp tục.
        // (Trước đây bấm "Thêm tài liệu" lại bị hỏi về một trang chẳng liên quan.)
        if (this.dirtyPages.size > 0) {
            await this.saveDirtyPages(true);
        }

        const folder = this.getActiveFolder();
        const relPath = folder ? folder.relativePath : '';
        const currentActiveId = this.activeImageId;

        let firstId = null;
        let added = 0;
        let overwrittenActiveId = null;

        try {
            for (const file of files) {
                // Kiểm tra xem tệp đã tồn tại trong thư mục chưa để hỏi người dùng ghi đè hay tạo bản sao
                const rawName = file.name || '';
                const fileStem = rawName.replace(/\.[^/.]+$/, "").trim().toLowerCase();
                const fileNameLower = rawName.toLowerCase();

                const existingPage = Array.from(this.pages.values()).find(p => {
                    if ((p.relativePath || '') !== (relPath || '')) return false;
                    const pFile = (p.filename || '').toLowerCase();
                    const pStem = (p.docName || pFile.replace(/\.[^/.]+$/, "")).trim().toLowerCase();
                    return pFile === fileNameLower || pStem === fileStem || pFile === `${fileStem}.jpg`;
                });

                let overwrite = false;
                if (existingPage) {
                    const wantOverwrite = await this.askConfirm(
                        'Tệp đã tồn tại trong thư mục',
                        `Tệp "${file.name}" đã có trong thư mục "${folder ? folder.name : 'gốc'}".\n\nBạn muốn GHI ĐÈ để cập nhật lại tệp này hay TẠO BẢN SAO mới (thêm hậu tố _2, _3)?`,
                        false,
                        'Ghi đè tệp này',
                        'Tạo bản sao mới'
                    );
                    overwrite = wantOverwrite;
                    if (overwrite && existingPage.id === currentActiveId) {
                        overwrittenActiveId = currentActiveId;
                    }
                }

                this.showLoading(`Đang xử lý "${file.name}" vào "${folder ? folder.name : ''}"…`);
                const form = new FormData();
                form.append('file', file);
                form.append('relative_path', relPath);
                if (overwrite) {
                    form.append('overwrite', 'true');
                }

                const res = await fetch('/api/import', { method: 'POST', body: form });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || `Không thêm được tệp "${file.name}".`);
                }
                const raw = await res.json();
                const rawList = Array.isArray(raw) ? raw : [raw];
                for (const item of rawList) {
                    const page = this.toPage(item);
                    this.pages.set(page.id, page);
                    if (folder && !folder.imageIds.includes(page.id)) folder.imageIds.push(page.id);
                    if (!firstId) firstId = page.id;
                    added++;
                }
            }

            this.renderFolderTree();
            this.updateFolderHeader();
            this.renderPageList();

            // QUAN TRỌNG: Nếu người dùng đang mở tệp chính (currentActiveId), KHÔNG tự ý cướp quyền
            // đổi sang tệp mới làm thay đổi tên tệp và gây lưu đè nhầm file.
            // Chỉ chuyển trang nếu trước đó CHƯA mở tệp nào, HOẶC tệp đang mở vừa được chọn ghi đè.
            if (!currentActiveId && firstId) {
                await this.selectPage(firstId);
            } else if (overwrittenActiveId && this.pages.has(overwrittenActiveId)) {
                this.activeImageId = null;
                await this.selectPage(overwrittenActiveId);
            }

            this.updateFolderActionButtons();
            this.toastOk(`Đã thêm ${added} trang tài liệu vào thư mục.`);
        } catch (err) {
            this.toastErr(err.message);
        } finally {
            this.hideLoading();
            this.fileInput.value = '';
            this.heroFileInput.value = '';
        }
    }

    handleClipboardPaste(e) {
        const items = (e.clipboardData || window.clipboardData)?.items;
        if (!items) return;
        const files = [];
        for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length) {
            e.preventDefault();
            this.importFiles(files);
        }
    }

    // ======================================================
    // 📑 DANH SÁCH TRANG
    // ======================================================

    thumbUrl(page) {
        return `/api/image?kind=thumb&rel=${encodeURIComponent(page.relativePath)}` +
            `&file=${encodeURIComponent(page.filename)}&v=${page.version}`;
    }

    imageUrl(page, kind) {
        return `/api/image?kind=${kind}&rel=${encodeURIComponent(page.relativePath)}` +
            `&file=${encodeURIComponent(page.filename)}&v=${page.version}`;
    }

    toggleSelectAll() {
        const ids = this.getFolderImageIds();
        if (ids.length === 0) return;
        const selectedInFolder = ids.filter(id => this.selectedPageIds.has(id));
        if (selectedInFolder.length === ids.length) {
            // Đang chọn hết -> Bỏ chọn tất cả
            ids.forEach(id => this.selectedPageIds.delete(id));
        } else {
            // Chưa chọn hết -> Chọn tất cả
            ids.forEach(id => this.selectedPageIds.add(id));
        }
        this.updateSelectionUI();
        this.renderPageList();
    }

    togglePageSelection(id, e) {
        if (e) e.stopPropagation();
        if (this.selectedPageIds.has(id)) {
            this.selectedPageIds.delete(id);
        } else {
            this.selectedPageIds.add(id);
        }
        this.updateSelectionUI();
        this.renderPageList();
    }

    selectAllPages() {
        const ids = this.getFolderImageIds();
        ids.forEach(id => this.selectedPageIds.add(id));
        this.updateSelectionUI();
        this.renderPageList();
    }

    deselectAllPages() {
        const ids = this.getFolderImageIds();
        ids.forEach(id => this.selectedPageIds.delete(id));
        this.updateSelectionUI();
        this.renderPageList();
    }

    updateSelectionUI() {
        const ids = this.getFolderImageIds();
        const selectedInFolder = ids.filter(id => this.selectedPageIds.has(id));
        const count = selectedInFolder.length;
        const allSelected = ids.length > 0 && count === ids.length;

        if (this.btnToggleSelectAll) {
            this.btnToggleSelectAll.disabled = ids.length === 0;
            this.btnToggleSelectAll.classList.toggle('active', count > 0);
            if (this.lblToggleSelectAll) {
                this.lblToggleSelectAll.textContent = allSelected ? 'Bỏ chọn' : (count > 0 ? `Bỏ chọn (${count})` : 'Chọn tất cả');
            }
            const icon = this.btnToggleSelectAll.querySelector('i');
            if (icon) {
                icon.className = allSelected ? 'fa-solid fa-square-check' : (count > 0 ? 'fa-solid fa-square-minus' : 'fa-regular fa-square-check');
            }
        }

        if (this.selectionActionBar) {
            this.selectionActionBar.style.display = count > 0 ? 'flex' : 'none';
        }
        if (this.selectionCount) {
            this.selectionCount.innerHTML = `<i class="fa-solid fa-check-double text-accent"></i> Đã chọn: <strong>${count}</strong> / ${ids.length} trang`;
        }
        if (this.lblExportPdf) {
            this.lblExportPdf.textContent = count > 0 ? `Lưu PDF (${count})` : 'Lưu PDF';
        }
        if (this.lblStitchFolder) {
            this.lblStitchFolder.textContent = count > 0 ? `Ghép ảnh (${count})` : 'Ghép 1 ảnh';
        }
        if (this.lblDownloadZip) {
            this.lblDownloadZip.textContent = count > 0 ? `Lưu ảnh (${count})` : 'Lưu ảnh';
        }

        if (this.btnExportFolderPdf) this.btnExportFolderPdf.disabled = count === 0;
        if (this.btnStitchFolderPages) this.btnStitchFolderPages.disabled = count === 0;
        if (this.btnDownloadFolderZip) this.btnDownloadFolderZip.disabled = count === 0;
    }

    updateFolderActionButtons() {
        const ids = this.getFolderImageIds();
        const hasImages = ids.length > 0;
        const selectedInFolder = ids.filter(id => this.selectedPageIds.has(id));
        const hasSelected = selectedInFolder.length > 0;
        const page = this.getActivePage();
        const hasActivePage = !!page;

        if (this.btnToggleSelectAll) this.btnToggleSelectAll.disabled = !hasImages;
        if (this.btnSortMenu) this.btnSortMenu.disabled = !hasImages;
        if (this.btnExportFolderPdf) this.btnExportFolderPdf.disabled = !hasSelected;
        if (this.btnStitchFolderPages) this.btnStitchFolderPages.disabled = !hasSelected;
        if (this.btnDownloadFolderZip) this.btnDownloadFolderZip.disabled = !hasSelected;
        if (this.btnExportPdf) this.btnExportPdf.disabled = !hasActivePage;
        if (this.btnSaveToDisk) this.btnSaveToDisk.disabled = this.dirtyPages.size === 0;
        if (this.btnCopyCurrent) this.btnCopyCurrent.disabled = !hasActivePage;
        if (this.btnDownloadCurrent) this.btnDownloadCurrent.disabled = !hasActivePage;

        // Bảng Inspector bên phải: Chỉ kích hoạt khi đang có 1 ảnh được chọn xem/sửa
        if (this.controlPanel) {
            this.controlPanel.classList.toggle('disabled', !hasActivePage);
        }

        // Floating toolbar buttons
        if (this.btnResetToRawOriginal) this.btnResetToRawOriginal.disabled = !hasActivePage;
        if (this.btnResetCorners) this.btnResetCorners.disabled = !hasActivePage;
        if (this.btnAutoDetect) this.btnAutoDetect.disabled = !hasActivePage;
        if (this.btnToggleBookSpread) {
            this.btnToggleBookSpread.disabled = !hasActivePage;
            const is6 = page && page.corners && page.corners.length === 6;
            this.btnToggleBookSpread.classList.toggle('active', !!is6);
            if (this.lblToggleBookSpread) {
                this.lblToggleBookSpread.textContent = is6 ? 'Bỏ điểm giữa (4 góc)' : '2 trang (gáy giữa)';
            }
        }
        if (this.selAspectPreset) this.selAspectPreset.disabled = !hasActivePage;
        if (this.btnExpandX) this.btnExpandX.disabled = !hasActivePage;
        if (this.btnShrinkX) this.btnShrinkX.disabled = !hasActivePage;
        if (this.btnExpandY) this.btnExpandY.disabled = !hasActivePage;
        if (this.btnShrinkY) this.btnShrinkY.disabled = !hasActivePage;
        if (this.btnExpandMargin) this.btnExpandMargin.disabled = !hasActivePage;
        if (this.btnShrinkMargin) this.btnShrinkMargin.disabled = !hasActivePage;
        if (this.btnRotateLeft) this.btnRotateLeft.disabled = !hasActivePage;
        if (this.btnRotateRight) this.btnRotateRight.disabled = !hasActivePage;
        if (this.btnPanelApplyAsOriginal) this.btnPanelApplyAsOriginal.disabled = !hasActivePage;
    }

    renderPageList() {
        if (!this.pageListContainer) return;
        const ids = this.getFolderImageIds();
        this.pageListContainer.innerHTML = '';
        if (this.pageCount) this.pageCount.textContent = ids.length;

        // Xóa các ID không còn tồn tại trong folder hiện tại
        for (const selId of this.selectedPageIds) {
            if (!ids.includes(selId)) this.selectedPageIds.delete(selId);
        }
        this.updateSelectionUI();
        this.updateFolderActionButtons();

        if (ids.length === 0) {
            this.pageListContainer.innerHTML =
                '<div class="empty-folder-msg">' +
                '<i class="fa-regular fa-images"></i>' +
                'Thư mục này chưa có trang nào.<br>Nhấn <strong>Thêm ảnh</strong> hoặc dán bằng <strong>Ctrl + V</strong>.' +
                '</div>';
            return;
        }

        ids.forEach((id, idx) => {
            const page = this.pages.get(id);
            if (!page) return;

            const isSelected = this.selectedPageIds.has(id);
            const card = document.createElement('div');
            card.className = `page-thumb-card ${id === this.activeImageId ? 'active' : ''} ${this.dirtyPages.has(id) ? 'unsaved' : ''} ${isSelected ? 'selected' : ''}`;
            card.draggable = true;
            card.dataset.imageId = id;
            card.innerHTML = `
                <div class="thumb-header">
                    <label class="thumb-checkbox-wrap" title="Chọn ảnh này">
                        <input type="checkbox" class="thumb-checkbox" ${isSelected ? 'checked' : ''}>
                    </label>
                    <span class="drag-handle" title="Kéo để đổi thứ tự trang"><i class="fa-solid fa-grip-vertical"></i></span>
                    <span class="page-index-badge">Trang ${idx + 1}</span>
                    ${page.hasOriginal ? '' : '<span class="badge-orphan" title="Chưa có ảnh gốc trong _goc/"><i class="fa-solid fa-triangle-exclamation"></i></span>'}
                </div>
                <div class="thumb-img-box">
                    <img src="${this.thumbUrl(page)}" alt="Trang ${idx + 1}" loading="lazy">
                </div>
                <div class="thumb-footer">
                    <span class="thumb-title-text" title="${escapeHtml(page.docName)}">${escapeHtml(page.docName)}</span>
                    <div class="thumb-card-actions">
                        <button class="thumb-action-btn up-btn" title="Chuyển lên trước" ${idx === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
                        <button class="thumb-action-btn down-btn" title="Chuyển xuống sau" ${idx === ids.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
                        <button class="thumb-action-btn move-btn" title="Chuyển sang thư mục khác"><i class="fa-solid fa-arrow-right-to-bracket"></i></button>
                        <button class="thumb-action-btn delete-btn" title="Xóa trang khỏi máy"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>`;

            const chk = card.querySelector('.thumb-checkbox');
            chk.addEventListener('click', (e) => e.stopPropagation());
            chk.addEventListener('change', (e) => this.togglePageSelection(id, e));

            card.addEventListener('click', (e) => {
                if (e.target.closest('.thumb-card-actions') || e.target.closest('.drag-handle') || e.target.closest('.thumb-checkbox-wrap')) return;
                this.selectPage(id);
            });

            // Nhấn giữ thumbnail để xem nhanh ảnh gốc
            const box = card.querySelector('.thumb-img-box');
            const img = box.querySelector('img');
            const holdOriginal = () => { img.src = this.imageUrl(page, 'thumb_original'); };
            const releaseOriginal = () => { img.src = this.thumbUrl(page); };
            box.addEventListener('mousedown', holdOriginal);
            box.addEventListener('mouseup', releaseOriginal);
            box.addEventListener('mouseleave', releaseOriginal);
            box.addEventListener('touchstart', holdOriginal, { passive: true });
            box.addEventListener('touchend', releaseOriginal);

            card.querySelector('.up-btn').addEventListener('click', (e) => { e.stopPropagation(); this.reorderPage(idx, idx - 1); });
            card.querySelector('.down-btn').addEventListener('click', (e) => { e.stopPropagation(); this.reorderPage(idx, idx + 1); });
            card.querySelector('.move-btn').addEventListener('click', (e) => { e.stopPropagation(); this.openMoveModal(id); });
            card.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); this.deletePage(id); });

            this.bindThumbDragDrop(card, id);
            this.pageListContainer.appendChild(card);
        });
    }

    bindThumbDragDrop(card, imageId) {
        card.addEventListener('dragstart', (e) => {
            this.draggedImageId = imageId;
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        const clearDropMarks = () => document.querySelectorAll('.page-thumb-card')
            .forEach(c => c.classList.remove('drag-over-top', 'drag-over-bottom'));

        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            clearDropMarks();
            this.draggedImageId = null;
        });
        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!this.draggedImageId || this.draggedImageId === imageId) return;
            const ids = this.getFolderImageIds();
            const before = ids.indexOf(this.draggedImageId) > ids.indexOf(imageId);
            card.classList.toggle('drag-over-top', before);
            card.classList.toggle('drag-over-bottom', !before);
        });
        card.addEventListener('dragleave', () => card.classList.remove('drag-over-top', 'drag-over-bottom'));
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            clearDropMarks();
            if (!this.draggedImageId || this.draggedImageId === imageId) return;
            const ids = this.getFolderImageIds();
            this.reorderPage(ids.indexOf(this.draggedImageId), ids.indexOf(imageId));
        });
    }

    reorderPage(from, to) {
        const folder = this.getActiveFolder();
        if (!folder) return;
        const ids = folder.imageIds;
        if (from < 0 || to < 0 || from >= ids.length || to >= ids.length || from === to) return;
        const [moved] = ids.splice(from, 1);
        ids.splice(to, 0, moved);
        this.renderPageList();
        this.saveFolderOrder(folder);
    }

    sortActiveFolder(type) {
        const folder = this.getActiveFolder();
        if (!folder) return;
        const nameOf = (id) => (this.pages.get(id)?.docName || '').toLowerCase();
        if (type === 'az') folder.imageIds.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'vi'));
        else if (type === 'za') folder.imageIds.sort((a, b) => nameOf(b).localeCompare(nameOf(a), 'vi'));
        else if (type === 'reverse') folder.imageIds.reverse();
        this.renderPageList();
        this.saveFolderOrder(folder);
        this.toastOk('Đã sắp xếp lại thứ tự trang và ghi nhớ vào thư mục.');
    }

    async saveFolderOrder(folder) {
        if (!this.rootPath) return;
        const order = (folder.imageIds || []).map(id => this.pages.get(id)?.filename).filter(Boolean);
        try {
            await apiJson('/api/save-metadata', {
                relative_path: folder.relativePath,
                pages: [],
                order,
            });
        } catch (_) { /* thứ tự sẽ được lưu lại ở lần lưu kế tiếp */ }
    }

    // ======================================================
    // 🎯 CHỌN TRANG
    // ======================================================

    async selectPage(imageId) {
        const page = this.pages.get(imageId);
        if (!page) return;

        if (this.activeImageId && this.activeImageId !== imageId && this.dirtyPages.has(this.activeImageId)) {
            const allowed = await this.confirmUnsavedChanges();
            if (!allowed) return;
        }

        this.activeImageId = imageId;
        localStorage.setItem('docscan_active_page', imageId);
        if (!page._savedSnapshot) {
            page._savedSnapshot = {
                corners: JSON.parse(JSON.stringify(page.corners || [])),
                rotation: page.rotation || 0,
                settings: JSON.parse(JSON.stringify(page.settings || {})),
                docName: page.docName || '',
                annotations: JSON.parse(JSON.stringify(page.annotations || [])),
            };
        }
        this.selectedAnnotationId = null;
        this.updateAnnotationActionButtons();
        this.emptyState.style.display = 'none';
        this.editorStage.style.display = 'flex';
        this.docNameWrapper.style.display = 'flex';
        if (this.btnCopyCurrent) this.btnCopyCurrent.disabled = false;
        this.btnDownloadCurrent.disabled = false;

        this.txtDocName.value = page.docName;
        this.renderNameSuggestions(page);

        this.syncInspector(page.settings);
        this.updateMetrics(page);
        this.updateHistoryButtons();
        this.updateFolderActionButtons();
        this.renderPageList();
        this.resetZoom();

        // Ảnh trên đĩa CHÍNH LÀ trạng thái hiện tại -> mở trang là hiển thị ngay, không xử lý lại.
        this.originalImg = null;
        this.editedImg = null;
        this.clearPreviewUrl();
        this.clearBaseline();

        try {
            const [orig, edited] = await Promise.all([
                loadImage(this.imageUrl(page, 'original')),
                loadImage(this.imageUrl(page, 'edited')).catch(() => null),
            ]);
            if (this.activeImageId !== imageId) return;
            this.originalImg = orig;
            this.editedImg = edited;
            this.layoutCanvas();
            this.ensureBaseline();
        } catch (err) {
            // Máy chủ vừa khởi động lại thì mất phiên làm việc — quét lại một lần
            // thay vì để người dùng nhìn màn hình trắng không hiểu vì sao.
            if (!this.recoveringSession && this.rootPath) {
                this.recoveringSession = true;
                await this.loadProject(this.rootPath, false);
                this.recoveringSession = false;
                const again = [...this.pages.values()].find(p =>
                    p.filename === page.filename && p.relativePath === page.relativePath);
                if (again) return this.selectPage(again.id);
            }
            this.toastErr('Không mở được ảnh của trang này trên ổ đĩa.');
        }

        if (!page.hasOriginal && !page.orphanHandled && !this.isUnapprovedFolder(page.folderId)) {
            this.openOrphanPrompt(imageId);
        }
    }

    isUnapprovedFolder(folderId) {
        const folder = this.getFolder(folderId);
        return !!(folder && folder.isUnapproved);
    }

    renderNameSuggestions(page) {
        if (!this.suggestMenu) return;
        const list = page.nameSuggestions || [];
        if (!list.length) {
            this.suggestMenu.innerHTML =
                '<div class="suggest-empty">' +
                '<i class="fa-solid fa-wand-magic-sparkles text-accent"></i> ' +
                'Chưa có gợi ý tên. Nhấn <strong>AI gợi ý tên</strong> để đọc nội dung văn bản.' +
                '</div>';
            return;
        }
        let html = '<div class="suggest-header"><i class="fa-solid fa-wand-magic-sparkles text-accent"></i> Gợi ý tên từ AI:</div>';
        html += list.map(n => `<a href="#" class="suggest-item"><i class="fa-regular fa-file-lines mr-1 text-muted"></i> ${escapeHtml(n)}</a>`).join('');
        html += '<div class="suggest-footer"><button class="btn-link-xs w-100 text-center" id="btnRerunAi"><i class="fa-solid fa-rotate mr-1"></i> Quét lại với AI</button></div>';
        this.suggestMenu.innerHTML = html;

        this.suggestMenu.querySelectorAll('.suggest-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.txtDocName.value = item.textContent.trim();
                this.suggestMenu.classList.remove('open');
                this.commitDocumentName();
            });
        });
        const rerunBtn = this.suggestMenu.querySelector('#btnRerunAi');
        if (rerunBtn) {
            rerunBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.runAiNaming();
            });
        }
    }

    // ======================================================
    // ✏️ ĐỔI TÊN TÀI LIỆU (đổi cả bộ ba)
    // ======================================================

    async commitDocumentName() {
        const page = this.getActivePage();
        if (!page) return;
        const newName = this.txtDocName.value.trim();
        if (!newName || newName === page.docName) {
            this.txtDocName.value = page.docName;
            return;
        }

        try {
            const raw = await apiJson('/api/rename-page', {
                relative_path: page.relativePath,
                filename: page.filename,
                new_name: newName,
            });

            const folder = this.getFolder(page.folderId);
            const oldId = page.id;
            const updated = this.toPage(raw);
            updated.history = page.history;
            updated.nameSuggestions = page.nameSuggestions;
            updated.orphanHandled = page.orphanHandled;

            this.pages.delete(oldId);
            this.pages.set(updated.id, updated);
            if (folder) {
                const idx = folder.imageIds.indexOf(oldId);
                if (idx >= 0) folder.imageIds[idx] = updated.id;
            }
            if (this.dirtyPages.delete(oldId)) this.dirtyPages.add(updated.id);
            this.activeImageId = updated.id;

            this.txtDocName.value = updated.docName;
            this.renderPageList();
            this.updateMetrics(updated);
            this.toastOk(`Đã đổi tên tài liệu thành “${updated.docName}” (ảnh gốc, ảnh sửa & metadata cùng đổi).`);
        } catch (err) {
            this.txtDocName.value = page.docName;
            this.toastErr(err.message);
        }
    }

    async runAiNaming() {
        const page = this.getActivePage();
        if (!page) return;
        this.showLoading('AI đang đọc nội dung tài liệu để gợi ý tên…');
        try {
            const ids = this.getFolderImageIds();
            const data = await apiJson('/api/ai-suggest-name', {
                relative_path: page.relativePath,
                filename: page.filename,
                page_index: Math.max(0, ids.indexOf(page.id)) + 1,
            });
            page.nameSuggestions = data.suggestions || [];
            this.renderNameSuggestions(page);
            if (data.primary_name) {
                this.txtDocName.value = data.primary_name;
                await this.commitDocumentName();
            }
            this.suggestMenu?.classList.add('open');
            this.toastOk('Đã nhận diện nội dung và gợi ý tên tài liệu.');
        } catch (err) {
            this.toastErr(err.message);
        } finally {
            this.hideLoading();
        }
    }

    // ======================================================
    // ⚡ XEM TRƯỚC (không chặn màn hình, hủy được)
    // ======================================================

    clearPreviewUrl() {
        if (this.previewUrl) {
            URL.revokeObjectURL(this.previewUrl);
            this.previewUrl = null;
        }
    }

    clearBaseline() {
        if (this.baselineUrl) URL.revokeObjectURL(this.baselineUrl);
        this.baselineUrl = null;
        this.baselineImg = null;
        this.baselineKey = null;
    }

    /** Khóa hình học: chỉ đổi khi 4 góc / góc xoay / làm phẳng thay đổi. */
    geometryKey(page) {
        return JSON.stringify([
            page.id, page.corners, page.rotation,
            page.settings.dewarp_enabled, page.settings.dewarp_strength,
            page.settings.page_size_preset, page.settings.page_orientation,
            page.settings.page_fit_mode, page.settings.page_margin_pct,
            page.settings.page_scale_x, page.settings.page_scale_y,
        ]);
    }

    /**
     * Dựng ảnh nền cho thanh so sánh: CÙNG khung cắt, CÙNG kích thước với bản đã sửa
     * nhưng chưa áp bộ lọc màu. Nhờ vậy kéo thanh trượt là thấy đúng tác dụng của
     * việc làm nét, thay vì so một tấm ảnh thô méo tỉ lệ với một tấm đã cắt phẳng.
     */
    async ensureBaseline() {
        const page = this.getActivePage();
        if (!page || this.viewMode !== VIEW.COMPARE) return;

        const key = this.geometryKey(page);
        if (this.baselineKey === key && this.baselineImg) return;

        try {
            const res = await fetch('/api/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    relative_path: page.relativePath,
                    filename: page.filename,
                    corners: page.corners,
                    rotation: page.rotation,
                    settings: { ...page.settings, mode: 'original', shadow_reduction: 0, sharpness: 0, contrast: 0 },
                }),
            });
            if (!res.ok) return;
            const url = URL.createObjectURL(await res.blob());
            const img = await loadImage(url);
            if (this.activeImageId !== page.id) { URL.revokeObjectURL(url); return; }
            this.clearBaseline();
            this.baselineUrl = url;
            this.baselineImg = img;
            this.baselineKey = key;
            this.drawCanvas();
        } catch (_) { /* thiếu ảnh nền thì tạm dùng ảnh gốc, không chặn thao tác */ }
    }

    markDirty(page) {
        this.dirtyPages.add(page.id);
        this.updateSaveState();
        this.updateFolderActionButtons();
        // Mọi chỉnh sửa đều phải kéo theo: ghi tình trạng (nhẹ) + hẹn giờ tự động lưu 60s.
        // Thiếu hai lời gọi này thì cam kết "tự động lưu sau 60 giây" chỉ nằm trên giấy.
        this.scheduleMetaSave();
        this.ensureAutoSaveArmed();
        const card = this.pageListContainer?.querySelector(`.page-thumb-card[data-image-id="${page.id}"]`);
        card?.classList.add('unsaved');
    }

    /** Dựng lại ảnh xem trước sau một khoảng lặng ngắn; yêu cầu cũ bị hủy ngay. */
    requestPreview() {
        const page = this.getActivePage();
        if (!page) return;
        this.markDirty(page);

        clearTimeout(this.previewTimer);
        this.previewTimer = setTimeout(() => this.renderPreview(), PREVIEW_DEBOUNCE_MS);
    }

    async renderPreview() {
        const page = this.getActivePage();
        if (!page) return;

        if (this.previewController) this.previewController.abort();
        const controller = new AbortController();
        this.previewController = controller;
        this.setProcessing(true);

        try {
            const res = await fetch('/api/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    relative_path: page.relativePath,
                    filename: page.filename,
                    corners: page.corners,
                    rotation: page.rotation,
                    settings: page.settings,
                    annotations: page.annotations || [],
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Không dựng được ảnh xem trước.');
            }

            const blob = await res.blob();
            if (this.previewController !== controller || this.activeImageId !== page.id) return;

            const url = URL.createObjectURL(blob);
            const img = await loadImage(url);
            if (this.activeImageId !== page.id) { URL.revokeObjectURL(url); return; }

            this.clearPreviewUrl();
            this.previewUrl = url;
            this.editedImg = img;

            page.outDim = `${res.headers.get('X-Out-Width')} × ${res.headers.get('X-Out-Height')} px`;
            const estSizeBytes = parseInt(res.headers.get('X-Out-Size'), 10);
            page.outSize = !isNaN(estSizeBytes) && estSizeBytes > 0 ? estSizeBytes : blob.size;
            page.outSizeHuman = formatBytes(page.outSize);
            page.baseQualitySize = page.outSize;
            page.baseQualityRef = page.settings?.quality || 85;
            this.updateMetrics(page);
            this.layoutCanvas();
            this.ensureBaseline();
        } catch (err) {
            if (err.name !== 'AbortError') this.toastErr(err.message);
        } finally {
            if (this.previewController === controller) {
                this.previewController = null;
                this.setProcessing(false);
            }
        }
    }

    setProcessing(on) {
        if (this.processingPill) this.processingPill.style.display = on ? 'inline-flex' : 'none';
    }

    // ======================================================
    // 💾 LƯU XUỐNG ĐĨA
    // ======================================================

    updateSaveState() {
        if (!this.saveStatePill) return;
        const n = this.dirtyPages.size;
        if (n === 0) {
            this.saveStatePill.className = 'save-state-pill saved';
            this.saveStatePill.innerHTML = '<i class="fa-solid fa-hard-drive"></i> Đã lưu';
        } else {
            this.saveStatePill.className = 'save-state-pill unsaved';
            this.saveStatePill.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> ${n} trang chưa lưu`;
        }
        if (this.btnSaveToDisk) this.btnSaveToDisk.disabled = n === 0;
    }

    scheduleMetaSave() {
        clearTimeout(this.metaTimer);
        this.metaTimer = setTimeout(() => this.saveMetadata(this.activeFolderId), META_SAVE_MS);
    }

    scheduleAutoSave() {
        clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = setTimeout(() => {
            this.autoSaveTimer = null;
            this.saveDirtyPages(true);
        }, AUTOSAVE_MS);
    }

    /** Còn trang chờ ghi ảnh thì luôn phải có một hẹn giờ tự động lưu đang chạy. */
    ensureAutoSaveArmed() {
        if (this.dirtyPages.size > 0 && !this.autoSaveTimer) this.scheduleAutoSave();
    }

    /** Lưu nhanh tình trạng chỉnh sửa (không kết xuất lại ảnh). */
    async saveMetadata(folderId) {
        const folder = this.getFolder(folderId);
        if (!folder || !this.rootPath) return;
        const pages = (folder.imageIds || [])
            .map(id => this.pages.get(id))
            .filter(Boolean)
            .map(p => ({
                filename: p.filename,
                doc_name: p.docName,
                corners: p.corners,
                rotation: p.rotation,
                settings: p.settings,
                annotations: p.annotations || [],
                history: p.history,
            }));
        if (!pages.length) return;

        try {
            await apiJson('/api/save-metadata', {
                relative_path: folder.relativePath,
                pages,
                order: (folder.imageIds || []).map(id => this.pages.get(id)?.filename).filter(Boolean),
            });
        } catch (_) { /* sẽ được lưu lại ở lần lưu đầy đủ kế tiếp */ }
    }

    /** Kết xuất & ghi đè ảnh đã sửa của các trang đang có thay đổi. */
    async saveDirtyPages(quiet = false) {
        if (!this.rootPath || this.dirtyPages.size === 0) return 0;
        const ids = [...this.dirtyPages];
        const byFolder = new Map();

        ids.forEach(id => {
            const page = this.pages.get(id);
            if (!page) return;
            if (!byFolder.has(page.relativePath)) byFolder.set(page.relativePath, []);
            byFolder.get(page.relativePath).push(page);
        });

        let saved = 0;
        const failures = [];
        for (const [rel, pages] of byFolder) {
            const folder = this.folders.find(f => (f.relativePath || '') === rel);
            try {
                const data = await apiJson('/api/save-folder', {
                    relative_path: rel,
                    pages: pages.map(p => this.pageStatePayload(p)),
                    // Lưu = ghi ảnh + metadata. Không ghép PDF ở đây: việc đó phải đọc lại
                    // toàn bộ ảnh của thư mục, làm mỗi lần lưu chậm dần theo số trang.
                    save_pdf: false,
                });
                // Chỉ trang nào máy chủ khẳng định đã ghi được mới coi là đã lưu. Trang ghi
                // thất bại phải GIỮ cờ "chưa lưu", nếu không người dùng thấy "Đã lưu" trong
                // khi công sức chỉnh sửa đã mất (ổ đầy, tệp bị khoá, hết quyền ghi...).
                saved += this.markPagesSaved(pages, data.saved_filenames, data.saved_details);
                (data.failed_pages || []).forEach(f => failures.push(f));
            } catch (err) {
                failures.push({ filename: '', reason: err.message });
            }
        }

        this.updateSaveState();
        this.updateFolderActionButtons();
        this.renderPageList();

        if (failures.length) {
            const reason = failures[0].reason || 'Không ghi được tệp xuống ổ đĩa.';
            this.toastErr(`Chưa lưu được ${failures.length} trang. ${reason}`);
            this.setStatus(`Còn ${this.dirtyPages.size} trang chưa lưu được — ${reason}`, 'warn');
        } else if (quiet && saved > 0) {
            this.setStatus(`Đã lưu ${saved} trang vào máy lúc ${new Date().toLocaleTimeString('vi-VN')}.`, 'ok');
        }
        return saved;
    }

    /**
     * Đánh dấu đã lưu cho đúng những trang máy chủ báo thành công.
     * savedFilenames vắng mặt thì coi như tất cả thành công (tương thích ngược).
     */
    markPagesSaved(pages, savedFilenames, savedDetails = null) {
        const ok = Array.isArray(savedFilenames) ? new Set(savedFilenames) : null;
        let count = 0;
        pages.forEach(p => {
            if (ok && !ok.has(p.filename)) return;
            p.version = Math.floor(Date.now() / 1000);
            p.isStale = false;
            p._savedSnapshot = {
                corners: JSON.parse(JSON.stringify(p.corners || [])),
                rotation: p.rotation || 0,
                settings: JSON.parse(JSON.stringify(p.settings || {})),
                docName: p.docName || '',
                annotations: JSON.parse(JSON.stringify(p.annotations || [])),
            };
            if (savedDetails && savedDetails[p.filename]) {
                const info = savedDetails[p.filename];
                p.outSize = info.file_size;
                p.outSizeHuman = info.file_size_human;
                p.editedSize = info.file_size;
                p.editedSizeHuman = info.file_size_human;
                p.baseQualitySize = info.file_size;
                p.baseQualityRef = p.settings?.quality || 85;
                if (p.id === this.activeImageId) {
                    this.updateMetrics(p);
                }
            }
            this.dirtyPages.delete(p.id);
            count++;
        });
        return count;
    }

    pageStatePayload(page) {
        return {
            filename: page.filename,
            doc_name: page.docName,
            corners: page.corners,
            rotation: page.rotation,
            settings: page.settings,
            annotations: page.annotations || [],
            history: page.history,
        };
    }

    /**
     * Nút "Lưu thay đổi": lưu mọi nhánh thư mục ĐANG CÓ thay đổi chưa ghi.
     * Cố tình không kết xuất lại những trang đã khớp đĩa — với dự án hàng trăm trang,
     * dựng lại tất cả sẽ treo máy hàng phút mà không thay đổi gì.
     */
    async saveProject() {
        if (!this.rootPath) { this.toastErr('Hãy chọn thư mục tài liệu trên máy trước.'); return; }
        if (this.dirtyPages.size === 0) {
            this.toastOk('Mọi thay đổi đã được lưu vào máy.');
            return;
        }

        const dirty = [...this.dirtyPages].map(id => this.pages.get(id)).filter(Boolean);
        const folders = this.folders
            .map(f => ({ folder: f, pages: dirty.filter(p => p.folderId === f.id) }))
            .filter(x => x.pages.length > 0)
            .map(x => ({
                relative_path: x.folder.relativePath,
                pages: x.pages.map(p => this.pageStatePayload(p)),
                save_pdf: false,
            }));

        if (folders.length === 0) {
            this.toastOk('Mọi thay đổi đã được lưu vào máy.');
            return;
        }

        this.showLoading(`Đang lưu ${dirty.length} trang vào máy tính…`);
        try {
            const data = await apiJson('/api/save-project', { folders });
            const saved = this.markPagesSaved(dirty, data.saved_filenames, data.saved_details);
            this.updateSaveState();
            this.updateFolderActionButtons();
            this.renderPageList();

            const failed = data.failed_pages || [];
            if (failed.length) {
                const reason = failed[0].reason || 'Không ghi được tệp xuống ổ đĩa.';
                this.toastErr(`Đã lưu ${saved} trang, còn ${failed.length} trang chưa lưu được. ${reason}`);
            } else {
                this.toastOk(
                    `Đã lưu ${data.pages_saved} trang trong ${data.folders_saved} thư mục vào: ` +
                    `${data.root_path}`
                );
            }
        } catch (err) {
            this.toastErr(err.message);
        } finally {
            this.hideLoading();
        }
    }

    /** Gửi tình trạng chỉnh sửa lúc đóng tab — chạy được cả khi trang đang bị hủy. */
    beaconMetadata() {
        const folder = this.getActiveFolder();
        if (!folder || !this.rootPath || !navigator.sendBeacon) return;
        const pages = (folder.imageIds || [])
            .map(id => this.pages.get(id)).filter(Boolean)
            .map(p => this.pageStatePayload(p));
        if (!pages.length) return;
        const body = JSON.stringify({
            relative_path: folder.relativePath,
            pages,
            order: (folder.imageIds || []).map(id => this.pages.get(id)?.filename).filter(Boolean),
        });
        navigator.sendBeacon('/api/save-metadata', new Blob([body], { type: 'application/json' }));
    }

    // ======================================================
    // 🧭 CÔNG CỤ CHỈNH ẢNH
    // ======================================================

    /** Đảm bảo đang ở chế độ Chỉnh sửa để người dùng thấy ngay khung 4 góc vừa thay đổi. */
    ensureCornerView() {
        if (this.viewMode !== VIEW.EDIT) this.setViewMode(VIEW.EDIT);
        this.showHandles = true;
    }

    async autoDetectCorners() {
        const page = this.getActivePage();
        if (!page) return;
        this.ensureCornerView();
        this.pushHistory('Tự động nhận diện 4 góc');
        try {
            const data = await apiJson('/api/auto-detect', {
                relative_path: page.relativePath,
                filename: page.filename,
                margin_percent: 0.0,
            });
            page.corners = data.corners;
            this.updateFolderActionButtons();
            this.drawCanvas();
            this.requestPreview();
            this.toastOk(data.detected
                ? 'Đã nhận diện chính xác mép giấy.'
                : 'Không thấy mép giấy rõ ràng — đã căn toàn bộ trang.');
        } catch (err) {
            this.toastErr(err.message);
        }
    }

    applyAspectRatio(presetKey) {
        const page = this.getActivePage();
        if (!page || !page.corners || page.corners.length < 4) return;
        this.ensureCornerView();

        const pts = page.corners;
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const rot = (page.rotation || 0) % 360;
        const isSwapped = (rot === 90 || rot === 270);

        // Đo kích thước khung hiện tại trên màn hình
        let curW, curH;
        if (isSwapped) {
            const minX = Math.min(...pts.map(p => p[1]));
            const maxX = Math.max(...pts.map(p => p[1]));
            const minY = Math.min(...pts.map(p => p[0]));
            const maxY = Math.max(...pts.map(p => p[0]));
            curW = Math.max(1, maxX - minX);
            curH = Math.max(1, maxY - minY);
        } else {
            const minX = Math.min(...pts.map(p => p[0]));
            const maxX = Math.max(...pts.map(p => p[0]));
            const minY = Math.min(...pts.map(p => p[1]));
            const maxY = Math.max(...pts.map(p => p[1]));
            curW = Math.max(1, maxX - minX);
            curH = Math.max(1, maxY - minY);
        }

        const isLandscape = curW >= curH;
        let targetRatio = 1.0;
        let ratioName = '1:1';

        switch (presetKey) {
            case 'a4':
                targetRatio = isLandscape ? Math.SQRT2 : (1 / Math.SQRT2);
                ratioName = isLandscape ? 'A4 ngang (1.41:1)' : 'A4 đứng (1:1.41)';
                break;
            case 'a4_portrait':
                targetRatio = 1 / Math.SQRT2;
                ratioName = 'A4 đứng (1:1.41)';
                break;
            case 'a4_landscape':
                targetRatio = Math.SQRT2;
                ratioName = 'A4 ngang (1.41:1)';
                break;
            case '2:3':
                targetRatio = isLandscape ? (3 / 2) : (2 / 3);
                ratioName = isLandscape ? '3:2 ngang' : '2:3 đứng';
                break;
            case '2:3_portrait':
                targetRatio = 2 / 3;
                ratioName = '2:3 đứng';
                break;
            case '3:2_landscape':
                targetRatio = 3 / 2;
                ratioName = '3:2 ngang';
                break;
            case '16:9':
                targetRatio = isLandscape ? (16 / 9) : (9 / 16);
                ratioName = isLandscape ? '16:9 ngang' : '9:16 đứng';
                break;
            case '16:9_landscape':
                targetRatio = 16 / 9;
                ratioName = '16:9 ngang';
                break;
            case '9:16_portrait':
                targetRatio = 9 / 16;
                ratioName = '9:16 đứng';
                break;
            case '4:3':
                targetRatio = isLandscape ? (4 / 3) : (3 / 4);
                ratioName = isLandscape ? '4:3 ngang' : '3:4 đứng';
                break;
            case '4:3_landscape':
                targetRatio = 4 / 3;
                ratioName = '4:3 ngang';
                break;
            case '3:4_portrait':
                targetRatio = 3 / 4;
                ratioName = '3:4 đứng';
                break;
            case '1:1':
                targetRatio = 1.0;
                ratioName = '1:1 vuông';
                break;
            default:
                return;
        }

        this.pushHistory(`Căn tỉ lệ ${ratioName}`);

        const curRatio = curW / curH;
        let scaleW = 1.0;
        let scaleH = 1.0;

        // Giãn rộng chiều thiếu để đạt tỉ lệ chuẩn mà không làm mất nội dung đã chọn
        if (curRatio < targetRatio) {
            scaleW = targetRatio / curRatio;
        } else {
            scaleH = curRatio / targetRatio;
        }

        if (isSwapped) {
            // Khi xoay 90°/270°, chiều ngang màn hình ứng với tọa độ Y của ảnh gốc
            page.corners = pts.map(([x, y]) => [
                cx + (x - cx) * scaleH,
                cy + (y - cy) * scaleW,
            ]);
        } else {
            page.corners = pts.map(([x, y]) => [
                cx + (x - cx) * scaleW,
                cy + (y - cy) * scaleH,
            ]);
        }

        this.drawCanvas();
        this.requestPreview();
        this.toastOk(`Đã giãn khung theo tỉ lệ ${ratioName}.`);
    }

    expandHorizontal(margin = 0.02) {
        const page = this.getActivePage();
        if (!page || !page.corners) return;
        this.ensureCornerView();
        this.pushHistory('Giãn rộng chiều ngang 2%');

        const pts = page.corners;
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const factor = 1 + margin * 2;
        const rot = (page.rotation || 0) % 360;
        const isSwapped = (rot === 90 || rot === 270);

        if (isSwapped) {
            page.corners = pts.map(([x, y]) => [x, cy + (y - cy) * factor]);
        } else {
            page.corners = pts.map(([x, y]) => [cx + (x - cx) * factor, y]);
        }

        this.drawCanvas();
        this.requestPreview();
        this.toastOk('Đã giãn rộng chiều ngang 2%.');
    }

    shrinkHorizontal(margin = 0.02) {
        const page = this.getActivePage();
        if (!page || !page.corners) return;
        this.ensureCornerView();
        this.pushHistory('Thu hẹp chiều ngang 2%');

        const pts = page.corners;
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const factor = 1 - margin * 2;
        const rot = (page.rotation || 0) % 360;
        const isSwapped = (rot === 90 || rot === 270);

        if (isSwapped) {
            page.corners = pts.map(([x, y]) => [x, cy + (y - cy) * factor]);
        } else {
            page.corners = pts.map(([x, y]) => [cx + (x - cx) * factor, y]);
        }

        this.drawCanvas();
        this.requestPreview();
        this.toastOk('Đã thu hẹp chiều ngang 2%.');
    }

    expandVertical(margin = 0.02) {
        const page = this.getActivePage();
        if (!page || !page.corners) return;
        this.ensureCornerView();
        this.pushHistory('Giãn rộng chiều dọc 2%');

        const pts = page.corners;
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const factor = 1 + margin * 2;
        const rot = (page.rotation || 0) % 360;
        const isSwapped = (rot === 90 || rot === 270);

        if (isSwapped) {
            page.corners = pts.map(([x, y]) => [cx + (x - cx) * factor, y]);
        } else {
            page.corners = pts.map(([x, y]) => [x, cy + (y - cy) * factor]);
        }

        this.drawCanvas();
        this.requestPreview();
        this.toastOk('Đã giãn rộng chiều dọc 2%.');
    }

    shrinkVertical(margin = 0.02) {
        const page = this.getActivePage();
        if (!page || !page.corners) return;
        this.ensureCornerView();
        this.pushHistory('Thu hẹp chiều dọc 2%');

        const pts = page.corners;
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const factor = 1 - margin * 2;
        const rot = (page.rotation || 0) % 360;
        const isSwapped = (rot === 90 || rot === 270);

        if (isSwapped) {
            page.corners = pts.map(([x, y]) => [cx + (x - cx) * factor, y]);
        } else {
            page.corners = pts.map(([x, y]) => [x, cy + (y - cy) * factor]);
        }

        this.drawCanvas();
        this.requestPreview();
        this.toastOk('Đã thu hẹp chiều dọc 2%.');
    }

    expandMargin(margin = 0.02) {
        const page = this.getActivePage();
        if (!page || !page.corners) return;
        this.ensureCornerView();
        this.pushHistory('Mở rộng lề 2%');

        const pts = page.corners;
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const factor = 1 + margin * 2;
        page.corners = pts.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);

        this.drawCanvas();
        this.requestPreview();
        this.toastOk('Đã mở rộng lề 2%.');
    }

    shrinkMargin(margin = 0.02) {
        const page = this.getActivePage();
        if (!page || !page.corners) return;
        this.ensureCornerView();
        this.pushHistory('Thu hẹp lề 2%');

        const pts = page.corners;
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const factor = 1 - margin * 2;
        page.corners = pts.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);

        this.drawCanvas();
        this.requestPreview();
        this.toastOk('Đã thu hẹp lề 2%.');
    }

    toggleBookSpread() {
        const page = this.getActivePage();
        if (!page) return;
        this.ensureCornerView();
        const corners = page.corners || this.fullFrameCorners(page.width, page.height);

        if (corners.length === 6) {
            this.pushHistory('Chuyển về 4 góc (1 trang)');
            // Giữ lại 4 góc ngoài: TL (0), TR (2), BR (3), BL (5)
            page.corners = [corners[0], corners[2], corners[3], corners[5]];
            this.toastOk('Đã chuyển về chế độ 4 góc đơn trang.');
        } else {
            this.pushHistory('Thêm 2 điểm giữa (2 trang / Sách / Hộ chiếu)');
            const [tl, tr, br, bl] = corners.length === 4 ? corners : this.fullFrameCorners(page.width, page.height);
            const tm = [Math.round((tl[0] + tr[0]) / 2), Math.round((tl[1] + tr[1]) / 2)];
            const bm = [Math.round((bl[0] + br[0]) / 2), Math.round((bl[1] + br[1]) / 2)];
            page.corners = [tl, tm, tr, br, bm, bl];
            this.toastOk('Đã thêm 2 điểm gáy giữa. Hãy kéo 2 điểm màu cam vào nếp gấp giữa 2 trang.');
        }

        this.updateFolderActionButtons();
        this.drawCanvas();
        this.requestPreview();
        this.scheduleMetaSave();
    }

    setCornersToFullFrame() {
        const page = this.getActivePage();
        if (!page) return;
        this.ensureCornerView();
        this.pushHistory('Bao trọn toàn ảnh');
        if (page.corners && page.corners.length === 6) {
            const w = Math.max(1, page.width || 1);
            const h = Math.max(1, page.height || 1);
            page.corners = [
                [0, 0],
                [Math.round((w - 1) / 2), 0],
                [w - 1, 0],
                [w - 1, h - 1],
                [Math.round((w - 1) / 2), h - 1],
                [0, h - 1],
            ];
            this.toastOk('Đã đặt 6 điểm bao trọn toàn bộ ảnh.');
        } else {
            page.corners = this.fullFrameCorners(page.width, page.height);
            this.toastOk('Đã đặt 4 góc bao trọn toàn bộ ảnh.');
        }
        this.updateFolderActionButtons();
        this.drawCanvas();
        this.requestPreview();
    }

    async resetToOriginal() {
        const page = this.getActivePage();
        if (!page) return;
        const ok = await this.askConfirm(
            'Khôi phục về ảnh chụp gốc',
            'Mọi góc cắt, góc xoay và bộ lọc đang áp dụng sẽ được đặt lại về ảnh chụp gốc ban đầu.',
            false,
            'Khôi phục',
            'Giữ nguyên'
        );
        if (!ok) return;

        this.pushHistory('Khôi phục về ảnh gốc');
        page.rotation = 0;
        page.settings = { ...DEFAULT_SETTINGS };
        page.corners = this.fullFrameCorners(page.width, page.height);
        this.updateFolderActionButtons();
        this.syncInspector(page.settings);
        this.clearBaseline();
        this.drawCanvas();
        this.requestPreview();
        this.toastOk('Đã khôi phục trang về ảnh chụp gốc ban đầu.');
    }

    rotate(deg) {
        const page = this.getActivePage();
        if (!page) return;
        this.pushHistory(deg < 0 ? 'Xoay trái 90°' : 'Xoay phải 90°');
        page.rotation = (page.rotation + deg + 360) % 360;
        this.clearBaseline();
        this.drawCanvas();
        this.requestPreview();
    }

    async applyAsOriginal() {
        const page = this.getActivePage();
        if (!page) return;
        const ok = await this.askConfirm(
            'Lưu ảnh sửa thành ảnh gốc',
            `Bạn đang lưu bản ảnh đang sửa thành ảnh gốc cho tệp:\n"${page.filename}"\n\nẢnh gốc cũ trong thư mục _goc/ sẽ được thay thế bằng bản ảnh nét hiện tại và lịch sử hoàn tác được làm mới. Bạn vẫn tiếp tục chỉnh sửa được trên nền ảnh mới.`,
            false,
            'Lưu thành ảnh gốc',
            'Hủy'
        );
        if (!ok) return;

        this.showLoading('Đang lưu ảnh sửa thành ảnh gốc…');
        try {
            await this.saveDirtyPages(true);
            const raw = await apiJson('/api/apply-as-original', {
                relative_path: page.relativePath,
                filename: page.filename,
            });
            const updated = this.toPage(raw);
            updated.nameSuggestions = page.nameSuggestions;
            updated.aiDismissed = page.aiDismissed;
            updated.orphanHandled = true;
            this.pages.set(updated.id, updated);
            this.dirtyPages.delete(updated.id);

            this.activeImageId = null;
            await this.selectPage(updated.id);
            this.updateSaveState();
            this.toastOk(`Đã lưu ảnh sửa thành ảnh gốc cho tệp "${updated.filename}".`);
        } catch (err) {
            this.toastErr(err.message);
        } finally {
            this.hideLoading();
        }
    }

    // ======================================================
    // ⏪ HOÀN TÁC / LÀM LẠI
    // ======================================================

    snapshot(page) {
        return {
            corners: JSON.parse(JSON.stringify(page.corners)),
            rotation: page.rotation,
            settings: { ...page.settings },
            annotations: JSON.parse(JSON.stringify(page.annotations || [])),
            stepCount: this.annStepCount,
        };
    }

    pushHistory(description = '') {
        const page = this.getActivePage();
        if (!page) return;
        page.history.undo.push({ ...this.snapshot(page), description });
        if (page.history.undo.length > MAX_HISTORY) page.history.undo.shift();
        page.history.redo = [];
        this.updateHistoryButtons();
        this.scheduleMetaSave();
    }

    applySnapshot(page, snap) {
        page.corners = JSON.parse(JSON.stringify(snap.corners));
        page.rotation = snap.rotation;
        page.settings = { ...DEFAULT_SETTINGS, ...snap.settings };
        page.annotations = JSON.parse(JSON.stringify(snap.annotations || []));
        if (snap.stepCount !== undefined) {
            this.annStepCount = snap.stepCount;
            if (this.lblNextStepNum) this.lblNextStepNum.textContent = String(this.annStepCount);
        }
        this.selectedAnnotationId = null;
        this.syncInspector(page.settings);
        if (this.viewMode === VIEW.COMPARE) {
            this.ensureBaseline();
        }
        this.layoutCanvas();
        this.drawCanvas();
        this.requestPreview();
        this.updateHistoryButtons();
        this.updateFolderActionButtons();
        this.updateAnnotationActionButtons();
    }

    undo() {
        const page = this.getActivePage();
        if (!page || !page.history || page.history.undo.length === 0) return;
        const currentSnap = this.snapshot(page);
        const prev = page.history.undo.pop();
        page.history.redo.push({ ...currentSnap, description: prev.description || '' });
        this.applySnapshot(page, prev);
        this.setStatus(`Đã hoàn tác: ${prev.description || 'thao tác trước'}`, 'info');
    }

    redo() {
        const page = this.getActivePage();
        if (!page || !page.history || page.history.redo.length === 0) return;
        const currentSnap = this.snapshot(page);
        const next = page.history.redo.pop();
        page.history.undo.push({ ...currentSnap, description: next.description || '' });
        this.applySnapshot(page, next);
        this.setStatus(`Đã làm lại: ${next.description || 'thao tác'}`, 'info');
    }

    updateHistoryButtons() {
        const page = this.getActivePage();
        const hasPage = !!page;
        const undoLen = (page && page.history && Array.isArray(page.history.undo)) ? page.history.undo.length : 0;
        const redoLen = (page && page.history && Array.isArray(page.history.redo)) ? page.history.redo.length : 0;

        if (this.btnUndo) this.btnUndo.disabled = !hasPage || undoLen === 0;
        if (this.btnRedo) this.btnRedo.disabled = !hasPage || redoLen === 0;
    }

    // ======================================================
    // 🎨 KHUNG XEM CANVAS
    // ======================================================

    setWorkflowTab(tab) {
        this.activeTab = tab;
        this.btnTabCrop?.classList.toggle('active', tab === WORKFLOW_TAB.CROP);
        this.btnTabPageSize?.classList.toggle('active', tab === WORKFLOW_TAB.PAGESIZE);
        this.btnTabColor?.classList.toggle('active', tab === WORKFLOW_TAB.COLOR);
        this.btnTabAnnotate?.classList.toggle('active', tab === WORKFLOW_TAB.ANNOTATE);

        if (this.annotationBarContainer) {
            this.annotationBarContainer.style.display = (tab === WORKFLOW_TAB.ANNOTATE) ? 'flex' : 'none';
        }

        const floatingToolbar = document.querySelector('.floating-toolbar');
        if (floatingToolbar) {
            floatingToolbar.style.display = (tab === WORKFLOW_TAB.CROP) ? 'flex' : 'none';
        }

        // Tự động cuộn đến phần điều khiển tương ứng trên bảng bên phải
        if (tab === WORKFLOW_TAB.PAGESIZE && this.sectionPageSize) {
            this.sectionPageSize.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else if (tab === WORKFLOW_TAB.COLOR) {
            const colorSec = $('sectionColorFilter');
            if (colorSec) colorSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        if (tab === WORKFLOW_TAB.CROP) {
            this.viewMode = VIEW.EDIT;
            this.showHandles = true;
        } else if (tab === WORKFLOW_TAB.PAGESIZE) {
            this.viewMode = VIEW.COMPARE;
            this.showHandles = false;
            this.ensureBaseline();
        } else if (tab === WORKFLOW_TAB.COLOR) {
            this.viewMode = VIEW.COMPARE;
            this.showHandles = false;
            this.ensureBaseline();
        } else if (tab === WORKFLOW_TAB.ANNOTATE) {
            this.viewMode = VIEW.ANNOTATE;
            this.showHandles = false;
        }

        this.btnModeEdit?.classList.toggle('active', this.viewMode === VIEW.EDIT);
        this.btnModeCompare?.classList.toggle('active', this.viewMode === VIEW.COMPARE);
        this.layoutCanvas();
    }

    updatePageSizeMetric(page) {
        if (!this.lblPageSizeMetric || !page) return;
        const preset = page.settings.page_size_preset || 'original';
        const labels = {
            'original': 'Khổ gốc: Tự do theo góc cắt',
            'a4': 'A4: 210 × 297 mm (Chuẩn văn bản & In ấn)',
            'a5': 'A5: 148 × 210 mm (Sổ tay)',
            'a3': 'A3: 297 × 420 mm (Bản vẽ lớn)',
            'letter': 'Letter: 8.5 × 11 in (216 × 279 mm)',
            'passport': 'Passport: 35 × 45 mm (Ảnh thẻ hộ chiếu)',
            'passport_4x6': 'Ảnh thẻ: 4 × 6 cm',
            'passport_spread': 'Hộ chiếu 2 trang mở: 125 × 176 mm',
            'id_card': 'Căn cước công dân / Bằng lái: 85.6 × 54 mm',
            'ratio_2_3': 'Tỉ lệ 2:3 / 3:2 (Chuẩn ảnh chụp)',
            'ratio_16_9': 'Tỉ lệ 16:9 (Màn hình rộng / Slide)',
            'ratio_4_3': 'Tỉ lệ 4:3 (Tài liệu / iPad)',
            'ratio_1_1': 'Tỉ lệ 1:1 (Vuông)',
        };
        const orient = page.settings.page_orientation || 'auto';
        const orientText = orient === 'portrait' ? ' [Dọc]' : (orient === 'landscape' ? ' [Ngang]' : '');
        const sx = Math.round((page.settings.page_scale_x ?? 1.0) * 100);
        const sy = Math.round((page.settings.page_scale_y ?? 1.0) * 100);
        let stretchInfo = '';
        if (sx !== 100 || sy !== 100) {
            stretchInfo = ` [Co giãn: X ${sx}% · Y ${sy}%]`;
        }
        const fitInfo = (page.settings.page_fit_mode === 'crop') ? ' · Cắt xén' : (preset !== 'original' ? ' · Co giãn phủ kín' : '');
        this.lblPageSizeMetric.textContent = (labels[preset] || 'Khổ chuẩn') + orientText + fitInfo + stretchInfo;
    }

    setViewMode(mode) {
        if (mode === VIEW.EDIT) this.setWorkflowTab(WORKFLOW_TAB.CROP);
        else if (mode === VIEW.COMPARE) this.setWorkflowTab(WORKFLOW_TAB.COLOR);
        else if (mode === VIEW.ANNOTATE) this.setWorkflowTab(WORKFLOW_TAB.ANNOTATE);
    }

    setHoldingCompare(on) {
        if (this.holdingCompare === on) return;
        this.holdingCompare = on;
        this.layoutCanvas();
    }

    isShowingOriginal() {
        return this.holdingCompare || (this.viewMode === VIEW.EDIT && this.activeTab === WORKFLOW_TAB.CROP) || !this.editedImg;
    }

    layoutCanvas() {
        const page = this.getActivePage();
        if (!page || !this.originalImg) return;

        const rect = this.canvasViewport.getBoundingClientRect();
        const availWidth = Math.max(200, (rect.width || 800) - 40);
        const availHeight = Math.max(200, (rect.height || 600) - 40);

        const showingOriginal = this.isShowingOriginal();
        const displayImg = showingOriginal ? this.originalImg : this.editedImg;
        // Khi căn 4 góc cần chừa lề để kéo góc ra ngoài mép ảnh.
        const padRatio = showingOriginal ? this.canvasPaddingRatio : 0.04;

        const rot = (showingOriginal && page.rotation) ? (page.rotation % 360) : 0;
        const isSwapped = (rot === 90 || rot === 270);
        let origW = (displayImg.naturalWidth || displayImg.width || 1000);
        let origH = (displayImg.naturalHeight || displayImg.height || 1000);
        if (showingOriginal && isSwapped) {
            const tmp = origW; origW = origH; origH = tmp;
        }
        const aspect = origW / origH;
        const screenAspect = availWidth / availHeight;

        let renderW, renderH;
        if (aspect > screenAspect) {
            renderW = availWidth / (1 + padRatio * 2);
            renderH = renderW / aspect;
        } else {
            renderH = availHeight / (1 + padRatio * 2);
            renderW = renderH * aspect;
        }

        this.imgOffsetX = renderW * padRatio;
        this.imgOffsetY = renderH * padRatio;
        this.imgRenderW = renderW;
        this.imgRenderH = renderH;

        // Đệm vẽ độ phân giải cao để phóng to vẫn sắc nét.
        const nativeW = displayImg.naturalWidth || displayImg.width || 2000;
        this.dpr = Math.min(3.0, Math.max(1.5, nativeW / renderW));

        const cssW = Math.round(renderW + this.imgOffsetX * 2);
        const cssH = Math.round(renderH + this.imgOffsetY * 2);
        this.canvas.width = Math.round(cssW * this.dpr);
        this.canvas.height = Math.round(cssH * this.dpr);
        this.canvas.style.width = `${cssW}px`;
        this.canvas.style.height = `${cssH}px`;

        this.scaleX = renderW / page.width;
        this.scaleY = renderH / page.height;

        this.drawCanvas();
    }

    drawCanvas() {
        const page = this.getActivePage();
        if (!page || !this.originalImg) return;

        const ctx = this.ctx;
        const dpr = this.dpr || 1;
        const totalW = this.canvas.width / dpr;
        const totalH = this.canvas.height / dpr;

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, totalW, totalH);
        ctx.fillStyle = '#090d16';
        ctx.fillRect(0, 0, totalW, totalH);

        const showingOriginal = this.isShowingOriginal();
        const comparing = !showingOriginal && this.viewMode === VIEW.COMPARE && this.editedImg;

        if (showingOriginal) {
            const rot = (page.rotation || 0) % 360;
            ctx.save();
            if (rot) {
                const cx = this.imgOffsetX + this.imgRenderW / 2;
                const cy = this.imgOffsetY + this.imgRenderH / 2;
                ctx.translate(cx, cy);
                ctx.rotate((rot * Math.PI) / 180);
                if (rot === 90 || rot === 270) {
                    ctx.drawImage(this.originalImg, -this.imgRenderH / 2, -this.imgRenderW / 2, this.imgRenderH, this.imgRenderW);
                } else {
                    ctx.drawImage(this.originalImg, -this.imgRenderW / 2, -this.imgRenderH / 2, this.imgRenderW, this.imgRenderH);
                }
                if (this.showHandles) this.drawCropOverlay(ctx, page, true);
            } else {
                ctx.drawImage(this.originalImg, this.imgOffsetX, this.imgOffsetY, this.imgRenderW, this.imgRenderH);
                if (this.showHandles) this.drawCropOverlay(ctx, page, false);
            }
            ctx.restore();
            this.setStatus(this.holdingCompare
                ? 'Đang giữ để xem ảnh gốc — thả ra để về bản so sánh.'
                : 'Chế độ Chỉnh sửa — kéo 4 chấm tròn để căn đúng mép giấy.', 'warn');
        } else if (comparing) {
            const sliderX = this.imgOffsetX + this.imgRenderW * this.sliderPos;

            this.drawContain(ctx, this.editedImg, this.imgOffsetX, this.imgOffsetY, this.imgRenderW, this.imgRenderH);
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, sliderX, totalH);
            ctx.clip();
            this.drawContain(ctx, this.baselineImg || this.originalImg,
                this.imgOffsetX, this.imgOffsetY, this.imgRenderW, this.imgRenderH);
            ctx.restore();

            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 8;
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(sliderX, this.imgOffsetY);
            ctx.lineTo(sliderX, this.imgOffsetY + this.imgRenderH);
            ctx.stroke();

            const handleY = this.imgOffsetY + this.imgRenderH / 2;
            ctx.beginPath();
            ctx.arc(sliderX, handleY, 18, 0, Math.PI * 2);
            ctx.fillStyle = '#38bdf8';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2.5;
            ctx.stroke();
            ctx.fillStyle = '#0b1120';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('◀ ▶', sliderX, handleY);
            ctx.restore();

            this.drawComparePills(ctx, sliderX, this.imgOffsetY + 16);
            this.setStatus('Chế độ So sánh — kéo thanh trượt để xem chi tiết Trước và Sau.', 'ok');
        } else {
            ctx.drawImage(this.editedImg, this.imgOffsetX, this.imgOffsetY, this.imgRenderW, this.imgRenderH);
            if (this.activeTab === WORKFLOW_TAB.ANNOTATE) {
                this.setStatus('Bước 3: Chú thích & Biên tập — Chọn công cụ để vẽ hình, mũi tên, vệt dạ quang, chữ, làm mờ.', 'ok');
            } else {
                this.setStatus('Bản đã chỉnh sửa — chữ đã được làm nét và cân bằng ánh sáng.', 'ok');
            }
        }

        // Vẽ lớp Vector Annotations lên trên ảnh tài liệu
        if (!showingOriginal) {
            this.drawAnnotationsLayer(ctx, page);
        }

        ctx.restore();
    }

    drawCropOverlay(ctx, page, isRotatedContext = false) {
        const corners = page.corners || this.fullFrameCorners(page.width, page.height);
        const rot = (page.rotation || 0) % 360;
        const isSwapped = (rot === 90 || rot === 270);
        const drawW = isSwapped ? this.imgRenderH : this.imgRenderW;
        const drawH = isSwapped ? this.imgRenderW : this.imgRenderH;
        const originX = isRotatedContext ? -drawW / 2 : this.imgOffsetX;
        const originY = isRotatedContext ? -drawH / 2 : this.imgOffsetY;
        const scaleX = drawW / page.width;
        const scaleY = drawH / page.height;

        const pts = corners.map(([x, y]) => [
            originX + x * scaleX,
            originY + y * scaleY,
        ]);

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();

        ctx.fillStyle = 'rgba(56, 189, 248, 0.10)';
        ctx.fill();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.stroke();

        if (pts.length === 6) {
            // Điểm giữa: pts[1] là Gáy trên, pts[4] là Gáy dưới
            // Vẽ đường trục gáy sách / nếp gấp giữa hai trang
            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([6, 4]);
            ctx.moveTo(pts[1][0], pts[1][1]);
            ctx.lineTo(pts[4][0], pts[4][1]);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 2.5;
            ctx.stroke();
            ctx.restore();

            // Vẽ lưới 1/2 cho trang trái và trang phải
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
            ctx.lineWidth = 1;
            // Trang trái: [0 (TL), 1 (TM), 4 (BM), 5 (BL)]
            const topL = this.lerp(pts[0], pts[1], 0.5);
            const botL = this.lerp(pts[5], pts[4], 0.5);
            const midLL = this.lerp(pts[0], pts[5], 0.5);
            const midLR = this.lerp(pts[1], pts[4], 0.5);
            ctx.beginPath(); ctx.moveTo(topL[0], topL[1]); ctx.lineTo(botL[0], botL[1]); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(midLL[0], midLL[1]); ctx.lineTo(midLR[0], midLR[1]); ctx.stroke();

            // Trang phải: [1 (TM), 2 (TR), 3 (BR), 4 (BM)]
            const topR = this.lerp(pts[1], pts[2], 0.5);
            const botR = this.lerp(pts[4], pts[3], 0.5);
            const midRL = this.lerp(pts[1], pts[4], 0.5);
            const midRR = this.lerp(pts[2], pts[3], 0.5);
            ctx.beginPath(); ctx.moveTo(topR[0], topR[1]); ctx.lineTo(botR[0], botR[1]); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(midRL[0], midRL[1]); ctx.lineTo(midRR[0], midRR[1]); ctx.stroke();
        } else {
            // Lưới 1/3 giúp căn tài liệu cân đối (4 góc thông thường)
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.28)';
            ctx.lineWidth = 1;
            for (let i = 1; i <= 2; i++) {
                const t = i / 3;
                const top = this.lerp(pts[0], pts[1], t);
                const bottom = this.lerp(pts[3], pts[2], t);
                const left = this.lerp(pts[0], pts[3], t);
                const right = this.lerp(pts[1], pts[2], t);
                ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(bottom[0], bottom[1]); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(left[0], left[1]); ctx.lineTo(right[0], right[1]); ctx.stroke();
            }
        }

        pts.forEach(([x, y], i) => {
            const active = i === this.draggingCornerIndex;
            const isMidPoint = (pts.length === 6 && (i === 1 || i === 4));
            const r = active ? this.handleRadius + 4 : this.handleRadius;

            // 1. Chấm tròn bán trong suốt (Transparent) giúp nhìn xuyên thấu mép giấy bên dưới
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            if (isMidPoint) {
                ctx.fillStyle = active ? 'rgba(245, 158, 11, 0.55)' : 'rgba(245, 158, 11, 0.35)';
                ctx.strokeStyle = active ? '#fbbf24' : '#f59e0b';
            } else {
                ctx.fillStyle = active ? 'rgba(56, 189, 248, 0.55)' : 'rgba(56, 189, 248, 0.35)';
                ctx.strokeStyle = active ? '#38bdf8' : '#ffffff';
            }
            ctx.fill();
            ctx.lineWidth = active ? 2.5 : 2;
            ctx.stroke();

            // 2. Chữ thập & Tâm định vị (Crosshair & Center Bullseye) để dễ căn mép chuẩn xác
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x - r + 3, y);
            ctx.lineTo(x + r - 3, y);
            ctx.moveTo(x, y - r + 3);
            ctx.lineTo(x, y + r - 3);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.lineWidth = 1.2;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(x, y, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();
        });
        ctx.restore();
    }

    drawComparePills(ctx, sliderX, y) {
        const pill = (text, cx, bg) => {
            ctx.font = '600 12px "Plus Jakarta Sans", sans-serif';
            const w = ctx.measureText(text).width + 20;
            const x = Math.max(this.imgOffsetX + 6, Math.min(cx - w / 2, this.imgOffsetX + this.imgRenderW - w - 6));
            ctx.fillStyle = bg;
            this.roundRect(ctx, x, y, w, 24, 12);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, x + w / 2, y + 12);
        };
        pill('Trước khi làm nét', this.imgOffsetX + (sliderX - this.imgOffsetX) / 2, 'rgba(245, 158, 11, 0.92)');
        pill('Sau khi làm nét', sliderX + (this.imgOffsetX + this.imgRenderW - sliderX) / 2, 'rgba(16, 185, 129, 0.92)');
    }

    roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

    /**
     * Vẽ ảnh vừa khung mà GIỮ NGUYÊN tỉ lệ gốc.
     * Ảnh gốc và bản đã cắt có tỉ lệ khác nhau, nếu kéo giãn cho bằng khung
     * thì thanh so sánh sẽ cho cảm giác sai lệch về hình dáng tài liệu.
     */
    drawContain(ctx, img, x, y, w, h) {
        const aspect = (img.width && img.height) ? img.width / img.height : 1;
        let dw = w;
        let dh = w / aspect;
        if (dh > h) { dh = h; dw = h * aspect; }
        ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }

    // ======================================================
    // 🖱️ TƯƠNG TÁC CHUỘT / CẢM ỨNG
    // ======================================================

    setZoom(value) {
        this.zoom = Math.max(0.25, Math.min(5.0, value));
        this.lblZoomLevel.textContent = `${Math.round(this.zoom * 100)}%`;
        this.applyTransform();
    }

    zoomAt(factor, clientX, clientY) {
        const oldZoom = this.zoom;
        const newZoom = Math.max(0.25, Math.min(5.0, oldZoom * factor));
        if (newZoom === oldZoom) return;

        if (clientX !== undefined && clientY !== undefined && this.canvasViewport) {
            const rect = this.canvasViewport.getBoundingClientRect();
            const mouseX = clientX - rect.left - rect.width / 2;
            const mouseY = clientY - rect.top - rect.height / 2;

            this.panX = mouseX - (mouseX - this.panX) * (newZoom / oldZoom);
            this.panY = mouseY - (mouseY - this.panY) * (newZoom / oldZoom);
        }

        this.zoom = newZoom;
        this.lblZoomLevel.textContent = `${Math.round(this.zoom * 100)}%`;
        this.applyTransform();
    }

    zoomFit() {
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;
        this.lblZoomLevel.textContent = 'Vừa khung';
        this.applyTransform();
    }

    zoom100() {
        const page = this.getActivePage();
        const displayImg = this.isShowingOriginal() ? this.originalImg : this.editedImg;
        const nativeW = (displayImg && displayImg.naturalWidth) ? displayImg.naturalWidth : (page ? page.width : 2000);
        const ratio = (nativeW && this.imgRenderW) ? (nativeW / this.imgRenderW) : 2.5;

        this.zoom = Math.max(0.25, Math.min(5.0, ratio));
        this.panX = 0;
        this.panY = 0;
        this.lblZoomLevel.textContent = `${Math.round(this.zoom * 100)}% (1:1)`;
        this.applyTransform();
    }

    resetZoom() {
        this.zoomFit();
    }

    applyTransform() {
        if (this.canvasTransformBox) {
            this.canvasTransformBox.style.transform =
                `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        }
    }

    /** Toạ độ trên bộ đệm canvas (hệ MÀN HÌNH, chưa nghịch-xoay). */
    screenCoords(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / this.zoom,
            y: (e.clientY - rect.top) / this.zoom,
        };
    }

    canvasCoords(e) {
        const rect = this.canvas.getBoundingClientRect();
        let x = (e.clientX - rect.left) / this.zoom;
        let y = (e.clientY - rect.top) / this.zoom;

        const page = this.getActivePage();
        const rot = (page && page.rotation) ? (page.rotation % 360) : 0;
        if (rot && this.isShowingOriginal()) {
            const cx = this.imgOffsetX + this.imgRenderW / 2;
            const cy = this.imgOffsetY + this.imgRenderH / 2;
            const rad = (-rot * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const dx = x - cx;
            const dy = y - cy;
            x = cx + dx * cos - dy * sin;
            y = cy + dx * sin + dy * cos;
        }
        return { x, y };
    }

    // ======================================================
    // ✏️ BỘ CÔNG CỤ CHÚ THÍCH & BIÊN TẬP (SNAGIT-STYLE)
    // ======================================================

    setAnnTool(tool) {
        this.activeAnnTool = tool;
        document.querySelectorAll('.ann-tool-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tool === tool);
        });

        if (this.propStepItem) {
            this.propStepItem.style.display = (tool === 'step') ? 'flex' : 'none';
        }
        if (this.propFontSizeItem) {
            this.propFontSizeItem.style.display = (tool === 'text' || tool === 'callout' || tool === 'arrow') ? 'flex' : 'none';
        }
        if (this.propCutPasteItem) {
            this.propCutPasteItem.style.display = (tool === 'cut_paste') ? 'flex' : 'none';
        }
        const isShapeOrLine = ['rect', 'ellipse', 'line', 'arrow'].includes(tool);
        if (this.propStrokeStyleItem) {
            this.propStrokeStyleItem.style.display = isShapeOrLine ? 'flex' : 'none';
        }

        if (tool !== 'select') {
            this.selectedAnnotationId = null;
            this.updateAnnotationActionButtons();
        }
        this.drawCanvas();
    }

    setAnnColor(c) {
        this.annColor = c;
        document.querySelectorAll('.ann-color-swatch').forEach(sw => {
            sw.classList.toggle('active', sw.dataset.color.toLowerCase() === c.toLowerCase());
        });
        if (this.annCustomColorPicker) this.annCustomColorPicker.value = c;
        if (this.selectedAnnotationId) {
            this.updateSelectedAnnotation({ color: c });
        }
    }

    setAnnStrokeWidth(w) {
        this.annStrokeWidth = w;
        document.querySelectorAll('#segStrokeWidth .ann-seg-btn').forEach(b => {
            b.classList.toggle('active', parseInt(b.dataset.width) === w);
        });
        if (this.selectedAnnotationId) {
            this.updateSelectedAnnotation({ strokeWidth: w });
        }
    }

    setAnnStrokeStyle(s) {
        this.annStrokeStyle = s;
        document.querySelectorAll('#segStrokeStyle .ann-seg-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.style === s);
        });
        if (this.selectedAnnotationId) {
            this.updateSelectedAnnotation({ strokeStyle: s });
        }
    }

    setAnnFontSize(sz) {
        this.annFontSize = sz;
        document.querySelectorAll('#segFontSize .ann-seg-btn').forEach(b => {
            b.classList.toggle('active', parseInt(b.dataset.size) === sz);
        });
        if (this.selectedAnnotationId) {
            this.updateSelectedAnnotation({ fontSize: sz });
        }
    }

    setAnnCutMode(m) {
        this.annCutMode = m;
        document.querySelectorAll('#segCutMode .ann-seg-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.cut === m);
        });
    }

    resetStepCount() {
        this.annStepCount = 1;
        if (this.lblNextStepNum) this.lblNextStepNum.textContent = '1';
    }

    updateAnnotationActionButtons() {
        const hasSel = !!this.selectedAnnotationId;
        if (this.btnDeleteSelectedAnn) this.btnDeleteSelectedAnn.disabled = !hasSel;
        if (this.btnDuplicateSelectedAnn) this.btnDuplicateSelectedAnn.disabled = !hasSel;
    }

    updateSelectedAnnotation(changes) {
        const page = this.getActivePage();
        if (!page || !this.selectedAnnotationId) return;
        const target = (page.annotations || []).find(a => a.id === this.selectedAnnotationId);
        if (!target) return;
        const hasDiff = Object.keys(changes).some(k => target[k] !== changes[k]);
        if (!hasDiff) return;
        this.pushHistory('Đổi thuộc tính chú thích');
        Object.assign(target, changes);
        this.markDirty(page);
        this.drawCanvas();
        this.requestPreview();
    }

    deleteSelectedAnnotation() {
        const page = this.getActivePage();
        if (!page || !this.selectedAnnotationId) return;
        this.pushHistory('Xóa chú thích');
        page.annotations = (page.annotations || []).filter(a => a.id !== this.selectedAnnotationId);
        this.selectedAnnotationId = null;
        this.updateAnnotationActionButtons();
        this.markDirty(page);
        this.drawCanvas();
        this.requestPreview();
    }

    duplicateSelectedAnnotation() {
        const page = this.getActivePage();
        if (!page || !this.selectedAnnotationId) return;
        const target = (page.annotations || []).find(a => a.id === this.selectedAnnotationId);
        if (!target) return;
        this.pushHistory('Nhân bản chú thích');
        const clone = JSON.parse(JSON.stringify(target));
        clone.id = 'ann_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
        const offset = 0.025;
        if (clone.x !== undefined) clone.x = Math.min(0.95, clone.x + offset);
        if (clone.y !== undefined) clone.y = Math.min(0.95, clone.y + offset);
        if (clone.x1 !== undefined) {
            clone.x1 = Math.min(0.95, clone.x1 + offset);
            clone.x2 = Math.min(0.95, clone.x2 + offset);
            clone.y1 = Math.min(0.95, clone.y1 + offset);
            clone.y2 = Math.min(0.95, clone.y2 + offset);
        }
        if (clone.tailX !== undefined) {
            clone.tailX = Math.min(0.95, clone.tailX + offset);
            clone.tailY = Math.min(0.95, clone.tailY + offset);
        }
        page.annotations = page.annotations || [];
        page.annotations.push(clone);
        this.selectedAnnotationId = clone.id;
        this.updateAnnotationActionButtons();
        this.markDirty(page);
        this.drawCanvas();
        this.requestPreview();
    }

    async clearAllAnnotations() {
        const page = this.getActivePage();
        if (!page || !page.annotations || page.annotations.length === 0) return;
        const ok = await this.askConfirm(
            'Xóa toàn bộ chú thích?',
            'Bạn có chắc chắn muốn xóa toàn bộ các nét vẽ, chữ và chú thích trên trang này không?'
        );
        if (!ok) return;
        this.pushHistory('Xóa toàn bộ chú thích');
        page.annotations = [];
        this.selectedAnnotationId = null;
        this.updateAnnotationActionButtons();
        this.markDirty(page);
        this.drawCanvas();
        this.requestPreview();
    }

    openInlineTextEditor(ann, canvasX, canvasY) {
        if (!this.canvasInlineTextEditor) return;
        this.editingAnnId = ann.id;
        const el = this.canvasInlineTextEditor;
        el.value = ann.text || '';
        el.style.display = 'block';
        el.style.left = `${canvasX}px`;
        el.style.top = `${canvasY}px`;
        el.style.color = ann.color || '#ffffff';
        el.style.fontSize = `${Math.max(14, Math.round((ann.fontSize || 18) * this.zoom))}px`;
        setTimeout(() => { el.focus(); el.select(); }, 20);
    }

    commitInlineTextEditor() {
        if (!this.canvasInlineTextEditor || this.canvasInlineTextEditor.style.display === 'none') return;
        const page = this.getActivePage();
        const text = this.canvasInlineTextEditor.value.trim();
        this.canvasInlineTextEditor.style.display = 'none';
        if (!page || !this.editingAnnId) return;

        const ann = (page.annotations || []).find(a => a.id === this.editingAnnId);
        if (ann && ann.text !== text) {
            this.pushHistory('Sửa nội dung chữ');
            ann.text = text || (ann.type === 'callout' ? 'Ghi chú' : '');
            this.markDirty(page);
            this.drawCanvas();
            this.requestPreview();
        }
        this.editingAnnId = null;
    }

    cancelInlineTextEditor() {
        if (this.canvasInlineTextEditor) this.canvasInlineTextEditor.style.display = 'none';
        this.editingAnnId = null;
    }

    onCanvasDoubleClick(e) {
        if (this.activeTab !== WORKFLOW_TAB.ANNOTATE) return;
        const page = this.getActivePage();
        if (!page) return;
        const pos = this.canvasCoords(e);
        const normX = (pos.x - this.imgOffsetX) / this.imgRenderW;
        const normY = (pos.y - this.imgOffsetY) / this.imgRenderH;
        const hit = this.hitTestAnnotation(page, normX, normY);
        if (hit && (hit.type === 'text' || hit.type === 'callout' || hit.type === 'arrow')) {
            const bx = (hit.x !== undefined) ? hit.x : (hit.x1 + hit.x2) / 2;
            const by = (hit.y !== undefined) ? hit.y : (hit.y1 + hit.y2) / 2;
            const cx = this.imgOffsetX + bx * this.imgRenderW;
            const cy = this.imgOffsetY + by * this.imgRenderH;
            this.openInlineTextEditor(hit, cx, cy);
        }
    }

    getAnnotationBoundingBox(ann) {
        if (ann.x !== undefined && ann.w !== undefined) {
            return { x: ann.x, y: ann.y, w: ann.w, h: ann.h };
        }
        if (ann.x1 !== undefined && ann.x2 !== undefined) {
            const minX = Math.min(ann.x1, ann.x2);
            const minY = Math.min(ann.y1, ann.y2);
            const w = Math.max(0.02, Math.abs(ann.x2 - ann.x1));
            const h = Math.max(0.02, Math.abs(ann.y2 - ann.y1));
            return { x: minX, y: minY, w, h };
        }
        if (ann.type === 'step') {
            const r = (ann.radius || 18) / Math.max(100, this.imgRenderW);
            return { x: ann.x - r, y: ann.y - r, w: r * 2, h: r * 2 };
        }
        return { x: ann.x || 0, y: ann.y || 0, w: ann.w || 0.1, h: ann.h || 0.05 };
    }

    hitTestAnnotation(page, normX, normY) {
        const anns = page.annotations || [];
        for (let i = anns.length - 1; i >= 0; i--) {
            const ann = anns[i];
            if (ann.type === 'line' || ann.type === 'arrow') {
                const x1 = ann.x1, y1 = ann.y1, x2 = ann.x2, y2 = ann.y2;
                const dx = x2 - x1, dy = y2 - y1;
                const lenSq = dx * dx + dy * dy;
                if (lenSq === 0) continue;
                const t = Math.max(0, Math.min(1, ((normX - x1) * dx + (normY - y1) * dy) / lenSq));
                const px = x1 + t * dx, py = y1 + t * dy;
                if (Math.hypot(normX - px, normY - py) <= 0.025) return ann;
            } else if (ann.type === 'step') {
                const r = (ann.radius || 18) / Math.max(100, this.imgRenderW);
                if (Math.hypot(normX - ann.x, normY - ann.y) <= r + 0.015) return ann;
            } else {
                const b = this.getAnnotationBoundingBox(ann);
                if (normX >= b.x - 0.01 && normX <= b.x + b.w + 0.01 &&
                    normY >= b.y - 0.01 && normY <= b.y + b.h + 0.01) {
                    return ann;
                }
            }
        }
        return null;
    }

    hitTestAnnotationHandle(ann, normX, normY) {
        const hitTol = 16 / Math.max(100, this.imgRenderW);
        if (ann.type === 'callout' && ann.tailX !== undefined) {
            if (Math.hypot(normX - ann.tailX, normY - ann.tailY) <= hitTol * 1.5) {
                return 'tail';
            }
        }
        const b = this.getAnnotationBoundingBox(ann);
        const handles = [
            { name: 'tl', x: b.x, y: b.y },
            { name: 'tr', x: b.x + b.w, y: b.y },
            { name: 'br', x: b.x + b.w, y: b.y + b.h },
            { name: 'bl', x: b.x, y: b.y + b.h },
        ];
        for (const h of handles) {
            if (Math.hypot(normX - h.x, normY - h.y) <= hitTol) return h.name;
        }
        return null;
    }

    finalizeCutPasteSelection(page, box) {
        const normX = Math.min(box.startX, box.endX);
        const normY = Math.min(box.startY, box.endY);
        const normW = Math.abs(box.endX - box.startX);
        const normH = Math.abs(box.endY - box.startY);
        if (normW < 0.01 || normH < 0.01 || !this.editedImg) return;

        this.pushHistory(this.annCutMode === 'move' ? 'Cắt dời vùng chọn' : 'Sao chép vùng chọn');

        const nw = this.editedImg.naturalWidth || this.editedImg.width || 1000;
        const nh = this.editedImg.naturalHeight || this.editedImg.height || 1000;
        const px = Math.max(0, Math.round(normX * nw));
        const py = Math.max(0, Math.round(normY * nh));
        const pw = Math.min(nw - px, Math.round(normW * nw));
        const ph = Math.min(nh - py, Math.round(normH * nh));

        if (pw <= 0 || ph <= 0) return;

        const offCanvas = document.createElement('canvas');
        offCanvas.width = pw;
        offCanvas.height = ph;
        const offCtx = offCanvas.getContext('2d');
        offCtx.drawImage(this.editedImg, px, py, pw, ph, 0, 0, pw, ph);
        const dataUrl = offCanvas.toDataURL('image/png');

        page.annotations = page.annotations || [];

        if (this.annCutMode === 'move') {
            page.annotations.push({
                id: 'ann_' + Date.now() + '_wo',
                type: 'whiteout',
                x: normX,
                y: normY,
                w: normW,
                h: normH,
            });
        }

        const patchAnn = {
            id: 'ann_' + Date.now() + '_patch',
            type: 'image_patch',
            x: normX,
            y: normY,
            w: normW,
            h: normH,
            patchDataUrl: dataUrl,
        };

        page.annotations.push(patchAnn);

        this.selectedAnnotationId = patchAnn.id;
        this.setAnnTool('select');
        this.updateAnnotationActionButtons();
        this.markDirty(page);
        this.drawCanvas();
        this.requestPreview();
        this.toastOk(this.annCutMode === 'move' ? 'Đã cắt vùng chọn. Bạn có thể kéo thả sang vị trí mới.' : 'Đã sao chép vùng chọn.');
    }

    drawAnnotationsLayer(ctx, page) {
        const anns = page.annotations || [];
        anns.forEach(ann => {
            const isSel = (ann.id === this.selectedAnnotationId);
            this.drawSingleAnnotation(ctx, ann, isSel);
        });

        if (this.activeDrawingAnnotation) {
            this.drawSingleAnnotation(ctx, this.activeDrawingAnnotation, false);
        }

        if (this.cutSelectionBox) {
            this.drawCutSelectionBox(ctx, this.cutSelectionBox);
        }
    }

    drawSingleAnnotation(ctx, ann, isSel = false) {
        ctx.save();
        const rw = this.imgRenderW;
        const rh = this.imgRenderH;
        const ox = this.imgOffsetX;
        const oy = this.imgOffsetY;

        const x = ox + (ann.x !== undefined ? ann.x : (ann.startX !== undefined ? Math.min(ann.startX, ann.currentX) : 0)) * rw;
        const y = oy + (ann.y !== undefined ? ann.y : (ann.startY !== undefined ? Math.min(ann.startY, ann.currentY) : 0)) * rh;
        const w = (ann.w !== undefined ? ann.w : (ann.startX !== undefined ? Math.abs(ann.currentX - ann.startX) : 0.1)) * rw;
        const h = (ann.h !== undefined ? ann.h : (ann.startY !== undefined ? Math.abs(ann.currentY - ann.startY) : 0.05)) * rh;

        const color = ann.color || '#ef4444';
        const strokeW = Math.max(2, Math.round((ann.strokeWidth || 4) * (rw / 800)));

        if (ann.strokeStyle === 'dashed') {
            ctx.setLineDash([8, 6]);
        }

        // 1. Hình chữ nhật
        if (ann.type === 'rect') {
            ctx.strokeStyle = color;
            ctx.lineWidth = strokeW;
            ctx.strokeRect(x, y, w, h);
        }
        // 2. Hình tròn / Elip
        else if (ann.type === 'ellipse') {
            ctx.strokeStyle = color;
            ctx.lineWidth = strokeW;
            ctx.beginPath();
            ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, Math.abs(w / 2)), Math.max(1, Math.abs(h / 2)), 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        // 3. Đường thẳng
        else if (ann.type === 'line') {
            const x1 = ox + (ann.x1 !== undefined ? ann.x1 : ann.startX) * rw;
            const y1 = oy + (ann.y1 !== undefined ? ann.y1 : ann.startY) * rh;
            const x2 = ox + (ann.x2 !== undefined ? ann.x2 : ann.currentX) * rw;
            const y2 = oy + (ann.y2 !== undefined ? ann.y2 : ann.currentY) * rh;
            ctx.strokeStyle = color;
            ctx.lineWidth = strokeW;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
        // 4. Mũi tên kèm nhãn dọc
        else if (ann.type === 'arrow') {
            const x1 = ox + (ann.x1 !== undefined ? ann.x1 : ann.startX) * rw;
            const y1 = oy + (ann.y1 !== undefined ? ann.y1 : ann.startY) * rh;
            const x2 = ox + (ann.x2 !== undefined ? ann.x2 : ann.currentX) * rw;
            const y2 = oy + (ann.y2 !== undefined ? ann.y2 : ann.currentY) * rh;

            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = strokeW;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();

            const angle = Math.atan2(y2 - y1, x2 - x1);
            const headLen = Math.max(14, strokeW * 3.5);
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 7), y2 - headLen * Math.sin(angle - Math.PI / 7));
            ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 7), y2 - headLen * Math.sin(angle + Math.PI / 7));
            ctx.closePath();
            ctx.fill();

            if (ann.text) {
                const fs = Math.max(11, Math.round((ann.fontSize || 16) * (rw / 800)));
                ctx.font = 'bold ' + fs + 'px "Plus Jakarta Sans", sans-serif';
                const mx = (x1 + x2) / 2;
                const my = (y1 + y2) / 2;
                const tm = ctx.measureText(ann.text);
                const pw = tm.width + 16;
                const ph = fs + 12;
                ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
                this.roundRect(ctx, mx - pw / 2, my - ph / 2, pw, ph, 6);
                ctx.fill();
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.5;
                ctx.stroke();
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(ann.text, mx, my);
            }
        }
        // 5. Bút dạ quang (Highlighter)
        else if (ann.type === 'highlighter') {
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.38;
            ctx.fillRect(x, y, w, h);
        }
        // 6. Hộp văn bản (Text)
        else if (ann.type === 'text') {
            const fs = Math.max(13, Math.round((ann.fontSize || 18) * (rw / 800)));
            ctx.font = (ann.bold ? 'bold ' : '') + fs + 'px "Plus Jakarta Sans", sans-serif';
            ctx.fillStyle = color;
            ctx.textBaseline = 'top';
            ctx.fillText(ann.text || 'Ghi chú...', x, y);
        }
        // 7. Bóng thoại (Callout Snagit)
        else if (ann.type === 'callout') {
            const tx = ox + (ann.tailX !== undefined ? ann.tailX : (ann.startX !== undefined ? ann.startX : ann.x)) * rw;
            const ty = oy + (ann.tailY !== undefined ? ann.tailY : (ann.startY !== undefined ? ann.startY : ann.y)) * rh;
            const bw = Math.max(60, w);
            const bh = Math.max(34, h);
            const bg = ann.fillColor || '#0284c7';

            ctx.fillStyle = bg;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = strokeW;

            // Đuôi bóng thoại
            ctx.beginPath();
            ctx.moveTo(x + bw / 2 - 12, y + bh / 2);
            ctx.lineTo(tx, ty);
            ctx.lineTo(x + bw / 2 + 12, y + bh / 2);
            ctx.closePath();
            ctx.fill();

            // Thân bóng thoại
            this.roundRect(ctx, x, y, bw, bh, 8);
            ctx.fill();
            ctx.stroke();

            // Chữ bên trong bóng thoại
            const fs = Math.max(12, Math.round((ann.fontSize || 16) * (rw / 800)));
            ctx.font = 'bold ' + fs + 'px "Plus Jakarta Sans", sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(ann.text || 'Chú thích', x + bw / 2, y + bh / 2);
        }
        // 8. Đánh số bước tuần tự (Step Badges 1, 2, 3...)
        else if (ann.type === 'step') {
            const cx = ox + ann.x * rw;
            const cy = oy + ann.y * rh;
            const r = Math.max(13, Math.round((ann.radius || 18) * (rw / 1000)));

            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2.5;
            ctx.stroke();

            ctx.font = 'bold ' + Math.round(r * 1.2) + 'px "Plus Jakarta Sans", sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(ann.stepNumber || 1), cx, cy - 1);
        }
        // 9. Làm mờ bảo mật (Blur / Pixelate Redaction)
        else if (ann.type === 'blur') {
            ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(x, y, w, h);

            ctx.fillStyle = '#38bdf8';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🔒 ĐÃ CHE MỜ', x + w / 2, y + h / 2);
        }
        // 10. Tẩy trắng / Xóa (Smart Whiteout)
        else if (ann.type === 'whiteout') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x, y, w, h);
        }
        // 11. Cắt - Kéo - Dán (Image Patch)
        else if (ann.type === 'image_patch' && ann.patchDataUrl) {
            let cached = this.patchImagesCache.get(ann.id);
            if (!cached) {
                cached = new Image();
                cached.src = ann.patchDataUrl;
                this.patchImagesCache.set(ann.id, cached);
                cached.onload = () => this.drawCanvas();
            }
            if (cached.complete) {
                ctx.drawImage(cached, x, y, w, h);
            }
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.strokeRect(x, y, w, h);
        }

        // Bounding Box & Handles khi đang được chọn
        if (isSel) {
            ctx.setLineDash([5, 4]);
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 2;
            const b = this.getAnnotationBoundingBox(ann);
            const bx = ox + b.x * rw;
            const by = oy + b.y * rh;
            const bw = b.w * rw;
            const bh = b.h * rh;
            ctx.strokeRect(bx - 4, by - 4, bw + 8, bh + 8);

            ctx.setLineDash([]);
            ctx.fillStyle = '#38bdf8';
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            const handlePoints = [
                [bx - 4, by - 4],
                [bx + bw + 4, by - 4],
                [bx + bw + 4, by + bh + 4],
                [bx - 4, by + bh + 4],
            ];
            handlePoints.forEach(([hx, hy]) => {
                ctx.fillRect(hx - 4, hy - 4, 8, 8);
                ctx.strokeRect(hx - 4, hy - 4, 8, 8);
            });

            if (ann.type === 'callout' && ann.tailX !== undefined) {
                const tx = ox + ann.tailX * rw;
                const ty = oy + ann.tailY * rh;
                ctx.beginPath();
                ctx.arc(tx, ty, 6, 0, Math.PI * 2);
                ctx.fillStyle = '#f59e0b';
                ctx.fill();
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    drawCutSelectionBox(ctx, box) {
        ctx.save();
        const rw = this.imgRenderW;
        const rh = this.imgRenderH;
        const ox = this.imgOffsetX;
        const oy = this.imgOffsetY;

        const x = ox + Math.min(box.startX, box.endX) * rw;
        const y = oy + Math.min(box.startY, box.endY) * rh;
        const w = Math.abs(box.endX - box.startX) * rw;
        const h = Math.abs(box.endY - box.startY) * rh;

        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(x, y, w, h);

        ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
        ctx.fillRect(x, y, w, h);

        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('✂️ Vùng cắt dán', x + 6, y - 6);

        ctx.restore();
    }

    onPointerDown(e) {
        const page = this.getActivePage();
        if (!page) return;
        const pos = this.canvasCoords(e);
        const screen = this.screenCoords(e);

        // --- XỬ LÝ KHI Ở TAB 3: CHÚ THÍCH & BIÊN TẬP ---
        if (this.activeTab === WORKFLOW_TAB.ANNOTATE && !this.isShowingOriginal()) {
            const normX = (pos.x - this.imgOffsetX) / this.imgRenderW;
            const normY = (pos.y - this.imgOffsetY) / this.imgRenderH;

            // 1. Tool Select & Move / Resize
            if (this.activeAnnTool === 'select') {
                if (this.selectedAnnotationId) {
                    const selAnn = (page.annotations || []).find(a => a.id === this.selectedAnnotationId);
                    if (selAnn) {
                        const handle = this.hitTestAnnotationHandle(selAnn, normX, normY);
                        if (handle) {
                            this.isResizingAnnotation = true;
                            this.selectedHandle = handle;
                            this.dragStartAnnPos = { normX, normY, origAnn: JSON.parse(JSON.stringify(selAnn)) };
                            this.annDragStartSnapshot = this.snapshot(page);
                            this.annHasMoved = false;
                            return;
                        }
                    }
                }

                const hit = this.hitTestAnnotation(page, normX, normY);
                if (hit) {
                    this.selectedAnnotationId = hit.id;
                    this.isDraggingAnnotation = true;
                    this.dragStartAnnPos = { normX, normY, origAnn: JSON.parse(JSON.stringify(hit)) };
                    this.annDragStartSnapshot = this.snapshot(page);
                    this.annHasMoved = false;
                    this.updateAnnotationActionButtons();
                    this.drawCanvas();
                    return;
                } else {
                    if (this.selectedAnnotationId) {
                        this.selectedAnnotationId = null;
                        this.updateAnnotationActionButtons();
                        this.drawCanvas();
                    }
                }
            }
            // 2. Tool Step (Đánh số bước)
            else if (this.activeAnnTool === 'step') {
                this.pushHistory('Thêm đánh số bước');
                const ann = {
                    id: 'ann_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                    type: 'step',
                    x: Math.max(0.02, Math.min(0.98, normX)),
                    y: Math.max(0.02, Math.min(0.98, normY)),
                    radius: 18,
                    stepNumber: this.annStepCount,
                    color: this.annColor,
                    strokeWidth: 2,
                };
                page.annotations = page.annotations || [];
                page.annotations.push(ann);
                this.annStepCount++;
                if (this.lblNextStepNum) this.lblNextStepNum.textContent = String(this.annStepCount);
                this.selectedAnnotationId = ann.id;
                this.updateAnnotationActionButtons();
                this.markDirty(page);
                this.drawCanvas();
                this.requestPreview();
                return;
            }
            // 3. Tool Text (Văn bản)
            else if (this.activeAnnTool === 'text') {
                this.pushHistory('Thêm hộp chữ');
                const ann = {
                    id: 'ann_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                    type: 'text',
                    x: Math.max(0.02, Math.min(0.95, normX)),
                    y: Math.max(0.02, Math.min(0.95, normY)),
                    w: 0.25,
                    h: 0.06,
                    text: 'Ghi chú...',
                    color: this.annColor,
                    fontSize: this.annFontSize,
                    bold: true,
                };
                page.annotations = page.annotations || [];
                page.annotations.push(ann);
                this.selectedAnnotationId = ann.id;
                this.updateAnnotationActionButtons();
                this.markDirty(page);
                this.drawCanvas();
                this.requestPreview();
                this.openInlineTextEditor(ann, pos.x, pos.y);
                return;
            }
            // 4. Tool Cut-Paste (Cắt dán)
            else if (this.activeAnnTool === 'cut_paste') {
                this.cutSelectionBox = { startX: normX, startY: normY, endX: normX, endY: normY };
                this.drawCanvas();
                return;
            }
            // 5. Các công cụ vẽ khác (rect, ellipse, line, arrow, highlighter, callout, blur, whiteout)
            else {
                this.activeDrawingAnnotation = {
                    id: 'ann_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                    type: this.activeAnnTool,
                    startX: normX,
                    startY: normY,
                    currentX: normX,
                    currentY: normY,
                    color: this.annColor,
                    strokeWidth: this.annStrokeWidth,
                    strokeStyle: this.annStrokeStyle,
                    fontSize: this.annFontSize,
                };
                return;
            }
        }

        // --- XỬ LÝ KHI Ở TAB 2: SO SÁNH TRƯỚC / SAU ---
        if (this.viewMode === VIEW.COMPARE && !this.holdingCompare && this.editedImg) {
            const sliderX = this.imgOffsetX + this.imgRenderW * this.sliderPos;
            if (Math.abs(pos.x - sliderX) <= 22) { this.isSliding = true; return; }
        }

        // --- XỬ LÝ KHI Ở TAB 1: CĂN CHỈNH 4 GÓC MÉP GIẤY ---
        if (this.showHandles && this.isShowingOriginal()) {
            const corners = page.corners || this.fullFrameCorners(page.width, page.height);
            const rot = (page.rotation || 0) % 360;
            const isSwapped = (rot === 90 || rot === 270);
            const drawW = isSwapped ? this.imgRenderH : this.imgRenderW;
            const drawH = isSwapped ? this.imgRenderW : this.imgRenderH;
            const cx = this.imgOffsetX + this.imgRenderW / 2;
            const cy = this.imgOffsetY + this.imgRenderH / 2;
            const originX = cx - drawW / 2;
            const originY = cy - drawH / 2;
            const scaleX = drawW / page.width;
            const scaleY = drawH / page.height;

            const hit = Math.max(this.handleRadius + 8, 22 / Math.max(0.1, this.zoom));
            for (let i = 0; i < corners.length; i++) {
                const sx = originX + corners[i][0] * scaleX;
                const sy = originY + corners[i][1] * scaleY;
                if (Math.hypot(pos.x - sx, pos.y - sy) <= hit) {
                    this.draggingCornerIndex = i;
                    this.cornerDragStartSnapshot = this.snapshot(page);
                    this.cornerHasMoved = false;
                    this.drawCanvas();
                    this.showMagnifier(screen.x, screen.y, i);
                    return;
                }
            }
        }

        // Kéo xoay khung xem ảnh (Pan)
        this.isPanning = true;
        this.panStartX = e.clientX - this.panX;
        this.panStartY = e.clientY - this.panY;
        this.canvasViewport.classList.add('panning');
    }

    onPointerMove(e) {
        const pos = this.canvasCoords(e);

        // --- XỬ LÝ KHI Ở TAB 3: CHÚ THÍCH & BIÊN TẬP ---
        if (this.activeTab === WORKFLOW_TAB.ANNOTATE && !this.isShowingOriginal()) {
            const normX = (pos.x - this.imgOffsetX) / this.imgRenderW;
            const normY = (pos.y - this.imgOffsetY) / this.imgRenderH;

            if (this.activeDrawingAnnotation) {
                this.activeDrawingAnnotation.currentX = normX;
                this.activeDrawingAnnotation.currentY = normY;
                this.drawCanvas();
                return;
            }
            if (this.cutSelectionBox) {
                this.cutSelectionBox.endX = normX;
                this.cutSelectionBox.endY = normY;
                this.drawCanvas();
                return;
            }
            if (this.isDraggingAnnotation && this.selectedAnnotationId && this.dragStartAnnPos) {
                const page = this.getActivePage();
                const sel = (page?.annotations || []).find(a => a.id === this.selectedAnnotationId);
                if (sel) {
                    const deltaX = normX - this.dragStartAnnPos.normX;
                    const deltaY = normY - this.dragStartAnnPos.normY;
                    if (Math.hypot(deltaX, deltaY) > 0.002) {
                        this.annHasMoved = true;
                    }
                    const orig = this.dragStartAnnPos.origAnn;
                    if (orig.x !== undefined) { sel.x = orig.x + deltaX; sel.y = orig.y + deltaY; }
                    if (orig.x1 !== undefined) {
                        sel.x1 = orig.x1 + deltaX; sel.x2 = orig.x2 + deltaX;
                        sel.y1 = orig.y1 + deltaY; sel.y2 = orig.y2 + deltaY;
                    }
                    if (orig.tailX !== undefined) {
                        sel.tailX = orig.tailX + deltaX; sel.tailY = orig.tailY + deltaY;
                    }
                    this.drawCanvas();
                }
                return;
            }
            if (this.isResizingAnnotation && this.selectedAnnotationId && this.dragStartAnnPos) {
                const page = this.getActivePage();
                const sel = (page?.annotations || []).find(a => a.id === this.selectedAnnotationId);
                if (sel) {
                    this.annHasMoved = true;
                    const orig = this.dragStartAnnPos.origAnn;
                    if (this.selectedHandle === 'tail') {
                        sel.tailX = normX; sel.tailY = normY;
                    } else if (this.selectedHandle === 'br') {
                        sel.w = Math.max(0.02, normX - orig.x); sel.h = Math.max(0.02, normY - orig.y);
                    } else if (this.selectedHandle === 'tl') {
                        const right = orig.x + orig.w; const bottom = orig.y + orig.h;
                        sel.x = Math.min(right - 0.02, normX); sel.y = Math.min(bottom - 0.02, normY);
                        sel.w = right - sel.x; sel.h = bottom - sel.y;
                    } else if (this.selectedHandle === 'tr') {
                        const left = orig.x; const bottom = orig.y + orig.h;
                        sel.y = Math.min(bottom - 0.02, normY);
                        sel.w = Math.max(0.02, normX - left); sel.h = bottom - sel.y;
                    } else if (this.selectedHandle === 'bl') {
                        const right = orig.x + orig.w; const top = orig.y;
                        sel.x = Math.min(right - 0.02, normX);
                        sel.w = right - sel.x; sel.h = Math.max(0.02, normY - top);
                    }
                    this.drawCanvas();
                }
                return;
            }

            if (this.activeAnnTool === 'select') {
                const page = this.getActivePage();
                if (page && this.selectedAnnotationId) {
                    const selAnn = (page.annotations || []).find(a => a.id === this.selectedAnnotationId);
                    if (selAnn && this.hitTestAnnotationHandle(selAnn, normX, normY)) {
                        this.canvasViewport.style.cursor = 'crosshair';
                        return;
                    }
                }
                const hit = page ? this.hitTestAnnotation(page, normX, normY) : null;
                this.canvasViewport.style.cursor = hit ? 'move' : 'default';
                return;
            } else {
                this.canvasViewport.style.cursor = 'crosshair';
                return;
            }
        }

        if (this.isSliding) {
            this.sliderPos = Math.max(0.01, Math.min(0.99, (pos.x - this.imgOffsetX) / this.imgRenderW));
            this.drawCanvas();
            return;
        }

        if (this.isPanning) {
            this.panX = e.clientX - this.panStartX;
            this.panY = e.clientY - this.panStartY;
            this.applyTransform();
            return;
        }

        if (this.draggingCornerIndex !== -1) {
            const page = this.getActivePage();
            if (!page) return;
            const screen = this.screenCoords(e);
            const rot = (page.rotation || 0) % 360;
            const isSwapped = (rot === 90 || rot === 270);
            const drawW = isSwapped ? this.imgRenderH : this.imgRenderW;
            const drawH = isSwapped ? this.imgRenderW : this.imgRenderH;
            const cx = this.imgOffsetX + this.imgRenderW / 2;
            const cy = this.imgOffsetY + this.imgRenderH / 2;
            const originX = cx - drawW / 2;
            const originY = cy - drawH / 2;
            const scaleX = drawW / page.width;
            const scaleY = drawH / page.height;

            const x = (pos.x - originX) / scaleX;
            const y = (pos.y - originY) / scaleY;
            this.cornerHasMoved = true;
            page.corners[this.draggingCornerIndex] = [
                Math.max(-page.width * 0.1, Math.min(page.width * 1.1, x)),
                Math.max(-page.height * 0.1, Math.min(page.height * 1.1, y)),
            ];
            this.drawCanvas();
            this.showMagnifier(screen.x, screen.y, this.draggingCornerIndex);
            return;
        }

        if (this.viewMode === VIEW.COMPARE && !this.holdingCompare && this.editedImg && this.imgRenderW) {
            const sliderX = this.imgOffsetX + this.imgRenderW * this.sliderPos;
            this.canvasViewport.style.cursor = Math.abs(pos.x - sliderX) <= 18 ? 'ew-resize' : '';
        } else {
            this.canvasViewport.style.cursor = '';
        }
    }

    onPointerUp() {
        this.isSliding = false;

        // --- XỬ LÝ KHI Ở TAB 3: CHÚ THÍCH & BIÊN TẬP ---
        if (this.activeTab === WORKFLOW_TAB.ANNOTATE) {
            const page = this.getActivePage();
            if (this.activeDrawingAnnotation && page) {
                const d = this.activeDrawingAnnotation;
                page.annotations = page.annotations || [];
                let finalAnn = null;

                if (d.type === 'callout') {
                    finalAnn = {
                        id: d.id,
                        type: 'callout',
                        x: Math.min(d.startX, d.currentX),
                        y: Math.min(d.startY, d.currentY),
                        w: Math.max(0.18, Math.abs(d.currentX - d.startX)),
                        h: Math.max(0.07, Math.abs(d.currentY - d.startY)),
                        tailX: d.startX,
                        tailY: d.startY,
                        color: '#ffffff',
                        fillColor: d.color,
                        strokeWidth: d.strokeWidth,
                        fontSize: d.fontSize,
                        text: 'Chú thích',
                    };
                } else if (d.type === 'line' || d.type === 'arrow') {
                    if (Math.hypot(d.currentX - d.startX, d.currentY - d.startY) > 0.015) {
                        finalAnn = {
                            id: d.id,
                            type: d.type,
                            x1: d.startX,
                            y1: d.startY,
                            x2: d.currentX,
                            y2: d.currentY,
                            color: d.color,
                            strokeWidth: d.strokeWidth,
                            strokeStyle: d.strokeStyle,
                            fontSize: d.fontSize,
                            text: d.type === 'arrow' ? '' : undefined,
                        };
                    }
                } else {
                    const w = Math.abs(d.currentX - d.startX);
                    const h = Math.abs(d.currentY - d.startY);
                    if (w > 0.01 && h > 0.01) {
                        finalAnn = {
                            id: d.id,
                            type: d.type,
                            x: Math.min(d.startX, d.currentX),
                            y: Math.min(d.startY, d.currentY),
                            w,
                            h,
                            color: d.color,
                            strokeWidth: d.strokeWidth,
                            strokeStyle: d.strokeStyle,
                        };
                    }
                }

                if (finalAnn) {
                    // Ghi mốc hoàn tác TRƯỚC KHI đẩy đối tượng mới vào
                    this.pushHistory(`Vẽ ${d.type}`);
                    page.annotations.push(finalAnn);
                    this.selectedAnnotationId = finalAnn.id;
                    this.updateAnnotationActionButtons();
                    this.markDirty(page);
                    this.drawCanvas();
                    this.requestPreview();
                }
                this.activeDrawingAnnotation = null;
                return;
            }

            if (this.cutSelectionBox && page) {
                this.finalizeCutPasteSelection(page, this.cutSelectionBox);
                this.cutSelectionBox = null;
                return;
            }

            if (this.isDraggingAnnotation || this.isResizingAnnotation) {
                if (this.annHasMoved && this.annDragStartSnapshot && page) {
                    const desc = this.isResizingAnnotation ? 'Co giãn chú thích' : 'Di chuyển chú thích';
                    page.history.undo.push({ ...this.annDragStartSnapshot, description: desc });
                    if (page.history.undo.length > MAX_HISTORY) page.history.undo.shift();
                    page.history.redo = [];
                    this.updateHistoryButtons();
                    this.scheduleMetaSave();
                    this.markDirty(page);
                    this.drawCanvas();
                    this.requestPreview();
                }
                this.isDraggingAnnotation = false;
                this.isResizingAnnotation = false;
                this.selectedHandle = null;
                this.annDragStartSnapshot = null;
                this.annHasMoved = false;
                return;
            }
        }

        if (this.draggingCornerIndex !== -1) {
            this.draggingCornerIndex = -1;
            this.hideMagnifier();
            if (this.cornerHasMoved && this.cornerDragStartSnapshot) {
                const page = this.getActivePage();
                if (page) {
                    page.history.undo.push({ ...this.cornerDragStartSnapshot, description: 'Kéo chỉnh góc mép giấy' });
                    if (page.history.undo.length > MAX_HISTORY) page.history.undo.shift();
                    page.history.redo = [];
                    this.updateHistoryButtons();
                    this.scheduleMetaSave();
                    this.drawCanvas();
                    this.requestPreview();
                }
            }
            this.cornerHasMoved = false;
            this.cornerDragStartSnapshot = null;
        }
        if (this.isPanning) {
            this.isPanning = false;
            this.canvasViewport.classList.remove('panning');
        }
    }

    /**
     * Kính lúp 2.5x. Toạ độ nhận vào là pixel CSS, còn bộ đệm canvas được nhân
     * theo hệ số nét cao — phải quy đổi, nếu không kính lúp soi nhầm vùng ảnh.
     */
    showMagnifier(canvasX, canvasY, cornerIdx) {
        if (!this.magLens || !this.originalImg) return;
        this.magLens.style.display = 'block';

        const page = this.getActivePage();
        const is6 = page && page.corners && page.corners.length === 6;
        const labels = is6 ? [
            'Góc trên - trái',
            'Gáy trên (điểm giữa)',
            'Góc trên - phải',
            'Góc dưới - phải',
            'Gáy dưới (điểm giữa)',
            'Góc dưới - trái',
        ] : [
            'Góc trên - trái',
            'Góc trên - phải',
            'Góc dưới - phải',
            'Góc dưới - trái',
        ];
        this.lensLabel.textContent = labels[cornerIdx] || 'Điểm mốc';

        const dpr = this.dpr || 1;
        const mw = this.magCanvas.width;
        const mh = this.magCanvas.height;
        const zoomFactor = 2.5;
        const srcW = (mw / zoomFactor) * dpr;
        const srcH = (mh / zoomFactor) * dpr;

        const ctx = this.magCtx;
        ctx.clearRect(0, 0, mw, mh);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(
            this.canvas,
            canvasX * dpr - srcW / 2, canvasY * dpr - srcH / 2, srcW, srcH,
            0, 0, mw, mh
        );
    }

    hideMagnifier() {
        if (this.magLens) this.magLens.style.display = 'none';
    }

    // ======================================================
    // 🔄 CHUYỂN / XÓA TRANG
    // ======================================================

    openMoveModal(imageId) {
        const page = this.pages.get(imageId);
        if (!page) return;
        this.moveModalState = { imageId, targetFolderId: null };
        this.moveImageDesc.textContent = `Chuyển "${page.docName}" sang thư mục nào?`;
        this.btnSubmitMoveModal.disabled = true;
        this.hideInlineFolderBox();
        this.renderMovePicker();
        this.moveImageModal.style.display = 'flex';
    }

    closeMoveModal() { this.moveImageModal.style.display = 'none'; }

    renderMovePicker() {
        this.moveFolderPicker.innerHTML = '';
        const roots = this.folders.filter(f => !f.parentId);
        roots.forEach(f => this.renderMovePickerNode(f, 0));
    }

    renderMovePickerNode(folder, level) {
        const page = this.pages.get(this.moveModalState.imageId);
        const isCurrent = page && page.folderId === folder.id;

        const item = document.createElement('div');
        item.className = `picker-item ${isCurrent ? 'disabled' : ''}`;
        item.dataset.level = Math.min(3, level);
        item.innerHTML = `
            <span class="picker-item-content">
                <i class="fa-solid ${folder.isUnapproved ? 'fa-inbox text-warning' : 'fa-folder text-accent'}"></i>
                <span>${escapeHtml(folder.name)}</span>
                <span class="tree-badge">${(folder.imageIds || []).length}</span>
            </span>
            ${isCurrent ? '<span class="picker-current-tag">đang ở đây</span>' : ''}`;

        if (!isCurrent) {
            item.addEventListener('click', () => {
                this.moveFolderPicker.querySelectorAll('.picker-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                this.moveModalState.targetFolderId = folder.id;
                this.btnSubmitMoveModal.disabled = false;
            });
        }

        this.moveFolderPicker.appendChild(item);
        this.getFolderChildren(folder.id).forEach(c => this.renderMovePickerNode(c, level + 1));
    }

    showInlineFolderBox() {
        this.moveInlineCreateBox.style.display = 'flex';
        this.txtInlineNewFolder.value = '';
        this.txtInlineNewFolder.focus();
    }

    hideInlineFolderBox() {
        this.moveInlineCreateBox.style.display = 'none';
    }

    async confirmInlineFolder() {
        const name = this.txtInlineNewFolder.value.trim();
        if (!name) { this.toastErr('Vui lòng nhập tên thư mục.'); return; }
        const parentId = this.moveModalState.targetFolderId || this.activeFolderId;
        try {
            const data = await apiJson('/api/create-folder', {
                relative_path: this.getFolderPath(parentId),
                folder_name: name,
            });
            this.folders.push({
                id: data.folder_id,
                name: data.folder_name,
                parentId: data.parent_id,
                relativePath: data.relative_path,
                imageIds: [],
                isUnapproved: false,
                isExpanded: true,
            });
            this.hideInlineFolderBox();
            this.renderMovePicker();
            this.renderFolderTree();
            this.toastOk(`Đã tạo thư mục "${name}".`);
        } catch (err) {
            this.toastErr(err.message);
        }
    }

    async submitMoveModal() {
        const { imageId, targetFolderId } = this.moveModalState;
        const page = this.pages.get(imageId);
        const target = this.getFolder(targetFolderId);
        if (!page || !target) return;

        try {
            const raw = await apiJson('/api/move-page', {
                relative_path: page.relativePath,
                filename: page.filename,
                target_relative_path: target.relativePath,
            });

            const source = this.getFolder(page.folderId);
            if (source) source.imageIds = source.imageIds.filter(id => id !== imageId);
            this.pages.delete(imageId);
            this.dirtyPages.delete(imageId);

            const moved = this.toPage(raw);
            this.pages.set(moved.id, moved);
            target.imageIds.push(moved.id);

            if (this.activeImageId === imageId) {
                this.activeImageId = null;
                this.editorStage.style.display = 'none';
                this.emptyState.style.display = 'flex';
                this.docNameWrapper.style.display = 'none';
            }

            this.closeMoveModal();
            this.renderFolderTree();
            this.updateFolderHeader();
            this.renderPageList();
            this.updateSaveState();
            this.toastOk(`Đã chuyển "${moved.docName}" sang "${target.name}" (kèm ảnh gốc và metadata).`);
        } catch (err) {
            this.toastErr(err.message);
        }
    }

    async deletePage(imageId) {
        const page = this.pages.get(imageId);
        if (!page) return;
        const ok = await this.askConfirm(
            `Xóa trang "${page.docName}"`,
            'Cả ảnh gốc, ảnh đã chỉnh sửa và metadata của trang này sẽ bị xóa vĩnh viễn khỏi máy tính.',
            true,
            'Xóa trang'
        );
        if (!ok) return;

        try {
            await apiJson('/api/delete-page', {
                relative_path: page.relativePath,
                filename: page.filename,
            });
            const folder = this.getFolder(page.folderId);
            if (folder) folder.imageIds = folder.imageIds.filter(id => id !== imageId);
            this.pages.delete(imageId);
            this.dirtyPages.delete(imageId);

            if (this.activeImageId === imageId) {
                const remaining = this.getFolderImageIds();
                if (remaining.length > 0) {
                    await this.selectPage(remaining[0]);
                } else {
                    this.activeImageId = null;
                    localStorage.removeItem('docscan_active_page');
                    this.editorStage.style.display = 'none';
                    this.emptyState.style.display = 'flex';
                    this.docNameWrapper.style.display = 'none';
                    if (this.btnCopyCurrent) this.btnCopyCurrent.disabled = true;
                    if (this.btnDownloadCurrent) this.btnDownloadCurrent.disabled = true;
                    this.updateHistoryButtons();
                }
            }
            this.renderFolderTree();
            this.updateFolderHeader();
            this.renderPageList();
            this.updateSaveState();
            this.toastOk(`Đã xóa trang "${page.docName}".`);
        } catch (err) {
            this.toastErr(err.message);
        }
    }

    // ======================================================
    // 🧩 ẢNH LẺ CHƯA CÓ BẢN GỐC
    // ======================================================

    openOrphanPrompt(imageId) {
        const page = this.pages.get(imageId);
        if (!page) return;
        this.pendingOrphanId = imageId;
        this.orphanFileName.textContent = page.filename;
        this.orphanFolderPath.textContent = this.getFolderBreadcrumb(page.folderId);
        this.orphanFileSize.textContent = page.fileSizeHuman || '--';
        this.orphanPreviewImg.src = this.thumbUrl(page);
        this.orphanImageModal.style.display = 'flex';
    }

    closeOrphanPrompt(markHandled = false) {
        if (markHandled && this.pendingOrphanId) {
            const page = this.pages.get(this.pendingOrphanId);
            if (page) page.orphanHandled = true;
        }
        this.orphanImageModal.style.display = 'none';
        this.pendingOrphanId = null;
    }

    async adoptOrphan() {
        const page = this.pages.get(this.pendingOrphanId);
        if (!page) return this.closeOrphanPrompt();
        try {
            const raw = await apiJson('/api/adopt-as-original', {
                relative_path: page.relativePath,
                filename: page.filename,
            });
            const updated = this.toPage(raw);
            updated.orphanHandled = true;
            this.pages.set(updated.id, updated);
            this.closeOrphanPrompt();

            this.activeImageId = null;
            await this.selectPage(updated.id);
            this.renderPageList();
            this.toastOk('Đã tạo bản gốc trong _goc/ — trang này giờ chỉnh sửa an toàn được.');
        } catch (err) {
            this.closeOrphanPrompt();
            this.toastErr(err.message);
        }
    }

    async moveOrphanToUnapproved() {
        const page = this.pages.get(this.pendingOrphanId);
        if (!page) return this.closeOrphanPrompt();
        try {
            await apiJson('/api/move-to-unapproved', {
                relative_path: page.relativePath,
                filename: page.filename,
            });
            this.closeOrphanPrompt();
            this.toastOk('Đã chuyển ảnh vào Kho ảnh chưa duyệt.');
            await this.loadProject(this.rootPath, false);
        } catch (err) {
            this.closeOrphanPrompt();
            this.toastErr(err.message);
        }
    }

    async deleteOrphan() {
        const imageId = this.pendingOrphanId;
        this.closeOrphanPrompt();
        if (imageId) await this.deletePage(imageId);
    }

    // ======================================================
    // 📤 XUẤT PDF & TẢI ẢNH
    // ======================================================

    /**
     * Hỏi người dùng nơi lưu tệp qua hộp thoại của hệ điều hành.
     * Thư mục mặc định là thư mục tài liệu đang mở — nơi người dùng mong muốn nhất,
     * thay vì ném vào Downloads của trình duyệt rồi phải đi tìm.
     * Trả về null nếu người dùng bấm Huỷ.
     */
    async askSavePath(suggestedName, extension, relativePath) {
        const folder = this.getActiveFolder();
        const data = await apiJson('/api/pick-save-path', {
            relative_path: relativePath !== undefined
                ? relativePath
                : (folder ? folder.relativePath : ''),
            suggested_name: suggestedName,
            extension,
        });
        return data.success && data.path ? data.path : null;
    }

    /** Ghi tệp xuất ra nơi người dùng vừa chọn và báo lại đường dẫn đầy đủ. */
    async exportToChosenPath(url, body, savePath) {
        const data = await apiJson(url, { ...body, save_path: savePath });
        return data;
    }

    /** Câu thông báo chung sau khi lưu xong, có nêu rõ tệp nằm ở đâu. */
    savedMessage(what, data) {
        return `Đã lưu ${what} vào: ${data.saved_to}`;
    }

    async exportFolderPdf(folderId) {
        const folder = this.getFolder(folderId);
        if (!folder) return;
        const selectedInFolder = (folder.imageIds || []).filter(id => this.selectedPageIds.has(id));
        if (selectedInFolder.length === 0) {
            this.toastErr('Hãy tích chọn ít nhất 1 trang để xuất PDF.');
            return;
        }

        const filenames = selectedInFolder.map(id => this.pages.get(id)?.filename).filter(Boolean);
        const docTitle = `${folder.name}_${selectedInFolder.length}_trang`;

        try {
            const savePath = await this.askSavePath(docTitle, 'pdf', folder.relativePath);
            if (!savePath) return;   // người dùng bấm Huỷ

            this.showLoading(`Đang tạo tệp PDF gồm ${filenames.length} trang đã chọn…`);
            await this.saveDirtyPages(true);
            const data = await this.exportToChosenPath('/api/export-pdf', {
                relative_path: folder.relativePath,
                filenames,
                doc_name: docTitle,
            }, savePath);
            this.toastOk(this.savedMessage(`PDF ${filenames.length} trang`, data));
        } catch (err) {
            this.toastErr(err.message);
        } finally {
            this.hideLoading();
        }
    }

    async downloadFolderZip(folderId) {
        const folder = this.getFolder(folderId);
        if (!folder) return;
        const selectedInFolder = (folder.imageIds || []).filter(id => this.selectedPageIds.has(id));
        if (selectedInFolder.length === 0) {
            this.toastErr('Hãy tích chọn ít nhất 1 ảnh để tải về.');
            return;
        }

        const filenames = selectedInFolder.map(id => this.pages.get(id)?.filename).filter(Boolean);
        const zipTitle = `${folder.name}_${selectedInFolder.length}_anh`;

        try {
            const savePath = await this.askSavePath(zipTitle, 'zip', folder.relativePath);
            if (!savePath) return;

            this.showLoading(`Đang nén ${filenames.length} ảnh đã chọn thành tệp ZIP…`);
            await this.saveDirtyPages(true);
            const data = await this.exportToChosenPath('/api/export-images-zip', {
                relative_path: folder.relativePath,
                filenames,
                zip_name: zipTitle,
            }, savePath);
            this.toastOk(this.savedMessage(`tệp ZIP gồm ${filenames.length} ảnh`, data));
        } catch (err) {
            this.toastErr(err.message);
        } finally {
            this.hideLoading();
        }
    }

    async exportProjectPdf() {
        if (this.pages.size === 0) { this.toastErr('Dự án chưa có trang nào để xuất PDF.'); return; }
        try {
            const title = this.rootName || 'Tai-Lieu-Scan';
            const savePath = await this.askSavePath(title, 'pdf', '');
            if (!savePath) return;

            this.showLoading('Đang ghép toàn bộ dự án thành một tệp PDF…');
            await this.saveDirtyPages(true);
            const data = await this.exportToChosenPath('/api/export-project-pdf',
                { doc_name: title }, savePath);
            this.toastOk(this.savedMessage(`PDF toàn bộ dự án (${data.pages} trang)`, data));
        } catch (err) {
            this.toastErr(err.message);
        } finally {
            this.hideLoading();
        }
    }

    async exportCurrentPagePdf() {
        const page = this.getActivePage();
        if (!page) { this.toastErr('Hãy chọn một trang tài liệu để xuất PDF.'); return; }
        try {
            const title = page.docName || 'Trang-Tai-Lieu';
            const savePath = await this.askSavePath(title, 'pdf', page.relativePath);
            if (!savePath) return;

            this.showLoading(`Đang xuất PDF cho trang “${title}”…`);
            await this.saveDirtyPages(true);
            const data = await this.exportToChosenPath('/api/export-pdf', {
                relative_path: page.relativePath,
                filenames: [page.filename],
                doc_name: title,
            }, savePath);
            this.toastOk(this.savedMessage(`PDF trang “${title}”`, data));
        } catch (err) {
            this.toastErr(err.message);
        } finally {
            this.hideLoading();
        }
    }

    async copyCurrentPageImage() {
        const page = this.getActivePage();
        if (!page) return;
        try {
            this.showLoading('Đang sao chép ảnh vào bộ nhớ tạm…');
            if (this.dirtyPages.has(page.id)) {
                await this.saveDirtyPages(true);
            }
            const imageUrl = `/api/image?file=${encodeURIComponent(page.filename)}&rel=${encodeURIComponent(page.relativePath)}&kind=edited&v=${page.version || Date.now()}`;
            const res = await fetch(imageUrl);
            if (!res.ok) throw new Error('Không thể tải ảnh kết quả.');
            const blob = await res.blob();
            const pngBlob = await this.blobToPngBlob(blob);

            if (!navigator.clipboard || !navigator.clipboard.write) {
                throw new Error('Trình duyệt không hỗ trợ sao chép ảnh vào Clipboard.');
            }

            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': pngBlob })
            ]);
            this.toastOk('Đã sao chép ảnh kết quả vào bộ nhớ tạm (Clipboard).');
        } catch (err) {
            console.error('Sao chép ảnh thất bại:', err);
            this.toastErr(err.message || 'Không thể sao chép ảnh vào bộ nhớ tạm.');
        } finally {
            this.hideLoading();
        }
    }

    blobToPngBlob(blob) {
        return new Promise((resolve, reject) => {
            if (blob.type === 'image/png') {
                resolve(blob);
                return;
            }
            const img = new Image();
            const url = URL.createObjectURL(blob);
            img.onload = () => {
                URL.revokeObjectURL(url);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    canvas.toBlob((b) => {
                        if (b) resolve(b);
                        else reject(new Error('Chuyển đổi định dạng ảnh thất bại.'));
                    }, 'image/png');
                } catch (e) {
                    reject(e);
                }
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Không đọc được dữ liệu ảnh để sao chép.'));
            };
            img.src = url;
        });
    }

    async downloadCurrentPage(format = 'jpeg') {
        const page = this.getActivePage();
        if (!page) return;
        const ext = format === 'jpeg' ? 'jpg' : format;
        try {
            const title = page.docName || 'Trang-Tai-Lieu';
            const savePath = await this.askSavePath(title, ext, page.relativePath);
            if (!savePath) return;

            this.showLoading('Đang chuẩn bị tệp ảnh…');
            await this.saveDirtyPages(true);
            const data = await this.exportToChosenPath('/api/download-single', {
                relative_path: page.relativePath,
                filename: page.filename,
                format,
                quality: page.settings?.quality,
                doc_name: title,
            }, savePath);
            this.toastOk(this.savedMessage(`ảnh ${ext.toUpperCase()}`, data));
        } catch (err) {
            this.toastErr(err.message);
        } finally {
            this.hideLoading();
        }
    }

    // ======================================================
    // 🎚️ ĐỒNG BỘ BẢNG ĐIỀU KHIỂN & THÔNG SỐ
    // ======================================================

    syncInspector(settings) {
        if (!settings) return;
        this.modeCards.forEach(c => c.classList.toggle('active', c.dataset.mode === (settings.mode || 'natural')));

        const pct = (v, d) => Math.round((v ?? d) * 100);
        if (this.rngFilterIntensity) {
            this.rngFilterIntensity.value = pct(settings.filter_intensity, 1.0);
            this.valFilterIntensity.textContent = `${this.rngFilterIntensity.value}%`;
            if (this.filterIntensityGroup) {
                this.filterIntensityGroup.style.opacity = (settings.mode === 'original') ? '0.4' : '1';
                this.rngFilterIntensity.disabled = (settings.mode === 'original');
            }
        }

        // Bước 2: Khổ ảnh chuẩn
        if (this.selPageSizePreset) {
            this.selPageSizePreset.value = settings.page_size_preset || 'original';
        }
        const orient = settings.page_orientation || 'auto';
        document.querySelectorAll('#segPageOrientation .ann-seg-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.orientation === orient);
        });
        const fit = settings.page_fit_mode || 'fill';
        document.querySelectorAll('#segPageFitMode .ann-seg-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.fit === fit);
        });
        const sx = Math.round((settings.page_scale_x ?? 1.0) * 100);
        const sy = Math.round((settings.page_scale_y ?? 1.0) * 100);
        if (this.valStep2ScaleX) this.valStep2ScaleX.textContent = `${sx}%`;
        if (this.valStep2ScaleY) this.valStep2ScaleY.textContent = `${sy}%`;
        if (this.rngPageMargin) {
            const m = Math.round((settings.page_margin_pct ?? 0.0) * 100);
            this.rngPageMargin.value = m;
            if (this.valPageMargin) this.valPageMargin.textContent = `${m}%`;
        }
        const activeP = this.getActivePage();
        if (activeP) this.updatePageSizeMetric(activeP);

        this.chkDewarp.checked = !!settings.dewarp_enabled;
        this.dewarpStrengthGroup.style.display = settings.dewarp_enabled ? 'flex' : 'none';
        this.rngDewarp.value = settings.dewarp_strength ?? 0.8;
        this.valDewarp.textContent = this.rngDewarp.value;

        this.rngShadow.value = pct(settings.shadow_reduction, 0.6);
        this.valShadow.textContent = `${this.rngShadow.value}%`;
        this.rngSharpness.value = pct(settings.sharpness, 0.6);
        this.valSharpness.textContent = `${this.rngSharpness.value}%`;
        this.rngContrast.value = pct(settings.contrast, 0.2);
        this.valContrast.textContent = `${this.rngContrast.value}%`;

        this.rngMargin.value = ((settings.margin_percent ?? 0.02) * 100).toFixed(1);
        this.valMargin.textContent = `${this.rngMargin.value}%`;

        this.rngQuality.value = settings.quality ?? 85;
        this.valQuality.textContent = `${this.rngQuality.value}%`;
        this.chkNormalizeDpi.checked = settings.normalize_res !== false;
    }

    updateMetrics(page) {
        if (!page) return;
        const origDim = `${page.width || '--'} × ${page.height || '--'} px`;
        const origBytes = page.origSize || page.fileSize || 0;
        const origSize = page.origSizeHuman || page.fileSizeHuman || formatBytes(origBytes);

        const outDim = page.outDim || origDim;
        const outBytes = page.outSize || page.editedSize || origBytes;
        const outSize = page.outSizeHuman || page.editedSizeHuman || formatBytes(outBytes);

        if (this.metaOrigDim) this.metaOrigDim.textContent = origDim;
        if (this.metaOrigSize) this.metaOrigSize.textContent = origSize;
        if (this.metaOutDim) this.metaOutDim.textContent = outDim;
        if (this.metaOutSize) this.metaOutSize.textContent = outSize;

        // Tính % tiết kiệm hoặc % tăng dung lượng so với ảnh gốc
        if (this.savingPill) {
            if (origBytes > 0 && outBytes > 0) {
                const diff = origBytes - outBytes;
                const pct = Math.round((diff / origBytes) * 100);
                if (pct > 0) {
                    this.savingPill.textContent = `Tiết kiệm ${pct}%`;
                    this.savingPill.className = 'saving-pill saving-positive';
                    this.savingPill.title = `Giảm từ ${origSize} xuống ${outSize} (tiết kiệm ${pct}% dung lượng)`;
                    this.savingPill.style.display = 'inline-flex';
                } else if (pct < 0) {
                    const inc = Math.abs(pct);
                    this.savingPill.textContent = `Tăng ${inc}%`;
                    this.savingPill.className = 'saving-pill saving-neutral';
                    this.savingPill.title = `Tăng từ ${origSize} lên ${outSize} (+${inc}% do xử lý làm nét & chuẩn hóa DPI)`;
                    this.savingPill.style.display = 'inline-flex';
                } else {
                    this.savingPill.textContent = 'Dung lượng 1:1';
                    this.savingPill.className = 'saving-pill';
                    this.savingPill.title = 'Dung lượng tương đương bản gốc';
                    this.savingPill.style.display = 'inline-flex';
                }
            } else {
                this.savingPill.style.display = 'none';
            }
        }

        if (this.cardFileName) this.cardFileName.textContent = page.filename;
        if (this.cardOrigDim) this.cardOrigDim.textContent = origDim;
        if (this.cardOrigSize) this.cardOrigSize.textContent = origSize;
        if (this.cardOutSize) this.cardOutSize.textContent = outSize;
        if (this.cardSavingsPct) {
            if (origBytes > 0 && outBytes > 0) {
                const diff = origBytes - outBytes;
                const pct = Math.round((diff / origBytes) * 100);
                if (pct > 0) {
                    this.cardSavingsPct.textContent = `Tiết kiệm ${pct}%`;
                    this.cardSavingsPct.className = 'meta-v text-success';
                } else if (pct < 0) {
                    this.cardSavingsPct.textContent = `Tăng ${Math.abs(pct)}%`;
                    this.cardSavingsPct.className = 'meta-v text-accent';
                } else {
                    this.cardSavingsPct.textContent = '100% (không đổi)';
                    this.cardSavingsPct.className = 'meta-v';
                }
            } else {
                this.cardSavingsPct.textContent = '--';
            }
        }
        if (this.cardOriginalState) {
            this.cardOriginalState.textContent = page.hasOriginal ? 'Đã có trong _goc/' : 'Chưa có';
            this.cardOriginalState.className = page.hasOriginal ? 'meta-v text-success' : 'meta-v text-warning';
        }
    }

    // ======================================================
    // 📐 KÉO CHỈNH KÍCH THƯỚC SIDEBAR
    // ======================================================

    initSidebarResizers() {
        if (!this.pageSidebar) return;

        const savedWidth = localStorage.getItem('docscan_sidebar_width');
        if (savedWidth) this.pageSidebar.style.width = `${savedWidth}px`;
        const savedHeight = localStorage.getItem('docscan_folder_height');
        if (savedHeight && this.folderSection) this.folderSection.style.height = `${savedHeight}px`;

        if (this.sidebarResizerV) {
            this.sidebarResizerV.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = this.pageSidebar.offsetWidth;
                const onMove = (ev) => {
                    const w = Math.max(240, Math.min(620, startW + (ev.clientX - startX)));
                    this.pageSidebar.style.width = `${w}px`;
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    localStorage.setItem('docscan_sidebar_width', this.pageSidebar.offsetWidth);
                    if (this.getActivePage()) this.layoutCanvas();
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }

        if (this.sidebarDividerH && this.folderSection) {
            this.sidebarDividerH.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const startY = e.clientY;
                const startH = this.folderSection.offsetHeight;
                const onMove = (ev) => {
                    const h = Math.max(120, Math.min(this.pageSidebar.offsetHeight - 200, startH + (ev.clientY - startY)));
                    this.folderSection.style.height = `${h}px`;
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    localStorage.setItem('docscan_folder_height', this.folderSection.offsetHeight);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }
    }

    // ======================================================
    // 🔔 THÔNG BÁO
    // ======================================================

    setStatus(text, tone = 'info') {
        if (this.resultInfoText) this.resultInfoText.textContent = text;
        if (!this.statusIcon) return;
        const icons = {
            ok: 'fa-solid fa-circle-check text-success',
            info: 'fa-solid fa-circle-info text-accent',
            warn: 'fa-regular fa-image text-warning',
        };
        this.statusIcon.className = icons[tone] || icons.info;
    }

    showToast(msg, ok = true) {
        this.toastMsg.textContent = msg;
        this.toastIcon.className = ok
            ? 'fa-solid fa-circle-check text-success'
            : 'fa-solid fa-triangle-exclamation text-warning';
        this.toast.classList.toggle('is-error', !ok);
        this.toast.classList.add('show');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), ok ? 3200 : 5000);
    }

    async confirmUnsavedChanges() {
        if (!this.activeImageId || !this.dirtyPages.has(this.activeImageId)) {
            return true;
        }
        const activePage = this.getActivePage();
        if (!activePage) return true;

        return new Promise((resolve) => {
            const $ = (id) => document.getElementById(id);
            const modal = $('unsavedModal');
            const msgEl = $('unsavedModalMessage');
            const btnSave = $('btnUnsavedSave');
            const btnDiscard = $('btnUnsavedDiscard');
            const btnCancel = $('btnUnsavedCancel');
            const btnClose = $('btnCloseUnsavedModal');

            if (!modal) {
                resolve(true);
                return;
            }

            msgEl.innerHTML = `Trang <strong>"${escapeHtml(activePage.docName || activePage.filename)}"</strong> có những thay đổi chưa lưu.<br><br>Bạn có muốn lưu các chỉnh sửa của trang này vào máy trước khi chuyển không?`;
            modal.style.display = 'flex';

            const cleanup = async (action) => {
                modal.style.display = 'none';
                btnSave.onclick = null;
                btnDiscard.onclick = null;
                btnCancel.onclick = null;
                btnClose.onclick = null;

                if (action === 'save') {
                    this.showLoading('Đang lưu thay đổi trang…');
                    try {
                        await this.saveDirtyPages(true);
                        this.toastOk(`Đã lưu thay đổi trang "${activePage.docName || activePage.filename}".`);
                        resolve(true);
                    } catch (err) {
                        this.toastErr(err.message);
                        resolve(false);
                    } finally {
                        this.hideLoading();
                    }
                } else if (action === 'discard') {
                    // Revert active page to saved snapshot
                    if (activePage._savedSnapshot) {
                        const snap = JSON.parse(JSON.stringify(activePage._savedSnapshot));
                        activePage.corners = snap.corners;
                        activePage.rotation = snap.rotation;
                        activePage.settings = snap.settings;
                        activePage.docName = snap.docName;
                        activePage.annotations = JSON.parse(JSON.stringify(snap.annotations || []));
                    }
                    this.dirtyPages.delete(activePage.id);
                    this.updateSaveState();
                    const card = this.pageListContainer?.querySelector(`.page-thumb-card[data-image-id="${activePage.id}"]`);
                    card?.classList.remove('unsaved');
                    resolve(true);
                } else {
                    // Cancel navigation
                    resolve(false);
                }
            };

            btnSave.onclick = () => cleanup('save');
            btnDiscard.onclick = () => cleanup('discard');
            btnCancel.onclick = () => cleanup('cancel');
            btnClose.onclick = () => cleanup('cancel');
        });
    }

    async askConfirm(title, message, isDanger = true, okText = 'Đồng ý', cancelText = 'Hủy') {
        return new Promise((resolve) => {
            const $ = (id) => document.getElementById(id);
            const modal = $('confirmModal');
            const titleEl = $('confirmModalTitle');
            const msgEl = $('confirmModalMessage');
            const okBtn = $('btnConfirmOk');
            const cancelBtn = $('btnConfirmCancel');
            const closeBtn = $('btnCancelConfirmModal');

            if (!modal) {
                resolve(true);
                return;
            }

            titleEl.innerHTML = isDanger
                ? `<i class="fa-solid fa-triangle-exclamation text-warning"></i> ${escapeHtml(title)}`
                : `<i class="fa-solid fa-circle-question text-accent"></i> ${escapeHtml(title)}`;

            msgEl.innerHTML = escapeHtml(message).replace(/\n/g, '<br>');
            okBtn.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';
            okBtn.textContent = okText;
            cancelBtn.textContent = cancelText;

            modal.style.display = 'flex';

            const cleanup = (result) => {
                modal.style.display = 'none';
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                closeBtn.onclick = null;
                resolve(result);
            };

            okBtn.onclick = () => cleanup(true);
            cancelBtn.onclick = () => cleanup(false);
            closeBtn.onclick = () => cleanup(false);
        });
    }

    toastOk(msg) { this.showToast(msg, true); }
    toastErr(msg) { this.showToast(msg || 'Đã xảy ra lỗi, vui lòng thử lại.', false); }

    showLoading(text) {
        if (this.loadingText) this.loadingText.textContent = text;
        if (this.loadingOverlay) this.loadingOverlay.style.display = 'flex';
    }

    hideLoading() {
        if (this.loadingOverlay) this.loadingOverlay.style.display = 'none';
    }

    // ======================================================
    // 📑 GHÉP FILE PDF THÀNH 1 ẢNH (DÀI / LƯỚI GRID)
    // ======================================================

    initStitchPdfModal() {
        const modal = this.stitchPdfModal;
        if (!modal) return;

        // Đóng modal
        const closeBtns = [$('btnCloseStitchModal'), $('btnCancelStitchModal')];
        closeBtns.forEach(btn => btn && on(btn, 'click', () => this.closeStitchModal()));
        on(modal, 'click', (e) => {
            if (e.target === modal) this.closeStitchModal();
        });

        // Tabs nguồn (Upload PDF vs Folder Pages)
        const tabUpload = $('btnStitchTabUpload');
        const tabFolder = $('btnStitchTabFolder');
        on(tabUpload, 'click', () => this.switchStitchSource('upload'));
        on(tabFolder, 'click', () => this.switchStitchSource('folder'));

        // Input & Drag-and-drop PDF
        const fileInput = $('stitchFileInput');
        const dropzone = $('stitchDropzone');
        if (fileInput) {
            on(fileInput, 'change', (e) => {
                if (e.target.files && e.target.files[0]) {
                    this.setStitchFile(e.target.files[0]);
                }
            });
        }
        if (dropzone) {
            ['dragenter', 'dragover'].forEach(ev => {
                on(dropzone, ev, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropzone.classList.add('dragover');
                });
            });
            ['dragleave', 'drop'].forEach(ev => {
                on(dropzone, ev, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropzone.classList.remove('dragover');
                });
            });
            on(dropzone, 'drop', (e) => {
                const files = e.dataTransfer?.files;
                if (files && files.length > 0) {
                    const pdf = Array.from(files).find(f => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');
                    if (pdf) {
                        this.setStitchFile(pdf);
                    } else {
                        this.toastErr('Vui lòng chọn hoặc thả tệp định dạng PDF.');
                    }
                }
            });
        }

        // Bố cục (Vertical / Grid / Horizontal)
        modal.querySelectorAll('.stitch-layout-card').forEach(btn => {
            on(btn, 'click', () => {
                modal.querySelectorAll('.stitch-layout-card').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.stitchState.layout = btn.dataset.layout;
                const gridSettings = $('stitchGridSettings');
                if (gridSettings) {
                    gridSettings.style.display = btn.dataset.layout === 'grid' ? 'flex' : 'none';
                }
                this.scheduleStitchPreview();
            });
        });

        // Số cột khi chọn Grid
        $('segStitchCols')?.querySelectorAll('.stitch-seg-btn').forEach(btn => {
            on(btn, 'click', () => {
                $('segStitchCols').querySelectorAll('.stitch-seg-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.stitchState.cols = parseInt(btn.dataset.cols, 10) || 3;
                this.scheduleStitchPreview();
            });
        });

        // Căn hàng cuối khi chọn Grid
        $('segStitchAlign')?.querySelectorAll('.stitch-seg-btn').forEach(btn => {
            on(btn, 'click', () => {
                $('segStitchAlign').querySelectorAll('.stitch-seg-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.stitchState.lastRowAlign = btn.dataset.align || 'center';
                this.scheduleStitchPreview();
            });
        });

        // Các tùy chọn select & checkbox
        const bindChange = (id, key, parseFn = x => x) => {
            const el = $(id);
            if (el) on(el, 'change', (e) => {
                this.stitchState[key] = parseFn(e.target.value ?? e.target.checked);
                this.scheduleStitchPreview();
            });
        };
        bindChange('selStitchSpacing', 'spacing', x => parseInt(x, 10));
        bindChange('selStitchBg', 'bgColor');
        bindChange('selStitchScale', 'scale', x => parseFloat(x));
        bindChange('selStitchFormat', 'format');
        const chkBorder = $('chkStitchBorder');
        if (chkBorder) on(chkBorder, 'change', (e) => {
            this.stitchState.drawBorder = e.target.checked;
            this.scheduleStitchPreview();
        });

        // Zoom preview
        on($('btnStitchZoomFit'), 'click', () => {
            const img = $('stitchPreviewImg');
            if (img) {
                img.style.maxWidth = '100%';
                img.style.maxHeight = '100%';
                img.style.transform = 'none';
            }
        });
        on($('btnStitchZoom100'), 'click', () => {
            const img = $('stitchPreviewImg');
            if (img) {
                img.style.maxWidth = 'none';
                img.style.maxHeight = 'none';
                img.style.transform = 'none';
            }
        });

        // Hành động xuất
        on($('btnStitchExport'), 'click', () => this.handleStitchExport('save'));
        on($('btnStitchCopy'), 'click', () => this.handleStitchExport('copy'));
        on($('btnStitchImportProject'), 'click', () => this.handleStitchExport('import'));
    }

    openStitchModal(source = 'upload') {
        if (!this.stitchPdfModal) return;
        this.stitchPdfModal.style.display = 'flex';
        this.switchStitchSource(source);
    }

    closeStitchModal() {
        if (!this.stitchPdfModal) return;
        this.stitchPdfModal.style.display = 'none';
        if (this._stitchPreviewUrl) {
            URL.revokeObjectURL(this._stitchPreviewUrl);
            this._stitchPreviewUrl = null;
        }
    }

    switchStitchSource(src) {
        this.stitchState.source = src;
        const btnUpload = $('btnStitchTabUpload');
        const btnFolder = $('btnStitchTabFolder');
        const areaUpload = $('stitchUploadArea');
        const areaFolder = $('stitchFolderArea');

        if (btnUpload) btnUpload.classList.toggle('active', src === 'upload');
        if (btnFolder) btnFolder.classList.toggle('active', src === 'folder');
        if (areaUpload) areaUpload.style.display = src === 'upload' ? 'block' : 'none';
        if (areaFolder) areaFolder.style.display = src === 'folder' ? 'block' : 'none';

        if (src === 'folder') {
            const folder = this.getActiveFolder();
            const ids = folder ? (folder.imageIds || []) : [];
            const selectedInFolder = ids.filter(id => this.selectedPageIds.has(id));
            const targetIds = selectedInFolder.length > 0 ? selectedInFolder : ids;
            const countEl = $('stitchFolderPagesCount');
            if (countEl) {
                countEl.textContent = `${targetIds.length} trang ${selectedInFolder.length > 0 ? '(đã chọn)' : 'trong thư mục'}`;
            }
            if (targetIds.length === 0) {
                this.toastErr('Thư mục hiện tại chưa có trang nào để ghép.');
            }
        }

        this.scheduleStitchPreview();
    }

    setStitchFile(file) {
        this.stitchState.file = file;
        const dropTitle = $('stitchDropTitle');
        const dropSubtitle = $('stitchDropSubtitle');
        if (dropTitle) dropTitle.innerHTML = `<i class="fa-solid fa-file-check text-success"></i> <strong>${escapeHtml(file.name)}</strong>`;
        if (dropSubtitle) dropSubtitle.textContent = `Dung lượng: ${formatBytes(file.size)}`;
        this.scheduleStitchPreview();
    }

    scheduleStitchPreview() {
        clearTimeout(this._stitchTimer);
        this._stitchTimer = setTimeout(() => this.updateStitchPreview(), 150);
    }

    async updateStitchPreview() {
        const state = this.stitchState;
        const imgEl = $('stitchPreviewImg');
        const emptyEl = $('stitchStageEmpty');
        const loadingEl = $('stitchLoadingGlass');
        const btnExport = $('btnStitchExport');
        const btnCopy = $('btnStitchCopy');
        const btnImport = $('btnStitchImportProject');

        if (state.source === 'upload' && !state.file) {
            if (imgEl) imgEl.style.display = 'none';
            if (emptyEl) emptyEl.style.display = 'block';
            [btnExport, btnCopy, btnImport].forEach(b => b && (b.disabled = true));
            return;
        }

        if (state.source === 'folder') {
            const folder = this.getActiveFolder();
            const ids = folder ? (folder.imageIds || []) : [];
            const selectedInFolder = ids.filter(id => this.selectedPageIds.has(id));
            const targetIds = selectedInFolder.length > 0 ? selectedInFolder : ids;
            if (targetIds.length === 0) {
                if (imgEl) imgEl.style.display = 'none';
                if (emptyEl) emptyEl.style.display = 'block';
                [btnExport, btnCopy, btnImport].forEach(b => b && (b.disabled = true));
                return;
            }
        }

        if (loadingEl) loadingEl.style.display = 'flex';

        try {
            let res;
            if (state.source === 'upload') {
                const fd = new FormData();
                fd.append('file', state.file);
                fd.append('layout', state.layout);
                fd.append('cols', state.cols);
                fd.append('spacing', state.spacing);
                fd.append('bg_color', state.bgColor);
                fd.append('draw_border', state.drawBorder ? 'true' : 'false');
                fd.append('last_row_align', state.lastRowAlign);
                fd.append('scale', state.scale);

                res = await fetch('/api/stitch-preview-upload', { method: 'POST', body: fd });
            } else {
                const folder = this.getActiveFolder();
                const ids = folder ? (folder.imageIds || []) : [];
                const selectedInFolder = ids.filter(id => this.selectedPageIds.has(id));
                const targetIds = selectedInFolder.length > 0 ? selectedInFolder : ids;
                const filenames = targetIds.map(id => this.pages.get(id)?.filename).filter(Boolean);

                res = await fetch('/api/stitch-preview-pages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        relative_path: folder ? folder.relativePath : '',
                        filenames,
                        layout: state.layout,
                        cols: state.cols,
                        spacing: state.spacing,
                        bg_color: state.bgColor,
                        draw_border: state.drawBorder,
                        last_row_align: state.lastRowAlign,
                        scale: state.scale,
                    }),
                });
            }

            if (!res.ok) {
                let detail = 'Không tạo được ảnh xem trước.';
                try {
                    const err = await res.json();
                    if (err && err.detail) detail = err.detail;
                } catch (_) {}
                throw new Error(detail);
            }

            const blob = await res.blob();
            if (this._stitchPreviewUrl) URL.revokeObjectURL(this._stitchPreviewUrl);
            this._stitchPreviewUrl = URL.createObjectURL(blob);

            if (imgEl) {
                imgEl.src = this._stitchPreviewUrl;
                imgEl.style.display = 'block';
            }
            if (emptyEl) emptyEl.style.display = 'none';

            // Đọc thông số kết xuất từ headers
            const outW = res.headers.get('X-Out-Width') || '--';
            const outH = res.headers.get('X-Out-Height') || '--';
            const totalPages = res.headers.get('X-Total-Pages') || '0';
            const cols = res.headers.get('X-Cols') || state.cols;

            const badgePages = $('stitchBadgePages');
            const badgeLayout = $('stitchBadgeLayout');
            const badgeDim = $('stitchBadgeDim');

            if (badgePages) badgePages.innerHTML = `<i class="fa-regular fa-file-pdf text-accent"></i> ${totalPages} trang`;
            if (badgeDim) badgeDim.textContent = `${outW} × ${outH} px`;

            if (badgeLayout) {
                if (state.layout === 'vertical') {
                    badgeLayout.innerHTML = '<i class="fa-solid fa-arrows-up-down text-accent"></i> Dọc 1 cột';
                } else if (state.layout === 'horizontal') {
                    badgeLayout.innerHTML = '<i class="fa-solid fa-arrows-left-right text-accent"></i> Ngang 1 hàng';
                } else {
                    const numP = parseInt(totalPages, 10) || 0;
                    const numC = parseInt(cols, 10) || 3;
                    if (numP === 5 && numC === 3) {
                        badgeLayout.innerHTML = '<i class="fa-solid fa-table-cells text-accent"></i> Lưới 3 cột (3 trên, 2 dưới)';
                    } else {
                        badgeLayout.innerHTML = `<i class="fa-solid fa-table-cells text-accent"></i> Lưới ${numC} cột`;
                    }
                }
            }

            [btnExport, btnCopy, btnImport].forEach(b => b && (b.disabled = false));
        } catch (err) {
            console.error('[stitch-preview]', err);
            this.toastErr(err.message);
            if (imgEl) imgEl.style.display = 'none';
            if (emptyEl) emptyEl.style.display = 'block';
            [btnExport, btnCopy, btnImport].forEach(b => b && (b.disabled = true));
        } finally {
            if (loadingEl) loadingEl.style.display = 'none';
        }
    }

    async handleStitchExport(action = 'save') {
        const state = this.stitchState;
        const isUpload = state.source === 'upload';
        const ext = (state.format || 'jpeg').toLowerCase() === 'png' ? 'png' : 'jpg';

        let suggestedTitle = 'Ghep-PDF';
        let relPath = '';

        if (isUpload && state.file) {
            const base = state.file.name.replace(/\.[^/.]+$/, "");
            suggestedTitle = `${base}_ghep_${state.layout}`;
        } else {
            const folder = this.getActiveFolder();
            relPath = folder ? folder.relativePath : '';
            const fName = folder ? folder.name : 'Tai-Lieu';
            suggestedTitle = `${fName}_ghep_${state.layout}`;
        }

        try {
            if (action === 'save') {
                const savePath = await this.askSavePath(suggestedTitle, ext, relPath);
                if (!savePath) return; // Người dùng hủy

                this.showLoading('Đang kết xuất và lưu ảnh ghép…');

                if (isUpload) {
                    const fd = new FormData();
                    fd.append('file', state.file);
                    fd.append('layout', state.layout);
                    fd.append('cols', state.cols);
                    fd.append('spacing', state.spacing);
                    fd.append('bg_color', state.bgColor);
                    fd.append('draw_border', state.drawBorder ? 'true' : 'false');
                    fd.append('last_row_align', state.lastRowAlign);
                    fd.append('scale', state.scale);
                    fd.append('format', state.format);
                    fd.append('doc_name', suggestedTitle);
                    fd.append('save_path', savePath);

                    const res = await fetch('/api/stitch-export-upload', { method: 'POST', body: fd });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.detail || 'Không lưu được ảnh ghép.');
                    }
                    const data = await res.json();
                    this.toastOk(this.savedMessage(`ảnh ghép (${data.pages} trang)`, data));
                } else {
                    const folder = this.getActiveFolder();
                    const ids = folder ? (folder.imageIds || []) : [];
                    const selectedInFolder = ids.filter(id => this.selectedPageIds.has(id));
                    const targetIds = selectedInFolder.length > 0 ? selectedInFolder : ids;
                    const filenames = targetIds.map(id => this.pages.get(id)?.filename).filter(Boolean);

                    const data = await apiJson('/api/stitch-export-pages', {
                        relative_path: relPath,
                        filenames,
                        layout: state.layout,
                        cols: state.cols,
                        spacing: state.spacing,
                        bg_color: state.bgColor,
                        draw_border: state.drawBorder,
                        last_row_align: state.lastRowAlign,
                        scale: state.scale,
                        format: state.format,
                        doc_name: suggestedTitle,
                        save_path: savePath,
                    });
                    this.toastOk(this.savedMessage(`ảnh ghép (${data.pages} trang)`, data));
                }
            } else if (action === 'copy') {
                this.showLoading('Đang chuẩn bị ảnh để sao chép…');
                let blob;
                if (isUpload) {
                    const fd = new FormData();
                    fd.append('file', state.file);
                    fd.append('layout', state.layout);
                    fd.append('cols', state.cols);
                    fd.append('spacing', state.spacing);
                    fd.append('bg_color', state.bgColor);
                    fd.append('draw_border', state.drawBorder ? 'true' : 'false');
                    fd.append('last_row_align', state.lastRowAlign);
                    fd.append('scale', state.scale);
                    fd.append('format', 'png');

                    const res = await fetch('/api/stitch-export-upload', { method: 'POST', body: fd });
                    if (!res.ok) throw new Error('Không thể tạo dữ liệu ảnh để sao chép.');
                    blob = await res.blob();
                } else {
                    const folder = this.getActiveFolder();
                    const ids = folder ? (folder.imageIds || []) : [];
                    const selectedInFolder = ids.filter(id => this.selectedPageIds.has(id));
                    const targetIds = selectedInFolder.length > 0 ? selectedInFolder : ids;
                    const filenames = targetIds.map(id => this.pages.get(id)?.filename).filter(Boolean);

                    const res = await fetch('/api/stitch-export-pages', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            relative_path: relPath,
                            filenames,
                            layout: state.layout,
                            cols: state.cols,
                            spacing: state.spacing,
                            bg_color: state.bgColor,
                            draw_border: state.drawBorder,
                            last_row_align: state.lastRowAlign,
                            scale: state.scale,
                            format: 'png',
                        }),
                    });
                    if (!res.ok) throw new Error('Không thể tạo dữ liệu ảnh để sao chép.');
                    blob = await res.blob();
                }

                if (!navigator.clipboard || !navigator.clipboard.write) {
                    throw new Error('Trình duyệt không hỗ trợ sao chép ảnh vào Clipboard.');
                }
                const pngBlob = await this.blobToPngBlob(blob);
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
                this.toastOk('Đã sao chép ảnh ghép vào bộ nhớ tạm (Clipboard).');
            } else if (action === 'import') {
                this.showLoading('Đang thêm ảnh ghép vào thư mục dự án…');
                const folder = this.getActiveFolder();
                const curRel = folder ? folder.relativePath : '';

                if (isUpload) {
                    const fd = new FormData();
                    fd.append('file', state.file);
                    fd.append('layout', state.layout);
                    fd.append('cols', state.cols);
                    fd.append('spacing', state.spacing);
                    fd.append('bg_color', state.bgColor);
                    fd.append('draw_border', state.drawBorder ? 'true' : 'false');
                    fd.append('last_row_align', state.lastRowAlign);
                    fd.append('scale', state.scale);
                    fd.append('import_to_project', 'true');
                    fd.append('relative_path', curRel);
                    fd.append('doc_name', suggestedTitle);

                    const res = await fetch('/api/stitch-export-upload', { method: 'POST', body: fd });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.detail || 'Không thể thêm vào dự án.');
                    }
                } else {
                    const ids = folder ? (folder.imageIds || []) : [];
                    const selectedInFolder = ids.filter(id => this.selectedPageIds.has(id));
                    const targetIds = selectedInFolder.length > 0 ? selectedInFolder : ids;
                    const filenames = targetIds.map(id => this.pages.get(id)?.filename).filter(Boolean);

                    await apiJson('/api/stitch-export-pages', {
                        relative_path: curRel,
                        filenames,
                        layout: state.layout,
                        cols: state.cols,
                        spacing: state.spacing,
                        bg_color: state.bgColor,
                        draw_border: state.drawBorder,
                        last_row_align: state.lastRowAlign,
                        scale: state.scale,
                        import_to_project: true,
                        doc_name: suggestedTitle,
                    });
                }

                this.closeStitchModal();
                this.toastOk('Đã thêm ảnh ghép vào thư mục dự án.');
                await this.loadProject(this.rootPath, false);
            }
        } catch (err) {
            console.error('[stitch-export]', err);
            this.toastErr(err.message || 'Thao tác không thành công.');
        } finally {
            this.hideLoading();
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new DocScanApp();
});
