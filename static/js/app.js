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

const VIEW = { EDIT: 'edit', COMPARE: 'compare' };
const AUTOSAVE_MS = 60000;
const META_SAVE_MS = 1200;
const PREVIEW_DEBOUNCE_MS = 160;
const MAX_HISTORY = 30;

const DEFAULT_SETTINGS = {
    mode: 'natural',
    shadow_reduction: 0.6,
    sharpness: 0.6,
    contrast: 0.2,
    brightness: 0.0,
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



class DocScanApp {
    constructor() {
        this.rootPath = localStorage.getItem('docscan_root_path') || '';
        this.rootName = '';

        this.folders = [];
        this.pages = new Map();
        this.activeFolderId = 'folder_root';
        this.activeImageId = null;

        this.viewMode = VIEW.COMPARE;
        this.holdingCompare = false;
        this.showHandles = true;
        this.sliderPos = 0.5;

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

        if (this.rootPath) {
            this.loadProject(this.rootPath, false);
        } else {
            this.setStatus('Hãy chọn thư mục tài liệu trên máy để bắt đầu.', 'info');
        }
    }

    // ======================================================
    // 🔗 THAM CHIẾU PHẦN TỬ GIAO DIỆN
    // ======================================================

    initElements() {
        const $ = (id) => document.getElementById(id);

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
        this.btnDownloadFolderZip = $('btnDownloadFolderZip');
        this.lblDownloadZip = $('lblDownloadZip');
        this.controlPanel = $('controlPanel');

        this.selectionActionBar = $('selectionActionBar');
        this.selectionCount = $('selectionCount');
        this.btnSelectAllPages = $('btnSelectAllPages');
        this.btnDeselectAllPages = $('btnDeselectAllPages');

        this.btnModeEdit = $('btnModeEdit');
        this.btnModeCompare = $('btnModeCompare');
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
        this.btnExpandMargin = $('btnExpandMargin');
        this.btnShrinkMargin = $('btnShrinkMargin');
        this.btnRotateLeft = $('btnRotateLeft');
        this.btnRotateRight = $('btnRotateRight');

        this.modeCards = document.querySelectorAll('.mode-card');
        this.chkDewarp = $('chkDewarp');
        this.dewarpStrengthGroup = $('dewarpStrengthGroup');
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
        const on = (el, evt, fn, opts) => { if (el) el.addEventListener(evt, fn, opts); };

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
            } else if (!typing && (e.code === 'Space' || e.key === '\\')) {
                if (!this.holdingCompare) { e.preventDefault(); this.setHoldingCompare(true); }
            }
        });
        window.addEventListener('keyup', (e) => {
            if ((e.code === 'Space' || e.key === '\\') && this.holdingCompare) this.setHoldingCompare(false);
        });

        // --- 2 Chế độ làm việc: Chỉnh sửa & So sánh ---
        on(this.btnModeEdit, 'click', () => this.setViewMode(VIEW.EDIT));
        on(this.btnModeCompare, 'click', () => this.setViewMode(VIEW.COMPARE));

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
                if (this.viewMode !== VIEW.COMPARE) this.setViewMode(VIEW.COMPARE);
                this.requestPreview();
            });
        });

        const bindSlider = (input, label, apply, formatter) => {
            if (!input) return;
            // Ghi 1 mốc hoàn tác duy nhất cho cả lượt kéo, không phải mỗi pixel.
            on(input, 'pointerdown', () => { if (this.getActivePage()) this.pushHistory('Chỉnh thanh trượt'); });
            on(input, 'input', (e) => {
                const page = this.getActivePage();
                if (label) label.textContent = formatter(e.target.value);
                if (!page) return;
                apply(page, e.target.value);
                if (this.viewMode !== VIEW.COMPARE) this.setViewMode(VIEW.COMPARE);
                this.requestPreview();
            });
        };

        bindSlider(this.rngDewarp, this.valDewarp,
            (p, v) => { p.settings.dewarp_strength = parseFloat(v); }, (v) => v);
        bindSlider(this.rngShadow, this.valShadow,
            (p, v) => { p.settings.shadow_reduction = v / 100; }, (v) => `${v}%`);
        bindSlider(this.rngSharpness, this.valSharpness,
            (p, v) => { p.settings.sharpness = v / 100; }, (v) => `${v}%`);
        bindSlider(this.rngContrast, this.valContrast,
            (p, v) => { p.settings.contrast = v / 100; }, (v) => `${v}%`);
        bindSlider(this.rngQuality, this.valQuality,
            (p, v) => { p.settings.quality = parseInt(v, 10); }, (v) => `${v}%`);
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
            page.settings.normalize_res = e.target.checked;
            this.markDirty(page);
            this.scheduleMetaSave();
        });

        // --- Lưu & xuất trên thanh Top Bar (phục vụ trực tiếp cho trang đang mở) ---
        on(this.btnSaveToDisk, 'click', () => this.saveProject());
        on(this.btnExportPdf, 'click', () => this.exportCurrentPagePdf());
        on(this.btnDownloadCurrent, 'click', () => this.downloadCurrentPage('jpeg'));

        // --- Xuất theo Thư mục (ở thanh công cụ Thumbnail) ---
        on(this.btnExportFolderPdf, 'click', () => this.exportFolderPdf(this.activeFolderId));
        on(this.btnDownloadFolderZip, 'click', () => this.downloadFolderZip(this.activeFolderId));

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
            if (target) this.selectFolder(target.id);

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
            this.activeImageId = null;
            this.editorStage.style.display = 'none';
            this.emptyState.style.display = 'flex';
            this.docNameWrapper.style.display = 'none';
            this.updateHistoryButtons();
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
        this.showLoading(`Đang thêm ${files.length} ảnh vào "${folder ? folder.name : ''}"…`);

        let firstId = null;
        let added = 0;
        try {
            for (const file of files) {
                const form = new FormData();
                form.append('file', file);
                form.append('relative_path', relPath);

                const res = await fetch('/api/import', { method: 'POST', body: form });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || `Không thêm được ảnh "${file.name}".`);
                }
                const raw = await res.json();
                const page = this.toPage(raw);
                this.pages.set(page.id, page);
                if (folder && !folder.imageIds.includes(page.id)) folder.imageIds.push(page.id);
                if (!firstId) firstId = page.id;
                added++;
            }

            this.renderFolderTree();
            this.updateFolderHeader();
            this.renderPageList();
            if (firstId) await this.selectPage(firstId);
            this.updateFolderActionButtons();
            this.toastOk(`Đã thêm ${added} ảnh và lưu ngay ảnh gốc, ảnh đã sửa & metadata vào máy.`);
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
        if (this.lblDownloadZip) {
            this.lblDownloadZip.textContent = count > 0 ? `Lưu ảnh (${count})` : 'Lưu ảnh';
        }

        if (this.btnExportFolderPdf) this.btnExportFolderPdf.disabled = count === 0;
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
        if (this.btnDownloadFolderZip) this.btnDownloadFolderZip.disabled = !hasSelected;
        if (this.btnExportPdf) this.btnExportPdf.disabled = !hasActivePage;
        if (this.btnSaveToDisk) this.btnSaveToDisk.disabled = this.dirtyPages.size === 0;
        if (this.btnDownloadCurrent) this.btnDownloadCurrent.disabled = !hasActivePage;

        // Bảng Inspector bên phải: Chỉ kích hoạt khi đang có 1 ảnh được chọn xem/sửa
        if (this.controlPanel) {
            this.controlPanel.classList.toggle('disabled', !hasActivePage);
        }

        // Floating toolbar buttons
        if (this.btnResetToRawOriginal) this.btnResetToRawOriginal.disabled = !hasActivePage;
        if (this.btnResetCorners) this.btnResetCorners.disabled = !hasActivePage;
        if (this.btnAutoDetect) this.btnAutoDetect.disabled = !hasActivePage;
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
        if (!page._savedSnapshot) {
            page._savedSnapshot = {
                corners: JSON.parse(JSON.stringify(page.corners || [])),
                rotation: page.rotation || 0,
                settings: JSON.parse(JSON.stringify(page.settings || {})),
                docName: page.docName || '',
            };
        }
        this.emptyState.style.display = 'none';
        this.editorStage.style.display = 'flex';
        this.docNameWrapper.style.display = 'flex';
        this.btnDownloadCurrent.disabled = false;

        this.txtDocName.value = page.docName;
        this.renderNameSuggestions(page);

        this.syncInspector(page.settings);
        this.updateMetrics(page);
        this.updateHistoryButtons();
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
            page.outSize = blob.size;
            page.outSizeHuman = formatBytes(blob.size);
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
                saved += this.markPagesSaved(pages, data.saved_filenames);
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
    markPagesSaved(pages, savedFilenames) {
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
            };
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
            const saved = this.markPagesSaved(dirty, data.saved_filenames);
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
            this.drawCanvas();
            this.requestPreview();
            this.toastOk(data.detected
                ? 'Đã nhận diện chính xác mép giấy.'
                : 'Không thấy mép giấy rõ ràng — đã căn toàn bộ trang.');
        } catch (err) {
            this.toastErr(err.message);
        }
    }

    expandMargin(margin = 0.02) {
        const page = this.getActivePage();
        if (!page || !page.corners) return;
        this.ensureCornerView();
        this.pushHistory('Mở rộng lề 2%');

        const pts = page.corners;
        const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
        const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
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
        const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
        const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
        const factor = 1 - margin * 2;
        page.corners = pts.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);

        this.drawCanvas();
        this.requestPreview();
        this.toastOk('Đã thu hẹp lề 2%.');
    }

    setCornersToFullFrame() {
        const page = this.getActivePage();
        if (!page) return;
        this.ensureCornerView();
        this.pushHistory('Bao trọn toàn ảnh');
        page.corners = this.fullFrameCorners(page.width, page.height);
        this.drawCanvas();
        this.requestPreview();
        this.toastOk('Đã đặt 4 góc bao trọn toàn bộ ảnh.');
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
            'Ảnh gốc cũ trong thư mục _goc/ sẽ được thay thế bằng bản ảnh nét hiện tại và lịch sử hoàn tác được làm mới. Bạn vẫn tiếp tục chỉnh sửa được trên nền ảnh mới.',
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
            this.toastOk('Đã lưu ảnh sửa thành ảnh gốc.');
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
        this.syncInspector(page.settings);
        this.drawCanvas();
        this.requestPreview();
        this.updateHistoryButtons();
    }

    undo() {
        const page = this.getActivePage();
        if (!page || page.history.undo.length === 0) return;
        page.history.redo.push(this.snapshot(page));
        const prev = page.history.undo.pop();
        this.applySnapshot(page, prev);
        this.setStatus(`Đã hoàn tác: ${prev.description || 'thao tác trước'}`, 'info');
    }

    redo() {
        const page = this.getActivePage();
        if (!page || page.history.redo.length === 0) return;
        page.history.undo.push(this.snapshot(page));
        const next = page.history.redo.pop();
        this.applySnapshot(page, next);
        this.setStatus('Đã làm lại thao tác.', 'info');
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

    setViewMode(mode) {
        this.viewMode = mode;
        if (mode === VIEW.COMPARE) this.ensureBaseline();
        this.btnModeEdit?.classList.toggle('active', mode === VIEW.EDIT);
        this.btnModeCompare?.classList.toggle('active', mode === VIEW.COMPARE);
        this.showHandles = (mode === VIEW.EDIT);
        this.layoutCanvas();
    }

    setHoldingCompare(on) {
        if (this.holdingCompare === on) return;
        this.holdingCompare = on;
        this.layoutCanvas();
    }

    isShowingOriginal() {
        return this.holdingCompare || this.viewMode === VIEW.EDIT || !this.editedImg;
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
            this.setStatus('Bản đã chỉnh sửa — chữ đã được làm nét và cân bằng ánh sáng.', 'ok');
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
        for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();

        ctx.fillStyle = 'rgba(56, 189, 248, 0.10)';
        ctx.fill();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Lưới 1/3 giúp căn tài liệu cân đối
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

        pts.forEach(([x, y], i) => {
            const active = i === this.draggingCornerIndex;
            ctx.beginPath();
            ctx.arc(x, y, active ? this.handleRadius + 3 : this.handleRadius, 0, Math.PI * 2);
            ctx.fillStyle = active ? '#0ea5e9' : '#38bdf8';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 3;
            ctx.stroke();
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

    onPointerDown(e) {
        const page = this.getActivePage();
        if (!page) return;
        const pos = this.canvasCoords(e);
        // Kính lúp lấy mẫu từ bộ đệm canvas (hệ toạ độ MÀN HÌNH), còn `pos` đã bị
        // nghịch-xoay về hệ toạ độ ảnh. Dùng lẫn hai hệ này thì kính lúp soi sai vùng.
        const screen = this.screenCoords(e);

        if (this.viewMode === VIEW.COMPARE && !this.holdingCompare && this.editedImg) {
            const sliderX = this.imgOffsetX + this.imgRenderW * this.sliderPos;
            if (Math.abs(pos.x - sliderX) <= 22) { this.isSliding = true; return; }
        }

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
                    this.pushHistory('Kéo chỉnh góc mép giấy');
                    this.drawCanvas();
                    this.showMagnifier(screen.x, screen.y, i);
                    return;
                }
            }
        }

        this.isPanning = true;
        this.panStartX = e.clientX - this.panX;
        this.panStartY = e.clientY - this.panY;
        this.canvasViewport.classList.add('panning');
    }

    onPointerMove(e) {
        if (this.isSliding) {
            const pos = this.canvasCoords(e);
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
            const pos = this.canvasCoords(e);
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
            // Cho phép kéo ra ngoài mép ảnh 10% để đắp thêm viền giấy.
            page.corners[this.draggingCornerIndex] = [
                Math.max(-page.width * 0.1, Math.min(page.width * 1.1, x)),
                Math.max(-page.height * 0.1, Math.min(page.height * 1.1, y)),
            ];
            this.drawCanvas();
            this.showMagnifier(screen.x, screen.y, this.draggingCornerIndex);
            return;
        }

        if (this.viewMode === VIEW.COMPARE && !this.holdingCompare && this.editedImg && this.imgRenderW) {
            const pos = this.canvasCoords(e);
            const sliderX = this.imgOffsetX + this.imgRenderW * this.sliderPos;
            this.canvasViewport.style.cursor = Math.abs(pos.x - sliderX) <= 18 ? 'ew-resize' : '';
        } else {
            this.canvasViewport.style.cursor = '';
        }
    }

    onPointerUp() {
        this.isSliding = false;
        if (this.draggingCornerIndex !== -1) {
            this.draggingCornerIndex = -1;
            this.hideMagnifier();
            this.drawCanvas();
            this.requestPreview();
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

        const labels = ['Góc trên - trái', 'Góc trên - phải', 'Góc dưới - phải', 'Góc dưới - trái'];
        this.lensLabel.textContent = labels[cornerIdx] || 'Góc';

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
                    this.editorStage.style.display = 'none';
                    this.emptyState.style.display = 'flex';
                    this.docNameWrapper.style.display = 'none';
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

        this.chkDewarp.checked = !!settings.dewarp_enabled;
        this.dewarpStrengthGroup.style.display = settings.dewarp_enabled ? 'flex' : 'none';
        this.rngDewarp.value = settings.dewarp_strength ?? 0.8;
        this.valDewarp.textContent = this.rngDewarp.value;

        const pct = (v, d) => Math.round((v ?? d) * 100);
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
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new DocScanApp();
});
