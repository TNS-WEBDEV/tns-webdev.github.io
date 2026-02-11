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
  let fileEntries = []; // { id, file, removeBg, status, objectUrl, resultUrl, resultBlob }
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

  // Yield to the browser so it can paint DOM updates
  function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  // ── Load an image from a File into an HTMLImageElement ────────────────
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not load image'));
      };
      img.src = url;
    });
  }

  // ── Background removal (flood-fill from edges) ───────────────────────
  // Makes white-ish / light pixels transparent starting from image edges.
  // Uses a tolerance-based BFS flood fill so it only removes contiguous
  // background, leaving the subject intact.
  function removeBackground(imageData) {
    const { data, width, height } = imageData;
    const total = width * height;

    // Pre-allocated typed-array queue (max size = total pixels)
    const queue = new Int32Array(total);
    let qHead = 0;
    let qTail = 0;

    // Visited map
    const visited = new Uint8Array(total);

    // Tolerance: Euclidean distance from pure white (255,255,255).
    // 55 covers JPEG compression artifacts and light shadows.
    const TOLERANCE = 55;

    function pixelIndex(x, y) {
      return y * width + x;
    }

    function isBackgroundPixel(i) {
      const off = i * 4;
      const r = data[off];
      const g = data[off + 1];
      const b = data[off + 2];
      const a = data[off + 3];
      // Already transparent → not background (nothing to remove)
      if (a < 10) return false;
      // Euclidean distance from white
      const dr = 255 - r;
      const dg = 255 - g;
      const db = 255 - b;
      return (dr * dr + dg * dg + db * db) < (TOLERANCE * TOLERANCE);
    }

    // Seed the queue with all edge pixels that look like background
    for (let x = 0; x < width; x++) {
      const top = pixelIndex(x, 0);
      if (isBackgroundPixel(top) && !visited[top]) {
        visited[top] = 1;
        queue[qTail++] = top;
      }
      const bot = pixelIndex(x, height - 1);
      if (isBackgroundPixel(bot) && !visited[bot]) {
        visited[bot] = 1;
        queue[qTail++] = bot;
      }
    }
    for (let y = 1; y < height - 1; y++) {
      const left = pixelIndex(0, y);
      if (isBackgroundPixel(left) && !visited[left]) {
        visited[left] = 1;
        queue[qTail++] = left;
      }
      const right = pixelIndex(width - 1, y);
      if (isBackgroundPixel(right) && !visited[right]) {
        visited[right] = 1;
        queue[qTail++] = right;
      }
    }

    // BFS: expand from edge background pixels inward
    while (qHead < qTail) {
      const i = queue[qHead++];
      const x = i % width;
      const y = (i - x) / width;

      // Make this pixel fully transparent
      data[i * 4 + 3] = 0;

      // Check 4-connected neighbors
      if (x > 0) {
        const ni = i - 1;
        if (!visited[ni] && isBackgroundPixel(ni)) {
          visited[ni] = 1;
          queue[qTail++] = ni;
        }
      }
      if (x < width - 1) {
        const ni = i + 1;
        if (!visited[ni] && isBackgroundPixel(ni)) {
          visited[ni] = 1;
          queue[qTail++] = ni;
        }
      }
      if (y > 0) {
        const ni = i - width;
        if (!visited[ni] && isBackgroundPixel(ni)) {
          visited[ni] = 1;
          queue[qTail++] = ni;
        }
      }
      if (y < height - 1) {
        const ni = i + width;
        if (!visited[ni] && isBackgroundPixel(ni)) {
          visited[ni] = 1;
          queue[qTail++] = ni;
        }
      }
    }

    // Anti-alias: soften alpha on pixels adjacent to removed ones
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = pixelIndex(x, y);
        if (visited[i]) continue;
        const off = i * 4;
        if (data[off + 3] < 10) continue;

        let removedNeighbors = 0;
        if (visited[i - 1])     removedNeighbors++;
        if (visited[i + 1])     removedNeighbors++;
        if (visited[i - width]) removedNeighbors++;
        if (visited[i + width]) removedNeighbors++;

        if (removedNeighbors >= 3) {
          data[off + 3] = Math.round(data[off + 3] * 0.3);
        } else if (removedNeighbors >= 2) {
          data[off + 3] = Math.round(data[off + 3] * 0.5);
        } else if (removedNeighbors === 1) {
          data[off + 3] = Math.round(data[off + 3] * 0.75);
        }
      }
    }

    return imageData;
  }

  // ── Convert a single file entry ──────────────────────────────────────
  async function convertEntry(entry) {
    entry.status = 'processing';
    renderList();

    // Yield so the browser paints the "Converting..." state before heavy work
    await yieldToUI();

    try {
      const { img, url } = await loadImage(entry.file);

      canvas.width  = img.naturalWidth;
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
          else reject(new Error('Canvas export failed'));
        }, 'image/png');
      });

      // Store result and create a preview URL for the processed image
      entry.resultBlob = blob;
      if (entry.resultUrl) URL.revokeObjectURL(entry.resultUrl);
      entry.resultUrl = URL.createObjectURL(blob);
      entry.status = 'done';
    } catch (err) {
      console.error('Conversion error for', entry.file.name, err);
      entry.status = 'error';
      showToast('Error converting ' + entry.file.name, 'error');
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

  // ── Convert all, then download ───────────────────────────────────────
  async function convertAll() {
    const pending = fileEntries.filter(e => e.status !== 'done');
    convertAllBtn.disabled = true;
    convertAllBtn.textContent = 'Converting\u2026';

    for (const entry of pending) {
      await convertEntry(entry);
    }

    const done = fileEntries.filter(e => e.status === 'done');
    if (done.length === 0) {
      showToast('No files were converted', 'error');
    } else if (done.length === 1) {
      downloadEntry(done[0]);
      showToast('Image converted and downloaded', 'success');
    } else {
      for (let i = 0; i < done.length; i++) {
        setTimeout(() => downloadEntry(done[i]), i * 300);
      }
      showToast(done.length + ' images converted and downloading', 'success');
    }

    convertAllBtn.disabled = false;
    convertAllBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/>' +
      '</svg> Convert &amp; Download All';
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
        status: 'pending',
        objectUrl: URL.createObjectURL(file),
        resultUrl: null,
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
    const i = fileEntries.findIndex(e => e.id === id);
    if (i === -1) return;
    URL.revokeObjectURL(fileEntries[i].objectUrl);
    if (fileEntries[i].resultUrl) URL.revokeObjectURL(fileEntries[i].resultUrl);
    fileEntries.splice(i, 1);
    renderList();
  }

  // ── Clear all entries ────────────────────────────────────────────────
  function clearAll() {
    fileEntries.forEach(e => {
      URL.revokeObjectURL(e.objectUrl);
      if (e.resultUrl) URL.revokeObjectURL(e.resultUrl);
    });
    fileEntries = [];
    renderList();
  }

  // ── Render the file list UI ──────────────────────────────────────────
  function renderList() {
    const hasFiles = fileEntries.length > 0;
    fileListSection.style.display = hasFiles ? '' : 'none';
    convertBar.style.display     = hasFiles ? '' : 'none';
    dropZone.style.display       = hasFiles ? 'none' : '';

    fileCountEl.textContent =
      fileEntries.length + (fileEntries.length === 1 ? ' file' : ' files');

    const readyCount = fileEntries.filter(e => e.status !== 'done').length;
    const doneCount  = fileEntries.filter(e => e.status === 'done').length;

    if (doneCount === fileEntries.length && fileEntries.length > 0) {
      convertCountEl.textContent = doneCount;
      convertBar.querySelector('.convert-bar-info').innerHTML =
        '<strong>' + doneCount + '</strong> file' + (doneCount !== 1 ? 's' : '') + ' converted';
      convertAllBtn.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
        '<polyline points="7 10 12 15 17 10"/>' +
        '<line x1="12" y1="15" x2="12" y2="3"/>' +
        '</svg> Download All';
    } else {
      convertCountEl.textContent = readyCount;
      convertBar.querySelector('.convert-bar-info').innerHTML =
        '<strong>' + readyCount + '</strong> file' + (readyCount !== 1 ? 's' : '') + ' ready to convert';
    }

    // Build HTML
    fileListEl.innerHTML = fileEntries.map(function (entry) {
      var statusLabel = {
        pending: 'Pending',
        processing: 'Converting\u2026',
        done: 'Done',
        error: 'Error',
      }[entry.status];

      // After conversion, show the processed result (with transparency)
      var thumbSrc = entry.resultUrl || entry.objectUrl;
      var thumbClass = (entry.status === 'done')
        ? 'file-thumb transparent-bg'
        : 'file-thumb';

      return (
        '<div class="file-item ' + entry.status + '" data-id="' + entry.id + '">' +
          '<div class="' + thumbClass + '">' +
            '<img src="' + thumbSrc + '" alt="' + entry.file.name + '">' +
          '</div>' +
          '<div class="file-info">' +
            '<div class="file-name" title="' + entry.file.name + '">' + entry.file.name + '</div>' +
            '<div class="file-meta">' +
              '<span>' + formatBytes(entry.file.size) + '</span>' +
              '<span>' + entry.file.type.split('/')[1].toUpperCase() + '</span>' +
              '<span class="status-badge ' + entry.status + '">' + statusLabel + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="file-options">' +
            '<label class="remove-bg-toggle" title="Remove white/light background">' +
              '<input type="checkbox" data-action="toggleBg" data-id="' + entry.id + '"' +
                (entry.removeBg ? ' checked' : '') +
                (entry.status === 'processing' ? ' disabled' : '') + '>' +
              '<span class="checkbox-visual"></span>' +
              '<span class="remove-bg-label">Remove background</span>' +
            '</label>' +
          '</div>' +
          '<div class="file-actions">' +
            (entry.status === 'done'
              ? '<button class="btn-icon" data-action="download" data-id="' + entry.id + '" title="Download PNG">' +
                  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
                  '<polyline points="7 10 12 15 17 10"/>' +
                  '<line x1="12" y1="15" x2="12" y2="3"/>' +
                  '</svg></button>'
              : '') +
            '<button class="btn-icon remove" data-action="remove" data-id="' + entry.id + '" title="Remove file">' +
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
              '</svg></button>' +
          '</div>' +
          (entry.status === 'processing'
            ? '<div class="progress-bar"><div class="progress-bar-fill" style="width:60%"></div></div>'
            : '') +
        '</div>'
      );
    }).join('');
  }

  // ── Event delegation for file list actions ───────────────────────────
  fileListEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = parseInt(btn.dataset.id, 10);
    var action = btn.dataset.action;

    if (action === 'remove') {
      removeEntry(id);
    } else if (action === 'download') {
      var entry = fileEntries.find(function (e) { return e.id === id; });
      if (entry) downloadEntry(entry);
    }
  });

  fileListEl.addEventListener('change', function (e) {
    if (e.target.dataset.action !== 'toggleBg') return;
    var id = parseInt(e.target.dataset.id, 10);
    var entry = fileEntries.find(function (item) { return item.id === id; });
    if (!entry) return;

    entry.removeBg = e.target.checked;

    // If already converted, reset so it can be re-converted with the new setting
    if (entry.status === 'done') {
      entry.status = 'pending';
      entry.resultBlob = null;
      if (entry.resultUrl) {
        URL.revokeObjectURL(entry.resultUrl);
        entry.resultUrl = null;
      }
      renderList();
    }
  });

  // ── Drop zone events ─────────────────────────────────────────────────
  dropZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', function () {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });

  dropZone.addEventListener('click', function () {
    fileInput.click();
  });

  browseBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    fileInput.click();
  });

  fileInput.addEventListener('change', function () {
    if (fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = '';
  });

  // ── "Add More" and "Clear All" ───────────────────────────────────────
  addMoreBtn.addEventListener('click', function () { addMoreInput.click(); });
  addMoreInput.addEventListener('change', function () {
    if (addMoreInput.files.length) addFiles(addMoreInput.files);
    addMoreInput.value = '';
  });

  clearAllBtn.addEventListener('click', clearAll);

  // ── Convert All button ───────────────────────────────────────────────
  convertAllBtn.addEventListener('click', function () {
    var allDone = fileEntries.length > 0 &&
                  fileEntries.every(function (e) { return e.status === 'done'; });
    if (allDone) {
      var done = fileEntries.filter(function (e) { return e.status === 'done'; });
      for (var i = 0; i < done.length; i++) {
        (function (entry, delay) {
          setTimeout(function () { downloadEntry(entry); }, delay);
        })(done[i], i * 300);
      }
      showToast('Downloading ' + done.length + ' file' + (done.length !== 1 ? 's' : ''), 'success');
      return;
    }
    convertAll();
  });

  // ── Global drag-and-drop (even when file list is shown) ──────────────
  document.addEventListener('dragover', function (e) { e.preventDefault(); });

  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.target.closest('#dropZone')) return;
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // ── Keyboard shortcut: Escape to go back to hub ──────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !e.target.closest('input')) {
      window.location.href = '/';
    }
  });

})();
