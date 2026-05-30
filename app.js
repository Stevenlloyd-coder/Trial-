'use strict';

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
    stream:     null,
    facingMode: 'environment',
    flashOn:    false,
    quality:    0.8,
    watermark: {
        enabled:     false,
        logoDataUrl: localStorage.getItem('wm_logo') || null,
        logoImg:     null,
        logoSize:    parseInt(localStorage.getItem('wm_logo_size') || '15', 10),
        includeDate: true
    },
    photos:      [],
    modalPhotoId: null,
    dropbox: {
        appKey: localStorage.getItem('dbx_app_key') || '',
        token:  localStorage.getItem('dbx_token')   || '',
        folder: localStorage.getItem('dbx_folder')  || '',
        folderStack: [],
        browsePath:  ''
    }
};

// ── DOM cache ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const el = {
    // Inline preview
    preview:         $('cameraPreview'),
    cameraError:     $('cameraError'),
    cameraErrorMsg:  $('cameraErrorMsg'),
    retryCameraBtn:  $('retryCameraBtn'),
    expandFsBtn:     $('expandFsBtn'),

    // Fullscreen overlay
    fsOverlay:       $('fsOverlay'),
    fsVideo:         $('fsVideo'),
    exitFsBtn:       $('exitFsBtn'),
    captureBtn:      $('captureBtn'),
    switchBtn:       $('switchCameraBtn'),
    flashBtn:        $('flashBtn'),
    canvas:          $('captureCanvas'),

    // Quality
    qualitySlider:   $('qualitySlider'),
    qualityValue:    $('qualityValue'),

    // Settings accordion
    settingsToggle:  $('settingsToggle'),
    settingsPanel:   $('settingsPanel'),
    settingsChevron: $('settingsChevron'),

    // Watermark
    watermarkToggle: $('watermarkToggle'),
    watermarkOptions:$('watermarkOptions'),
    watermarkDate:   $('watermarkDate'),
    logoFileInput:   $('logoFileInput'),
    logoUploadLabel: $('logoUploadLabel'),
    logoPreviewWrap: $('logoPreviewWrap'),
    logoPreview:     $('logoPreview'),
    clearLogoBtn:    $('clearLogoBtn'),
    logoSizeRow:     $('logoSizeRow'),
    logoSizeSlider:  $('logoSizeSlider'),
    logoSizeValue:   $('logoSizeValue'),
    batchBtn:        $('batchWatermarkBtn'),

    // Gallery
    photoQueue:      $('photoQueue'),
    photoCount:      $('photoCount'),
    uploadAllBtn:    $('uploadAllBtn'),

    // Dropbox settings
    setupInstructions: $('setupInstructions'),
    dropboxAuth:       $('dropboxAuth'),
    appKeyInput:       $('appKeyInput'),
    saveAppKeyBtn:     $('saveAppKeyBtn'),
    appKeyDisplay:     $('appKeyDisplay'),
    clearAppKeyBtn:    $('clearAppKeyBtn'),
    dropboxNotConn:    $('dropboxNotConnected'),
    dropboxConn:       $('dropboxConnected'),
    connectBtn:        $('connectDropboxBtn'),
    disconnectBtn:     $('disconnectBtn'),
    selectedFolder:    $('selectedFolderPath'),
    changeFolderBtn:   $('changeFolderBtn'),
    switchAccountBtn:  $('switchAccountBtn'),
    redirectDisplay:   $('redirectUriDisplay'),

    // Modals
    photoModal:       $('photoModal'),
    modalBackdrop:    $('modalBackdrop'),
    modalImg:         $('modalImage'),
    modalClose:       $('modalClose'),
    modalSaveBtn:     $('modalSaveBtn'),
    modalUploadBtn:   $('modalUploadBtn'),
    modalDeleteBtn:   $('modalDeleteBtn'),
    folderModal:      $('folderModal'),
    folderModalBack:  $('folderModalBackdrop'),
    folderList:       $('folderList'),
    folderNavBack:    $('folderNavBack'),
    folderPath:       $('folderBrowserPath'),
    folderModalClose: $('folderModalClose'),
    selectFolderBtn:  $('selectFolderBtn')
};

// ── Camera ─────────────────────────────────────────────────────────────────────

async function startCamera() {
    stopCamera();
    try {
        state.stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: state.facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false
        });
    } catch {
        try {
            state.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch (err) {
            el.cameraError.classList.remove('hidden');
            el.cameraErrorMsg.textContent = `Camera error: ${err.message}`;
            return;
        }
    }
    // Feed the same stream to both inline preview and fullscreen video
    el.preview.srcObject = state.stream;
    el.fsVideo.srcObject = state.stream;
    el.cameraError.classList.add('hidden');
}

function stopCamera() {
    if (state.stream) {
        state.stream.getTracks().forEach(t => t.stop());
        state.stream = null;
    }
}

async function switchCamera() {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    await startCamera();
}

async function toggleFlash() {
    if (!state.stream) return;
    const track = state.stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.();
    if (!caps?.torch) { toast('Flash not supported on this device'); return; }
    state.flashOn = !state.flashOn;
    await track.applyConstraints({ advanced: [{ torch: state.flashOn }] });
    el.flashBtn.innerHTML = state.flashOn ? '&#x1F526;' : '&#9889;';
}

// ── Fullscreen camera ──────────────────────────────────────────────────────────

function openFullscreen() {
    el.fsOverlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // Try native fullscreen (Android); iOS ignores this but fixed overlay works fine
    el.fsOverlay.requestFullscreen?.().catch(() => {});
}

function exitFullscreen() {
    el.fsOverlay.classList.add('hidden');
    document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

// ── Capture ────────────────────────────────────────────────────────────────────

function capturePhoto() {
    // Capture from whichever video has valid dimensions
    const video  = el.fsVideo.videoWidth ? el.fsVideo : el.preview;
    const canvas = el.canvas;

    if (!video.videoWidth) { toast('Camera not ready yet'); return; }

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    const original = canvas.toDataURL('image/jpeg', state.quality);

    let display = original;
    if (state.watermark.enabled) {
        stampWatermark(canvas, ctx, new Date());
        display = canvas.toDataURL('image/jpeg', state.quality);
    }

    const photo = {
        id:          Date.now() + Math.random(),
        originalUrl: original,
        dataUrl:     display,
        filename:    makeFilename(),
        watermarked: state.watermark.enabled,
        uploaded:    false
    };

    state.photos.push(photo);
    renderQueue();
    captureFlash();
}

function makeFilename() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `inspection_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`
         + `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

function captureFlash() {
    const f = document.createElement('div');
    f.className = 'capture-flash';
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 300);
}

// ── Save to iPhone Photos ──────────────────────────────────────────────────────

async function saveToPhotos(id) {
    const photo = state.photos.find(p => p.id === id);
    if (!photo) return;

    try {
        const blob = dataUrlToBlob(photo.dataUrl);
        const file = new File([blob], photo.filename, { type: 'image/jpeg' });
        // Web Share API — on iOS this opens the share sheet with "Save Image" option
        if (navigator.share && navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: 'Inspection Photo' });
            return;
        }
    } catch (err) {
        if (err.name === 'AbortError') return; // user dismissed share sheet
    }

    // Fallback: download link (works on all browsers; on iOS saves to Files)
    const url = URL.createObjectURL(dataUrlToBlob(photo.dataUrl));
    const a   = document.createElement('a');
    a.href     = url;
    a.download = photo.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Photo saved');
}

// ── Watermark ──────────────────────────────────────────────────────────────────
// Layout matches the example photo:
//   - Company logo  → top-right corner (image, no background box)
//   - Date/time     → bottom-left corner (white text, dark pill)

function stampWatermark(canvas, ctx, date) {
    const w      = canvas.width;
    const h      = canvas.height;
    const margin = Math.round(w * 0.015);

    // ── Top-right: company logo image ──
    if (state.watermark.logoImg) {
        const logoW = Math.round(w * state.watermark.logoSize / 100);
        const logoH = Math.round(logoW * state.watermark.logoImg.naturalHeight
                                         / state.watermark.logoImg.naturalWidth);
        ctx.drawImage(state.watermark.logoImg, w - logoW - margin, margin, logoW, logoH);
    }

    // ── Bottom-left: date/time ──
    if (state.watermark.includeDate) {
        const fSize   = Math.max(16, Math.round(w * 0.026));
        const pad     = Math.round(w * 0.018);
        const dateStr = formatDate(date);
        ctx.font         = `bold ${fSize}px Arial, sans-serif`;
        ctx.textBaseline = 'top';
        const tw = ctx.measureText(dateStr).width;
        const bw = tw + pad * 2;
        const bh = fSize + pad * 2;
        const bx = margin;
        const by = h - bh - margin;

        ctx.fillStyle = 'rgba(0,0,0,0.60)';
        roundRect(ctx, bx, by, bw, bh, 6);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.fillText(dateStr, bx + pad, by + pad);
    }
}

// ── Logo upload ────────────────────────────────────────────────────────────────

function handleLogoUpload(file) {
    if (!file || !file.type.startsWith('image/')) { toast('Please select an image file'); return; }
    const reader = new FileReader();
    reader.onload = e => {
        const dataUrl = e.target.result;
        try { localStorage.setItem('wm_logo', dataUrl); } catch { /* storage full */ }
        state.watermark.logoDataUrl = dataUrl;
        loadLogoImage(dataUrl, true);
    };
    reader.readAsDataURL(file);
}

function loadLogoImage(dataUrl, showPreview = false) {
    const img = new Image();
    img.onload = () => {
        state.watermark.logoImg = img;
        if (showPreview) renderLogoPreview(dataUrl);
    };
    img.src = dataUrl;
}

function renderLogoPreview(dataUrl) {
    el.logoPreview.src = dataUrl;
    el.logoPreviewWrap.classList.remove('hidden');
    el.logoUploadLabel.classList.add('hidden');
    el.logoSizeRow.classList.remove('hidden');
}

function clearLogo() {
    state.watermark.logoDataUrl = null;
    state.watermark.logoImg     = null;
    localStorage.removeItem('wm_logo');
    el.logoPreview.src = '';
    el.logoPreviewWrap.classList.add('hidden');
    el.logoUploadLabel.classList.remove('hidden');
    el.logoSizeRow.classList.add('hidden');
    el.logoFileInput.value = '';
}

function formatDate(d) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const day    = d.getDate();
    const month  = months[d.getMonth()];
    const year   = d.getFullYear();
    let   h      = d.getHours();
    const m      = String(d.getMinutes()).padStart(2, '0');
    const ampm   = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${day} ${month} ${year} ${h}:${m} ${ampm}`;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
    ctx.lineTo(x + w,     y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r,     y + h);
    ctx.quadraticCurveTo(x,     y + h, x, y + h - r);
    ctx.lineTo(x,         y + r);
    ctx.quadraticCurveTo(x,     y,     x + r, y);
    ctx.closePath();
}

function applyWatermarkToPhoto(photo) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width  = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            stampWatermark(canvas, ctx, new Date());
            photo.dataUrl     = canvas.toDataURL('image/jpeg', state.quality);
            photo.watermarked = true;
            resolve();
        };
        img.src = photo.originalUrl;
    });
}

async function batchWatermark() {
    if (!state.photos.length) { toast('No photos to watermark'); return; }
    el.batchBtn.disabled    = true;
    el.batchBtn.textContent = 'Applying…';
    for (const p of state.photos) await applyWatermarkToPhoto(p);
    renderQueue();
    el.batchBtn.disabled    = false;
    el.batchBtn.textContent = 'Apply Watermark to All Photos';
    toast(`Watermark applied to ${state.photos.length} photo(s)`);
}

// ── Settings accordion ─────────────────────────────────────────────────────────

function toggleSettings() {
    const open = el.settingsPanel.classList.toggle('hidden');
    el.settingsChevron.classList.toggle('open', !open);
    el.settingsToggle.setAttribute('aria-expanded', String(!open));
}

// ── Photo queue ────────────────────────────────────────────────────────────────

function renderQueue() {
    const count = state.photos.length;
    el.photoCount.textContent = count;
    el.uploadAllBtn.disabled  = count === 0 || !state.dropbox.token;

    el.photoQueue.innerHTML = '';
    if (!count) {
        el.photoQueue.innerHTML = '<p class="empty-message">No photos yet&#8202;—&#8202;tap Shoot Fullscreen to start</p>';
        return;
    }

    state.photos.forEach(photo => {
        const div = document.createElement('div');
        div.className = 'photo-thumb' + (photo.uploaded ? ' uploaded' : '');

        const badges = [
            photo.uploaded    ? '<span class="badge ok">&#10003;</span>' : '',
            photo.watermarked ? '<span class="badge">WM</span>'          : ''
        ].join('');

        const upBtn = !photo.uploaded
            ? `<button class="btn-thumb btn-thumb-up"  data-id="${photo.id}" title="Upload to Dropbox">&#8593;</button>`
            : '';

        div.innerHTML = `
            <img src="${photo.dataUrl}" alt="Inspection photo" loading="lazy">
            <div class="photo-badges">${badges}</div>
            <div class="thumb-actions">
                <button class="btn-thumb btn-thumb-save" data-id="${photo.id}" title="Save to Photos">&#128247;</button>
                ${upBtn}
                <button class="btn-thumb btn-thumb-del"  data-id="${photo.id}" title="Delete">&times;</button>
            </div>`;

        div.querySelector('img').addEventListener('click', () => openModal(photo.id));

        div.querySelector('.btn-thumb-save').addEventListener('click', e => {
            e.stopPropagation(); saveToPhotos(photo.id);
        });

        const up = div.querySelector('.btn-thumb-up');
        if (up) up.addEventListener('click', e => { e.stopPropagation(); uploadOne(photo.id); });

        div.querySelector('.btn-thumb-del').addEventListener('click', e => {
            e.stopPropagation(); deletePhoto(photo.id);
        });

        el.photoQueue.appendChild(div);
    });
}

function deletePhoto(id) {
    state.photos = state.photos.filter(p => p.id !== id);
    renderQueue();
    if (state.modalPhotoId === id) closeModal();
}

// ── Photo modal ────────────────────────────────────────────────────────────────

function openModal(id) {
    const photo = state.photos.find(p => p.id === id);
    if (!photo) return;
    state.modalPhotoId = id;
    el.modalImg.src = photo.dataUrl;
    el.modalUploadBtn.disabled    = photo.uploaded || !state.dropbox.token;
    el.modalUploadBtn.textContent = photo.uploaded ? 'Uploaded ✓' : '↑ Dropbox';
    el.photoModal.classList.remove('hidden');
}

function closeModal() {
    el.photoModal.classList.add('hidden');
    state.modalPhotoId = null;
}

// ── Dropbox auth ───────────────────────────────────────────────────────────────

async function generatePKCE() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const verifier  = btoa(String.fromCharCode(...arr)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    const digest    = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    return { verifier, challenge };
}

async function connectDropbox(forceReapprove = false) {
    const key = state.dropbox.appKey;
    if (!key) { toast('Please enter your App Key first'); return; }

    const { verifier, challenge } = await generatePKCE();
    sessionStorage.setItem('pkce_verifier', verifier);

    const redirectUri = pageUrl();
    const params = new URLSearchParams({
        client_id:             key,
        response_type:         'code',
        code_challenge:        challenge,
        code_challenge_method: 'S256',
        redirect_uri:          redirectUri,
        token_access_type:     'online'
    });
    if (forceReapprove) params.set('force_reapprove', 'true');
    window.location.href = `https://www.dropbox.com/oauth2/authorize?${params}`;
}

async function switchAccount() {
    state.dropbox.token = '';
    localStorage.removeItem('dbx_token');
    showNotConnected();
    await connectDropbox(true);
}

async function handleOAuthReturn() {
    const urlParams = new URLSearchParams(window.location.search);
    const code      = urlParams.get('code');
    const verifier  = sessionStorage.getItem('pkce_verifier');
    if (!code || !verifier) return;

    history.replaceState(null, '', window.location.pathname);
    sessionStorage.removeItem('pkce_verifier');

    try {
        const res = await fetch('https://api.dropbox.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                grant_type:    'authorization_code',
                client_id:     state.dropbox.appKey,
                code_verifier: verifier,
                redirect_uri:  pageUrl()
            })
        });
        const data = await res.json();
        if (data.access_token) {
            state.dropbox.token = data.access_token;
            localStorage.setItem('dbx_token', data.access_token);
            await loadDropboxUser();
        } else {
            toast('Dropbox connection failed: ' + (data.error_description || 'unknown error'));
        }
    } catch (err) {
        toast('Dropbox connection error: ' + err.message);
    }
}

async function loadDropboxUser() {
    try {
        const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${state.dropbox.token}`, 'Content-Type': 'application/json' },
            body:    'null'
        });
        if (res.status === 401) { expireToken(); return; }
        const user = await res.json();
        $('dropboxUserName').textContent = '✓ ' + (user.name?.display_name || 'Connected');
        showConnected();
    } catch {
        expireToken();
    }
}

function disconnectDropbox() {
    state.dropbox.token = '';
    localStorage.removeItem('dbx_token');
    showNotConnected();
}

function expireToken() {
    state.dropbox.token = '';
    localStorage.removeItem('dbx_token');
    showNotConnected();
    toast('Dropbox session expired — please reconnect');
}

function saveAppKey() {
    const key = el.appKeyInput.value.trim();
    if (!key) { toast('Please enter a valid App Key'); return; }
    state.dropbox.appKey = key;
    localStorage.setItem('dbx_app_key', key);
    renderDropboxSection();
}

function clearAppKey() {
    state.dropbox.appKey = '';
    state.dropbox.token  = '';
    localStorage.removeItem('dbx_app_key');
    localStorage.removeItem('dbx_token');
    renderDropboxSection();
}

function renderDropboxSection() {
    if (!state.dropbox.appKey) {
        el.setupInstructions.classList.remove('hidden');
        el.dropboxAuth.classList.add('hidden');
    } else {
        el.setupInstructions.classList.add('hidden');
        el.dropboxAuth.classList.remove('hidden');
        el.appKeyDisplay.textContent = state.dropbox.appKey.slice(0, 8) + '…';
        state.dropbox.token ? showConnected() : showNotConnected();
    }
}

function showConnected() {
    el.dropboxNotConn.classList.add('hidden');
    el.dropboxConn.classList.remove('hidden');
    el.selectedFolder.textContent = state.dropbox.folder || '/ (root)';
    renderQueue();
}

function showNotConnected() {
    el.dropboxNotConn.classList.remove('hidden');
    el.dropboxConn.classList.add('hidden');
    renderQueue();
}

// ── Folder browser ─────────────────────────────────────────────────────────────

function openFolderBrowser() {
    state.dropbox.folderStack = [];
    el.folderModal.classList.remove('hidden');
    loadFolder('');
}

function closeFolderBrowser() {
    el.folderModal.classList.add('hidden');
}

async function loadFolder(path) {
    state.dropbox.browsePath  = path;
    el.folderPath.textContent = path || '/ root';
    el.folderNavBack.disabled = !path;
    el.folderList.innerHTML   = '<div class="loading">Loading…</div>';

    try {
        const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${state.dropbox.token}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ path, recursive: false })
        });
        if (res.status === 401) { expireToken(); closeFolderBrowser(); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data    = await res.json();
        const folders = (data.entries || [])
            .filter(e => e['.tag'] === 'folder')
            .sort((a, b) => a.name.localeCompare(b.name));

        el.folderList.innerHTML = '';
        if (!folders.length) {
            el.folderList.innerHTML = '<p class="loading">No subfolders here</p>';
            return;
        }
        folders.forEach(f => {
            const btn = document.createElement('button');
            btn.className = 'folder-item';
            btn.innerHTML = `<span class="folder-icon">&#x1F4C1;</span><span>${escHtml(f.name)}</span><span class="folder-chevron">&#8250;</span>`;
            btn.addEventListener('click', () => {
                state.dropbox.folderStack.push(path);
                loadFolder(f.path_lower);
            });
            el.folderList.appendChild(btn);
        });
    } catch (err) {
        el.folderList.innerHTML = `<p class="error-msg">Error: ${escHtml(err.message)}</p>`;
    }
}

function folderBack() {
    if (!state.dropbox.folderStack.length) return;
    loadFolder(state.dropbox.folderStack.pop());
}

function selectFolder() {
    state.dropbox.folder = state.dropbox.browsePath;
    localStorage.setItem('dbx_folder', state.dropbox.folder);
    el.selectedFolder.textContent = state.dropbox.folder || '/ (root)';
    closeFolderBrowser();
    toast('Folder set: ' + (state.dropbox.folder || '/ root'));
}

// ── Upload ─────────────────────────────────────────────────────────────────────

async function uploadOne(id) {
    const photo = state.photos.find(p => p.id === id);
    if (!photo || photo.uploaded || photo._uploading) return;
    if (!state.dropbox.token) { toast('Connect to Dropbox first'); return; }

    photo._uploading = true;
    renderQueue();

    try {
        await pushToDropbox(photo);
        photo.uploaded   = true;
        photo._uploading = false;
        renderQueue();
        toast('Uploaded: ' + photo.filename);
        if (state.modalPhotoId === id) {
            el.modalUploadBtn.disabled    = true;
            el.modalUploadBtn.textContent = 'Uploaded ✓';
        }
    } catch (err) {
        photo._uploading = false;
        renderQueue();
        toast('Upload failed: ' + err.message);
    }
}

async function uploadAll() {
    const pending = state.photos.filter(p => !p.uploaded);
    if (!pending.length) { toast('All photos already uploaded'); return; }

    el.uploadAllBtn.disabled = true;
    let done = 0;

    for (const photo of pending) {
        el.uploadAllBtn.textContent = `Uploading ${done + 1}/${pending.length}…`;
        try {
            await pushToDropbox(photo);
            photo.uploaded = true;
            done++;
            renderQueue();
        } catch (err) {
            toast(`Failed ${photo.filename}: ${err.message}`);
        }
    }

    el.uploadAllBtn.disabled    = false;
    el.uploadAllBtn.textContent = 'Upload All';
    toast(`Uploaded ${done} of ${pending.length} photo(s)`);
}

async function pushToDropbox(photo) {
    const folder = state.dropbox.folder || '';
    const path   = folder + '/' + photo.filename;

    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method:  'POST',
        headers: {
            'Authorization':   `Bearer ${state.dropbox.token}`,
            'Content-Type':    'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true, mute: false })
        },
        body: dataUrlToBlob(photo.dataUrl)
    });

    if (res.status === 401) { expireToken(); throw new Error('Session expired'); }
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error_summary || `HTTP ${res.status}`);
    }
    return res.json();
}

function dataUrlToBlob(dataUrl) {
    const [head, data] = dataUrl.split(',');
    const mime   = head.match(/:(.*?);/)[1];
    const binary = atob(data);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

// ── Toast ──────────────────────────────────────────────────────────────────────

function toast(msg) {
    const t = document.createElement('div');
    t.className   = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => { requestAnimationFrame(() => t.classList.add('show')); });
    setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.remove(), 300);
    }, 3200);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function pageUrl() {
    return window.location.origin + window.location.pathname;
}

function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Event wiring ───────────────────────────────────────────────────────────────

function bindEvents() {
    // Camera
    el.expandFsBtn  .addEventListener('click', openFullscreen);
    el.exitFsBtn    .addEventListener('click', exitFullscreen);
    el.captureBtn   .addEventListener('click', capturePhoto);
    el.switchBtn    .addEventListener('click', switchCamera);
    el.flashBtn     .addEventListener('click', toggleFlash);
    el.retryCameraBtn.addEventListener('click', startCamera);

    // Exit fullscreen when back button pressed on Android
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) el.fsOverlay.classList.add('hidden');
    });

    // Quality
    el.qualitySlider.addEventListener('input', () => {
        state.quality = el.qualitySlider.value / 100;
        el.qualityValue.textContent = el.qualitySlider.value + '%';
    });

    // Settings accordion
    el.settingsToggle.addEventListener('click', toggleSettings);

    // Watermark
    el.watermarkToggle.addEventListener('change', () => {
        state.watermark.enabled = el.watermarkToggle.checked;
        el.watermarkOptions.classList.toggle('hidden', !state.watermark.enabled);
    });
    el.logoFileInput.addEventListener('change', e => {
        if (e.target.files[0]) handleLogoUpload(e.target.files[0]);
    });
    el.clearLogoBtn.addEventListener('click', clearLogo);
    el.logoSizeSlider.addEventListener('input', () => {
        state.watermark.logoSize = parseInt(el.logoSizeSlider.value, 10);
        el.logoSizeValue.textContent = el.logoSizeSlider.value + '%';
        localStorage.setItem('wm_logo_size', el.logoSizeSlider.value);
    });
    el.watermarkDate.addEventListener('change', () => {
        state.watermark.includeDate = el.watermarkDate.checked;
    });
    el.batchBtn.addEventListener('click', batchWatermark);

    // Gallery
    el.uploadAllBtn.addEventListener('click', uploadAll);

    // Dropbox settings
    el.saveAppKeyBtn  .addEventListener('click', saveAppKey);
    el.appKeyInput    .addEventListener('keydown', e => { if (e.key === 'Enter') saveAppKey(); });
    el.clearAppKeyBtn .addEventListener('click', clearAppKey);
    el.connectBtn     .addEventListener('click', connectDropbox);
    el.disconnectBtn  .addEventListener('click', disconnectDropbox);
    el.switchAccountBtn.addEventListener('click', switchAccount);
    el.changeFolderBtn.addEventListener('click', openFolderBrowser);

    // Photo modal
    el.modalBackdrop .addEventListener('click', closeModal);
    el.modalClose    .addEventListener('click', closeModal);
    el.modalSaveBtn  .addEventListener('click', () => { if (state.modalPhotoId) saveToPhotos(state.modalPhotoId); });
    el.modalUploadBtn.addEventListener('click', () => { if (state.modalPhotoId) uploadOne(state.modalPhotoId); });
    el.modalDeleteBtn.addEventListener('click', () => { if (state.modalPhotoId) deletePhoto(state.modalPhotoId); });

    // Folder browser
    el.folderModalBack .addEventListener('click', closeFolderBrowser);
    el.folderModalClose.addEventListener('click', closeFolderBrowser);
    el.folderNavBack   .addEventListener('click', folderBack);
    el.selectFolderBtn .addEventListener('click', selectFolder);
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
    el.redirectDisplay.textContent = pageUrl();

    if (state.watermark.logoDataUrl) loadLogoImage(state.watermark.logoDataUrl, true);
    el.logoSizeSlider.value      = state.watermark.logoSize;
    el.logoSizeValue.textContent = state.watermark.logoSize + '%';

    el.qualitySlider.value      = Math.round(state.quality * 100);
    el.qualityValue.textContent = Math.round(state.quality * 100) + '%';

    renderDropboxSection();
    renderQueue();
    bindEvents();

    await handleOAuthReturn();
    if (state.dropbox.token) await loadDropboxUser();

    await startCamera();
}

document.addEventListener('DOMContentLoaded', init);
