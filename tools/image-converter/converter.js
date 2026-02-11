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

  // ═══════════════════════════════════════════════════════════════════════
  // SMART BACKGROUND REMOVAL
  //
  // Pipeline:
  //   1. Sample background colours from the 4 image edges
  //   2. Compute luminance → Gaussian blur → Sobel edge map
  //   3. Edge-aware BFS from borders:
  //        • background-colour match  → can cross weak/moderate edges
  //        • local-similarity match   → can only cross very weak edges
  //        • strong edge              → always blocks
  //   4. Morphological close to fill tiny mask holes
  //   5. Multi-radius alpha feathering at mask boundary
  //
  // This handles solid, gradient and textured backgrounds of any colour
  // without eating into the subject.
  // ═══════════════════════════════════════════════════════════════════════

  // ── Helper: average colour in a rectangular region ───────────────────
  function averageColorInRect(data, stride, x0, y0, x1, y1) {
    var r = 0, g = 0, b = 0, n = 0;
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var o = (y * stride + x) * 4;
        if (data[o + 3] < 10) continue;
        r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
      }
    }
    if (n === 0) return null;
    return { r: r / n, g: g / n, b: b / n };
  }

  // ── Main entry point ────────────────────────────────────────────────
  function removeBackground(imageData) {
    var data   = imageData.data;
    var width  = imageData.width;
    var height = imageData.height;
    var total  = width * height;

    // ── 1. Sample background colours from the four edges ──────────────
    var BORDER = Math.max(3, Math.min(10,
                   Math.floor(Math.min(width, height) * 0.02)));

    var bgColors = [
      averageColorInRect(data, width, 0, 0, width, BORDER),              // top
      averageColorInRect(data, width, 0, height - BORDER, width, height), // bottom
      averageColorInRect(data, width, 0, 0, BORDER, height),              // left
      averageColorInRect(data, width, width - BORDER, 0, width, height),  // right
    ].filter(Boolean); // drop null (fully-transparent edges)

    // Also add the four corner averages for better gradient coverage
    var CS = Math.max(BORDER, Math.floor(Math.min(width, height) * 0.05));
    var corners = [
      averageColorInRect(data, width, 0, 0, CS, CS),
      averageColorInRect(data, width, width - CS, 0, width, CS),
      averageColorInRect(data, width, 0, height - CS, CS, height),
      averageColorInRect(data, width, width - CS, height - CS, width, height),
    ].filter(Boolean);
    for (var ci = 0; ci < corners.length; ci++) bgColors.push(corners[ci]);

    if (bgColors.length === 0) return imageData; // nothing to do

    // ── 2. Edge map: luminance → blur → Sobel ─────────────────────────
    var lum = new Float32Array(total);
    for (var i = 0; i < total; i++) {
      var o4 = i * 4;
      lum[i] = 0.299 * data[o4] + 0.587 * data[o4 + 1] + 0.114 * data[o4 + 2];
    }

    // 3×3 Gaussian blur (reduces noise + texture so Sobel sees real edges)
    var blurred = new Float32Array(total);
    for (var by = 1; by < height - 1; by++) {
      for (var bx = 1; bx < width - 1; bx++) {
        var bi = by * width + bx;
        blurred[bi] = (
          lum[bi - width - 1]     + 2 * lum[bi - width] + lum[bi - width + 1] +
          2 * lum[bi - 1]         + 4 * lum[bi]          + 2 * lum[bi + 1] +
          lum[bi + width - 1]     + 2 * lum[bi + width]  + lum[bi + width + 1]
        ) / 16;
      }
    }
    // Copy unblurred border rows/columns
    for (var ex = 0; ex < width; ex++) {
      blurred[ex] = lum[ex];
      blurred[(height - 1) * width + ex] = lum[(height - 1) * width + ex];
    }
    for (var ey = 0; ey < height; ey++) {
      blurred[ey * width] = lum[ey * width];
      blurred[ey * width + width - 1] = lum[ey * width + width - 1];
    }

    // Sobel gradient magnitude  (reuse `lum` array to store edges)
    var edges = lum; // alias — lum is no longer needed
    for (var si = 0; si < total; si++) edges[si] = 0; // clear
    for (var sy = 1; sy < height - 1; sy++) {
      for (var sx = 1; sx < width - 1; sx++) {
        var idx = sy * width + sx;
        var tl = blurred[idx - width - 1], tc = blurred[idx - width], tr = blurred[idx - width + 1];
        var ml = blurred[idx - 1],                                     mr = blurred[idx + 1];
        var bl = blurred[idx + width - 1], bc = blurred[idx + width], br = blurred[idx + width + 1];
        var gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
        var gy = -tl - 2 * tc - tr  + bl + 2 * bc + br;
        edges[idx] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    blurred = null; // allow GC

    // ── 3. Edge-aware BFS from image borders ──────────────────────────
    var visited = new Uint8Array(total); // 0=unvisited, 1=background
    var queue   = new Int32Array(total);
    var qHead   = 0, qTail = 0;

    // Thresholds (squared where applicable for speed)
    var BG_TOL_SQ    = 70 * 70;   // match any sampled background colour
    var LOCAL_TOL_SQ = 35 * 35;   // match immediate neighbour
    var EDGE_HARD    = 80;        // never cross
    var EDGE_SOFT    = 25;        // local-similarity only below this

    // -- Does pixel i match any background colour? --
    function matchesBg(pi) {
      var po = pi * 4;
      var pr = data[po], pg = data[po + 1], pb = data[po + 2];
      for (var k = 0; k < bgColors.length; k++) {
        var dr = pr - bgColors[k].r;
        var dg = pg - bgColors[k].g;
        var db = pb - bgColors[k].b;
        if (dr * dr + dg * dg + db * db < BG_TOL_SQ) return true;
      }
      return false;
    }

    // -- Are two pixels locally similar? --
    function localSimilar(a, b) {
      var oa = a * 4, ob = b * 4;
      var dr = data[oa] - data[ob];
      var dg = data[oa + 1] - data[ob + 1];
      var db = data[oa + 2] - data[ob + 2];
      return (dr * dr + dg * dg + db * db) < LOCAL_TOL_SQ;
    }

    // -- Attempt to expand from pixel `from` into pixel `ni` --
    function tryExpand(from, ni) {
      if (visited[ni]) return;
      if (data[ni * 4 + 3] < 10) { visited[ni] = 1; return; } // already transparent

      var e = edges[ni];
      if (e >= EDGE_HARD) return;                      // hard edge — never cross

      if (matchesBg(ni)) {                             // bg-colour match → cross moderate edges
        visited[ni] = 1;
        queue[qTail++] = ni;
      } else if (e < EDGE_SOFT && localSimilar(from, ni)) { // gradient follow → weak edges only
        visited[ni] = 1;
        queue[qTail++] = ni;
      }
    }

    // Seed: border pixels that look like background
    for (var tx = 0; tx < width; tx++) {
      var t = tx;
      if (data[t * 4 + 3] >= 10 && matchesBg(t)) { visited[t] = 1; queue[qTail++] = t; }
      t = (height - 1) * width + tx;
      if (!visited[t] && data[t * 4 + 3] >= 10 && matchesBg(t)) { visited[t] = 1; queue[qTail++] = t; }
    }
    for (var ty = 1; ty < height - 1; ty++) {
      var tl2 = ty * width;
      if (!visited[tl2] && data[tl2 * 4 + 3] >= 10 && matchesBg(tl2)) { visited[tl2] = 1; queue[qTail++] = tl2; }
      var tr2 = ty * width + width - 1;
      if (!visited[tr2] && data[tr2 * 4 + 3] >= 10 && matchesBg(tr2)) { visited[tr2] = 1; queue[qTail++] = tr2; }
    }

    // Run BFS
    while (qHead < qTail) {
      var cur = queue[qHead++];
      var cx  = cur % width;
      var cy  = (cur - cx) / width;

      // Make background pixel transparent
      data[cur * 4 + 3] = 0;

      // Expand into 4-connected neighbours
      if (cx > 0)            tryExpand(cur, cur - 1);
      if (cx < width - 1)    tryExpand(cur, cur + 1);
      if (cy > 0)            tryExpand(cur, cur - width);
      if (cy < height - 1)   tryExpand(cur, cur + width);
    }

    // ── 4. Mask cleanup ────────────────────────────────────────────────
    //    a) Morphological close: fills tiny 1-2px holes in the mask
    //    b) Fringe expansion: grow the mask by 1px to eat the anti-alias
    //       halo that the original image baked against its background
    var mask = visited; // 1 = background (removed)

    // 4a — Close: dilate then erode to fill small holes
    var dilated = new Uint8Array(total);
    for (var dy = 1; dy < height - 1; dy++) {
      for (var dx = 1; dx < width - 1; dx++) {
        var di = dy * width + dx;
        if (mask[di]) { dilated[di] = 1; continue; }
        var nb = mask[di - 1] + mask[di + 1] + mask[di - width] + mask[di + width];
        if (nb >= 3) dilated[di] = 1;
      }
    }
    for (var ery = 1; ery < height - 1; ery++) {
      for (var erx = 1; erx < width - 1; erx++) {
        var ei = ery * width + erx;
        if (!dilated[ei]) continue;
        if (mask[ei]) continue;
        var enb = dilated[ei - 1] + dilated[ei + 1] + dilated[ei - width] + dilated[ei + width];
        if (enb >= 3) { data[ei * 4 + 3] = 0; mask[ei] = 1; }
      }
    }

    // 4b — Fringe expansion: any non-mask pixel directly adjacent to
    //       the mask gets absorbed if it's still somewhat close to the
    //       background color (the anti-alias fringe zone).
    var fringe = new Uint8Array(total);
    var FRINGE_TOL_SQ = 110 * 110; // generous — fringe pixels are blends
    for (var fey = 1; fey < height - 1; fey++) {
      for (var fex = 1; fex < width - 1; fex++) {
        var fi2 = fey * width + fex;
        if (mask[fi2]) continue;
        if (data[fi2 * 4 + 3] < 10) continue;
        // Is it on the mask boundary?
        if (!mask[fi2 - 1] && !mask[fi2 + 1] && !mask[fi2 - width] && !mask[fi2 + width]) continue;
        // Check if colour is between subject and background (fringe)
        var fo = fi2 * 4;
        var fr = data[fo], fg = data[fo + 1], fb = data[fo + 2];
        var isFringe = false;
        for (var fk = 0; fk < bgColors.length; fk++) {
          var fdr = fr - bgColors[fk].r;
          var fdg = fg - bgColors[fk].g;
          var fdb = fb - bgColors[fk].b;
          if (fdr * fdr + fdg * fdg + fdb * fdb < FRINGE_TOL_SQ) { isFringe = true; break; }
        }
        if (isFringe) fringe[fi2] = 1;
      }
    }
    // Apply fringe removal
    for (var fri = 0; fri < total; fri++) {
      if (fringe[fri]) { data[fri * 4 + 3] = 0; mask[fri] = 1; }
    }

    // ── 5. Color decontamination ────────────────────────────────────
    //    Edge pixels in the original image were anti-aliased against the
    //    background, so their RGB is a blend of subject + bg colour.
    //    We estimate the bg contribution and subtract it so the cutout
    //    looks clean against any new background.
    //
    //    Formula: assuming original pixel = α·fg + (1−α)·bg
    //    where α is the "true" foreground fraction estimated from
    //    neighbourhood context. We solve for fg:
    //       fg = (pixel − (1−α)·bg) / α   [clamped to 0–255]

    // Compute the overall average background colour for decontamination
    var avgBgR = 0, avgBgG = 0, avgBgB = 0;
    for (var bci = 0; bci < bgColors.length; bci++) {
      avgBgR += bgColors[bci].r; avgBgG += bgColors[bci].g; avgBgB += bgColors[bci].b;
    }
    avgBgR /= bgColors.length; avgBgG /= bgColors.length; avgBgB /= bgColors.length;

    for (var dcy = 1; dcy < height - 1; dcy++) {
      for (var dcx = 1; dcx < width - 1; dcx++) {
        var dci = dcy * width + dcx;
        if (mask[dci]) continue;
        var dco = dci * 4;
        if (data[dco + 3] < 10) continue;

        // Count removed neighbours in 3×3 to detect boundary pixels
        var dcRemoved = 0;
        for (var dky = -1; dky <= 1; dky++) {
          for (var dkx = -1; dkx <= 1; dkx++) {
            if (dkx === 0 && dky === 0) continue;
            if (mask[(dcy + dky) * width + (dcx + dkx)]) dcRemoved++;
          }
        }
        if (dcRemoved === 0) continue; // interior pixel — skip

        // Estimate foreground fraction: more bg neighbours → more contaminated
        var fgFrac = 1.0 - (dcRemoved / 8) * 0.7; // keep at least 0.3
        if (fgFrac < 0.3) fgFrac = 0.3;

        // Decontaminate RGB
        var invFg = 1.0 / fgFrac;
        var bgContrib = 1.0 - fgFrac;
        data[dco]     = Math.max(0, Math.min(255, Math.round((data[dco]     - bgContrib * avgBgR) * invFg)));
        data[dco + 1] = Math.max(0, Math.min(255, Math.round((data[dco + 1] - bgContrib * avgBgG) * invFg)));
        data[dco + 2] = Math.max(0, Math.min(255, Math.round((data[dco + 2] - bgContrib * avgBgB) * invFg)));

        // Also reduce alpha proportionally
        data[dco + 3] = Math.max(0, Math.round(data[dco + 3] * fgFrac));
      }
    }

    // ── 6. Smooth alpha feathering ──────────────────────────────────
    //    Final pass: gentle alpha fade on any remaining boundary pixels
    //    using a 5×5 neighbourhood ratio.
    for (var fy = 2; fy < height - 2; fy++) {
      for (var fx = 2; fx < width - 2; fx++) {
        var fi = fy * width + fx;
        if (mask[fi]) continue;
        var foff = fi * 4;
        if (data[foff + 3] < 5) continue;

        var fremoved = 0, fneighbours = 0;
        for (var fky = -2; fky <= 2; fky++) {
          for (var fkx = -2; fkx <= 2; fkx++) {
            if (fkx === 0 && fky === 0) continue;
            fneighbours++;
            if (mask[(fy + fky) * width + (fx + fkx)]) fremoved++;
          }
        }
        if (fremoved === 0) continue;

        var fRatio = fremoved / fneighbours;
        var fMul;
        if (fRatio > 0.65)      fMul = 0.0;  // nearly surrounded → remove
        else if (fRatio > 0.45) fMul = 0.2;
        else if (fRatio > 0.3)  fMul = 0.45;
        else if (fRatio > 0.15) fMul = 0.7;
        else continue;

        data[foff + 3] = Math.round(data[foff + 3] * fMul);
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
            '<label class="remove-bg-toggle" title="Detect subject and remove background">' +
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
