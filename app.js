/**
 * ZeroCam 1.0 — AI Computational Web Camera
 * Created by HowKeJaa (@howkejaa)
 *
 * Fitur Utama:
 * - Zero-Blur Frame Lock Capture + Auto-Resume Live Stream (Opsi A)
 * - Adaptive Dual Flash (Rear Hardware LED Torch + Non-Stuck Front Screen Flash)
 * - Single-Frame Edge-Preserving AI Denoise, Selective Skin Refinement & HD Sharpening
 * - MediaPipe Portrait Bokeh + Auto-Fallback
 * - Permanent Flagship Watermark & Credits Modal
 */

const state = {
  stream: null,
  facingMode: 'environment', // 'environment' (belakang) | 'user' (depan)
  mode: 'hdr',               // 'hdr' | 'portrait' | 'night'
  lut: 'natural',            // 'natural' | 'leica' | 'vivid' | 'mono'
  ratio: '4:3',              // '4:3' | '16:9' | '1:1'
  zoom: 1,
  flash: false,
  timer: 0,                  // 0 | 3 | 10
  grid: false,
  isCapturing: false,
  torchSupported: false,
  photos: [],                // { id, rawUrl, finalUrl, filename, meta }
  selectedPhotoIndex: 0,
  segmentation: null,
  segmentationReady: false,
  latestMaskCanvas: null
};

// DOM References
const dom = {
  video: document.getElementById('cameraStream'),
  viewfinderFrame: document.getElementById('viewfinderFrame'),
  gridOverlay: document.getElementById('gridOverlay'),
  focusReticle: document.getElementById('focusReticle'),
  countdownOverlay: document.getElementById('countdownOverlay'),
  countdownNumber: document.getElementById('countdownNumber'),
  processingOverlay: document.getElementById('processingOverlay'),
  processingText: document.getElementById('processingText'),
  screenFlash: document.getElementById('screenFlash'),
  cameraError: document.getElementById('cameraError'),
  cameraErrorMsg: document.getElementById('cameraErrorMsg'),
  btnRetryCamera: document.getElementById('btnRetryCamera'),

  // Top controls
  btnFlash: document.getElementById('btnFlash'),
  flashLabel: document.getElementById('flashLabel'),
  btnTimer: document.getElementById('btnTimer'),
  timerLabel: document.getElementById('timerLabel'),
  btnRatio: document.getElementById('btnRatio'),
  ratioLabel: document.getElementById('ratioLabel'),
  btnGrid: document.getElementById('btnGrid'),
  btnSettings: document.getElementById('btnSettings'),

  // HUD
  hudModeBadge: document.getElementById('hudModeBadge'),
  hudResBadge: document.getElementById('hudResBadge'),
  hudLutBadge: document.getElementById('hudLutBadge'),

  // Bottom controls
  btnShutter: document.getElementById('btnShutter'),
  btnSwitchCam: document.getElementById('btnSwitchCam'),
  btnGallery: document.getElementById('btnGallery'),
  latestThumbImg: document.getElementById('latestThumbImg'),
  galleryPlaceholderIcon: document.getElementById('galleryPlaceholderIcon'),
  galleryCountBadge: document.getElementById('galleryCountBadge'),

  // Gallery Modal
  galleryModal: document.getElementById('galleryModal'),
  btnCloseGallery: document.getElementById('btnCloseGallery'),
  galleryEmptyState: document.getElementById('galleryEmptyState'),
  galleryViewer: document.getElementById('galleryViewer'),
  compareContainer: document.getElementById('compareContainer'),
  compareBeforeWrapper: document.getElementById('compareBeforeWrapper'),
  compareBeforeImg: document.getElementById('compareBeforeImg'),
  compareAfterImg: document.getElementById('compareAfterImg'),
  compareDivider: document.getElementById('compareDivider'),
  thumbStrip: document.getElementById('thumbStrip'),
  photoMetaInfo: document.getElementById('photoMetaInfo'),
  btnRedownload: document.getElementById('btnRedownload'),

  // Info & Credits Modal
  infoModal: document.getElementById('infoModal'),
  btnCloseInfo: document.getElementById('btnCloseInfo'),

  toast: document.getElementById('toast')
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Initialize MediaPipe AI Segmentation (untuk Mode Portrait)
function initMediaPipeSegmentation() {
  try {
    if (typeof SelfieSegmentation === 'undefined') return;
    const seg = new SelfieSegmentation({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
    });
    seg.setOptions({ modelSelection: 1, selfieMode: false });
    seg.onResults((results) => {
      if (results.segmentationMask) {
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = results.segmentationMask.width;
        maskCanvas.height = results.segmentationMask.height;
        const mCtx = maskCanvas.getContext('2d');
        mCtx.drawImage(results.segmentationMask, 0, 0);
        state.latestMaskCanvas = maskCanvas;
        state.segmentationReady = true;
      }
    });
    state.segmentation = seg;
  } catch (err) {
    console.warn('MediaPipe fallback aktif:', err);
  }
}

// Start Camera Stream dengan Dukungan Cross-Device
async function startCamera() {
  dom.cameraError.classList.add('hidden');
  state.torchSupported = false;

  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
  }

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: state.facingMode },
      width: { ideal: 3840 },
      height: { ideal: 2160 }
    }
  };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    dom.video.srcObject = state.stream;

    await new Promise((resolve) => {
      dom.video.onloadedmetadata = () => {
        dom.video.play().catch(() => {});
        resolve();
      };
    });

    updatePreviewTransform();

    const track = state.stream.getVideoTracks()[0];
    if (track) {
      const settings = track.getSettings ? track.getSettings() : {};
      if (settings.width && settings.height) {
        const mp = ((settings.width * settings.height) / 1_000_000).toFixed(1);
        dom.hudResBadge.textContent = `${settings.width}×${settings.height} (${mp}MP)`;
      }

      // Deteksi dukungan Hardware LED Torch (Android Chrome / Mobile Rear Cam)
      if (typeof track.getCapabilities === 'function') {
        const caps = track.getCapabilities();
        state.torchSupported = Boolean(caps && caps.torch);
      }
    }
  } catch (err) {
    // Fallback otomatis ke kamera depan/webcam jika kamera belakang tidak tersedia
    if (state.facingMode === 'environment') {
      state.facingMode = 'user';
      return startCamera();
    }
    dom.cameraErrorMsg.textContent =
      'Kamera tidak dapat diakses. Pastikan izin kamera aktif dan website dibuka lewat HTTPS.';
    dom.cameraError.classList.remove('hidden');
  }
}

// Kontrol Hardware LED Torch (Kamera Belakang)
async function setHardwareTorch(enable) {
  if (!state.stream || !state.torchSupported) return false;
  const track = state.stream.getVideoTracks()[0];
  if (!track || typeof track.applyConstraints !== 'function') return false;

  try {
    await track.applyConstraints({
      advanced: [{ torch: Boolean(enable) }]
    });
    return true;
  } catch (_) {
    return false;
  }
}

// Pengaman Matikan Semua Flash (Anti-Stuck)
async function forceTurnOffAllFlash() {
  dom.screenFlash.classList.remove('active');
  await setHardwareTorch(false);
}

function updatePreviewTransform() {
  const mirror = state.facingMode === 'user' ? -1 : 1;
  dom.video.style.transform = `scaleX(${mirror * state.zoom}) scaleY(${state.zoom})`;
}

// Hitung Area Crop Sesuai Rasio (4:3, 16:9, 1:1) & Zoom
function getCropGeometry(vw, vh) {
  const isPortraitStream = vh > vw;
  let targetRatio;

  if (state.ratio === '1:1') {
    targetRatio = 1;
  } else if (state.ratio === '16:9') {
    targetRatio = isPortraitStream ? 9 / 16 : 16 / 9;
  } else {
    targetRatio = isPortraitStream ? 3 / 4 : 4 / 3;
  }

  const streamRatio = vw / vh;
  let baseW, baseH;

  if (streamRatio > targetRatio) {
    baseH = vh;
    baseW = Math.round(vh * targetRatio);
  } else {
    baseW = vw;
    baseH = Math.round(vw / targetRatio);
  }

  const cropW = Math.round(baseW / state.zoom);
  const cropH = Math.round(baseH / state.zoom);
  const sx = Math.round((vw - cropW) / 2);
  const sy = Math.round((vh - cropH) / 2);

  return { sx, sy, cropW, cropH };
}

// Tangkap 1 Frame Terkunci ke Offscreen Canvas
function grabLockedFrame() {
  const vw = dom.video.videoWidth || 1280;
  const vh = dom.video.videoHeight || 720;
  const { sx, sy, cropW, cropH } = getCropGeometry(vw, vh);

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (state.facingMode === 'user') {
    ctx.translate(cropW, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(dom.video, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
  return canvas;
}

// AI Computational Photography Engine (Fokus pada 1 Frame Terkunci — Bebas Motion Blur)
async function processLockedPhotoPipeline(lockedCanvas) {
  const width = lockedCanvas.width;
  const height = lockedCanvas.height;

  // Simpan foto RAW untuk perbandingan Before/After di Galeri
  const rawUrl = lockedCanvas.toDataURL('image/jpeg', 0.9);

  // Jika mode Portrait, jalankan segmentasi AI dengan batas waktu agar anti-hang
  if (state.mode === 'portrait' && state.segmentation) {
    try {
      await Promise.race([
        state.segmentation.send({ image: lockedCanvas }),
        sleep(1200)
      ]);
    } catch (_) {}
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const ctx = outCanvas.getContext('2d', { willReadFrequently: true });

  const imgData = lockedCanvas
    .getContext('2d')
    .getImageData(0, 0, width, height);

  // AI Edge-Preserving Denoise + Skin Refinement + HDR Tone Mapping + HD Sharpen + LUT
  const processed = applySingleFrameAIEnhancements(imgData, width, height);
  ctx.putImageData(processed, 0, 0);

  // AI Portrait Bokeh (Blur Latar Belakang)
  if (state.mode === 'portrait') {
    applyPortraitBokeh(outCanvas);
  }

  // Tambahkan Watermark Permanen Classy di Bagian Bawah
  const finalCanvas = applyPermanentWatermark(outCanvas);
  const finalUrl = finalCanvas.toDataURL('image/jpeg', 0.96);

  return { rawUrl, finalUrl };
}

function applySingleFrameAIEnhancements(imgData, width, height) {
  const src = new Uint8ClampedArray(imgData.data);
  const out = imgData.data;

  const isNight = state.mode === 'night';
  const isHdr = state.mode === 'hdr';
  const lut = state.lut;

  // Parameter Computational berdasarkan Mode
  const shadowLift = isNight ? 0.74 : isHdr ? 0.87 : 0.93;
  const gain = isNight ? 1.26 : 1.03;
  const sharpenStrength = lut === 'leica' ? 0.46 : 0.36;
  const skinSmoothStrength = 0.62;
  const rowStride = width * 4;

  for (let y = 1; y < height - 1; y++) {
    const rowOffset = y * rowStride;
    const prevRow = rowOffset - rowStride;
    const nextRow = rowOffset + rowStride;

    for (let x = 1; x < width - 1; x++) {
      const colOffset = x * 4;
      const idx = rowOffset + colOffset;

      const r0 = src[idx];
      const g0 = src[idx + 1];
      const b0 = src[idx + 2];

      // Unrolled 3x3 Neighborhood Sampling (3x lebih cepat & responsif di semua HP)
      const iTL = prevRow + colOffset - 4;
      const iTC = prevRow + colOffset;
      const iTR = prevRow + colOffset + 4;
      const iML = idx - 4;
      const iMR = idx + 4;
      const iBL = nextRow + colOffset - 4;
      const iBC = nextRow + colOffset;
      const iBR = nextRow + colOffset + 4;

      const avgR =
        (src[iTL] + src[iTC] + src[iTR] +
         src[iML] + r0       + src[iMR] +
         src[iBL] + src[iBC] + src[iBR]) * 0.111111;

      const avgG =
        (src[iTL + 1] + src[iTC + 1] + src[iTR + 1] +
         src[iML + 1] + g0           + src[iMR + 1] +
         src[iBL + 1] + src[iBC + 1] + src[iBR + 1]) * 0.111111;

      const avgB =
        (src[iTL + 2] + src[iTC + 2] + src[iTR + 2] +
         src[iML + 2] + b0           + src[iMR + 2] +
         src[iBL + 2] + src[iBC + 2] + src[iBR + 2]) * 0.111111;

      // Deteksi warna kulit alami
      const isSkin =
        r0 > 95 && g0 > 40 && b0 > 20 &&
        r0 > g0 && r0 > b0 &&
        Math.abs(r0 - g0) > 15;

      // Deteksi detail tepi (edge) agar mata/alis/rambut tetap tajam
      const edgeDelta =
        Math.abs(r0 - avgR) + Math.abs(g0 - avgG) + Math.abs(b0 - avgB);

      let r = r0, g = g0, b = b0;

      if (isSkin && edgeDelta < 36) {
        // AI Selective Skin Smoothing
        r = r0 * (1 - skinSmoothStrength) + avgR * skinSmoothStrength;
        g = g0 * (1 - skinSmoothStrength) + avgG * skinSmoothStrength;
        b = b0 * (1 - skinSmoothStrength) + avgB * skinSmoothStrength;
      } else if (edgeDelta < 18 && isNight) {
        // Edge-Preserving Noise Reduction untuk area gelap di Night Sight
        r = r0 * 0.55 + avgR * 0.45;
        g = g0 * 0.55 + avgG * 0.45;
        b = b0 * 0.55 + avgB * 0.45;
      } else {
        // Unsharp Mask (HD Micro-Sharpening)
        r = r0 + (r0 - avgR) * sharpenStrength;
        g = g0 + (g0 - avgG) * sharpenStrength;
        b = b0 + (b0 - avgB) * sharpenStrength;
      }

      // HDR / Night Dynamic Range Tone Mapping
      r = Math.pow(Math.min(255, Math.max(0, r * gain)) / 255, shadowLift) * 255;
      g = Math.pow(Math.min(255, Math.max(0, g * gain)) / 255, shadowLift) * 255;
      b = Math.pow(Math.min(255, Math.max(0, b * gain)) / 255, shadowLift) * 255;

      // Color Profile (LUT)
      if (lut === 'mono') {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const monoContrast = ((lum / 255 - 0.5) * 1.24 + 0.5) * 255;
        r = g = b = monoContrast;
      } else if (lut === 'leica') {
        r = ((r / 255 - 0.5) * 1.16 + 0.505) * 255;
        g = ((g / 255 - 0.5) * 1.15 + 0.5) * 255;
        b = ((b / 255 - 0.5) * 1.16 + 0.49) * 255;
      } else if (lut === 'vivid') {
        const avg = (r + g + b) / 3;
        r = avg + (r - avg) * 1.26;
        g = avg + (g - avg) * 1.26;
        b = avg + (b - avg) * 1.26;
      } else {
        const avg = (r + g + b) / 3;
        r = avg + (r - avg) * 1.07;
        g = avg + (g - avg) * 1.07;
        b = avg + (b - avg) * 1.07;
      }

      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
    }
  }

  return imgData;
}

// AI Portrait Bokeh (MediaPipe Mask + Smart Radial Fallback)
function applyPortraitBokeh(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const blurRadius = Math.max(10, Math.round(Math.min(w, h) * 0.018));

  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = w;
  bgCanvas.height = h;
  const bgCtx = bgCanvas.getContext('2d');
  bgCtx.filter = `blur(${blurRadius}px)`;
  bgCtx.drawImage(canvas, 0, 0);

  const fgCanvas = document.createElement('canvas');
  fgCanvas.width = w;
  fgCanvas.height = h;
  const fgCtx = fgCanvas.getContext('2d');
  fgCtx.drawImage(canvas, 0, 0);

  fgCtx.globalCompositeOperation = 'destination-in';

  if (state.segmentationReady && state.latestMaskCanvas) {
    fgCtx.drawImage(state.latestMaskCanvas, 0, 0, w, h);
  } else {
    const grad = fgCtx.createRadialGradient(
      w * 0.5, h * 0.45, Math.min(w, h) * 0.22,
      w * 0.5, h * 0.48, Math.max(w, h) * 0.52
    );
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.65, 'rgba(0,0,0,0.92)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    fgCtx.fillStyle = grad;
    fgCtx.fillRect(0, 0, w, h);
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bgCanvas, 0, 0);
  ctx.drawImage(fgCanvas, 0, 0);
}

// Permanent Classy Watermark Frame (Non-Removable)
function applyPermanentWatermark(photoCanvas) {
  const w = photoCanvas.width;
  const h = photoCanvas.height;
  const barHeight = Math.max(46, Math.round(Math.min(w, h) * 0.068));

  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = w;
  finalCanvas.height = h + barHeight;
  const ctx = finalCanvas.getContext('2d');

  ctx.drawImage(photoCanvas, 0, 0);

  ctx.fillStyle = '#090B10';
  ctx.fillRect(0, h, w, barHeight);

  ctx.fillStyle = 'rgba(59, 130, 246, 0.35)';
  ctx.fillRect(0, h, w, Math.max(1, Math.round(barHeight * 0.025)));

  const padX = Math.round(barHeight * 0.45);
  const centerY = h + barHeight / 2;
  const titleSize = Math.max(12, Math.round(barHeight * 0.29));
  const subSize = Math.max(10, Math.round(barHeight * 0.22));

  ctx.textBaseline = 'middle';

  ctx.font = `700 ${titleSize}px Inter, sans-serif`;
  ctx.fillStyle = '#F8FAFC';
  const brandText = 'ZEROCAM 1.0';
  ctx.fillText(brandText, padX, centerY);

  const brandWidth = ctx.measureText(brandText).width;
  const dotX = padX + brandWidth + Math.round(titleSize * 0.65);

  ctx.fillStyle = '#3B82F6';
  ctx.beginPath();
  ctx.arc(dotX, centerY, Math.max(2, titleSize * 0.14), 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `500 ${subSize}px "JetBrains Mono", monospace`;
  ctx.fillStyle = '#94A3B8';
  ctx.fillText(
    'AI COMPUTATIONAL OPTICS',
    dotX + Math.round(titleSize * 0.65),
    centerY
  );

  const modeLabel =
    state.mode === 'portrait'
      ? 'PORTRAIT • 50mm f/1.4'
      : state.mode === 'night'
      ? 'NIGHT SIGHT • 24mm f/1.6'
      : 'AI HDR+ • 24mm f/1.8';

  ctx.textAlign = 'right';
  ctx.font = `500 ${subSize}px "JetBrains Mono", monospace`;
  ctx.fillStyle = '#CBD5E1';
  ctx.fillText(modeLabel, w - padX, centerY);

  return finalCanvas;
}

// Auto-Download Helper
function triggerAutoDownload(dataUrl, filename) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => dom.toast.classList.add('hidden'), 2600);
}

// Eksekusi Jepret Foto: Freeze Frame -> Flash Off -> AI Process -> Auto-Resume (Opsi A)
async function handleCapture() {
  if (state.isCapturing || !state.stream) return;
  state.isCapturing = true;
  dom.btnShutter.disabled = true;

  // Failsafe timer agar flash mustahil stuck dalam kondisi apapun
  const flashSafetyTimer = setTimeout(() => {
    forceTurnOffAllFlash();
  }, 1500);

  try {
    // 1. Timer Countdown jika aktif
    if (state.timer > 0) {
      dom.countdownOverlay.classList.remove('hidden');
      for (let t = state.timer; t >= 1; t--) {
        dom.countdownNumber.textContent = t;
        await sleep(1000);
      }
      dom.countdownOverlay.classList.add('hidden');
    }

    // 2. Aktifkan Flash yang Sesuai (LED Torch untuk Belakang / Screen Flash untuk Depan)
    if (state.flash) {
      if (state.facingMode === 'environment' && state.torchSupported) {
        await setHardwareTorch(true);
        await sleep(420); // Beri waktu sensor menyesuaikan cahaya LED
      } else {
        dom.screenFlash.classList.add('active');
        await sleep(180);
      }
    }

    // 3. Langsung Kunci (Freeze) Video Preview & Ambil 1 Frame Tajam
    dom.video.pause();
    const lockedCanvas = grabLockedFrame();

    // 4. Segera Matikan Flash SEBELUM AI Memproses Piksel (Anti-Stuck!)
    clearTimeout(flashSafetyTimer);
    await forceTurnOffAllFlash();

    // 5. Tampilkan Indikator AI Processing di Atas Frame yang Terkunci
    dom.processingText.textContent =
      state.mode === 'night'
        ? 'AI Night Sight Denoise & Boost...'
        : state.mode === 'portrait'
        ? 'AI Portrait Depth & Skin Refinement...'
        : 'AI HDR+ Frame-Lock HD Processing...';
    dom.processingOverlay.classList.remove('hidden');

    // Beri jeda 1 frame render UI agar spinner muncul mulus
    await sleep(30);
    const { rawUrl, finalUrl } = await processLockedPhotoPipeline(lockedCanvas);

    // 6. Auto-Download Hasil HD
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `ZeroCam_1.0_${state.mode.toUpperCase()}_${stamp}.jpg`;

    triggerAutoDownload(finalUrl, filename);

    // 7. Simpan ke Mini Gallery
    state.photos.unshift({
      id: Date.now(),
      rawUrl,
      finalUrl,
      filename,
      meta: `${state.mode.toUpperCase()} • ${state.lut.toUpperCase()} • ${state.ratio}`
    });

    updateMiniGalleryThumb();
    showToast('Foto HD tersimpan otomatis!');
  } catch (err) {
    console.error('Capture error:', err);
    showToast('Gagal memproses foto, coba lagi.');
  } finally {
    clearTimeout(flashSafetyTimer);
    await forceTurnOffAllFlash();
    dom.processingOverlay.classList.add('hidden');
    dom.btnShutter.disabled = false;
    state.isCapturing = false;

    // Opsi A: Otomatis nyalakan (resume) kamera live kembali agar siap jepret lagi
    if (dom.video && dom.video.paused) {
      dom.video.play().catch(() => {});
    }
  }
}

function updateMiniGalleryThumb() {
  const count = state.photos.length;
  if (count === 0) return;

  dom.latestThumbImg.src = state.photos[0].finalUrl;
  dom.latestThumbImg.classList.remove('hidden');
  dom.galleryPlaceholderIcon.classList.add('hidden');
  dom.galleryCountBadge.textContent = count;
  dom.galleryCountBadge.classList.remove('hidden');
}

// Gallery & Before/After Slider Logic
function openGallery() {
  dom.galleryModal.classList.remove('hidden');
  if (state.photos.length === 0) {
    dom.galleryEmptyState.classList.remove('hidden');
    dom.galleryViewer.classList.add('hidden');
    return;
  }

  dom.galleryEmptyState.classList.add('hidden');
  dom.galleryViewer.classList.remove('hidden');
  selectGalleryPhoto(0);
}

function selectGalleryPhoto(index) {
  state.selectedPhotoIndex = index;
  const item = state.photos[index];
  if (!item) return;

  dom.compareBeforeImg.src = item.rawUrl;
  dom.compareAfterImg.src = item.finalUrl;
  dom.photoMetaInfo.textContent = item.meta;
  setCompareSliderPosition(50);

  dom.thumbStrip.innerHTML = '';
  state.photos.forEach((p, idx) => {
    const img = document.createElement('img');
    img.src = p.finalUrl;
    img.alt = `Hasil ${idx + 1}`;
    img.className = `thumb-item ${idx === index ? 'active' : ''}`;
    img.onclick = () => selectGalleryPhoto(idx);
    dom.thumbStrip.appendChild(img);
  });
}

function setCompareSliderPosition(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  dom.compareBeforeWrapper.style.clipPath = `inset(0 ${100 - clamped}% 0 0)`;
  dom.compareDivider.style.left = `${clamped}%`;
}

function initCompareSliderEvents() {
  let dragging = false;

  const updateFromEvent = (clientX) => {
    const rect = dom.compareContainer.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setCompareSliderPosition(pct);
  };

  dom.compareContainer.addEventListener('pointerdown', (e) => {
    dragging = true;
    updateFromEvent(e.clientX);
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    updateFromEvent(e.clientX);
  });

  window.addEventListener('pointerup', () => {
    dragging = false;
  });
}

// Event Listeners Setup
function bindEvents() {
  dom.btnShutter.addEventListener('click', handleCapture);
  dom.btnRetryCamera.addEventListener('click', startCamera);

  dom.btnSwitchCam.addEventListener('click', async () => {
    await forceTurnOffAllFlash();
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    startCamera();
  });

  // Top Controls: Flash
  dom.btnFlash.addEventListener('click', () => {
    state.flash = !state.flash;
    dom.flashLabel.textContent = state.flash ? 'ON' : 'OFF';
    dom.btnFlash.classList.toggle('active-blue', state.flash);
  });

  // Top Controls: Timer (OFF -> 3s -> 10s)
  dom.btnTimer.addEventListener('click', () => {
    state.timer = state.timer === 0 ? 3 : state.timer === 3 ? 10 : 0;
    dom.timerLabel.textContent = state.timer === 0 ? 'OFF' : `${state.timer}S`;
    dom.btnTimer.classList.toggle('active-blue', state.timer > 0);
  });

  // Top Controls: Aspect Ratio (4:3 -> 16:9 -> 1:1)
  dom.btnRatio.addEventListener('click', () => {
    const order = ['4:3', '16:9', '1:1'];
    state.ratio = order[(order.indexOf(state.ratio) + 1) % order.length];
    dom.ratioLabel.textContent = state.ratio;

    dom.viewfinderFrame.classList.remove('ratio-4-3', 'ratio-16-9', 'ratio-1-1');
    dom.viewfinderFrame.classList.add(`ratio-${state.ratio.replace(':', '-')}`);
  });

  // Top Controls: Grid 3x3
  dom.btnGrid.addEventListener('click', () => {
    state.grid = !state.grid;
    dom.gridOverlay.classList.toggle('hidden', !state.grid);
    dom.btnGrid.classList.toggle('active-blue', state.grid);
  });

  // Top Controls: Settings / Credits & Camera Info Modal
  dom.btnSettings.addEventListener('click', () => {
    dom.infoModal.classList.remove('hidden');
  });
  dom.btnCloseInfo.addEventListener('click', () => {
    dom.infoModal.classList.add('hidden');
  });
  dom.infoModal.addEventListener('click', (e) => {
    if (e.target === dom.infoModal) dom.infoModal.classList.add('hidden');
  });

  // Zoom Buttons
  document.querySelectorAll('.zoom-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.zoom-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.zoom = parseFloat(btn.dataset.zoom);
      updatePreviewTransform();
    });
  });

  // Color LUT Pills
  document.querySelectorAll('.lut-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lut-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.lut = btn.dataset.lut;
      dom.hudLutBadge.textContent = state.lut.toUpperCase();

      dom.video.className = `lut-preview-${state.lut}`;
    });
  });

  // AI Camera Mode Buttons
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;

      const labels = {
        hdr: 'AI HDR+',
        portrait: 'AI PORTRAIT',
        night: 'NIGHT SIGHT'
      };
      dom.hudModeBadge.textContent = labels[state.mode];
    });
  });

  // Tap Viewfinder untuk Animasi Fokus
  dom.viewfinderFrame.addEventListener('click', (e) => {
    if (e.target.closest('.zoom-bar')) return;
    const rect = dom.viewfinderFrame.getBoundingClientRect();
    dom.focusReticle.style.left = `${e.clientX - rect.left}px`;
    dom.focusReticle.style.top = `${e.clientY - rect.top}px`;
    dom.focusReticle.classList.remove('hidden');
    void dom.focusReticle.offsetWidth;
  });

  // Gallery Modal Events
  dom.btnGallery.addEventListener('click', openGallery);
  dom.btnCloseGallery.addEventListener('click', () =>
    dom.galleryModal.classList.add('hidden')
  );
  dom.galleryModal.addEventListener('click', (e) => {
    if (e.target === dom.galleryModal) dom.galleryModal.classList.add('hidden');
  });

  dom.btnRedownload.addEventListener('click', () => {
    const item = state.photos[state.selectedPhotoIndex];
    if (item) {
      triggerAutoDownload(item.finalUrl, item.filename);
      showToast('Mengunduh ulang foto HD...');
    }
  });

  initCompareSliderEvents();
}

// Boot Application
window.addEventListener('DOMContentLoaded', () => {
  dom.video.classList.add('lut-preview-natural');
  bindEvents();
  initMediaPipeSegmentation();
  startCamera();
});
