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
  const productNameRow  = document.getElementById('productNameRow');
  const productNameInput = document.getElementById('productNameInput');
  const aiModelStatusEl = document.getElementById('aiModelStatus');
  const aiStatusLabel   = document.getElementById('aiStatusLabel');
  const aiStatusPct     = document.getElementById('aiStatusPct');
  const aiProgressFill  = document.getElementById('aiProgressFill');
  const settingsToggle  = document.getElementById('settingsToggle');
  const aiSettingsPanel = document.getElementById('aiSettingsPanel');
  const geminiApiKeyInput = document.getElementById('geminiApiKeyInput');
  const apiKeyStatus    = document.getElementById('apiKeyStatus');

  // Hidden input for "Add More" button
  const addMoreInput = document.createElement('input');
  addMoreInput.type = 'file';
  addMoreInput.multiple = true;
  addMoreInput.accept = fileInput.accept;

  // ── State ─────────────────────────────────────────────────────────────
  let fileEntries = []; // { id, file, removeBg, status, objectUrl, resultUrl, resultBlob, description, descriptionSource }
  let nextId = 0;
  let productName = '';          // batch-level product name for all files
  let segmenter = null;          // lazy-loaded Transformers.js RMBG pipeline
  let modelLoading = false;      // prevent concurrent init
  let classifier = null;         // lazy-loaded CLIP pipeline for angle detection
  let classifierLoading = false; // prevent concurrent CLIP init
  let progressBarInUse = false;  // semaphore for shared model status bar
  let geminiApiKey = localStorage.getItem('tns-gemini-api-key') || '';

  // ── Angle detection constants ──────────────────────────────────────
  var ANGLE_LABELS = [
    // Direct / flat views (camera perpendicular to one face)
    'a flat straight-on photo showing only the front of a product',
    'a flat straight-on photo showing only the side of a product',
    'a flat straight-on photo showing only the back of a product',
    'a flat straight-on photo showing only the top of a product',
    'a flat straight-on photo showing only the bottom of a product',
    // Angled / perspective views (main face visible but at an angle)
    'a perspective photo of a product at an angle with the front side prominent',
    'a perspective photo of a product at an angle with the side prominent',
    'a perspective photo of a product at an angle with the back side prominent',
    'a perspective photo of a product at an angle with the top side prominent',
    'a perspective photo of a product at an angle with the bottom side prominent',
    // Special categories
    'a close-up detail photo showing a specific feature of a product',
    'a photo of a remote control device',
    'a lifestyle photo of a product being used in a real environment or room',
  ];

  var LABEL_TO_DUTCH = {
    // Direct / flat views
    'a flat straight-on photo showing only the front of a product':             'voorkant',
    'a flat straight-on photo showing only the side of a product':              'zijkant',
    'a flat straight-on photo showing only the back of a product':              'achterkant',
    'a flat straight-on photo showing only the top of a product':               'bovenkant',
    'a flat straight-on photo showing only the bottom of a product':            'onderkant',
    // Angled / perspective views
    'a perspective photo of a product at an angle with the front side prominent': 'vooraanzicht',
    'a perspective photo of a product at an angle with the side prominent':       'zijaanzicht',
    'a perspective photo of a product at an angle with the back side prominent':  'achterzijde',
    'a perspective photo of a product at an angle with the top side prominent':   'bovenzijde',
    'a perspective photo of a product at an angle with the bottom side prominent':'onderzijde',
    // Special categories
    'a close-up detail photo showing a specific feature of a product':           'detail',
    'a photo of a remote control device':                                        'afstandsbediening',
    'a lifestyle photo of a product being used in a real environment or room':    'scenario',
  };

  var ANGLE_CONFIDENCE_THRESHOLD = 0.20;

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

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function sanitizeFilename(name) {
    var cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    if (cleaned.length > 200) cleaned = cleaned.substring(0, 200).trim();
    return cleaned;
  }

  function buildFilename(entry) {
    var name = productName.trim();
    var desc = entry.description.trim();
    if (name && desc) return sanitizeFilename(name + ' ' + desc) + '.png';
    if (name) return sanitizeFilename(name) + '.png';
    if (desc) return sanitizeFilename(desc) + '.png';
    return entry.file.name.replace(/\.[^.]+$/, '') + '.png';
  }

  function getDeduplicatedFilename(entry, allEntries) {
    var base = buildFilename(entry);
    var baseName = base.replace(/\.png$/, '');
    var count = 0;
    for (var i = 0; i < allEntries.length; i++) {
      if (allEntries[i].id === entry.id) break;
      if (buildFilename(allEntries[i]).replace(/\.png$/, '') === baseName) count++;
    }
    if (count === 0) return base;
    return baseName + ' ' + (count + 1) + '.png';
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

  // ── Check whether an image file already has a transparency layer ─────
  function imageHasTransparency(file) {
    return new Promise(function (resolve) {
      if (file.type === 'image/svg+xml') { resolve(true); return; }

      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var tc = document.createElement('canvas');
        var tctx = tc.getContext('2d', { willReadFrequently: true });
        tc.width = img.naturalWidth;
        tc.height = img.naturalHeight;
        tctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);

        var data = tctx.getImageData(0, 0, tc.width, tc.height).data;
        var total = data.length / 4;
        var step = Math.max(1, Math.floor(total / 50000));
        var transparentCount = 0;
        var sampledCount = 0;

        for (var i = 0; i < total; i += step) {
          sampledCount++;
          if (data[i * 4 + 3] < 250) transparentCount++;
        }

        resolve(transparentCount / sampledCount > 0.005);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(false);
      };
      img.src = url;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AI BACKGROUND REMOVAL (Transformers.js + RMBG-1.4)
  // Lazy-loaded on first use. Model is cached in browser after download.
  // ═══════════════════════════════════════════════════════════════════════

  function showModelProgress(visible) {
    aiModelStatusEl.style.display = visible ? '' : 'none';
  }

  function updateModelProgress(pct, label) {
    aiStatusLabel.textContent = label;
    aiStatusPct.textContent = pct + '%';
    aiProgressFill.style.width = pct + '%';
  }

  function waitForProgressBar() {
    return new Promise(function (resolve) {
      (function check() {
        if (!progressBarInUse) { resolve(); return; }
        setTimeout(check, 300);
      })();
    });
  }

  async function getSegmenter() {
    if (segmenter) return segmenter;
    if (modelLoading) {
      return new Promise(function (resolve, reject) {
        var check = setInterval(function () {
          if (segmenter) { clearInterval(check); resolve(segmenter); }
          if (!modelLoading) { clearInterval(check); reject(new Error('Model loading failed')); }
        }, 200);
      });
    }

    modelLoading = true;
    await waitForProgressBar();
    progressBarInUse = true;
    showModelProgress(true);
    updateModelProgress(0, 'Loading background removal model\u2026');

    try {
      var mod = await import(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1'
      );
      var pipeline = mod.pipeline;
      var env = mod.env;
      env.allowLocalModels = false;

      var downloadTracker = {};

      segmenter = await pipeline('background-removal', 'briaai/RMBG-1.4', {
        progress_callback: function (info) {
          if (!info || !info.status) return;

          if (info.status === 'progress' && info.file) {
            downloadTracker[info.file] = {
              loaded: info.loaded || 0,
              total: info.total || 1,
            };
            var totalLoaded = 0, totalSize = 0;
            for (var key in downloadTracker) {
              totalLoaded += downloadTracker[key].loaded;
              totalSize += downloadTracker[key].total;
            }
            var pct = totalSize > 0 ? Math.round((totalLoaded / totalSize) * 100) : 0;
            updateModelProgress(pct, 'Downloading background removal model\u2026');
          } else if (info.status === 'ready') {
            updateModelProgress(100, 'Background removal model ready');
            setTimeout(function () { showModelProgress(false); }, 1500);
          }
        },
      });

      modelLoading = false;
      progressBarInUse = false;
      return segmenter;
    } catch (err) {
      modelLoading = false;
      progressBarInUse = false;
      segmenter = null;
      showModelProgress(false);
      throw err;
    }
  }

  async function aiRemoveBackground(entry, img) {
    var seg = await getSegmenter();
    var result = await seg(entry.file);
    var aiImage = Array.isArray(result) ? result[0] : result;

    // Draw original image at full resolution
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    // Get the AI mask, scaled to match original dimensions
    var maskCanvas = aiImage.toCanvas();
    var tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    var tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
    var maskData = tempCtx.getImageData(0, 0, canvas.width, canvas.height);

    // Apply the AI-generated alpha mask to the full-res original
    var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var src = imageData.data;
    var mask = maskData.data;
    for (var i = 3; i < src.length; i += 4) {
      src[i] = mask[i]; // copy alpha channel from AI mask
    }
    ctx.putImageData(imageData, 0, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AI ANGLE DETECTION (Transformers.js + CLIP)
  // Classifies product photos by viewing angle, maps to Dutch terms.
  // ═══════════════════════════════════════════════════════════════════════

  async function getClassifier() {
    if (classifier) return classifier;
    if (classifierLoading) {
      return new Promise(function (resolve, reject) {
        var check = setInterval(function () {
          if (classifier) { clearInterval(check); resolve(classifier); }
          if (!classifierLoading) { clearInterval(check); reject(new Error('Classifier loading failed')); }
        }, 200);
      });
    }

    classifierLoading = true;
    await waitForProgressBar();
    progressBarInUse = true;
    showModelProgress(true);
    updateModelProgress(0, 'Loading angle detection model\u2026');

    try {
      var mod = await import(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1'
      );
      var pipelineFn = mod.pipeline;
      var env = mod.env;
      env.allowLocalModels = false;

      var downloadTracker = {};

      classifier = await pipelineFn('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', {
        dtype: 'q8',
        progress_callback: function (info) {
          if (!info || !info.status) return;
          if (info.status === 'progress' && info.file) {
            downloadTracker[info.file] = { loaded: info.loaded || 0, total: info.total || 1 };
            var totalLoaded = 0, totalSize = 0;
            for (var key in downloadTracker) {
              totalLoaded += downloadTracker[key].loaded;
              totalSize += downloadTracker[key].total;
            }
            var pct = totalSize > 0 ? Math.round((totalLoaded / totalSize) * 100) : 0;
            updateModelProgress(pct, 'Downloading angle detection model\u2026');
          } else if (info.status === 'ready') {
            updateModelProgress(100, 'Angle detection model ready');
            setTimeout(function () { showModelProgress(false); }, 1500);
          }
        },
      });

      classifierLoading = false;
      progressBarInUse = false;
      return classifier;
    } catch (err) {
      classifierLoading = false;
      progressBarInUse = false;
      classifier = null;
      showModelProgress(false);
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AI ANGLE DETECTION — GEMINI 2.5 FLASH (primary, requires API key)
  // ═══════════════════════════════════════════════════════════════════════

  var VALID_DESCRIPTIONS = [
    'voorkant', 'vooraanzicht', 'zijkant', 'zijaanzicht',
    'achterkant', 'achterzijde', 'bovenkant', 'bovenzijde',
    'onderkant', 'onderzijde', 'detail', 'afstandsbediening', 'scenario',
  ];

  var GEMINI_PROMPT = [
    'You are classifying product photography for an e-commerce catalog.',
    '',
    'Follow these steps internally before answering:',
    '',
    'STEP 1 — Is this a special category?',
    '  - Is the main subject a handheld remote control (small device with buttons, NOT the main product)? → afstandsbediening',
    '  - Is the product shown installed/in-use in a real room or environment? → scenario',
    '  - Is this an extreme close-up of one small feature (a single port, button, label, vent)? → detail',
    '  - If none of the above, continue to step 2.',
    '',
    'STEP 2 — Where is the CAMERA physically positioned?',
    '  Imagine you are the photographer. Where are you standing/holding the camera relative to the product?',
    '  - ABOVE the product, looking DOWN at it → the top surface (housing, vents, top panel) dominates',
    '  - IN FRONT of the product → the front surface (display, lens, front panel) dominates',
    '  - BEHIND the product → the rear surface (ports, connectors, back panel) dominates',
    '  - TO THE SIDE of the product → the side surface dominates',
    '  - BELOW the product, looking UP → the bottom surface (feet, base, screws) dominates',
    '',
    'STEP 3 — Is the view straight-on or angled?',
    '  - If ONLY ONE surface is visible (flat, no perspective/depth) → straight-on ("-kant")',
    '  - If ONE surface is DOMINANT but you can also see a second surface → angled ("-aanzicht" or "-zijde")',
    '',
    'MAPPING:',
    '  Camera above + straight-on → bovenkant',
    '  Camera above + angled → bovenzijde',
    '  Camera in front + straight-on → voorkant',
    '  Camera in front + angled → vooraanzicht',
    '  Camera to side + straight-on → zijkant',
    '  Camera to side + angled → zijaanzicht',
    '  Camera behind + straight-on → achterkant',
    '  Camera behind + angled → achterzijde',
    '  Camera below + straight-on → onderkant',
    '  Camera below + angled → onderzijde',
    '',
    'IMPORTANT:',
    '- The LARGEST visible surface determines camera position. Ignore small protruding features (lenses, knobs, logos).',
    '- A product photographed from above shows its top housing/panel as the largest area — that is bovenkant/bovenzijde, even if the front edge or lens is partially visible.',
    '',
    'Respond with ONLY the single category name, nothing else.',
  ].join('\n');

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        // result is "data:<mime>;base64,<data>" — extract the base64 part
        resolve(reader.result.split(',')[1]);
      };
      reader.onerror = function () { reject(new Error('Failed to read file')); };
      reader.readAsDataURL(file);
    });
  }

  async function detectAngleGemini(entry) {
    var base64 = await fileToBase64(entry.file);
    var mimeType = entry.file.type || 'image/jpeg';

    var response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(geminiApiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: GEMINI_PROMPT },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 256,
          },
        }),
      }
    );

    if (!response.ok) {
      var errBody = await response.text().catch(function () { return ''; });
      throw new Error('Gemini API error ' + response.status + ': ' + errBody);
    }

    var data = await response.json();
    console.log('[Gemini] Raw response for', entry.file.name, data);

    var text = '';
    if (data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts) {
      // Gemini 2.5 Flash is a thinking model — response may contain thought
      // parts (thought: true) alongside the actual answer. We only want the
      // non-thought text part.
      var parts = data.candidates[0].content.parts;
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i].thought && parts[i].text) {
          text = parts[i].text.trim().toLowerCase();
        }
      }
    }

    console.log('[Gemini] Parsed label for', entry.file.name, '→', JSON.stringify(text));

    // Validate the response is one of our valid descriptions
    if (VALID_DESCRIPTIONS.indexOf(text) !== -1) {
      return text;
    }

    // Try to match partial / fuzzy (in case Gemini adds punctuation or extra text)
    for (var i = 0; i < VALID_DESCRIPTIONS.length; i++) {
      if (text.indexOf(VALID_DESCRIPTIONS[i]) !== -1) {
        return VALID_DESCRIPTIONS[i];
      }
    }

    console.warn('[Gemini] Unrecognised response for', entry.file.name, '→', JSON.stringify(text), '— falling back to detail');
    return 'detail'; // fallback
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ANGLE DETECTION DISPATCHER — tries Gemini first, falls back to CLIP
  // ═══════════════════════════════════════════════════════════════════════

  async function detectAngle(entry) {
    if (entry.descriptionSource === 'user') return;

    // Try Gemini first if API key is available
    if (geminiApiKey) {
      try {
        console.log('[Gemini] Detecting angle for', entry.file.name);
        if (!fileEntries.find(function (e) { return e.id === entry.id; })) return;
        var result = await detectAngleGemini(entry);
        if (!fileEntries.find(function (e) { return e.id === entry.id; })) return;
        if (entry.descriptionSource === 'user') return;

        console.log('[Gemini] Result for', entry.file.name, '→', result);
        entry.description = result;
        entry.descriptionSource = 'ai';
        renderList();
        return;
      } catch (err) {
        console.warn('[Gemini] Failed for', entry.file.name, '— falling back to CLIP:', err);
      }
    } else {
      console.log('[Angle] No Gemini API key, using CLIP for', entry.file.name);
    }

    // Fallback: CLIP zero-shot classification
    try {
      var cls = await getClassifier();
      if (!fileEntries.find(function (e) { return e.id === entry.id; })) return;
      var results = await cls(entry.objectUrl, ANGLE_LABELS);
      if (!fileEntries.find(function (e) { return e.id === entry.id; })) return;
      if (entry.descriptionSource === 'user') return;

      if (results.length > 0 && results[0].score >= ANGLE_CONFIDENCE_THRESHOLD) {
        entry.description = LABEL_TO_DUTCH[results[0].label] || 'detail';
      } else {
        entry.description = 'detail';
      }
      entry.descriptionSource = 'ai';
    } catch (err) {
      console.warn('CLIP angle detection failed for', entry.file.name, err);
      if (entry.descriptionSource !== 'user') {
        entry.description = 'detail';
        entry.descriptionSource = 'ai';
      }
    }
    renderList();
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

      if (entry.removeBg) {
        await aiRemoveBackground(entry, img);
      }

      URL.revokeObjectURL(url);

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
  function downloadEntry(entry, allEntries) {
    if (!entry.resultBlob) return;
    var filename = allEntries
      ? getDeduplicatedFilename(entry, allEntries)
      : buildFilename(entry);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(entry.resultBlob);
    a.download = filename;
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
      downloadEntry(done[0], done);
      showToast('Image converted and downloaded', 'success');
    } else {
      for (let i = 0; i < done.length; i++) {
        (function (entry, delay) {
          setTimeout(function () { downloadEntry(entry, done); }, delay);
        })(done[i], i * 300);
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
    const newEntries = [];
    for (const file of files) {
      if (!validTypes.includes(file.type)) continue;
      const entry = {
        id: nextId++,
        file,
        removeBg: true,
        status: 'pending',
        objectUrl: URL.createObjectURL(file),
        resultUrl: null,
        resultBlob: null,
        description: '',
        descriptionSource: 'none',
      };
      fileEntries.push(entry);
      newEntries.push(entry);
      added++;
    }

    if (added === 0 && files.length > 0) {
      showToast('No supported image files found', 'error');
    }

    renderList();

    // Auto-disable background removal for images that already have transparency
    for (const entry of newEntries) {
      imageHasTransparency(entry.file).then(function (hasAlpha) {
        if (hasAlpha && entry.status === 'pending' && !entry._userToggled) {
          entry.removeBg = false;
          renderList();
        }
      });
    }

    // Auto-detect product angles via AI
    for (const entry of newEntries) {
      detectAngle(entry);
    }
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
    productName = '';
    productNameInput.value = '';
    renderList();
  }

  // ── Render the file list UI ──────────────────────────────────────────
  function renderList() {
    const hasFiles = fileEntries.length > 0;
    fileListSection.style.display = hasFiles ? '' : 'none';
    convertBar.style.display     = hasFiles ? '' : 'none';
    dropZone.style.display       = hasFiles ? 'none' : '';
    productNameRow.style.display = hasFiles ? '' : 'none';

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
        processing: entry.removeBg ? 'AI processing\u2026' : 'Converting\u2026',
        done: 'Done',
        error: 'Error',
      }[entry.status];

      var statusClass = entry.status;
      if (entry.status === 'processing' && entry.removeBg) {
        statusClass = 'ai-processing';
      }

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
            '<div class="file-name" title="' + escapeAttr(entry.file.name) + '">' + escapeHtml(entry.file.name) + '</div>' +
            '<div class="file-meta">' +
              '<span>' + formatBytes(entry.file.size) + '</span>' +
              '<span>' + entry.file.type.split('/')[1].toUpperCase() + '</span>' +
              '<span class="status-badge ' + statusClass + '">' + statusLabel + '</span>' +
            '</div>' +
            '<div class="file-description">' +
              '<input type="text" class="description-input" ' +
                'data-action="editDescription" data-id="' + entry.id + '" ' +
                'value="' + escapeAttr(entry.description) + '" ' +
                'placeholder="' + (entry.descriptionSource === 'none' && entry.description === '' ? 'Detecting angle\u2026' : 'Add description\u2026') + '"' +
                (entry.status === 'processing' ? ' disabled' : '') + '>' +
              (entry.descriptionSource === 'ai'
                ? '<span class="description-ai-badge" title="AI-generated">AI</span>'
                : '') +
            '</div>' +
            '<div class="filename-preview" title="Download filename">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
                '<polyline points="14 2 14 8 20 8"/>' +
              '</svg>' +
              '<span class="filename-preview-text">' + escapeHtml(buildFilename(entry)) + '</span>' +
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
    entry._userToggled = true;

    // If already converted, reset so it can be re-converted with the new setting
    if (entry.status === 'done') {
      entry.status = 'pending';
      entry.resultBlob = null;
      if (entry.resultUrl) {
        URL.revokeObjectURL(entry.resultUrl);
        entry.resultUrl = null;
      }
    }
    renderList();
  });

  // ── Description input (delegated, targeted update to avoid losing focus)
  fileListEl.addEventListener('input', function (e) {
    if (!e.target.classList.contains('description-input')) return;
    var id = parseInt(e.target.dataset.id, 10);
    var entry = fileEntries.find(function (item) { return item.id === id; });
    if (!entry) return;

    entry.description = e.target.value;
    entry.descriptionSource = e.target.value.trim() ? 'user' : 'none';

    // Update only the filename preview for this row (not a full re-render)
    var fileItem = e.target.closest('.file-item');
    if (fileItem) {
      var preview = fileItem.querySelector('.filename-preview-text');
      if (preview) preview.textContent = buildFilename(entry);
      // Hide/show AI badge
      var badge = fileItem.querySelector('.description-ai-badge');
      if (badge) badge.remove();
    }
  });

  // ── Product name input ────────────────────────────────────────────
  productNameInput.addEventListener('input', function () {
    productName = productNameInput.value;
    // Update all filename previews without full re-render
    document.querySelectorAll('.file-item').forEach(function (el) {
      var id = parseInt(el.dataset.id, 10);
      var entry = fileEntries.find(function (e) { return e.id === id; });
      if (entry) {
        var preview = el.querySelector('.filename-preview-text');
        if (preview) preview.textContent = buildFilename(entry);
      }
    });
  });

  // ── Settings panel toggle ────────────────────────────────────────────
  settingsToggle.addEventListener('click', function () {
    var visible = aiSettingsPanel.style.display !== 'none';
    aiSettingsPanel.style.display = visible ? 'none' : '';
    settingsToggle.classList.toggle('active', !visible);
  });

  // ── Gemini API key input ───────────────────────────────────────────
  // Initialize UI from stored key
  if (geminiApiKey) {
    geminiApiKeyInput.value = geminiApiKey;
    apiKeyStatus.textContent = 'Saved';
    apiKeyStatus.className = 'api-key-status saved';
  }

  geminiApiKeyInput.addEventListener('input', function () {
    geminiApiKey = geminiApiKeyInput.value.trim();
    if (geminiApiKey) {
      localStorage.setItem('tns-gemini-api-key', geminiApiKey);
      apiKeyStatus.textContent = 'Saved';
      apiKeyStatus.className = 'api-key-status saved';
    } else {
      localStorage.removeItem('tns-gemini-api-key');
      apiKeyStatus.textContent = '';
      apiKeyStatus.className = 'api-key-status';
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
          setTimeout(function () { downloadEntry(entry, done); }, delay);
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
