/* ============================================================
   Scale2Me — resize worker
   Separable Lanczos-3 resampling for upscaling, with an optional
   pre-blur (denoise) pass and a post unsharp-mask (sharpen) pass.
   Runs off the main thread so the UI stays responsive.
   ============================================================ */

const LANCZOS_A = 3;

function lanczosKernel(x) {
  if (x === 0) return 1;
  if (x <= -LANCZOS_A || x >= LANCZOS_A) return 0;
  const px = Math.PI * x;
  return (LANCZOS_A * Math.sin(px) * Math.sin(px / LANCZOS_A)) / (px * px);
}

// Precompute, for every output coordinate, which source indices
// contribute and with what (normalized) weight. Upscaling only,
// so the kernel support stays fixed at LANCZOS_A (no widening).
function buildWeights(srcLen, dstLen) {
  const ratio = srcLen / dstLen;
  const table = new Array(dstLen);
  for (let d = 0; d < dstLen; d++) {
    const center = (d + 0.5) * ratio - 0.5;
    const left = Math.floor(center - LANCZOS_A + 1);
    const right = Math.floor(center + LANCZOS_A);
    const idx = [];
    const w = [];
    let sum = 0;
    for (let s = left; s <= right; s++) {
      const weight = lanczosKernel(center - s);
      if (weight === 0) continue;
      const clamped = s < 0 ? 0 : s >= srcLen ? srcLen - 1 : s;
      idx.push(clamped);
      w.push(weight);
      sum += weight;
    }
    if (sum !== 0) {
      for (let k = 0; k < w.length; k++) w[k] /= sum;
    }
    table[d] = { idx, w };
  }
  return table;
}

// Horizontal pass: srcW x srcH -> dstW x srcH (Float32, 4 channels)
function resizeHorizontal(src, srcW, srcH, dstW, progress) {
  const weights = buildWeights(srcW, dstW);
  const out = new Float32Array(dstW * srcH * 4);
  const reportEvery = Math.max(1, srcH >> 5);

  for (let y = 0; y < srcH; y++) {
    const srcRowOff = y * srcW * 4;
    const dstRowOff = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const { idx, w } = weights[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < idx.length; k++) {
        const o = srcRowOff + idx[k] * 4;
        const wk = w[k];
        r += src[o] * wk;
        g += src[o + 1] * wk;
        b += src[o + 2] * wk;
        a += src[o + 3] * wk;
      }
      const o2 = dstRowOff + x * 4;
      out[o2] = r; out[o2 + 1] = g; out[o2 + 2] = b; out[o2 + 3] = a;
    }
    if (y % reportEvery === 0) progress(0.05 + (y / srcH) * 0.4);
  }
  return out;
}

// Vertical pass: dstW x srcH -> dstW x dstH (Float32, 4 channels)
function resizeVertical(src, dstW, srcH, dstH, progress) {
  const weights = buildWeights(srcH, dstH);
  const out = new Float32Array(dstW * dstH * 4);
  const reportEvery = Math.max(1, dstH >> 5);

  for (let y = 0; y < dstH; y++) {
    const { idx, w } = weights[y];
    const dstRowOff = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const xo = x * 4;
      for (let k = 0; k < idx.length; k++) {
        const o = idx[k] * dstW * 4 + xo;
        const wk = w[k];
        r += src[o] * wk;
        g += src[o + 1] * wk;
        b += src[o + 2] * wk;
        a += src[o + 3] * wk;
      }
      const o2 = dstRowOff + xo;
      out[o2] = r; out[o2 + 1] = g; out[o2 + 2] = b; out[o2 + 3] = a;
    }
    if (y % reportEvery === 0) progress(0.45 + (y / dstH) * 0.35);
  }
  return out;
}

// Cheap 3x3 gaussian-ish blur used both for the optional denoise
// pre-pass and to build the "unsharp" reference for sharpening.
function boxBlur3(src, w, h) {
  const out = new Float32Array(src.length);
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const kSum = 16;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, ki = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const o = (yy * w + xx) * 4;
          const kw = kernel[ki++];
          r += src[o] * kw; g += src[o + 1] * kw;
          b += src[o + 2] * kw; a += src[o + 3] * kw;
        }
      }
      const o2 = (y * w + x) * 4;
      out[o2] = r / kSum; out[o2 + 1] = g / kSum;
      out[o2 + 2] = b / kSum; out[o2 + 3] = a / kSum;
    }
  }
  return out;
}

function unsharpMask(src, w, h, amount, progress) {
  if (amount <= 0) return src;
  const blurred = boxBlur3(src, w, h);
  const out = new Float32Array(src.length);
  const strength = amount / 100 * 1.8; // 0..1.8
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const orig = src[i + c];
      const diff = orig - blurred[i + c];
      out[i + c] = orig + diff * strength;
    }
    out[i + 3] = src[i + 3];
  }
  progress(0.95);
  return out;
}

function toUint8Clamped(src) {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

function toFloat32(u8) {
  const out = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = u8[i];
  return out;
}

self.onmessage = function (e) {
  const { data, width, height, targetWidth, targetHeight, sharpen, denoise } = e.data;

  try {
    const report = (v) => self.postMessage({ type: 'progress', value: Math.min(0.99, v) });

    let source = toFloat32(data);

    if (denoise) {
      report(0.02);
      source = boxBlur3(source, width, height);
    }

    report(0.05);
    const afterH = resizeHorizontal(source, width, height, targetWidth, report);
    const afterV = resizeVertical(afterH, targetWidth, height, targetHeight, report);
    const sharpened = unsharpMask(afterV, targetWidth, targetHeight, sharpen, report);
    const result = toUint8Clamped(sharpened);

    self.postMessage(
      { type: 'done', buffer: result.buffer, width: targetWidth, height: targetHeight },
      [result.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
