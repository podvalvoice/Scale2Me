(function () {
  'use strict';

  /* ---------- constants -------------------------------------------- */

  const MAX_OUTPUT_PIXELS = 28000000; // safety budget for memory/time in-browser
  const MAX_DIMENSION = 10000;        // stays safely under browser canvas limits

  /* ---------- theme toggle -------------------------------------------- */

  const THEME_KEY = 'scale2me-theme';
  const themeToggle = document.getElementById('themeToggle');

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    if (themeToggle) {
      themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
      themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
    }
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode etc. — ignore */ }
  }

  if (themeToggle) {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
    themeToggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });
  }

  /* ---------- hero compare slider (decorative demo) ------------------ */

  const heroSlider = document.getElementById('heroSlider');
  const heroCompare = document.getElementById('heroCompare');
  if (heroSlider && heroCompare) {
    const afterWrap = heroCompare.querySelector('.after-wrap');
    const handle = heroCompare.querySelector('.handle');
    const update = () => {
      const v = heroSlider.value;
      afterWrap.style.clipPath = `inset(0 0 0 ${v}%)`;
      handle.style.left = v + '%';
    };
    heroSlider.addEventListener('input', update);
    update();
  }

  /* ---------- state ---------------------------------------------------- */

  let sourceImage = null;   // HTMLImageElement
  let sourceW = 0, sourceH = 0;
  let currentScale = 2;
  let worker = null;

  /* ---------- element refs --------------------------------------------- */

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const fileRow = document.getElementById('fileRow');
  const thumb = document.getElementById('thumb');
  const fileName = document.getElementById('fileName');
  const fileDims = document.getElementById('fileDims');
  const clearFileBtn = document.getElementById('clearFile');

  const zoomOpts = Array.from(document.querySelectorAll('.zoom-opt'));
  const customWrap = document.getElementById('customWrap');
  const customRadio = document.getElementById('customRadio');
  const customInput = document.getElementById('customInput');

  const roSrc = document.getElementById('roSrc');
  const roDst = document.getElementById('roDst');
  const roMp = document.getElementById('roMp');
  const roScale = document.getElementById('roScale');
  const clampNote = document.getElementById('clampNote');

  const sharpenRange = document.getElementById('sharpenRange');
  const sharpenVal = document.getElementById('sharpenVal');
  const denoiseToggle = document.getElementById('denoiseToggle');
  const formatChips = Array.from(document.querySelectorAll('input[name="format"]'));
  const qualityBlock = document.getElementById('qualityBlock');
  const qualityRange = document.getElementById('qualityRange');
  const qualityVal = document.getElementById('qualityVal');

  const processBtn = document.getElementById('processBtn');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const statusLine = document.getElementById('statusLine');
  const statusText = document.getElementById('statusText');
  const statusPct = document.getElementById('statusPct');
  const stage = document.getElementById('stage');
  const resultCanvas = document.getElementById('resultCanvas');
  const resultActions = document.getElementById('resultActions');
  const downloadBtn = document.getElementById('downloadBtn');
  const againBtn = document.getElementById('againBtn');

  /* ---------- file loading --------------------------------------------- */

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      sourceImage = img;
      sourceW = img.naturalWidth;
      sourceH = img.naturalHeight;

      thumb.src = url;
      fileName.textContent = file.name;
      fileDims.textContent = `${sourceW}×${sourceH} px · ${humanSize(file.size)}`;
      fileRow.style.display = 'flex';
      dropzone.style.display = 'none';

      processBtn.disabled = false;
      processBtn.textContent = 'Обработать';
      resetResult();
      updateReadout();
    };
    img.onerror = () => {
      alert('Не удалось прочитать это изображение. Попробуйте другой файл.');
    };
    img.src = url;
  }

  dropzone.addEventListener('click', (e) => {
    if (e.target === fileInput) return; // avoid re-triggering from the input's own bubbled click
    fileInput.click();
  });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add('drag');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove('drag');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  clearFileBtn.addEventListener('click', () => {
    sourceImage = null;
    sourceW = 0; sourceH = 0;
    fileInput.value = '';
    fileRow.style.display = 'none';
    dropzone.style.display = 'block';
    processBtn.disabled = true;
    processBtn.textContent = 'Загрузите фото, чтобы начать';
    resetResult();
    updateReadout();
  });

  /* ---------- scale selector -------------------------------------------- */

  zoomOpts.forEach((opt) => {
    opt.addEventListener('click', () => {
      zoomOpts.forEach((o) => o.classList.remove('active'));
      opt.classList.add('active');
      customWrap.classList.remove('active');
      currentScale = parseFloat(opt.dataset.scale);
      updateReadout();
    });
  });

  function activateCustom() {
    zoomOpts.forEach((o) => o.classList.remove('active'));
    customWrap.classList.add('active');
    customRadio.checked = true;
  }

  customInput.addEventListener('focus', activateCustom);
  customInput.addEventListener('input', () => {
    activateCustom();
    const v = parseFloat(customInput.value);
    currentScale = (!isNaN(v) && v > 1) ? v : 1;
    updateReadout();
  });

  /* ---------- readout / clamp logic -------------------------------------- */

  function computeTarget(scale) {
    let w = Math.round(sourceW * scale);
    let h = Math.round(sourceH * scale);
    let clamped = false;

    if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
      const factor = MAX_DIMENSION / Math.max(w, h);
      w = Math.round(w * factor); h = Math.round(h * factor);
      clamped = true;
    }
    if (w * h > MAX_OUTPUT_PIXELS) {
      const factor = Math.sqrt(MAX_OUTPUT_PIXELS / (w * h));
      w = Math.round(w * factor); h = Math.round(h * factor);
      clamped = true;
    }
    return { w, h, clamped };
  }

  function updateReadout() {
    if (!sourceImage) {
      roSrc.textContent = '—'; roDst.textContent = '—';
      roMp.textContent = '—'; roScale.textContent = '—';
      clampNote.classList.add('hidden');
      return;
    }
    const { w, h, clamped } = computeTarget(currentScale);
    roSrc.textContent = `${sourceW}×${sourceH} px`;
    roDst.textContent = `${w}×${h} px`;
    roMp.textContent = ((w * h) / 1_000_000).toFixed(1) + ' MP';
    const effScale = w / sourceW;
    roScale.textContent = '×' + (Math.round(effScale * 100) / 100);

    if (clamped) {
      clampNote.textContent =
        `Запрошенный масштаб ×${currentScale} дал бы слишком большое изображение для браузера. ` +
        `Результат ограничен до ${w}×${h} px (~${((w * h) / 1_000_000).toFixed(0)} MP), ` +
        `это примерно ×${(Math.round(effScale * 100) / 100)} от исходника.`;
      clampNote.classList.remove('hidden');
    } else {
      clampNote.classList.add('hidden');
    }
  }

  /* ---------- options ------------------------------------------------------ */

  sharpenRange.addEventListener('input', () => {
    sharpenVal.textContent = sharpenRange.value + '%';
  });

  qualityRange.addEventListener('input', () => {
    qualityVal.textContent = qualityRange.value + '%';
  });

  const chipLabels = Array.from(document.querySelectorAll('.format-row .chip'));
  chipLabels.forEach((chip) => {
    chip.addEventListener('click', () => {
      chipLabels.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const format = chip.querySelector('input').value;
      qualityBlock.style.display = format === 'png' ? 'none' : 'block';
      updateDownloadFilename(format);
    });
  });

  function currentFormat() {
    const checked = formatChips.find((r) => r.checked);
    return checked ? checked.value : 'png';
  }

  function updateDownloadFilename(format) {
    const ext = format === 'jpeg' ? 'jpg' : format;
    downloadBtn.setAttribute('download', `scale2me.${ext}`);
  }

  /* ---------- processing --------------------------------------------------- */

  function resetResult() {
    stage.style.display = 'none';
    stage.classList.remove('scanning');
    resultActions.style.display = 'none';
    progressBar.style.display = 'none';
    statusLine.style.display = 'none';
    progressFill.style.width = '0%';
    if (worker) { worker.terminate(); worker = null; }
  }

  processBtn.addEventListener('click', runUpscale);
  againBtn.addEventListener('click', () => {
    resetResult();
    processBtn.disabled = false;
    processBtn.textContent = 'Обработать';
    processBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  function runUpscale() {
    if (!sourceImage) return;

    const { w: targetW, h: targetH } = computeTarget(currentScale);

    // Draw source into an offscreen canvas to read raw pixels.
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = sourceW;
    srcCanvas.height = sourceH;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.drawImage(sourceImage, 0, 0);
    let imageData;
    try {
      imageData = srcCtx.getImageData(0, 0, sourceW, sourceH);
    } catch (err) {
      alert('Не удалось прочитать пиксели изображения (возможно, ограничение браузера для больших файлов).');
      return;
    }

    processBtn.disabled = true;
    processBtn.textContent = 'Обрабатываем…';
    stage.style.display = 'flex';
    stage.classList.add('scanning');
    resultActions.style.display = 'none';
    progressBar.style.display = 'block';
    statusLine.style.display = 'flex';
    progressFill.style.width = '0%';
    statusText.textContent = 'Готовим данные…';
    statusPct.textContent = '0%';

    const sharpen = parseInt(sharpenRange.value, 10);
    const denoise = denoiseToggle.checked;

    try {
      worker = new Worker('worker.js');
    } catch (err) {
      stage.classList.remove('scanning');
      stage.style.display = 'none';
      progressBar.style.display = 'none';
      statusLine.style.display = 'none';
      processBtn.disabled = false;
      processBtn.textContent = 'Обработать';
      alert(
        'Не удалось запустить обработку в этом браузере.\n\n' +
        'Если вы открыли файл двойным кликом (адрес начинается с file://), ' +
        'браузер блокирует фоновую обработку из соображений безопасности. ' +
        'Откройте сайт через локальный сервер (например: python3 -m http.server) ' +
        'или через опубликованную версию на GitHub Pages.'
      );
      return;
    }

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        const pct = Math.round(msg.value * 100);
        progressFill.style.width = pct + '%';
        statusPct.textContent = pct + '%';
        statusText.textContent = pct < 45 ? 'Ресемплинг по горизонтали…'
          : pct < 80 ? 'Ресемплинг по вертикали…'
          : 'Коррекция резкости…';
      } else if (msg.type === 'done') {
        finishUpscale(msg.buffer, msg.width, msg.height);
      } else if (msg.type === 'error') {
        stage.classList.remove('scanning');
        processBtn.disabled = false;
        processBtn.textContent = 'Обработать';
        alert('Ошибка при обработке: ' + msg.message);
      }
    };
    worker.onerror = (err) => {
      stage.classList.remove('scanning');
      processBtn.disabled = false;
      processBtn.textContent = 'Обработать';
      alert('Не удалось выполнить обработку в этом браузере: ' + err.message);
    };

    worker.postMessage(
      {
        data: imageData.data,
        width: sourceW,
        height: sourceH,
        targetWidth: targetW,
        targetHeight: targetH,
        sharpen,
        denoise,
      },
      [imageData.data.buffer]
    );
  }

  function finishUpscale(buffer, w, h) {
    stage.classList.remove('scanning');
    progressFill.style.width = '100%';
    statusPct.textContent = '100%';
    statusText.textContent = 'Готово';

    resultCanvas.width = w;
    resultCanvas.height = h;
    const ctx = resultCanvas.getContext('2d');
    const clamped = new Uint8ClampedArray(buffer);
    const outData = new ImageData(clamped, w, h);
    ctx.putImageData(outData, 0, 0);

    const format = currentFormat();
    const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    const quality = format === 'png' ? undefined : parseInt(qualityRange.value, 10) / 100;

    const finalizeDownload = (blob, actualFormat) => {
      const url = URL.createObjectURL(blob);
      downloadBtn.href = url;
      updateDownloadFilename(actualFormat);
      resultActions.style.display = 'flex';
    };

    resultCanvas.toBlob((blob) => {
      if (blob) { finalizeDownload(blob, format); return; }

      // Some browsers (e.g. older Firefox) can't encode certain
      // formats via canvas — fall back to PNG rather than failing silently.
      if (mime !== 'image/png') {
        resultCanvas.toBlob((pngBlob) => {
          if (pngBlob) {
            finalizeDownload(pngBlob, 'png');
          } else {
            alert('Не удалось сохранить результат в этом браузере.');
          }
        }, 'image/png');
      } else {
        alert('Не удалось сохранить результат в этом браузере.');
      }
    }, mime, quality);

    processBtn.disabled = false;
    processBtn.textContent = 'Обработать';
  }

})();
