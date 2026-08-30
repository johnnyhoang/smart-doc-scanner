// DocScan Studio Frontend Application
// Quản lý Dự án & Thư mục Đa cấp, Sắp xếp thứ tự ảnh, Dán ảnh Clipboard & Lưu vào Thư mục Root trên Máy

class DocScanApp {
    constructor() {
        const savedDiskPath = localStorage.getItem('docscan_root_path') || 'C:\\DocScan_Projects\\DuAn1';

        // Multi-level Project & Folder Architecture
        this.projects = [
            {
                id: 'proj_default',
                name: 'Dự án: Tài liệu Scan',
                rootFolderId: 'folder_root',
                rootDiskPath: savedDiskPath
            }
        ];
        this.activeProjectId = 'proj_default';

        this.folders = [
            {
                id: 'folder_root',
                projectId: 'proj_default',
                name: 'Thư mục gốc',
                parentId: null,
                imageIds: [],
                isExpanded: true
            }
        ];
        this.activeFolderId = 'folder_root';

        // Image Map: imageId -> Page Object
        this.images = new Map();
        this.activeImageId = null;
        this.currentView = 'crop';

        // Undo / Redo History Stacks per image
        this.historyMap = new Map();
        this.isApplyingHistory = false;

        // Canvas State with Padding for Free Margin Outpainting
        this.canvas = document.getElementById('cropCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.currentImageObj = null;
        this.draggingCornerIndex = -1;
        this.handleRadius = 14;
        this.canvasPaddingRatio = 0.12;

        // Zoom & Pan State
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;
        this.isPanning = false;
        this.panStartX = 0;
        this.panStartY = 0;

        // Magnifier State
        this.magCanvas = document.getElementById('magnifierCanvas');
        this.magCtx = this.magCanvas.getContext('2d');
        this.magLens = document.getElementById('magnifierLens');
        this.lensLabel = document.getElementById('lensLabel');

        // Comparison Slider State
        this.isSliding = false;

        // Drag & Drop Reorder State
        this.draggedImageId = null;

        // Modal States
        this.folderModalState = { mode: 'create_subfolder', targetFolderId: null };
        this.moveModalState = { imageId: null, selectedTargetFolderId: null };

        this.initElements();
        this.bindEvents();
        this.initSidebarResizers();
        this.updateProjectHeaderUI();
        this.renderFolderTree();
        this.updateActiveFolderUI();

        // Auto load existing directory tree & images from disk
        if (savedDiskPath) {
            this.loadProjectFromDisk(savedDiskPath, false);
        }
    }

    initElements() {
        this.pageSidebar = document.getElementById('pageSidebar');
        this.folderSection = document.getElementById('folderSection');
        this.pagesSection = document.getElementById('pagesSection');
        this.sidebarDividerH = document.getElementById('sidebarDividerH');
        this.sidebarResizerV = document.getElementById('sidebarResizerV');

        this.btnUndo = document.getElementById('btnUndo');
        this.btnRedo = document.getElementById('btnRedo');

        // Project Selector Elements
        this.projectDropdownContainer = document.getElementById('projectDropdownContainer');
        this.btnProjectSelector = document.getElementById('btnProjectSelector');
        this.currentProjectTitle = document.getElementById('currentProjectTitle');
        this.projectDropdownMenu = document.getElementById('projectDropdownMenu');

        // Physical Root Disk Directory Elements
        this.btnPickRootDir = document.getElementById('btnPickRootDir');
        this.btnOpenExplorer = document.getElementById('btnOpenExplorer');
        this.lblRootPath = document.getElementById('lblRootPath');

        // Document name box & AI Suggestion Banner
        this.docNameWrapper = document.getElementById('docNameWrapper');
        this.txtDocName = document.getElementById('txtDocName');
        this.btnMagicSuggest = document.getElementById('btnMagicSuggest');
        this.suggestMenu = document.getElementById('suggestMenu');

        this.aiSuggestBanner = document.getElementById('aiSuggestBanner');
        this.btnRunAiSuggest = document.getElementById('btnRunAiSuggest');
        this.btnDismissAiSuggest = document.getElementById('btnDismissAiSuggest');

        this.fileInput = document.getElementById('fileInput');
        this.heroFileInput = document.getElementById('heroFileInput');

        // Save to Disk Dropdown in Header & Action Bar
        this.btnSaveToDiskMenu = document.getElementById('btnSaveToDiskMenu');
        this.saveDiskDropdown = document.getElementById('saveDiskDropdown');
        this.menuSaveFolderDisk = document.getElementById('menuSaveFolderDisk');
        this.menuSaveProjectDisk = document.getElementById('menuSaveProjectDisk');
        this.btnSaveFolderToDisk = document.getElementById('btnSaveFolderToDisk');

        // Apply as Original buttons
        this.btnApplyAsOriginal = document.getElementById('btnApplyAsOriginal');
        this.btnPanelApplyAsOriginal = document.getElementById('btnPanelApplyAsOriginal');

        // Export PDF Dropdown
        this.btnExportPdf = document.getElementById('btnExportPdf');
        this.exportDropdown = document.getElementById('exportDropdown');
        this.menuExportActiveFolder = document.getElementById('menuExportActiveFolder');
        this.menuExportAllProject = document.getElementById('menuExportAllProject');

        this.btnDownloadCurrent = document.getElementById('btnDownloadCurrent');
        this.downloadDropdown = document.getElementById('downloadDropdown');

        this.emptyState = document.getElementById('emptyState');
        this.editorStage = document.getElementById('editorStage');
        this.dropZone = document.getElementById('dropZone');

        // Folder & Page Sidebar Elements
        this.folderTreeContainer = document.getElementById('folderTreeContainer');
        this.btnAddSubfolder = document.getElementById('btnAddSubfolder');
        this.btnNewProject = document.getElementById('btnNewProject');
        this.activeFolderName = document.getElementById('activeFolderName');
        this.pageCount = document.getElementById('pageCount');
        this.pageListContainer = document.getElementById('pageListContainer');

        this.btnSortMenu = document.getElementById('btnSortMenu');
        this.sortDropdown = document.getElementById('sortDropdown');
        this.btnExportFolderPdf = document.getElementById('btnExportFolderPdf');

        // Apple-Style View Switch & Controls (1 Cửa Sổ Duy Nhất)
        this.btnShowEdited = document.getElementById('btnShowEdited');
        this.btnShowOriginal = document.getElementById('btnShowOriginal');
        this.btnHoldCompare = document.getElementById('btnHoldCompare');
        this.btnToggleCropHandles = document.getElementById('btnToggleCropHandles');
        this.cropCanvasWrapper = document.getElementById('cropCanvasWrapper');
        this.canvasViewport = document.getElementById('canvasViewport');
        this.canvasTransformBox = document.getElementById('canvasTransformBox');
        this.resultStatusBar = document.getElementById('resultStatusBar');
        this.resultInfoText = document.getElementById('resultInfoText');
        this.statusIcon = document.getElementById('statusIcon');

        this.btnZoomIn = document.getElementById('btnZoomIn');
        this.btnZoomOut = document.getElementById('btnZoomOut');
        this.btnZoomFit = document.getElementById('btnZoomFit');
        this.btnZoom100 = document.getElementById('btnZoom100');
        this.lblZoomLevel = document.getElementById('lblZoomLevel');

        this.btnAutoDetect = document.getElementById('btnAutoDetect');
        this.btnExpandMargin = document.getElementById('btnExpandMargin');
        this.btnResetCorners = document.getElementById('btnResetCorners');
        this.btnResetToRawOriginal = document.getElementById('btnResetToRawOriginal');
        this.btnRotateLeft = document.getElementById('btnRotateLeft');
        this.btnRotateRight = document.getElementById('btnRotateRight');

        // Inspector Controls
        this.modeCards = document.querySelectorAll('.mode-card');
        this.chkDewarp = document.getElementById('chkDewarp');
        this.dewarpStrengthGroup = document.getElementById('dewarpStrengthGroup');
        this.rngDewarp = document.getElementById('rngDewarp');
        this.valDewarp = document.getElementById('valDewarp');

        this.rngShadow = document.getElementById('rngShadow');
        this.valShadow = document.getElementById('valShadow');

        this.rngSharpness = document.getElementById('rngSharpness');
        this.valSharpness = document.getElementById('valSharpness');

        this.rngMargin = document.getElementById('rngMargin');
        this.valMargin = document.getElementById('valMargin');

        this.rngContrast = document.getElementById('rngContrast');
        this.valContrast = document.getElementById('valContrast');

        this.rngQuality = document.getElementById('rngQuality');
        this.valQuality = document.getElementById('valQuality');
        this.chkNormalizeDpi = document.getElementById('chkNormalizeDpi');

        // Metadata elements
        this.metaOrigDim = document.getElementById('metaOrigDim');
        this.metaOrigSize = document.getElementById('metaOrigSize');
        this.metaOutDim = document.getElementById('metaOutDim');
        this.metaOutSize = document.getElementById('metaOutSize');
        this.savingPill = document.getElementById('savingPill');

        this.cardFileName = document.getElementById('cardFileName');
        this.cardOrigDim = document.getElementById('cardOrigDim');
        this.cardOrigSize = document.getElementById('cardOrigSize');
        this.cardMegapixels = document.getElementById('cardMegapixels');
        this.cardOutSize = document.getElementById('cardOutSize');
        this.cardSavingRatio = document.getElementById('cardSavingRatio');

        // Modals & Feedback
        this.toast = document.getElementById('toast');
        this.toastMsg = document.getElementById('toastMsg');
        this.loadingOverlay = document.getElementById('loadingOverlay');
        this.loadingText = document.getElementById('loadingText');

        // Folder Modal
        this.folderNameModal = document.getElementById('folderNameModal');
        this.folderModalTitle = document.getElementById('folderModalTitle');
        this.folderModalLabel = document.getElementById('folderModalLabel');
        this.txtFolderModalName = document.getElementById('txtFolderModalName');
        this.folderModalHint = document.getElementById('folderModalHint');
        this.btnCloseFolderModal = document.getElementById('btnCloseFolderModal');
        this.btnCancelFolderModal = document.getElementById('btnCancelFolderModal');
        this.btnSubmitFolderModal = document.getElementById('btnSubmitFolderModal');

        // Move Image Modal
        this.moveImageModal = document.getElementById('moveImageModal');
        this.moveImageDesc = document.getElementById('moveImageDesc');
        this.moveFolderPicker = document.getElementById('moveFolderPicker');
        this.btnMoveModalNewFolder = document.getElementById('btnMoveModalNewFolder');
        this.moveInlineCreateBox = document.getElementById('moveInlineCreateBox');
        this.txtInlineNewFolder = document.getElementById('txtInlineNewFolder');
        this.btnConfirmInlineFolder = document.getElementById('btnConfirmInlineFolder');
        this.btnCancelInlineFolder = document.getElementById('btnCancelInlineFolder');
        this.btnCloseMoveModal = document.getElementById('btnCloseMoveModal');
        this.btnCancelMoveModal = document.getElementById('btnCancelMoveModal');
        this.btnSubmitMoveModal = document.getElementById('btnSubmitMoveModal');
        this.inlineCreateParentFolderId = null;
    }

    bindEvents() {
        // File Uploads
        this.fileInput.addEventListener('change', (e) => this.handleFilesSelected(e.target.files));
        this.heroFileInput.addEventListener('change', (e) => this.handleFilesSelected(e.target.files));

        // Clipboard Paste Listener (Ctrl + V) from anywhere
        window.addEventListener('paste', (e) => this.handleClipboardPaste(e));

        // Drag and Drop Upload
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
            this.dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        });

        this.dropZone.addEventListener('dragover', () => this.dropZone.classList.add('dragover'));
        this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('dragover'));
        this.dropZone.addEventListener('drop', (e) => {
            this.dropZone.classList.remove('dragover');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                this.handleFilesSelected(e.dataTransfer.files);
            }
        });

        // Project Selector Dropdown in Header
        if (this.btnProjectSelector) {
            this.btnProjectSelector.addEventListener('click', (e) => {
                e.stopPropagation();
                this.renderProjectDropdownMenu();
                this.projectDropdownContainer.classList.toggle('open');
            });
        }

        // Physical Disk Root Directory Controls
        if (this.btnPickRootDir) {
            this.btnPickRootDir.addEventListener('click', () => this.pickRootDiskDirectory());
        }
        if (this.btnOpenExplorer) {
            this.btnOpenExplorer.addEventListener('click', () => this.openActiveFolderInExplorer());
        }
        if (this.lblRootPath) {
            this.lblRootPath.addEventListener('click', () => this.editRootDiskPath());
        }

        // Document Name Input & Suggestion dropdown
        this.txtDocName.addEventListener('input', (e) => {
            const page = this.getActivePage();
            if (page) {
                page.suggested_name = e.target.value;
                this.cardFileName.textContent = e.target.value;
                this.updatePageThumbTitle(page.id, e.target.value);
                this.debounceSaveMetadata(this.activeFolderId);
                this.scheduleAutoSave(60000);
            }
        });

        this.btnMagicSuggest.addEventListener('click', (e) => {
            e.stopPropagation();
            this.suggestMenu.classList.toggle('open');
        });

        if (this.btnRunAiSuggest) {
            this.btnRunAiSuggest.addEventListener('click', () => this.triggerAiDocumentNaming());
        }
        if (this.btnDismissAiSuggest) {
            this.btnDismissAiSuggest.addEventListener('click', () => {
                const page = this.getActivePage();
                if (page) page.aiDismissed = true;
                if (this.aiSuggestBanner) this.aiSuggestBanner.style.display = 'none';
            });
        }

        // Global dropdown auto-close
        window.addEventListener('click', () => {
            this.suggestMenu.classList.remove('open');
            document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
        });

        // Undo / Redo
        this.btnUndo.addEventListener('click', () => this.undo());
        this.btnRedo.addEventListener('click', () => this.redo());

        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                this.undo();
            } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
                e.preventDefault();
                this.redo();
            }
        });

        // Apple-Style View Switch & Hold-to-Compare
        if (this.btnShowEdited) {
            this.btnShowEdited.addEventListener('click', () => {
                this.setViewMode('edited');
            });
        }
        if (this.btnShowOriginal) {
            this.btnShowOriginal.addEventListener('click', () => {
                this.setViewMode('original');
            });
        }

        // Hold to compare button (Mouse & Touch)
        if (this.btnHoldCompare) {
            const startHold = (e) => {
                e.preventDefault();
                this.isHoldingCompare = true;
                this.btnHoldCompare.classList.add('active');
                this.renderCropCanvas();
            };
            const endHold = (e) => {
                if (this.isHoldingCompare) {
                    this.isHoldingCompare = false;
                    this.btnHoldCompare.classList.remove('active');
                    this.renderCropCanvas();
                }
            };
            this.btnHoldCompare.addEventListener('mousedown', startHold);
            this.btnHoldCompare.addEventListener('touchstart', startHold, { passive: false });
            window.addEventListener('mouseup', endHold);
            window.addEventListener('touchend', endHold);
        }

        // Toggle crop corner handles
        if (this.btnToggleCropHandles) {
            this.btnToggleCropHandles.addEventListener('click', () => {
                this.showCropHandles = !this.showCropHandles;
                this.btnToggleCropHandles.classList.toggle('active', this.showCropHandles);
                if (this.currentViewMode !== 'original') {
                    this.setViewMode('original');
                } else {
                    this.renderCropCanvas();
                }
            });
        }

        // Keyboard Spacebar / Backslash Hold-to-Compare
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.code === 'Space' || e.key === '\\') {
                if (!this.isHoldingCompare) {
                    e.preventDefault();
                    this.isHoldingCompare = true;
                    if (this.btnHoldCompare) this.btnHoldCompare.classList.add('active');
                    this.renderCropCanvas();
                }
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space' || e.key === '\\') {
                if (this.isHoldingCompare) {
                    this.isHoldingCompare = false;
                    if (this.btnHoldCompare) this.btnHoldCompare.classList.remove('active');
                    this.renderCropCanvas();
                }
            }
        });

        // Zoom Controls
        this.btnZoomIn.addEventListener('click', () => this.setZoom(this.zoom * 1.25));
        this.btnZoomOut.addEventListener('click', () => this.setZoom(this.zoom / 1.25));
        this.btnZoomFit.addEventListener('click', () => this.resetZoomFit());
        this.btnZoom100.addEventListener('click', () => this.setZoom(1.0, 0, 0));

        this.canvasViewport.addEventListener('wheel', (e) => this.handleWheelZoom(e), { passive: false });

        // Canvas Viewport Mouse & Touch
        this.canvasViewport.addEventListener('mousedown', (e) => this.onViewportMouseDown(e));
        this.canvasViewport.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        this.canvasViewport.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        this.canvasViewport.addEventListener('touchend', () => this.onViewportMouseUp());

        // Global mouse moves and mouse up
        window.addEventListener('mousemove', (e) => this.onViewportMouseMove(e));
        window.addEventListener('mouseup', () => this.onViewportMouseUp());

        // Corner & Image Tools
        this.btnAutoDetect.addEventListener('click', () => {
            this.pushHistoryState("Tự nhận góc");
            this.autoDetectActivePage();
        });

        this.btnExpandMargin.addEventListener('click', () => {
            this.pushHistoryState("Mở rộng lề 2%");
            this.expandMarginActivePage(0.02);
        });

        this.btnResetCorners.addEventListener('click', () => {
            this.pushHistoryState("Trọn ảnh");
            this.resetCornersToBorder();
        });

        if (this.btnResetToRawOriginal) {
            this.btnResetToRawOriginal.addEventListener('click', () => this.resetToRawOriginal());
        }

        this.btnRotateLeft.addEventListener('click', () => {
            this.pushHistoryState("Xoay trái 90°");
            this.rotateActivePage(-90);
        });

        this.btnRotateRight.addEventListener('click', () => {
            this.pushHistoryState("Xoay phải 90°");
            this.rotateActivePage(90);
        });

        if (this.btnApplyAsOriginal) {
            this.btnApplyAsOriginal.addEventListener('click', () => this.applyCurrentAsOriginal());
        }
        if (this.btnPanelApplyAsOriginal) {
            this.btnPanelApplyAsOriginal.addEventListener('click', () => this.applyCurrentAsOriginal());
        }

        // Color & Filter Modes
        this.modeCards.forEach(card => {
            card.addEventListener('click', () => {
                this.modeCards.forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                if (this.getActivePage()) {
                    this.pushHistoryState(`Đổi bộ lọc: ${card.dataset.mode}`);
                    this.getActivePage().settings.mode = card.dataset.mode;
                    this.processActivePage();
                }
            });
        });

        // Inspector Controls
        this.chkDewarp.addEventListener('change', (e) => {
            this.dewarpStrengthGroup.style.display = e.target.checked ? 'flex' : 'none';
            if (this.getActivePage()) {
                this.pushHistoryState(e.target.checked ? "Bật làm phẳng" : "Tắt làm phẳng");
                this.getActivePage().settings.dewarp_enabled = e.target.checked;
                this.processActivePage();
            }
        });

        this.rngDewarp.addEventListener('input', (e) => {
            this.valDewarp.textContent = e.target.value;
            if (this.getActivePage()) {
                this.getActivePage().settings.dewarp_strength = parseFloat(e.target.value);
                this.debounceProcess();
            }
        });

        this.rngShadow.addEventListener('input', (e) => {
            this.valShadow.textContent = `${e.target.value}%`;
            if (this.getActivePage()) {
                this.getActivePage().settings.shadow_reduction = e.target.value / 100;
                this.debounceProcess();
            }
        });

        this.rngSharpness.addEventListener('input', (e) => {
            this.valSharpness.textContent = `${e.target.value}%`;
            if (this.getActivePage()) {
                this.getActivePage().settings.sharpness = e.target.value / 100;
                this.debounceProcess();
            }
        });

        this.rngMargin.addEventListener('input', (e) => {
            this.valMargin.textContent = `${parseFloat(e.target.value).toFixed(1)}%`;
            if (this.getActivePage()) {
                this.getActivePage().settings.margin_percent = parseFloat(e.target.value) / 100;
            }
        });

        this.rngContrast.addEventListener('input', (e) => {
            this.valContrast.textContent = `${e.target.value}%`;
            if (this.getActivePage()) {
                this.getActivePage().settings.contrast = e.target.value / 100;
                this.debounceProcess();
            }
        });

        this.rngQuality.addEventListener('input', (e) => {
            this.valQuality.textContent = `${e.target.value}%`;
            if (this.getActivePage()) {
                this.getActivePage().settings.quality = parseInt(e.target.value);
                this.debounceProcess();
            }
        });

        this.chkNormalizeDpi.addEventListener('change', (e) => {
            if (this.getActivePage()) {
                this.getActivePage().settings.normalize_res = e.target.checked;
                this.processActivePage();
            }
        });

        // Download Single Page Dropdown
        this.btnDownloadCurrent.addEventListener('click', (e) => {
            e.stopPropagation();
            this.btnDownloadCurrent.parentElement.classList.toggle('open');
        });

        this.downloadDropdown.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const fmt = link.dataset.format;
                this.downloadCurrentPage(fmt);
            });
        });

        // Save to Disk Dropdown in Header & Sidebar Button
        if (this.btnSaveToDiskMenu) {
            this.btnSaveToDiskMenu.addEventListener('click', (e) => {
                e.stopPropagation();
                this.btnSaveToDiskMenu.parentElement.classList.toggle('open');
            });
        }

        if (this.menuSaveFolderDisk) {
            this.menuSaveFolderDisk.addEventListener('click', (e) => {
                e.preventDefault();
                this.saveActiveFolderToDisk();
            });
        }

        if (this.menuSaveProjectDisk) {
            this.menuSaveProjectDisk.addEventListener('click', (e) => {
                e.preventDefault();
                this.saveWholeProjectToDisk();
            });
        }

        if (this.btnSaveFolderToDisk) {
            this.btnSaveFolderToDisk.addEventListener('click', () => {
                this.saveActiveFolderToDisk();
            });
        }

        // Export PDF Dropdown in Header
        this.btnExportPdf.addEventListener('click', (e) => {
            e.stopPropagation();
            this.btnExportPdf.parentElement.classList.toggle('open');
        });

        this.menuExportActiveFolder.addEventListener('click', (e) => {
            e.preventDefault();
            this.exportActiveFolderPdf();
        });

        this.menuExportAllProject.addEventListener('click', (e) => {
            e.preventDefault();
            this.exportAllProjectPdf();
        });

        // Folder Action Bar: Sort & Folder PDF
        this.btnSortMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            this.btnSortMenu.parentElement.classList.toggle('open');
        });

        this.sortDropdown.querySelectorAll('a').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const sortType = item.dataset.sort;
                this.sortActiveFolderImages(sortType);
            });
        });

        this.btnExportFolderPdf.addEventListener('click', () => {
            this.exportActiveFolderPdf();
        });

        // Folder Tree Top Buttons
        if (this.btnAddSubfolder) {
            this.btnAddSubfolder.addEventListener('click', () => {
                this.openFolderModal('create_subfolder', this.activeFolderId);
            });
        }

        if (this.btnNewProject) {
            this.btnNewProject.addEventListener('click', () => {
                this.openFolderModal('new_project', null);
            });
        }

        // Folder Modal Actions
        this.btnCloseFolderModal.addEventListener('click', () => this.closeFolderModal());
        this.btnCancelFolderModal.addEventListener('click', () => this.closeFolderModal());
        this.btnSubmitFolderModal.addEventListener('click', () => this.submitFolderModal());
        this.txtFolderModalName.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.submitFolderModal();
            if (e.key === 'Escape') this.closeFolderModal();
        });

        // Move Modal Actions
        this.btnCloseMoveModal.addEventListener('click', () => this.closeMoveModal());
        this.btnCancelMoveModal.addEventListener('click', () => this.closeMoveModal());
        this.btnSubmitMoveModal.addEventListener('click', () => this.submitMoveModal());

        if (this.btnMoveModalNewFolder) {
            this.btnMoveModalNewFolder.addEventListener('click', () => {
                const parentId = this.moveModalState.selectedTargetFolderId || this.activeFolderId;
                this.showInlineFolderCreation(parentId);
            });
        }
        if (this.btnConfirmInlineFolder) {
            this.btnConfirmInlineFolder.addEventListener('click', () => this.confirmInlineFolderCreation());
        }
        if (this.btnCancelInlineFolder) {
            this.btnCancelInlineFolder.addEventListener('click', () => this.hideInlineFolderCreation());
        }
        if (this.txtInlineNewFolder) {
            this.txtInlineNewFolder.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.confirmInlineFolderCreation();
                if (e.key === 'Escape') this.hideInlineFolderCreation();
            });
        }

        window.addEventListener('resize', () => {
            if (this.currentView === 'crop' && this.getActivePage()) {
                this.renderCropCanvas();
            }
        });
    }

    // ==========================================
    // 📐 SIDEBAR & SECTION RESIZERS (KÉO THẢ CHIỀU RỘNG & PHÂN CHIA CHIỀU DỌC)
    // ==========================================

    initSidebarResizers() {
        if (!this.pageSidebar) return;

        // Restore saved sizes from localStorage
        const savedWidth = localStorage.getItem('docscan_sidebar_width');
        if (savedWidth && this.pageSidebar) {
            this.pageSidebar.style.width = `${savedWidth}px`;
        }

        const savedHeight = localStorage.getItem('docscan_folder_height');
        if (savedHeight && this.folderSection) {
            this.folderSection.style.height = `${savedHeight}px`;
        }

        // 1. Horizontal Width Resizer (Kéo giãn chiều rộng sidebar)
        if (this.sidebarResizerV) {
            let isResizingW = false;
            let startX = 0;
            let startW = 0;

            this.sidebarResizerV.addEventListener('mousedown', (e) => {
                isResizingW = true;
                startX = e.clientX;
                startW = this.pageSidebar.offsetWidth;
                this.sidebarResizerV.classList.add('active');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });

            window.addEventListener('mousemove', (e) => {
                if (!isResizingW) return;
                const newWidth = Math.max(220, Math.min(650, startW + (e.clientX - startX)));
                this.pageSidebar.style.width = `${newWidth}px`;
                localStorage.setItem('docscan_sidebar_width', newWidth);
                if (this.currentView === 'crop' && this.getActivePage()) {
                    this.renderCropCanvas();
                }
            });

            window.addEventListener('mouseup', () => {
                if (isResizingW) {
                    isResizingW = false;
                    this.sidebarResizerV.classList.remove('active');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                }
            });
        }

        // 2. Vertical Section Divider (Kéo di chuyển phân chia độ cao Cây thư mục / Danh sách ảnh)
        if (this.sidebarDividerH && this.folderSection) {
            let isResizingH = false;
            let startY = 0;
            let startH = 0;

            this.sidebarDividerH.addEventListener('mousedown', (e) => {
                isResizingH = true;
                startY = e.clientY;
                startH = this.folderSection.offsetHeight;
                this.sidebarDividerH.classList.add('active');
                document.body.style.cursor = 'row-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });

            window.addEventListener('mousemove', (e) => {
                if (!isResizingH) return;
                const sidebarHeight = this.pageSidebar.offsetHeight;
                const newHeight = Math.max(80, Math.min(sidebarHeight - 110, startH + (e.clientY - startY)));
                this.folderSection.style.height = `${newHeight}px`;
                localStorage.setItem('docscan_folder_height', newHeight);
            });

            window.addEventListener('mouseup', () => {
                if (isResizingH) {
                    isResizingH = false;
                    this.sidebarDividerH.classList.remove('active');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                }
            });
        }
    }

    // ==========================================
    // 📋 CLIPBOARD PASTE HANDLER (CTRL + V)
    // ==========================================

    handleClipboardPaste(e) {
        const items = (e.clipboardData || window.clipboardData)?.items;
        if (!items) return;

        const imageFiles = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type && item.type.startsWith('image/')) {
                const blob = item.getAsFile();
                if (blob) {
                    const ext = item.type.split('/')[1] || 'png';
                    const file = new File([blob], `anh_clipboard_${Date.now()}.${ext}`, { type: blob.type });
                    imageFiles.push(file);
                }
            }
        }

        if (imageFiles.length > 0) {
            e.preventDefault();
            this.showToast(`Đã nhận ${imageFiles.length} ảnh dán từ Clipboard!`);
            this.handleFilesSelected(imageFiles);
        }
    }

    // ==========================================
    // 📁 PROJECT & FOLDER TREE MANAGEMENT
    // ==========================================

    getActiveProject() {
        return this.projects.find(p => p.id === this.activeProjectId) || this.projects[0];
    }

    updateProjectHeaderUI() {
        const proj = this.getActiveProject();
        if (proj) {
            if (this.currentProjectTitle) {
                this.currentProjectTitle.textContent = proj.name;
            }
            if (this.lblRootPath) {
                this.lblRootPath.textContent = proj.rootDiskPath || 'C:\\DocScan_Projects';
                this.lblRootPath.title = `Thư mục lưu trên máy: ${proj.rootDiskPath}`;
            }
        }
    }

    async loadProjectFromDisk(diskPath, showSuccessToast = true) {
        if (!diskPath) return;
        const proj = this.getActiveProject();
        this.showLoading(`Đang quét và tải cây thư mục từ máy tính: ${diskPath}...`);

        try {
            const res = await fetch('/api/scan-directory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: diskPath, load_images: true })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Không thể quét thư mục");
            }

            const data = await res.json();
            proj.rootDiskPath = data.root_path;
            proj.name = data.root_name || "Dự án Scan";
            localStorage.setItem('docscan_root_path', data.root_path);

            // Replace folders for this project
            this.folders = data.folders.map(f => ({
                id: f.id,
                projectId: this.activeProjectId,
                name: f.name,
                parentId: f.parentId,
                imageIds: f.imageIds || [],
                isExpanded: true
            }));

            // Fallback root folder if empty
            if (this.folders.length === 0) {
                this.folders.push({
                    id: 'folder_root',
                    projectId: this.activeProjectId,
                    name: data.root_name || 'Thư mục gốc',
                    parentId: null,
                    imageIds: [],
                    isExpanded: true
                });
            }

            // Populate images map with persistent metadata
            if (data.pages && data.pages.length > 0) {
                data.pages.forEach(p => {
                    const defaultSettings = {
                        mode: 'natural',
                        shadow_reduction: 0.6,
                        sharpness: 0.6,
                        contrast: 0.2,
                        brightness: 0.0,
                        margin_percent: 0.02,
                        dewarp_enabled: false,
                        dewarp_strength: 0.8,
                        quality: 85,
                        normalize_res: true
                    };
                    const finalSettings = p.settings ? { ...defaultSettings, ...p.settings } : defaultSettings;

                    if (p.history && (p.history.undo?.length > 0 || p.history.redo?.length > 0)) {
                        this.historyMap.set(p.id, p.history);
                    }

                    this.images.set(p.id, {
                        id: p.id,
                        filename: p.filename,
                        suggested_name: p.suggested_name,
                        name_suggestions: p.name_suggestions || [],
                        width: p.width,
                        height: p.height,
                        megapixels: p.megapixels,
                        file_size_human: p.file_size_human,
                        corners: p.corners,
                        preview_url: p.preview_url,
                        rotation: p.rotation || 0,
                        processed_url: p.processed_url || null,
                        out_dim: null,
                        out_size_human: null,
                        saving_ratio: null,
                        aiAnalyzed: false,
                        aiDismissed: false,
                        settings: finalSettings
                    });
                });
            }

            this.updateProjectHeaderUI();
            this.renderFolderTree();

            // Select root folder or first folder
            const rootFolder = this.folders.find(f => !f.parentId) || this.folders[0];
            this.selectFolder(rootFolder.id);

            if (showSuccessToast) {
                this.showToast(`✅ Đã tải ${data.total_folders} thư mục & ${data.total_images} ảnh từ máy tính!`);
            }
        } catch (err) {
            this.showToast(err.message || "Lỗi khi quét thư mục", false);
            this.renderFolderTree();
            this.updateActiveFolderUI();
        } finally {
            this.hideLoading();
        }
    }

    async pickRootDiskDirectory() {
        this.showLoading("Đang mở hộp thoại chọn thư mục trên máy tính...");
        try {
            const res = await fetch('/api/pick-directory', { method: 'POST' });
            const data = await res.json();
            if (data.success && data.path) {
                await this.loadProjectFromDisk(data.path, true);
            }
        } catch (err) {
            this.showToast("Không thể mở hộp thoại chọn thư mục.", false);
        } finally {
            this.hideLoading();
        }
    }

    async editRootDiskPath() {
        const proj = this.getActiveProject();
        const current = proj.rootDiskPath || 'C:\\DocScan_Projects';
        const newPath = prompt("Nhập hoặc dán đường dẫn Thư mục Root trên máy tính:", current);
        if (newPath && newPath.trim()) {
            await this.loadProjectFromDisk(newPath.trim(), true);
        }
    }

    async openActiveFolderInExplorer() {
        const proj = this.getActiveProject();
        if (!proj || !proj.rootDiskPath) return;

        const relPath = this.getFolderRelativePath(this.activeFolderId);
        const fullPath = relPath ? `${proj.rootDiskPath}\\${relPath.replace(/\//g, '\\')}` : proj.rootDiskPath;

        try {
            const res = await fetch('/api/open-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: fullPath })
            });
            if (!res.ok) {
                // If folder doesn't exist yet, open root
                await fetch('/api/open-folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: proj.rootDiskPath })
                });
            }
            this.showToast(`Đã mở thư mục trong Windows Explorer!`);
        } catch (err) {
            this.showToast("Lỗi khi mở thư mục trên máy tính.", false);
        }
    }

    renderProjectDropdownMenu() {
        if (!this.projectDropdownMenu) return;
        this.projectDropdownMenu.innerHTML = '';

        this.projects.forEach(proj => {
            const item = document.createElement('a');
            item.href = '#';
            const isCurrent = proj.id === this.activeProjectId;
            const imgCount = this.countTotalImagesInProject(proj.id);
            item.innerHTML = `
                <i class="fa-solid ${isCurrent ? 'fa-folder-open text-accent' : 'fa-folder'}"></i>
                <span style="flex: 1; margin-right: 8px;">${proj.name}</span>
                <span class="tree-badge">${imgCount}</span>
                ${isCurrent ? '<i class="fa-solid fa-check ml-2 text-accent"></i>' : ''}
            `;
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.switchProject(proj.id);
            });
            this.projectDropdownMenu.appendChild(item);
        });

        const divider = document.createElement('div');
        divider.style.cssText = 'height: 1px; background: var(--border); margin: 4px 0;';
        this.projectDropdownMenu.appendChild(divider);

        const newItem = document.createElement('a');
        newItem.href = '#';
        newItem.innerHTML = `<i class="fa-solid fa-folder-plus text-accent"></i> <strong>+ Tạo Dự án mới</strong>`;
        newItem.addEventListener('click', (e) => {
            e.preventDefault();
            this.openFolderModal('new_project', null);
        });
        this.projectDropdownMenu.appendChild(newItem);
    }

    switchProject(projectId) {
        const proj = this.projects.find(p => p.id === projectId);
        if (!proj) return;
        this.activeProjectId = projectId;
        this.updateProjectHeaderUI();
        const rootFolder = this.folders.find(f => f.projectId === projectId && !f.parentId);
        if (rootFolder) {
            this.selectFolder(rootFolder.id);
        } else {
            this.renderFolderTree();
        }
        this.showToast(`Đã chuyển sang ${proj.name}`);
    }

    countTotalImagesInProject(projectId) {
        let count = 0;
        const projFolders = this.folders.filter(f => f.projectId === projectId);
        projFolders.forEach(f => {
            count += (f.imageIds || []).length;
        });
        return count;
    }

    getFolder(folderId) {
        return this.folders.find(f => f.id === folderId) || null;
    }

    getActiveFolder() {
        return this.getFolder(this.activeFolderId) || this.folders[0];
    }

    getFolderChildren(folderId) {
        return this.folders.filter(f => f.parentId === folderId);
    }

    getFolderRelativePath(folderId) {
        const parts = [];
        let curr = this.getFolder(folderId);
        while (curr) {
            if (curr.parentId) {
                parts.unshift(curr.name);
            }
            curr = curr.parentId ? this.getFolder(curr.parentId) : null;
        }
        return parts.join('/');
    }

    selectFolder(folderId) {
        const folder = this.getFolder(folderId);
        if (!folder) return;

        this.activeFolderId = folderId;
        this.renderFolderTree();
        this.updateActiveFolderUI();

        const imagesInFolder = folder.imageIds || [];
        if (imagesInFolder.length > 0) {
            if (!this.activeImageId || !imagesInFolder.includes(this.activeImageId)) {
                this.selectPage(imagesInFolder[0]);
            } else {
                this.selectPage(this.activeImageId);
            }
        } else {
            this.activeImageId = null;
            this.emptyState.style.display = 'flex';
            this.editorStage.style.display = 'none';
            this.docNameWrapper.style.display = 'none';
            this.btnExportPdf.disabled = false;
            if (this.btnSaveToDiskMenu) this.btnSaveToDiskMenu.disabled = false;
            this.btnDownloadCurrent.disabled = true;
            this.updateSidebarUI();
        }
    }

    openFolderModal(mode, targetFolderId = null) {
        this.folderModalState = { mode, targetFolderId };
        this.folderNameModal.style.display = 'flex';

        if (mode === 'create_subfolder') {
            const parent = this.getFolder(targetFolderId);
            const parentName = parent ? parent.name : "Thư mục gốc";
            this.folderModalTitle.innerHTML = `<i class="fa-solid fa-folder-plus text-accent"></i> Tạo thư mục con trong '${parentName}'`;
            this.folderModalLabel.textContent = "Tên thư mục con:";
            this.txtFolderModalName.value = `Thư mục con ${this.folders.length}`;
            this.folderModalHint.textContent = "Thư mục con sẽ tương ứng với folder con trên ổ đĩa máy tính.";
        } else if (mode === 'rename_folder') {
            const folder = this.getFolder(targetFolderId);
            this.folderModalTitle.innerHTML = `<i class="fa-solid fa-pen text-accent"></i> Đổi tên thư mục`;
            this.folderModalLabel.textContent = "Tên mới:";
            this.txtFolderModalName.value = folder ? folder.name : "";
            this.folderModalHint.textContent = "Tên thư mục sẽ được dùng làm tên folder trên máy và file PDF.";
        } else if (mode === 'new_project') {
            this.folderModalTitle.innerHTML = `<i class="fa-solid fa-folder-tree text-accent"></i> Tạo Dự án (Root Folder) mới`;
            this.folderModalLabel.textContent = "Tên Dự án:";
            this.txtFolderModalName.value = `Dự án ${this.projects.length + 1}`;
            this.folderModalHint.textContent = "Mỗi Dự án là một Thư mục gốc độc lập chứa các nhánh con.";
        }

        this.txtFolderModalName.focus();
        this.txtFolderModalName.select();
    }

    closeFolderModal() {
        this.folderNameModal.style.display = 'none';
    }

    async submitFolderModal() {
        const name = this.txtFolderModalName.value.trim();
        if (!name) {
            this.showToast("Vui lòng nhập tên hợp lệ.", false);
            return;
        }

        const { mode, targetFolderId } = this.folderModalState;
        const proj = this.getActiveProject();

        if (mode === 'create_subfolder') {
            const parent = this.getFolder(targetFolderId);
            let finalFolderId = 'folder_' + Date.now();

            if (proj && proj.rootDiskPath) {
                try {
                    const parentRel = this.getFolderRelativePath(targetFolderId);
                    const res = await fetch('/api/create-folder', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            root_path: proj.rootDiskPath,
                            relative_path: parentRel,
                            folder_name: name
                        })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        finalFolderId = data.folder_id || finalFolderId;
                    }
                } catch (e) {
                    console.error("Lỗi tạo thư mục vật lý:", e);
                }
            }

            if (parent) parent.isExpanded = true;

            this.folders.push({
                id: finalFolderId,
                projectId: this.activeProjectId,
                name: name,
                parentId: targetFolderId,
                imageIds: [],
                isExpanded: true
            });

            this.showToast(`Đã tạo thư mục '${name}' trên ổ đĩa!`);
            this.renderFolderTree();
            this.selectFolder(finalFolderId);
        } else if (mode === 'rename_folder') {
            const folder = this.getFolder(targetFolderId);
            if (folder) {
                const oldRel = this.getFolderRelativePath(targetFolderId);
                if (proj && proj.rootDiskPath && oldRel) {
                    try {
                        await fetch('/api/rename-folder', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                root_path: proj.rootDiskPath,
                                old_relative_path: oldRel,
                                new_folder_name: name
                            })
                        });
                    } catch (e) {
                        console.error("Lỗi đổi tên trên ổ đĩa:", e);
                    }
                }
                folder.name = name;
                if (!folder.parentId) {
                    if (proj) proj.name = name;
                }
                this.showToast(`Đã đổi tên thành '${name}'!`);
                this.updateProjectHeaderUI();
                this.renderFolderTree();
                this.updateActiveFolderUI();
            }
        } else if (mode === 'new_project') {
            const projId = 'proj_' + Date.now();
            const rootFolderId = 'folder_root_' + Date.now();
            const diskPath = `C:\\DocScan_Projects\\${name.replace(/[^a-zA-Z0-9_\-\s]/g, '_')}`;

            this.projects.push({
                id: projId,
                name: name,
                rootFolderId: rootFolderId,
                rootDiskPath: diskPath
            });

            this.folders.push({
                id: rootFolderId,
                projectId: projId,
                name: name,
                parentId: null,
                imageIds: [],
                isExpanded: true
            });

            this.activeProjectId = projId;
            this.updateProjectHeaderUI();
            this.showToast(`Đã tạo Dự án mới '${name}'!`);
            this.selectFolder(rootFolderId);
        }

        this.closeFolderModal();
    }

    deleteFolder(folderId) {
        const folder = this.getFolder(folderId);
        if (!folder) return;

        // Check if root folder
        if (!folder.parentId) {
            if (this.projects.length <= 1) {
                if (confirm(`Bạn có chắc muốn làm trống thư mục gốc '${folder.name}' và xóa toàn bộ tài liệu bên trong?`)) {
                    folder.imageIds.forEach(id => this.images.delete(id));
                    folder.imageIds = [];
                    const childIds = this.getAllDescendantFolderIds(folderId);
                    childIds.forEach(cid => {
                        const cf = this.getFolder(cid);
                        if (cf) {
                            cf.imageIds.forEach(id => this.images.delete(id));
                        }
                    });
                    this.folders = this.folders.filter(f => !childIds.includes(f.id));
                    this.showToast(`Đã làm trống thư mục gốc.`);
                    this.selectFolder(folderId);
                }
                return;
            } else {
                if (confirm(`Xóa Dự án '${folder.name}' cùng toàn bộ tài liệu bên trong?`)) {
                    const allFolderIds = [folderId, ...this.getAllDescendantFolderIds(folderId)];
                    allFolderIds.forEach(fid => {
                        const f = this.getFolder(fid);
                        if (f) f.imageIds.forEach(id => this.images.delete(id));
                    });
                    this.folders = this.folders.filter(f => !allFolderIds.includes(f.id));
                    this.projects = this.projects.filter(p => p.id !== folder.projectId);
                    this.activeProjectId = this.projects[0].id;
                    const nextRoot = this.folders.find(f => f.projectId === this.activeProjectId && !f.parentId);
                    this.selectFolder(nextRoot ? nextRoot.id : this.folders[0].id);
                    this.showToast(`Đã xóa Dự án thành công.`);
                }
                return;
            }
        }

        if (confirm(`Bạn có chắc chắn muốn xóa thư mục '${folder.name}' và các nhánh con bên trong?`)) {
            const proj = this.getActiveProject();
            const rel = this.getFolderRelativePath(folderId);
            if (proj && proj.rootDiskPath && rel) {
                try {
                    fetch('/api/delete-folder', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            root_path: proj.rootDiskPath,
                            relative_path: rel
                        })
                    });
                } catch (e) {
                    console.error("Lỗi xóa trên ổ đĩa:", e);
                }
            }

            const allFolderIds = [folderId, ...this.getAllDescendantFolderIds(folderId)];
            allFolderIds.forEach(fid => {
                const f = this.getFolder(fid);
                if (f) f.imageIds.forEach(id => this.images.delete(id));
            });
            const parentId = folder.parentId;
            this.folders = this.folders.filter(f => !allFolderIds.includes(f.id));

            this.showToast(`Đã xóa thư mục '${folder.name}'.`);
            this.selectFolder(parentId || this.folders[0].id);
        }
    }

    getAllDescendantFolderIds(folderId) {
        let result = [];
        const children = this.getFolderChildren(folderId);
        children.forEach(ch => {
            result.push(ch.id);
            result = result.concat(this.getAllDescendantFolderIds(ch.id));
        });
        return result;
    }

    renderFolderTree() {
        if (!this.folderTreeContainer) return;
        this.folderTreeContainer.innerHTML = '';

        const rootFolders = this.folders.filter(f => f.projectId === this.activeProjectId && f.parentId === null);

        rootFolders.forEach(root => {
            this.renderFolderTreeNode(root, 0, this.folderTreeContainer);
        });
    }

    renderFolderTreeNode(folder, level, container) {
        const node = document.createElement('div');
        node.className = `tree-node ${folder.id === this.activeFolderId ? 'active' : ''}`;
        node.dataset.folderId = folder.id;
        node.dataset.level = level;

        const children = this.getFolderChildren(folder.id);
        const hasChildren = children.length > 0;
        const imgCount = (folder.imageIds || []).length;

        node.innerHTML = `
            <span class="tree-expander ${hasChildren ? (folder.isExpanded ? 'expanded' : '') : 'empty'}">
                <i class="fa-solid fa-chevron-right"></i>
            </span>
            <i class="fa-solid ${folder.id === this.activeFolderId ? 'fa-folder-open' : (folder.parentId ? 'fa-folder' : 'fa-folder-tree')} tree-icon"></i>
            <span class="tree-title" title="${folder.name}">${folder.name}</span>
            <span class="tree-badge">${imgCount}</span>
            <div class="tree-actions">
                <button class="tree-action-btn add-sub" title="Thêm thư mục con">
                    <i class="fa-solid fa-plus"></i>
                </button>
                <button class="tree-action-btn edit-name" title="Đổi tên">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="tree-action-btn save-disk" title="Lưu thư mục vào máy tính">
                    <i class="fa-solid fa-floppy-disk"></i>
                </button>
                <button class="tree-action-btn export-pdf" title="Xuất PDF thư mục này">
                    <i class="fa-solid fa-file-pdf"></i>
                </button>
                <button class="tree-action-btn delete" title="Xóa thư mục">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `;

        // Click on expander
        const expander = node.querySelector('.tree-expander');
        expander.addEventListener('click', (e) => {
            e.stopPropagation();
            if (hasChildren) {
                folder.isExpanded = !folder.isExpanded;
                this.renderFolderTree();
            }
        });

        // Click on node body
        node.addEventListener('click', (e) => {
            if (e.target.closest('.tree-actions') || e.target.closest('.tree-expander')) return;
            this.selectFolder(folder.id);
        });

        // Actions inside node
        node.querySelector('.add-sub').addEventListener('click', (e) => {
            e.stopPropagation();
            this.openFolderModal('create_subfolder', folder.id);
        });

        node.querySelector('.edit-name').addEventListener('click', (e) => {
            e.stopPropagation();
            this.openFolderModal('rename_folder', folder.id);
        });

        node.querySelector('.save-disk').addEventListener('click', (e) => {
            e.stopPropagation();
            this.saveFolderToDiskById(folder.id);
        });

        node.querySelector('.export-pdf').addEventListener('click', (e) => {
            e.stopPropagation();
            this.exportFolderPdf(folder.id);
        });

        node.querySelector('.delete').addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteFolder(folder.id);
        });

        container.appendChild(node);

        if (hasChildren && folder.isExpanded) {
            children.forEach(child => {
                this.renderFolderTreeNode(child, level + 1, container);
            });
        }
    }

    updateActiveFolderUI() {
        const folder = this.getActiveFolder();
        if (!folder) return;

        const path = this.getFolderBreadcrumbPath(folder.id);
        this.activeFolderName.textContent = path;
        this.activeFolderName.title = path;

        const count = (folder.imageIds || []).length;
        this.pageCount.textContent = count;

        this.updateSidebarUI();
    }

    getFolderBreadcrumbPath(folderId) {
        const parts = [];
        let curr = this.getFolder(folderId);
        while (curr) {
            parts.unshift(curr.name);
            curr = curr.parentId ? this.getFolder(curr.parentId) : null;
        }
        return parts.join(' / ') || "Thư mục gốc";
    }

    // ==========================================
    // 💾 SAVE TO DISK (LOCAL ROOT & SUBFOLDERS)
    // ==========================================

    async saveActiveFolderToDisk() {
        const folder = this.getActiveFolder();
        if (!folder || !folder.imageIds || folder.imageIds.length === 0) {
            this.showToast("Thư mục hiện tại chưa có ảnh nào để lưu.", false);
            return;
        }
        await this.saveFolderToDiskById(folder.id);
    }

    async saveFolderToDiskById(folderId, quiet = false) {
        const folder = this.getFolder(folderId);
        if (!folder || !folder.imageIds || folder.imageIds.length === 0) {
            if (!quiet) this.showToast(`Thư mục '${folder ? folder.name : ""}' không có ảnh nào để lưu vào máy.`, false);
            return;
        }

        const proj = this.getActiveProject();
        if (!proj || !proj.rootDiskPath) {
            if (!quiet) {
                this.showToast("Vui lòng chọn Thư mục Root trên máy tính trước khi lưu.", false);
                this.pickRootDiskDirectory();
            }
            return;
        }

        const relPath = this.getFolderRelativePath(folderId);
        const items = folder.imageIds.map(iid => {
            const page = this.images.get(iid);
            const hist = this.historyMap.get(iid) || { undo: [], redo: [] };
            return {
                image_id: iid,
                filename: page ? page.filename : null,
                doc_name: page ? (page.suggested_name || page.filename) : "trang",
                corners: page ? page.corners : null,
                rotation: page ? (page.rotation || 0) : 0,
                settings: page ? page.settings : null,
                history: hist
            };
        });

        if (!quiet) {
            this.showLoading(`Đang lưu ${items.length} ảnh gốc & ảnh chỉnh sửa + PDF vào máy tính...`);
        }

        try {
            const res = await fetch('/api/save-to-disk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    root_path: proj.rootDiskPath,
                    relative_path: relPath,
                    items: items,
                    save_original: true,
                    save_edited: true,
                    save_pdf: true,
                    pdf_name: folder.name,
                    quality: 85,
                    normalize_res: true
                })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Lưu vào thư mục máy thất bại");
            }

            const data = await res.json();
            if (!quiet) {
                this.showToast(`✅ Đã lưu ${data.count} file vào: ${data.target_dir}`);
            } else {
                if (this.resultInfoText) {
                    this.resultInfoText.textContent = `💾 Đã tự động lưu vào máy tính lúc ${new Date().toLocaleTimeString('vi-VN')}`;
                }
            }
        } catch (err) {
            if (!quiet) this.showToast(err.message || "Lỗi khi lưu", false);
        } finally {
            if (!quiet) this.hideLoading();
        }
    }

    scheduleAutoSave(delayMs = 60000) {
        clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = setTimeout(() => {
            this.performAutoSave();
        }, delayMs);
    }

    async performAutoSave() {
        const folder = this.getActiveFolder();
        const proj = this.getActiveProject();
        if (!folder || !proj || !proj.rootDiskPath || !folder.imageIds || folder.imageIds.length === 0) return;

        try {
            await this.saveFolderToDiskById(folder.id, true);
        } catch (e) {
            console.error("Auto save failed:", e);
        }
    }

    async saveWholeProjectToDisk() {
        const proj = this.getActiveProject();
        if (!proj || !proj.rootDiskPath) {
            this.showToast("Vui lòng chọn Thư mục Root trên máy tính trước.", false);
            this.pickRootDiskDirectory();
            return;
        }

        const projectFolders = this.folders.filter(f => f.projectId === this.activeProjectId);
        let savedFolderCount = 0;
        let totalFilesCount = 0;

        this.showLoading(`Đang lưu toàn bộ Dự án '${proj.name}' vào thư mục máy...`);

        try {
            for (const folder of projectFolders) {
                if (folder.imageIds && folder.imageIds.length > 0) {
                    const relPath = this.getFolderRelativePath(folder.id);
                    const items = folder.imageIds.map(iid => {
                        const page = this.images.get(iid);
                        return {
                            image_id: iid,
                            doc_name: page ? (page.suggested_name || page.filename) : "trang"
                        };
                    });

                    const res = await fetch('/api/save-to-disk', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            root_path: proj.rootDiskPath,
                            relative_path: relPath,
                            items: items,
                            save_original: true,
                            save_edited: true,
                            save_pdf: true,
                            pdf_name: folder.name,
                            quality: 85,
                            normalize_res: true
                        })
                    });

                    if (res.ok) {
                        const data = await res.json();
                        savedFolderCount++;
                        totalFilesCount += data.count || 0;
                    }
                }
            }

            if (savedFolderCount === 0) {
                this.showToast("Dự án chưa có ảnh nào để lưu.", false);
            } else {
                this.showToast(`✅ Đã lưu hoàn tất ${savedFolderCount} nhánh thư mục (${totalFilesCount} files) vào: ${proj.rootDiskPath}`);
            }
        } catch (err) {
            this.showToast(err.message || "Lỗi khi lưu dự án vào máy", false);
        } finally {
            this.hideLoading();
        }
    }

    // ==========================================
    // 📑 PAGE LIST & DRAG-AND-DROP REORDER
    // ==========================================

    getActiveFolderImageIds() {
        const folder = this.getActiveFolder();
        return (folder && folder.imageIds) ? folder.imageIds : [];
    }

    getActivePage() {
        if (!this.activeImageId) return null;
        return this.images.get(this.activeImageId) || null;
    }

    updateSidebarUI() {
        const imageIds = this.getActiveFolderImageIds();
        this.pageCount.textContent = imageIds.length;
        this.pageListContainer.innerHTML = '';

        if (imageIds.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'empty-folder-msg';
            emptyMsg.style.cssText = 'text-align: center; color: var(--text-muted); padding: 24px 10px; font-size: 12px;';
            emptyMsg.innerHTML = '<i class="fa-regular fa-images" style="font-size: 24px; margin-bottom: 8px; display: block; opacity: 0.6;"></i>Thư mục này chưa có ảnh.<br>Nhấp bên dưới hoặc nhấn <strong>Ctrl+V</strong> để dán ảnh.';
            this.pageListContainer.appendChild(emptyMsg);
            return;
        }

        imageIds.forEach((iid, idx) => {
            const page = this.images.get(iid);
            if (!page) return;

            const card = document.createElement('div');
            card.className = `page-thumb-card ${iid === this.activeImageId ? 'active' : ''}`;
            card.draggable = true;
            card.dataset.imageId = iid;
            card.dataset.index = idx;

            const pageNumberText = `Trang ${idx + 1}`;
            const titleDisplay = page.suggested_name || page.filename || pageNumberText;

            card.innerHTML = `
                <div class="thumb-header">
                    <span class="drag-handle" title="Kéo để đổi thứ tự trang"><i class="fa-solid fa-grip-vertical"></i></span>
                    <span class="page-index-badge">${pageNumberText}</span>
                </div>
                <div class="thumb-img-box">
                    <img src="${page.processed_url || page.preview_url}" alt="${pageNumberText}">
                </div>
                <div class="thumb-footer">
                    <span class="thumb-title-text" title="${titleDisplay}">${titleDisplay}</span>
                    <div class="thumb-card-actions">
                        <button class="thumb-action-btn up-btn" title="Đẩy lên trước (Trang ${idx})" ${idx === 0 ? 'disabled' : ''}>
                            <i class="fa-solid fa-arrow-up"></i>
                        </button>
                        <button class="thumb-action-btn down-btn" title="Đẩy xuống sau (Trang ${idx + 2})" ${idx === imageIds.length - 1 ? 'disabled' : ''}>
                            <i class="fa-solid fa-arrow-down"></i>
                        </button>
                        <button class="thumb-action-btn move-btn" title="Chuyển ảnh sang thư mục khác">
                            <i class="fa-solid fa-arrow-right-to-bracket"></i>
                        </button>
                        <button class="thumb-action-btn delete-btn" title="Xóa trang này">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </div>
            `;

            // Card click to select
            card.addEventListener('click', (e) => {
                if (e.target.closest('.thumb-card-actions') || e.target.closest('.drag-handle')) return;
                this.selectPage(iid);
            });

            // Card actions
            card.querySelector('.up-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.moveImageInActiveFolder(idx, idx - 1);
            });

            card.querySelector('.down-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.moveImageInActiveFolder(idx, idx + 1);
            });

            card.querySelector('.move-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.openMoveModal(iid);
            });

            card.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.deletePage(iid);
            });

            // HTML5 Drag & Drop for reordering
            this.bindCardDragAndDrop(card, iid);

            this.pageListContainer.appendChild(card);
        });
    }

    bindCardDragAndDrop(card, imageId) {
        card.addEventListener('dragstart', (e) => {
            this.draggedImageId = imageId;
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', imageId);
        });

        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            document.querySelectorAll('.page-thumb-card').forEach(c => {
                c.classList.remove('drag-over-top', 'drag-over-bottom');
            });
            this.draggedImageId = null;
        });

        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            if (this.draggedImageId === imageId) return;

            const rect = card.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;

            if (e.clientY < midpoint) {
                card.classList.add('drag-over-top');
                card.classList.remove('drag-over-bottom');
            } else {
                card.classList.add('drag-over-bottom');
                card.classList.remove('drag-over-top');
            }
        });

        card.addEventListener('dragleave', () => {
            card.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        card.addEventListener('drop', (e) => {
            e.preventDefault();
            card.classList.remove('drag-over-top', 'drag-over-bottom');

            if (!this.draggedImageId || this.draggedImageId === imageId) return;

            const folder = this.getActiveFolder();
            if (!folder) return;

            const fromIndex = folder.imageIds.indexOf(this.draggedImageId);
            const toIndex = folder.imageIds.indexOf(imageId);

            if (fromIndex === -1 || toIndex === -1) return;

            const rect = card.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            const insertAfter = e.clientY >= midpoint;

            folder.imageIds.splice(fromIndex, 1);

            let newIndex = folder.imageIds.indexOf(imageId);
            if (insertAfter) newIndex++;

            folder.imageIds.splice(newIndex, 0, this.draggedImageId);

            this.showToast(`Đã sắp xếp lại thứ tự trang!`);
            this.updateSidebarUI();
        });
    }

    moveImageInActiveFolder(fromIdx, toIdx) {
        const folder = this.getActiveFolder();
        if (!folder || fromIdx < 0 || toIdx < 0 || fromIdx >= folder.imageIds.length || toIdx >= folder.imageIds.length) return;

        const movedId = folder.imageIds.splice(fromIdx, 1)[0];
        folder.imageIds.splice(toIdx, 0, movedId);

        this.showToast(`Đã di chuyển trang sang vị trí ${toIdx + 1}`);
        this.updateSidebarUI();
    }

    sortActiveFolderImages(type) {
        const folder = this.getActiveFolder();
        if (!folder || folder.imageIds.length <= 1) return;

        if (type === 'az') {
            folder.imageIds.sort((a, b) => {
                const nameA = (this.images.get(a)?.suggested_name || this.images.get(a)?.filename || "").toLowerCase();
                const nameB = (this.images.get(b)?.suggested_name || this.images.get(b)?.filename || "").toLowerCase();
                return nameA.localeCompare(nameB, 'vi');
            });
            this.showToast("Đã sắp xếp theo tên A → Z");
        } else if (type === 'za') {
            folder.imageIds.sort((a, b) => {
                const nameA = (this.images.get(a)?.suggested_name || this.images.get(a)?.filename || "").toLowerCase();
                const nameB = (this.images.get(b)?.suggested_name || this.images.get(b)?.filename || "").toLowerCase();
                return nameB.localeCompare(nameA, 'vi');
            });
            this.showToast("Đã sắp xếp theo tên Z → A");
        } else if (type === 'reverse') {
            folder.imageIds.reverse();
            this.showToast("Đã đảo ngược thứ tự các trang");
        }

        this.updateSidebarUI();
    }

    updatePageThumbTitle(imageId, newTitle) {
        const card = this.pageListContainer.querySelector(`.page-thumb-card[data-image-id="${imageId}"]`);
        if (card) {
            const titleEl = card.querySelector('.thumb-title-text');
            if (titleEl) {
                titleEl.textContent = newTitle;
                titleEl.title = newTitle;
            }
        }
    }

    // ==========================================
    // 🚚 MOVE IMAGE BETWEEN FOLDERS
    // ==========================================

    openMoveModal(imageId) {
        this.moveModalState = { imageId, selectedTargetFolderId: null };
        this.hideInlineFolderCreation();
        this.btnSubmitMoveModal.disabled = true;

        const page = this.images.get(imageId);
        const pageTitle = page ? (page.suggested_name || page.filename) : "ảnh này";
        this.moveImageDesc.textContent = `Chọn thư mục đích hoặc tạo mới để chuyển '${pageTitle}' vào:`;

        this.refreshMovePickerTree();
        this.moveImageModal.style.display = 'flex';
    }

    refreshMovePickerTree() {
        this.moveFolderPicker.innerHTML = '';
        const rootFolders = this.folders.filter(f => f.projectId === this.activeProjectId && f.parentId === null);
        rootFolders.forEach(root => {
            this.renderPickerNode(root, 0, this.moveFolderPicker);
        });
    }

    renderPickerNode(folder, level, container) {
        const item = document.createElement('div');
        const isCurrent = folder.id === this.activeFolderId;
        const isSelected = folder.id === this.moveModalState.selectedTargetFolderId;

        item.className = `picker-item ${isCurrent ? 'current-folder' : ''} ${isSelected ? 'selected' : ''}`;
        item.dataset.level = level;
        item.dataset.folderId = folder.id;

        item.innerHTML = `
            <div class="picker-item-content">
                <i class="fa-solid fa-folder text-accent"></i>
                <span>${folder.name} ${isCurrent ? '(Thư mục hiện tại)' : ''}</span>
            </div>
            <div class="picker-item-actions">
                <button class="picker-add-btn" title="Tạo thư mục con trong '${folder.name}'">
                    <i class="fa-solid fa-plus"></i> Con
                </button>
            </div>
        `;

        if (!isCurrent) {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.picker-add-btn')) return;
                container.querySelectorAll('.picker-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                this.moveModalState.selectedTargetFolderId = folder.id;
                this.btnSubmitMoveModal.disabled = false;
            });
        } else {
            item.style.opacity = '0.55';
            item.style.cursor = 'default';
        }

        // Add child subfolder button
        item.querySelector('.picker-add-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.showInlineFolderCreation(folder.id);
        });

        container.appendChild(item);

        const children = this.getFolderChildren(folder.id);
        children.forEach(ch => {
            this.renderPickerNode(ch, level + 1, container);
        });
    }

    showInlineFolderCreation(parentFolderId) {
        this.inlineCreateParentFolderId = parentFolderId;
        const parent = this.getFolder(parentFolderId);
        const pName = parent ? parent.name : "Thư mục gốc";
        this.txtInlineNewFolder.placeholder = `Tên thư mục con trong '${pName}'...`;
        this.txtInlineNewFolder.value = `Thư mục con ${this.folders.length}`;
        this.moveInlineCreateBox.style.display = 'flex';
        this.txtInlineNewFolder.focus();
        this.txtInlineNewFolder.select();
    }

    hideInlineFolderCreation() {
        if (this.moveInlineCreateBox) {
            this.moveInlineCreateBox.style.display = 'none';
        }
        this.inlineCreateParentFolderId = null;
    }

    async confirmInlineFolderCreation() {
        const name = this.txtInlineNewFolder.value.trim();
        if (!name) {
            this.showToast("Vui lòng nhập tên thư mục.", false);
            return;
        }

        const parentId = this.inlineCreateParentFolderId || this.activeFolderId;
        const parent = this.getFolder(parentId);
        const proj = this.getActiveProject();
        let newFolderId = 'folder_' + Date.now();

        if (proj && proj.rootDiskPath) {
            try {
                const parentRel = this.getFolderRelativePath(parentId);
                const res = await fetch('/api/create-folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        root_path: proj.rootDiskPath,
                        relative_path: parentRel,
                        folder_name: name
                    })
                });
                if (res.ok) {
                    const data = await res.json();
                    newFolderId = data.folder_id || newFolderId;
                }
            } catch (e) {
                console.error("Lỗi tạo thư mục vật lý:", e);
            }
        }

        if (parent) parent.isExpanded = true;

        this.folders.push({
            id: newFolderId,
            projectId: this.activeProjectId,
            name: name,
            parentId: parentId,
            imageIds: [],
            isExpanded: true
        });

        this.hideInlineFolderCreation();
        this.moveModalState.selectedTargetFolderId = newFolderId;
        this.refreshMovePickerTree();

        this.btnSubmitMoveModal.disabled = false;
        this.renderFolderTree();
        this.showToast(`Đã tạo thư mục '${name}' trên ổ đĩa và chọn làm thư mục đích!`);
    }

    closeMoveModal() {
        this.moveImageModal.style.display = 'none';
    }

    submitMoveModal() {
        const { imageId, selectedTargetFolderId } = this.moveModalState;
        if (!imageId || !selectedTargetFolderId) return;

        const sourceFolder = this.getActiveFolder();
        const targetFolder = this.getFolder(selectedTargetFolderId);

        if (!sourceFolder || !targetFolder) return;

        const idx = sourceFolder.imageIds.indexOf(imageId);
        if (idx !== -1) sourceFolder.imageIds.splice(idx, 1);

        targetFolder.imageIds.push(imageId);

        const page = this.images.get(imageId);
        const title = page ? page.suggested_name : "ảnh";
        this.showToast(`Đã chuyển '${title}' sang thư mục '${targetFolder.name}'!`);

        this.closeMoveModal();
        this.renderFolderTree();
        this.updateActiveFolderUI();

        if (sourceFolder.imageIds.length > 0) {
            const nextIdx = Math.min(idx, sourceFolder.imageIds.length - 1);
            this.selectPage(sourceFolder.imageIds[nextIdx]);
        } else {
            this.activeImageId = null;
            this.emptyState.style.display = 'flex';
            this.editorStage.style.display = 'none';
            this.docNameWrapper.style.display = 'none';
        }
    }

    // ==========================================
    // 📤 PDF EXPORT PER FOLDER / PROJECT
    // ==========================================

    async exportActiveFolderPdf() {
        const folder = this.getActiveFolder();
        if (!folder || !folder.imageIds || folder.imageIds.length === 0) {
            this.showToast("Thư mục hiện tại chưa có ảnh nào để xuất PDF.", false);
            return;
        }
        await this.exportFolderPdf(folder.id, folder.name);
    }

    async exportFolderPdf(folderId, customName = null) {
        const folder = this.getFolder(folderId);
        if (!folder || !folder.imageIds || folder.imageIds.length === 0) {
            this.showToast(`Thư mục '${folder ? folder.name : ""}' không có ảnh nào để xuất PDF.`, false);
            return;
        }

        const docTitle = customName || folder.name || "Tai-Lieu-Scan";
        this.showLoading(`Đang ghép ${folder.imageIds.length} trang thành PDF cho thư mục '${docTitle}'...`);

        try {
            const res = await fetch('/api/export-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: folder.imageIds,
                    doc_name: docTitle,
                    quality: 85,
                    normalize_res: true
                })
            });

            if (!res.ok) throw new Error("Xuất PDF thất bại");

            const blob = await res.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = `${docTitle}.pdf`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(downloadUrl);

            this.showToast(`Đã xuất trọn bộ PDF cho thư mục '${docTitle}' thành công!`);
        } catch (err) {
            this.showToast(err.message || "Lỗi khi xuất PDF", false);
        } finally {
            this.hideLoading();
        }
    }

    async exportAllProjectPdf() {
        const allImageIds = [];
        const projectFolders = this.folders.filter(f => f.projectId === this.activeProjectId);

        projectFolders.forEach(f => {
            if (f.imageIds && f.imageIds.length > 0) {
                allImageIds.push(...f.imageIds);
            }
        });

        if (allImageIds.length === 0) {
            this.showToast("Dự án chưa có ảnh nào để xuất PDF.", false);
            return;
        }

        const proj = this.getActiveProject();
        const docTitle = proj ? proj.name : "Du-An-Scan";

        this.showLoading(`Đang ghép ${allImageIds.length} trang toàn bộ Dự án '${docTitle}' thành PDF...`);

        try {
            const res = await fetch('/api/export-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: allImageIds,
                    doc_name: docTitle,
                    quality: 85,
                    normalize_res: true
                })
            });

            if (!res.ok) throw new Error("Xuất PDF thất bại");

            const blob = await res.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = `${docTitle}.pdf`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(downloadUrl);

            this.showToast(`Đã xuất PDF toàn bộ Dự án (${allImageIds.length} trang) thành công!`);
        } catch (err) {
            this.showToast(err.message || "Lỗi khi xuất PDF", false);
        } finally {
            this.hideLoading();
        }
    }

    // ==========================================
    // 📸 IMAGE UPLOADS & PAGE PROCESSING
    // ==========================================

    async handleFilesSelected(files) {
        if (!files || files.length === 0) return;
        const targetFolder = this.getActiveFolder();
        this.showLoading(`Đang tải ảnh vào thư mục '${targetFolder.name}' và gợi ý tên...`);

        try {
            let firstNewId = null;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const formData = new FormData();
                formData.append('file', file);

                const res = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData
                });

                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Tải ảnh thất bại");
                }

                const data = await res.json();
                const imageId = data.image_id;
                if (!firstNewId) firstNewId = imageId;

                const newPage = {
                    id: imageId,
                    filename: file.name || `Tài liệu ${this.images.size + 1}`,
                    suggested_name: data.suggested_name || "Tai-Lieu-Scan",
                    name_suggestions: data.name_suggestions || [],
                    width: data.width,
                    height: data.height,
                    megapixels: data.megapixels,
                    file_size_human: data.file_size_human,
                    corners: data.corners,
                    preview_url: data.preview_url,
                    rotation: 0,
                    processed_url: null,
                    out_dim: null,
                    out_size_human: null,
                    saving_ratio: null,
                    settings: {
                        mode: 'natural',
                        shadow_reduction: 0.6,
                        sharpness: 0.6,
                        contrast: 0.2,
                        brightness: 0.0,
                        margin_percent: 0.02,
                        dewarp_enabled: false,
                        dewarp_strength: 0.8,
                        quality: 85,
                        normalize_res: true
                    }
                };

                this.images.set(imageId, newPage);
                targetFolder.imageIds.push(imageId);
            }

            this.renderFolderTree();
            this.updateActiveFolderUI();

            if (firstNewId) {
                this.selectPage(firstNewId);
            }

            if (this.btnSaveToDiskMenu) this.btnSaveToDiskMenu.disabled = false;
            this.showToast(`Đã thêm ${files.length} ảnh vào thư mục '${targetFolder.name}'!`);
        } catch (err) {
            this.showToast(err.message || "Đã xảy ra lỗi khi tải ảnh.", false);
        } finally {
            this.hideLoading();
            this.fileInput.value = '';
            this.heroFileInput.value = '';
        }
    }

    selectPage(imageId) {
        const page = this.images.get(imageId);
        if (!page) return;

        this.activeImageId = imageId;

        this.emptyState.style.display = 'none';
        this.editorStage.style.display = 'flex';
        this.docNameWrapper.style.display = 'flex';
        this.btnExportPdf.disabled = false;
        if (this.btnSaveToDiskMenu) this.btnSaveToDiskMenu.disabled = false;
        this.btnDownloadCurrent.disabled = false;

        this.txtDocName.value = page.suggested_name;
        this.renderNameSuggestions(page);

        // Show/hide on-demand AI banner
        if (this.aiSuggestBanner) {
            if (!page.aiAnalyzed && !page.aiDismissed) {
                this.aiSuggestBanner.style.display = 'flex';
            } else {
                this.aiSuggestBanner.style.display = 'none';
            }
        }

        this.resetZoomFit();
        this.updateSidebarUI();
        this.syncInspectorUI(page.settings);
        this.updateMetadataUI(page);
        this.updateHistoryButtons();

        const img = new Image();
        img.onload = () => {
            this.currentImageObj = img;
            if (page.processed_url) {
                const procImg = new Image();
                procImg.onload = () => {
                    page.processedImageObj = procImg;
                    this.renderCropCanvas();
                };
                procImg.src = page.processed_url;
            } else {
                this.renderCropCanvas();
                if (this.currentViewMode === 'edited') {
                    this.processActivePage();
                }
            }
        };
        img.src = page.preview_url;
    }

    setViewMode(mode) {
        this.currentViewMode = mode;
        if (this.btnShowEdited) this.btnShowEdited.classList.toggle('active', mode === 'edited');
        if (this.btnShowOriginal) this.btnShowOriginal.classList.toggle('active', mode === 'original');
        
        const page = this.getActivePage();
        if (mode === 'edited' && page && !page.processedImageObj) {
            this.processActivePage();
        } else {
            this.renderCropCanvas();
        }
    }

    // ==========================================
    // 🎨 UNIFIED CANVAS VIEWER (APPLE-STYLE)
    // ==========================================

    renderCropCanvas() {
        const page = this.getActivePage();
        if (!page || !this.currentImageObj) return;

        const viewport = this.canvasViewport;
        const availWidth = viewport.clientWidth - 40;
        const availHeight = viewport.clientHeight - 40;

        const isViewingOriginal = this.isHoldingCompare || this.currentViewMode === 'original';
        const displayImg = (!isViewingOriginal && page.processedImageObj) ? page.processedImageObj : this.currentImageObj;

        const padRatio = isViewingOriginal ? this.canvasPaddingRatio : 0.04;

        const paddedAspect = displayImg.width / displayImg.height;
        const screenAspect = availWidth / availHeight;

        let imgRenderW, imgRenderH;
        if (paddedAspect > screenAspect) {
            imgRenderW = availWidth / (1 + padRatio * 2);
            imgRenderH = imgRenderW / paddedAspect;
        } else {
            imgRenderH = availHeight / (1 + padRatio * 2);
            imgRenderW = imgRenderH * paddedAspect;
        }

        this.imgOffsetX = imgRenderW * padRatio;
        this.imgOffsetY = imgRenderH * padRatio;
        this.imgRenderW = imgRenderW;
        this.imgRenderH = imgRenderH;

        this.canvas.width = imgRenderW + this.imgOffsetX * 2;
        this.canvas.height = imgRenderH + this.imgOffsetY * 2;

        this.scaleX = imgRenderW / page.width;
        this.scaleY = imgRenderH / page.height;

        this.drawCanvasContent();
    }

    drawCanvasContent() {
        const page = this.getActivePage();
        if (!page || !this.currentImageObj) return;

        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#090d16';
        ctx.fillRect(0, 0, w, h);

        const isViewingOriginal = this.isHoldingCompare || this.currentViewMode === 'original';

        if (isViewingOriginal || !page.processedImageObj) {
            // Draw original photo
            ctx.drawImage(this.currentImageObj, this.imgOffsetX, this.imgOffsetY, this.imgRenderW, this.imgRenderH);

            if (this.resultInfoText) {
                this.resultInfoText.textContent = this.isHoldingCompare ? 
                    "Đang giữ xem: Ảnh gốc ban đầu" : "Chế độ xem: Ảnh gốc ban đầu (Chỉnh 4 góc)";
            }
            if (this.statusIcon) {
                this.statusIcon.className = "fa-regular fa-image text-warning";
            }

            // Draw crop quad & corner handles if in original mode and handles active
            if ((this.currentViewMode === 'original' || this.isHoldingCompare) && this.showCropHandles) {
                const corners = page.corners || [
                    [0, 0],
                    [page.width - 1, 0],
                    [page.width - 1, page.height - 1],
                    [0, page.height - 1]
                ];

                const screenPts = corners.map(pt => [
                    this.imgOffsetX + pt[0] * this.scaleX,
                    this.imgOffsetY + pt[1] * this.scaleY
                ]);

                ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
                ctx.beginPath();
                ctx.rect(0, 0, w, h);
                ctx.moveTo(screenPts[0][0], screenPts[0][1]);
                for (let i = screenPts.length - 1; i >= 0; i--) {
                    ctx.lineTo(screenPts[i][0], screenPts[i][1]);
                }
                ctx.closePath();
                ctx.fill();

                ctx.strokeStyle = '#38bdf8';
                ctx.lineWidth = 2.5;
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(screenPts[0][0], screenPts[0][1]);
                for (let i = 1; i < screenPts.length; i++) {
                    ctx.lineTo(screenPts[i][0], screenPts[i][1]);
                }
                ctx.closePath();
                ctx.stroke();

                this.drawGrid(ctx, screenPts);

                screenPts.forEach((pt, idx) => {
                    const isDragging = idx === this.draggingCornerIndex;

                    ctx.beginPath();
                    ctx.arc(pt[0], pt[1], this.handleRadius + (isDragging ? 4 : 0), 0, Math.PI * 2);
                    ctx.fillStyle = isDragging ? '#38bdf8' : '#ffffff';
                    ctx.fill();
                    ctx.strokeStyle = '#0284c7';
                    ctx.lineWidth = 3;
                    ctx.stroke();

                    ctx.beginPath();
                    ctx.arc(pt[0], pt[1], 4, 0, Math.PI * 2);
                    ctx.fillStyle = '#0284c7';
                    ctx.fill();
                });
            }
        } else {
            // Draw processed enhanced image
            ctx.drawImage(page.processedImageObj, this.imgOffsetX, this.imgOffsetY, this.imgRenderW, this.imgRenderH);

            if (this.resultInfoText) {
                this.resultInfoText.textContent = "Chế độ xem: Đã làm rõ nét chữ & cân bằng ánh sáng";
            }
            if (this.statusIcon) {
                this.statusIcon.className = "fa-solid fa-circle-check text-success";
            }
        }
    }

    drawGrid(ctx, pts) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        for (let t = 0.333; t < 1.0; t += 0.333) {
            const top = this.lerpPoint(pts[0], pts[1], t);
            const bottom = this.lerpPoint(pts[3], pts[2], t);
            ctx.beginPath();
            ctx.moveTo(top[0], top[1]);
            ctx.lineTo(bottom[0], bottom[1]);
            ctx.stroke();

            const left = this.lerpPoint(pts[0], pts[3], t);
            const right = this.lerpPoint(pts[1], pts[2], t);
            ctx.beginPath();
            ctx.moveTo(left[0], left[1]);
            ctx.lineTo(right[0], right[1]);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    lerpPoint(p1, p2, t) {
        return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
    }

    // ==========================================
    // 🔍 VIEWPORT ZOOM, PAN & CORNER DRAG
    // ==========================================

    setZoom(newZoom) {
        this.zoom = Math.max(0.25, Math.min(5.0, newZoom));
        this.lblZoomLevel.textContent = `${Math.round(this.zoom * 100)}%`;
        this.applyZoomTransform();
    }

    resetZoomFit() {
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;
        this.lblZoomLevel.textContent = "100%";
        this.applyZoomTransform();
    }

    applyZoomTransform() {
        const transformStr = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        if (this.canvasTransformBox) {
            this.canvasTransformBox.style.transform = transformStr;
        }
        if (this.resultZoomBox) {
            this.resultZoomBox.style.transform = transformStr;
        }
    }

    handleWheelZoom(e) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1.15 : 0.85;
        this.setZoom(this.zoom * delta);
    }

    getCanvasCoords(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / this.zoom,
            y: (e.clientY - rect.top) / this.zoom
        };
    }

    onViewportMouseDown(e) {
        const pos = this.getCanvasCoords(e);
        const page = this.getActivePage();
        if (!page) return;

        const corners = page.corners || [
            [0, 0],
            [page.width - 1, 0],
            [page.width - 1, page.height - 1],
            [0, page.height - 1]
        ];

        const screenPts = corners.map(pt => [
            this.imgOffsetX + pt[0] * this.scaleX,
            this.imgOffsetY + pt[1] * this.scaleY
        ]);

        if ((this.currentViewMode === 'original' || this.isHoldingCompare) && this.showCropHandles) {
            for (let i = 0; i < screenPts.length; i++) {
                const dist = Math.hypot(pos.x - screenPts[i][0], pos.y - screenPts[i][1]);
                if (dist <= this.handleRadius + 8) {
                    this.draggingCornerIndex = i;
                    this.pushHistoryState("Kéo chỉnh góc");
                    this.showMagnifier(pos.x, pos.y, i);
                    this.drawCanvasContent();
                    return;
                }
            }
        }

        this.isPanning = true;
        this.panStartX = e.clientX - this.panX;
        this.panStartY = e.clientY - this.panY;
        this.canvasViewport.classList.add('panning');
    }

    onViewportMouseMove(e) {
        if (this.isPanning) {
            this.panX = e.clientX - this.panStartX;
            this.panY = e.clientY - this.panStartY;
            this.applyZoomTransform();
            return;
        }

        if (this.isSliding) {
            this.onSlideMove(e);
            return;
        }

        if (this.draggingCornerIndex !== -1) {
            const pos = this.getCanvasCoords(e);
            const page = this.getActivePage();
            if (!page) return;

            const origX = (pos.x - this.imgOffsetX) / this.scaleX;
            const origY = (pos.y - this.imgOffsetY) / this.scaleY;

            const minBound = -page.width * 0.1;
            const maxBoundW = page.width * 1.1;
            const maxBoundH = page.height * 1.1;

            page.corners[this.draggingCornerIndex] = [
                Math.max(minBound, Math.min(maxBoundW, origX)),
                Math.max(minBound, Math.min(maxBoundH, origY))
            ];

            this.drawCanvasContent();
            this.showMagnifier(pos.x, pos.y, this.draggingCornerIndex);
        }
    }

    onViewportMouseUp() {
        if (this.draggingCornerIndex !== -1) {
            this.draggingCornerIndex = -1;
            this.hideMagnifier();
            this.drawCanvasContent();
            this.debounceProcess();
            this.debounceSaveMetadata(this.activeFolderId);
        }
        if (this.isPanning) {
            this.isPanning = false;
            this.canvasViewport.classList.remove('panning');
        }
        if (this.isSliding) {
            this.isSliding = false;
        }
    }

    onTouchStart(e) {
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            const fakeEvent = { clientX: touch.clientX, clientY: touch.clientY };
            this.onViewportMouseDown(fakeEvent);
        }
    }

    onTouchMove(e) {
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            if (this.isPanning) {
                e.preventDefault();
                this.panX = touch.clientX - this.panStartX;
                this.panY = touch.clientY - this.panStartY;
                this.applyZoomTransform();
            } else if (this.draggingCornerIndex !== -1) {
                e.preventDefault();
                const fakeEvent = { clientX: touch.clientX, clientY: touch.clientY };
                this.onViewportMouseMove(fakeEvent);
            }
        }
    }

    showMagnifier(canvasX, canvasY, cornerIdx) {
        if (!this.currentImageObj || !this.magLens) return;

        this.magLens.style.display = 'block';
        this.magLens.style.left = '20px';
        this.magLens.style.top = '20px';

        const labels = ['Góc Trên - Trái', 'Góc Trên - Phải', 'Góc Dưới - Phải', 'Góc Dưới - Trái'];
        this.lensLabel.textContent = labels[cornerIdx] || "Góc";

        const ctx = this.magCtx;
        const mw = this.magCanvas.width;
        const mh = this.magCanvas.height;

        ctx.clearRect(0, 0, mw, mh);
        ctx.drawImage(
            this.canvas,
            canvasX - mw / 4,
            canvasY - mh / 4,
            mw / 2,
            mh / 2,
            0,
            0,
            mw,
            mh
        );
    }

    hideMagnifier() {
        if (this.magLens) this.magLens.style.display = 'none';
    }

    // ==========================================
    // ⚡ AUTO DETECT, EXPAND MARGIN, ROTATE
    // ==========================================

    async autoDetectActivePage() {
        const page = this.getActivePage();
        if (!page) return;

        this.showLoading("Đang nhận diện lại mép giấy...");
        try {
            const formData = new FormData();
            formData.append('image_id', page.id);
            formData.append('margin_percent', page.settings.margin_percent);

            fetch('/api/detect', {
                method: 'POST',
                body: formData
            }).then(res => res.json()).then(data => {
                page.corners = data.corners;
                this.renderCropCanvas();
                this.debounceProcess();
                this.debounceSaveMetadata(this.activeFolderId);
                this.showToast("Đã tự động nhận diện mép tài liệu!");
            }).catch(err => {
                this.showToast("Lỗi nhận diện", false);
            }).finally(() => {
                this.hideLoading();
            });
        } catch (err) {
            this.showToast("Lỗi nhận diện", false);
            this.hideLoading();
        }
    }

    expandMarginActivePage(margin = 0.02) {
        const page = this.getActivePage();
        if (!page || !page.corners) return;

        const pts = page.corners;
        const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4.0;
        const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4.0;

        const factor = 1.0 + margin * 2.0;
        page.corners = pts.map(pt => [
            cx + (pt[0] - cx) * factor,
            cy + (pt[1] - cy) * factor
        ]);

        this.renderCropCanvas();
        this.debounceProcess();
        this.debounceSaveMetadata(this.activeFolderId);
        this.showToast(`Đã mở rộng lề ${(margin * 100).toFixed(0)}% và đắp viền giấy.`);
    }

    resetCornersToBorder() {
        const page = this.getActivePage();
        if (!page) return;

        page.corners = [
            [0, 0],
            [page.width - 1, 0],
            [page.width - 1, page.height - 1],
            [0, page.height - 1]
        ];
        this.renderCropCanvas();
        this.debounceProcess();
        this.debounceSaveMetadata(this.activeFolderId);
        this.showToast("Đã đặt 4 góc trọn toàn bộ ảnh.");
    }

    resetToRawOriginal() {
        const page = this.getActivePage();
        if (!page) return;

        this.pushHistoryState("Khôi phục về ảnh chụp gốc ban đầu");
        page.rotation = 0;
        page.settings = {
            mode: 'natural',
            shadow_reduction: 0.6,
            sharpness: 0.6,
            contrast: 0.2,
            brightness: 0.0,
            margin_percent: 0.02,
            dewarp_enabled: false,
            dewarp_strength: 0.8,
            quality: 85,
            normalize_res: true
        };
        this.syncInspectorUI(page.settings);
        this.autoDetectActivePage();
        this.debounceSaveMetadata(this.activeFolderId);
        this.showToast("Đã khôi phục về trạng thái ảnh chụp ban đầu.");
    }

    rotateActivePage(deg) {
        const page = this.getActivePage();
        if (!page) return;

        page.rotation = (page.rotation + deg + 360) % 360;
        this.showToast(`Đã xoay ảnh ${page.rotation}°`);
        this.processActivePage();
        this.debounceSaveMetadata(this.activeFolderId);
    }

    // ==========================================
    // ✨ PROCESS ENHANCEMENT & PREVIEWS
    // ==========================================

    debounceProcess() {
        clearTimeout(this.processTimer);
        this.processTimer = setTimeout(() => {
            this.processActivePage();
        }, 250);
        this.scheduleAutoSave(60000);
    }

    async processActivePage() {
        const page = this.getActivePage();
        if (!page) return;

        this.showLoading("Đang xử lý làm rõ chữ & đắp viền giấy...");

        try {
            const reqBody = {
                image_id: page.id,
                corners: page.corners,
                rotation: page.rotation,
                margin_percent: page.settings.margin_percent,
                dewarp_enabled: page.settings.dewarp_enabled,
                dewarp_strength: page.settings.dewarp_strength,
                mode: page.settings.mode,
                shadow_reduction: page.settings.shadow_reduction,
                sharpness: page.settings.sharpness,
                contrast: page.settings.contrast,
                brightness: page.settings.brightness,
                quality: page.settings.quality,
                format: 'jpeg',
                normalize_res: page.settings.normalize_res
            };

            const res = await fetch('/api/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(reqBody)
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Xử lý thất bại");
            }

            const data = await res.json();
            page.processed_url = data.image_data;
            page.out_dim = `${data.width} × ${data.height} px`;
            page.out_size_human = data.file_size_human;
            page.saving_ratio = data.saving_ratio;

            const procImg = new Image();
            procImg.onload = () => {
                page.processedImageObj = procImg;
                this.renderCropCanvas();
            };
            procImg.src = data.image_data;

            this.updateMetadataUI(page);
            this.updateSidebarUI();
        } catch (err) {
            this.showToast(err.message || "Lỗi khi xử lý hình ảnh", false);
        } finally {
            this.hideLoading();
        }
    }

    async downloadCurrentPage(format = 'jpeg') {
        const page = this.getActivePage();
        if (!page) return;

        this.showLoading("Đang chuẩn bị tải về...");
        try {
            const docName = encodeURIComponent(this.txtDocName.value.trim() || page.suggested_name || "scan");
            const url = `/api/download/${page.id}?format=${format}&quality=${page.settings.quality}&doc_name=${docName}`;
            const link = document.createElement('a');
            link.href = url;
            link.download = `${this.txtDocName.value.trim() || page.suggested_name}.${format === 'jpeg' ? 'jpg' : format}`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            this.showToast("Đã tải ảnh về máy thành công!");
        } catch (err) {
            this.showToast("Lỗi khi tải file", false);
        } finally {
            this.hideLoading();
        }
    }

    async applyCurrentAsOriginal() {
        const page = this.getActivePage();
        if (!page) return;

        if (!page.processed_url) {
            this.showToast("Vui lòng xem kết quả làm nét trước khi lưu làm ảnh gốc.", false);
            return;
        }

        const confirmApply = confirm("Bạn có chắc chắn muốn lấy hình đã chỉnh sửa này thay thế làm Hình Gốc mới không?\n(Bạn sẽ có thể tiếp tục kéo cắt 4 góc hoặc xử lý tiếp trên nền bức ảnh mới này).");
        if (!confirmApply) return;

        this.showLoading("Đang lưu hình đã sửa thành hình gốc mới...");
        try {
            const proj = this.getActiveProject();
            const relPath = this.getFolderRelativePath(this.activeFolderId);
            const res = await fetch('/api/apply-as-original', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_id: page.id,
                    root_path: proj ? proj.rootDiskPath : null,
                    relative_path: relPath,
                    doc_name: page.suggested_name
                })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Không thể lưu làm ảnh gốc");
            }

            const data = await res.json();
            page.preview_url = data.preview_url;
            page.corners = data.corners;
            page.width = data.width;
            page.height = data.height;
            page.megapixels = data.megapixels;
            page.rotation = 0;
            page.processed_url = null;
            page.out_dim = null;
            page.out_size_human = null;
            page.saving_ratio = null;

            // Reset history stack for this image
            this.historyMap.set(page.id, { undo: [], redo: [] });
            this.updateHistoryButtons();

            const img = new Image();
            img.onload = () => {
                this.currentImageObj = img;
                this.switchView('crop');
                this.resetZoomFit();
                this.renderCropCanvas();
                this.updateMetadataUI(page);
                this.updateSidebarUI();
            };
            img.src = data.preview_url;

            this.showToast("✅ Đã thay thế ảnh gốc thành công! Bạn có thể tiếp tục chỉnh sửa.");
        } catch (err) {
            this.showToast(err.message || "Lỗi khi lưu làm ảnh gốc", false);
        } finally {
            this.hideLoading();
        }
    }

    // ==========================================
    // ⏪ UNDO / REDO HISTORY
    // ==========================================

    getHistoryForActivePage() {
        const page = this.getActivePage();
        if (!page) return null;
        if (!this.historyMap.has(page.id)) {
            this.historyMap.set(page.id, { undo: [], redo: [] });
        }
        return this.historyMap.get(page.id);
    }

    pushHistoryState(description = "") {
        if (this.isApplyingHistory) return;
        const page = this.getActivePage();
        if (!page) return;

        const hist = this.getHistoryForActivePage();
        const snapshot = {
            corners: JSON.parse(JSON.stringify(page.corners)),
            rotation: page.rotation,
            settings: JSON.parse(JSON.stringify(page.settings)),
            description: description
        };

        hist.undo.push(snapshot);
        if (hist.undo.length > 30) hist.undo.shift();
        hist.redo = [];
        this.updateHistoryButtons();
        this.debounceSaveMetadata(this.activeFolderId);
        this.scheduleAutoSave(60000);
    }

    undo() {
        const page = this.getActivePage();
        if (!page) return;
        const hist = this.getHistoryForActivePage();
        if (!hist || hist.undo.length === 0) return;

        const currentSnapshot = {
            corners: JSON.parse(JSON.stringify(page.corners)),
            rotation: page.rotation,
            settings: JSON.parse(JSON.stringify(page.settings))
        };
        hist.redo.push(currentSnapshot);

        const prevState = hist.undo.pop();
        this.isApplyingHistory = true;

        page.corners = JSON.parse(JSON.stringify(prevState.corners));
        page.rotation = prevState.rotation;
        page.settings = JSON.parse(JSON.stringify(prevState.settings));

        this.syncInspectorUI(page.settings);
        this.renderCropCanvas();

        this.isApplyingHistory = false;
        this.updateHistoryButtons();
        this.debounceSaveMetadata(this.activeFolderId);
        this.scheduleAutoSave(60000);
        this.showToast(`Đã hoàn tác: ${prevState.description || "thao tác trước"}`);
    }

    redo() {
        const page = this.getActivePage();
        if (!page) return;
        const hist = this.getHistoryForActivePage();
        if (!hist || hist.redo.length === 0) return;

        const currentSnapshot = {
            corners: JSON.parse(JSON.stringify(page.corners)),
            rotation: page.rotation,
            settings: JSON.parse(JSON.stringify(page.settings))
        };
        hist.redo.push(currentSnapshot);

        const nextState = hist.redo.pop();
        this.isApplyingHistory = true;

        page.corners = JSON.parse(JSON.stringify(nextState.corners));
        page.rotation = nextState.rotation;
        page.settings = JSON.parse(JSON.stringify(nextState.settings));

        this.syncInspectorUI(page.settings);
        this.renderCropCanvas();

        this.isApplyingHistory = false;
        this.updateHistoryButtons();
        this.debounceSaveMetadata(this.activeFolderId);
        this.scheduleAutoSave(60000);
        this.showToast("Đã làm lại thao tác");
    }

    debounceSaveMetadata(folderId) {
        clearTimeout(this.saveMetaTimer);
        this.saveMetaTimer = setTimeout(() => {
            this.saveMetadataToDisk(folderId);
        }, 1200);
    }

    async saveMetadataToDisk(folderId) {
        const folder = this.getFolder(folderId);
        const proj = this.getActiveProject();
        if (!folder || !proj || !proj.rootDiskPath) return;

        const relPath = this.getFolderRelativePath(folderId);
        const pagesPayload = (folder.imageIds || []).map(imgId => {
            const p = this.images.get(imgId);
            if (!p) return null;
            const hist = this.historyMap.get(imgId) || { undo: [], redo: [] };
            return {
                filename: p.filename,
                doc_name: p.suggested_name,
                corners: p.corners,
                rotation: p.rotation || 0,
                settings: p.settings,
                history: hist
            };
        }).filter(Boolean);

        if (pagesPayload.length === 0) return;

        try {
            await fetch('/api/save-metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    root_path: proj.rootDiskPath,
                    relative_path: relPath,
                    pages: pagesPayload
                })
            });
        } catch (e) {
            console.error("Failed to auto-save metadata:", e);
        }
    }

    updateHistoryButtons() {
        const hist = this.getHistoryForActivePage();
        this.btnUndo.disabled = !hist || hist.undo.length === 0;
        this.btnRedo.disabled = !hist || hist.redo.length === 0;
    }

    // ==========================================
    // 🔔 TOAST & FEEDBACK UTILITIES
    // ==========================================

    showToast(msg, isSuccess = true) {
        this.toastMsg.textContent = msg;
        const icon = document.getElementById('toastIcon');
        icon.className = isSuccess ? 'fa-solid fa-circle-check text-success' : 'fa-solid fa-triangle-exclamation text-warning';
        this.toast.classList.add('show');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 3000);
    }

    showLoading(text = "Đang tối ưu hóa tài liệu...") {
        this.loadingText.textContent = text;
        this.loadingOverlay.style.display = 'flex';
    }

    hideLoading() {
        this.loadingOverlay.style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new DocScanApp();
});
