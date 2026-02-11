/**
 * Image Converter - TNS Toolbox
 * Client-side image-to-PNG conversion with optional background removal.
 * All processing happens in the browser; no files are uploaded anywhere.
 */

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────────
  const dropZone        = document.getElementById('dropZone');
  const fileInput       = document.getElementById('fileInput');
  const browseBtn       = document.getElementById('browseBtn');
  const addMoreBtn      = document.getElementById('addMoreBtn');
  const clearAllBtn     = document.getElementById('clearAllBtn');
  const fileListSection = document.getElementById('fileListSection');
  const fileListEl      = document.getElementById('fileList');
  const fileCountEl     = document.getElementById('fileCount');
  const convertBar      = document.getElementById('convertBar');
  const convertCountEl  = document.getElementById('convertCount');
  const convertAllBtn   = document.getElementById('convertAllBtn');
  const canvas          = document.getElementById('processingCanvas');
  const ctx             = canvas.getContext('2d', { willReadFrequently: true });
  const toastEl         = document.getElementById('toast');
  const toastIcon       = document.getElementById('toastIcon');
  const toastMsg        = document.getElementById('toastMessage');

  // Hidden input for "Add More" button
  const addMoreInput = document.createElement('input');
  addMoreInput.type = 'file';
  addMoreInput.multiple = true;
  addMoreInput.accept = fileInput.accept;

  // ── State ─────────────────────────────────────────────────────────────
  let fileEntries = []; // { id, file, removeBg, status, objectUrl, resultBlob }
  let nextId = 0;

  // ── Helpers ───────────────────────────────────────────────────────────
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function showToast(message, type) {
    toastIcon.textContent = type === 'success' ? '\u2713' : '\u2717';
    toastMsg.textContent = message;
    toastEl.className = 'toast visible ' + type;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toastEl.classList.remove('visible');
    }, 3000);
  }

  // ── Load an image from a File into an HTMLImageElement ────────────────
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        resolve({ img, url });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not load image'));
      };
      img.src = url;
    });
  }

  // ── Background removal (flood-fill from edges) ───────────────────────
  // Makes white-ish / light pixels transparent starting from image edges.
  // Uses a tolerance-based flood fill so it only removes contiguous
  // background regions, leaving the actual subject intact.
  function removeBackground(imageData) {
    const { data, width, height } = imageData;
    const total = width * height;
    const visited = new Uint8Array(total);

    // Tolerance: how "white" a pixel can be to count as background.
    // Also catches light shadows / off-white paper.
    const TOLERANCE = 45; // distance from white (255,255,255)

    function idx(x, y) {
      return y * width + x;
    }

    function isBackground(i) {
      const off = i * 4;
      const r = data[off], g = data[off + 1], b = data[off + 2], a = data[off + 3];
      // Already transparent -> skip
      if (a < 10) return false;
      // Distance from pure white
      const dist = Math.sqrt((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2);
      return dist < TOLERANCE;
    }

    // BFS flood fill from all edge pixels that look like background
    const queue = [];

    // Seed: all edge pixels
    for (let x = 0; x < width; x++) {
      const topIdx = idx(x, 0);
      const botIdx = idx(x, height - 1);
      if (isBackground(topIdx) && !visited[topIdx]) { visited[topIdx] = 1; queue.push(topIdx); }
      if (isBackground(botIdx) && !visited[botIdx]) { visited[botIdx] = 1; queue.push(botIdx); }
    }
    for (let y = 0; y < height; y++) {
      const leftIdx = idx(0, y);
      const rightIdx = idx(width - 1, y);
      if (isBackground(leftIdx) && !visited[leftIdx])  { visited[leftIdx]  = 1; queue.push(leftIdx); }
      if (isBackground(rightIdx) && !visited[rightIdx]) { visited[rightIdx] = 1; queue.push(rightIdx); }
    }

    // Process queue
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      const x = i % width;
      const y = (i - x) / width;

      // Make pixel transparent
      data[i * 4 + 3] = 0;

      // Check 4 neighbors
      const neighbors = [];
      if (x > 0)          neighbors.push(idx(x - 1, y));
      if (x < width - 1)  neighbors.push(idx(x + 1, y));
      if (y > 0)          neighbors.push(idx(x, y - 1));
      if (y < height - 1) neighbors.push(idx(x, y + 1));

      for (const ni of neighbors) {
        if (!visited[ni] && isBackground(ni)) {
          visited[ni] = 1;
          queue.push(ni);
        }
      }
    }

    // Smooth edges: partially fade pixels adjacent to removed ones
    // so the cutout doesn't look jaggy.
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = idx(x, y);
        if (visited[i]) continue; // already removed
        const off = i * 4;
        if (data[off + 3] < 10) continue; // already transparent

        // Count how many direct neighbors were removed
        let removedNeighbors = 0;
        if (visited[idx(x - 1, y)]) removedNeighbors++;
        if (visited[idx(x + 1, y)]) removedNeighbors++;
        if (visited[idx(x, y - 1)]) removedNeighbors++;
        if (visited[idx(x, y + 1)]) removedNeighbors++;

        if (removedNeighbors >= 2) {
          // Edge pixel: soften alpha for anti-aliasing
          data[off + 3] = Math.round(data[off + 3] * 0.5);
        } else if (removedNeighbors === 1) {
          data[off + 3] = Math.round(data[off + 3] * 0.8);
        }
      }
    }

    return imageData;
  }

  // ── Convert a single file entry ──────────────────────────────────────
  async function convertEntry(entry) {
    entry.status = 'processing';
    renderList();

    try {
      const { img, url } = await loadImage(entry.file);

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      URL.revokeObjectURL(url);

      if (entry.removeBg) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        removeBackground(imageData);
        ctx.putImageData(imageData, 0, 0);
      }

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => {
          if (b) resolve(b);
          else reject(new Error('Canvas toBlob failed'));
        }, 'image/png');
      });

      entry.resultBlob = blob;
      entry.status = 'done';
    } catch (err) {
      console.error('Conversion error:', err);
      entry.status = 'error';
    }

    renderList();
  }

  // ── Download a single result ─────────────────────────────────────────
  function downloadEntry(entry) {
    if (!entry.resultBlob) return;
    const baseName = entry.file.name.replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(entry.resultBlob);
    a.download = baseName + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ── Convert all, then zip-download ───────────────────────────────────
  async function convertAll() {
    const pending = fileEntries.filter(e => e.status !== 'done');
    convertAllBtn.disabled = true;
    convertAllBtn.textContent = 'Converting...';

    for (const entry of pending) {
      await convertEntry(entry);
    }

    // Download each individually (lightweight; no zip dependency)
    const done = fileEntries.filter(e => e.status === 'done');
    if (done.length === 0) {
      showToast('No files were converted', 'error');
    } else if (done.length === 1) {
      downloadEntry(done[0]);
      showToast('Image converted and downloaded', 'success');
    } else {
      // Small delay between downloads so the browser doesn't block them
      for (let i = 0; i < done.length; i++) {
        setTimeout(() => downloadEntry(done[i]), i * 300);
      }
      showToast(`${done.length} images converted and downloading`, 'success');
    }

    convertAllBtn.disabled = false;
    convertAllBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Convert &amp; Download All`;
  }

  // ── Add files to state ────────────────────────────────────────────────
  function addFiles(files) {
    const validTypes = [
      'image/png', 'image/jpeg', 'image/webp', 'image/avif',
      'image/bmp', 'image/tiff', 'image/gif', 'image/svg+xml'
    ];

    let added = 0;
    for (const file of files) {
      if (!validTypes.includes(file.type)) continue;
      fileEntries.push({
        id: nextId++,
        file,
        removeBg: false,
        status: 'pending',    // pending | processing | done | error
        objectUrl: URL.createObjectURL(file),
        resultBlob: null,
      });
      added++;
    }

    if (added === 0 && files.length > 0) {
      showToast('No supported image files found', 'error');
    }

    renderList();
  }

  // ── Remove a single entry ────────────────────────────────────────────
  function removeEntry(id) {
    const idx = fileEntries.findIndex(e => e.id === id);
    if (idx === -1) return;
    URL.revokeObjectURL(fileEntries[idx].objectUrl);
    fileEntries.splice(idx, 1);
    renderList();
  }

  // ── Clear all entries ────────────────────────────────────────────────
  function clearAll() {
    fileEntries.forEach(e => URL.revokeObjectURL(e.objectUrl));
    fileEntries = [];
    renderList();
  }

  // ── Render the file list UI ──────────────────────────────────────────
  function renderList() {
    const hasFiles = fileEntries.length > 0;
    fileListSection.style.display = hasFiles ? '' : 'none';
    convertBar.style.display = hasFiles ? '' : 'none';
    dropZone.style.display = hasFiles ? 'none' : '';

    fileCountEl.textContent = fileEntries.length + (fileEntries.length === 1 ? ' file' : ' files');

    const readyCount = fileEntries.filter(e => e.status !== 'done').length;
    const doneCount = fileEntries.filter(e => e.status === 'done').length;
    if (doneCount === fileEntries.length && fileEntries.length > 0) {
      convertCountEl.textContent = doneCount;
      convertBar.querySelector('.convert-bar-info').innerHTML =
        `<strong>${doneCount}</strong> file${doneCount !== 1 ? 's' : ''} converted`;
      convertAllBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download All`;
    } else {
      convertCountEl.textContent = readyCount;
      convertBar.querySelector('.convert-bar-info').innerHTML =
        `<strong>${readyCount}</strong> file${readyCount !== 1 ? 's' : ''} ready to convert`;
    }

    // Build HTML
    fileListEl.innerHTML = fileEntries.map(entry => {
      const statusClass = entry.status;
      const statusLabel = {
        pending: 'Pending',
        processing: 'Converting...',
        done: 'Done',
        error: 'Error',
      }[entry.status];

      const thumbClass = entry.status === 'done' ? 'file-thumb transparent-bg' : 'file-thumb';

      return `
        <div class="file-item ${statusClass}" data-id="${entry.id}">
          <div class="${thumbClass}">
            <img src="${entry.objectUrl}" alt="${entry.file.name}">
          </div>
          <div class="file-info">
            <div class="file-name" title="${entry.file.name}">${entry.file.name}</div>
            <div class="file-meta">
              <span>${formatBytes(entry.file.size)}</span>
              <span>${entry.file.type.split('/')[1].toUpperCase()}</span>
              <span class="status-badge ${statusClass}">${statusLabel}</span>
            </div>
          </div>
          <div class="file-options">
            <label class="remove-bg-toggle" title="Remove white/light background">
              <input type="checkbox" data-action="toggleBg" data-id="${entry.id}" ${entry.removeBg ? 'checked' : ''} ${entry.status === 'processing' ? 'disabled' : ''}>
              <span class="checkbox-visual"></span>
              <span class="remove-bg-label">Remove background</span>
            </label>
          </div>
          <div class="file-actions">
            ${entry.status === 'done' ? `
              <button class="btn-icon" data-action="download" data-id="${entry.id}" title="Download PNG">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>` : ''}
            <button class="btn-icon remove" data-action="remove" data-id="${entry.id}" title="Remove file">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          ${entry.status === 'processing' ? `
            <div class="progress-bar"><div class="progress-bar-fill" style="width: 60%"></div></div>
          ` : ''}
        </div>`;
    }).join('');
  }

  // ── Event delegation for file list actions ───────────────────────────
  fileListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = parseInt(btn.dataset.id);
    const action = btn.dataset.action;

    if (action === 'remove') {
      removeEntry(id);
    } else if (action === 'download') {
      const entry = fileEntries.find(e => e.id === id);
      if (entry) downloadEntry(entry);
    }
  });

  fileListEl.addEventListener('change', (e) => {
    if (e.target.dataset.action === 'toggleBg') {
      const id = parseInt(e.target.dataset.id);
      const entry = fileEntries.find(e => e.id === id);
      if (entry) {
        entry.removeBg = e.target.checked;
        // Reset status if already converted so it can be re-converted
        if (entry.status === 'done') {
          entry.status = 'pending';
          entry.resultBlob = null;
          renderList();
        }
      }
    }
  });

  // ── Drop zone events ─────────────────────────────────────────────────
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target.closest('.drop-zone-btn') || e.target === dropZone || e.target.closest('.drop-zone-icon') || e.target.closest('h3') || e.target.closest('p')) {
      fileInput.click();
    }
  });

  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = '';
  });

  // ── "Add More" and "Clear All" ───────────────────────────────────────
  addMoreBtn.addEventListener('click', () => addMoreInput.click());
  addMoreInput.addEventListener('change', () => {
    if (addMoreInput.files.length) addFiles(addMoreInput.files);
    addMoreInput.value = '';
  });

  clearAllBtn.addEventListener('click', clearAll);

  // ── Convert All button ───────────────────────────────────────────────
  convertAllBtn.addEventListener('click', () => {
    // If all done, just re-download
    const allDone = fileEntries.length > 0 && fileEntries.every(e => e.status === 'done');
    if (allDone) {
      const done = fileEntries.filter(e => e.status === 'done');
      for (let i = 0; i < done.length; i++) {
        setTimeout(() => downloadEntry(done[i]), i * 300);
      }
      showToast(`Downloading ${done.length} file${done.length !== 1 ? 's' : ''}`, 'success');
      return;
    }
    convertAll();
  });

  // ── Global drag-and-drop (even when file list is shown) ──────────────
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.target.closest('#dropZone')) return; // handled by dropZone
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // ── Keyboard shortcut: Escape to go back to hub ──────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest('input')) {
      window.location.href = '/';
    }
  });

})();
