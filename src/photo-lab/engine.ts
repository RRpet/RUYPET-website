import { defaults, type Adjustments, type Stroke, type Metrics } from "./types";
const clamp = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const linear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const srgb = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
const luminance = (r: number, g: number, b: number) =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;
const lut = Array.from({ length: 256 }, (_, i) => linear(i / 255));
function quantile(values: number[], q: number) {
  const a = [...values].sort((a, b) => a - b);
  return a[Math.floor((a.length - 1) * q)] || 0;
}
function globalPixel(
  r: number,
  g: number,
  b: number,
  p: Adjustments,
): number[] {
  if (
    !p.exposure &&
    !p.brightness &&
    !p.temperature &&
    !p.tint &&
    !p.highlights &&
    !p.shadows &&
    !p.contrast &&
    !p.saturation
  )
    return [r, g, b];
  const gain = 2 ** p.exposure;
  let rr = lut[r] * gain * (1 + p.temperature * 0.0025 + p.tint * 0.001),
    gg = lut[g] * gain * (1 - p.tint * 0.002),
    bb = lut[b] * gain * (1 - p.temperature * 0.0025 + p.tint * 0.001);
  const l = luminance(rr, gg, bb);
  const dark = (1 - clamp(l / 0.45)) ** 2;
  const bright = clamp((l - 0.35) / 0.65) ** 2;
  const shift =
    (p.shadows / 100) * 0.15 * dark + (p.highlights / 100) * 0.25 * bright;
  rr = srgb(Math.max(0, rr + shift));
  gg = srgb(Math.max(0, gg + shift));
  bb = srgb(Math.max(0, bb + shift));
  const c = 1 + (p.contrast / 100) * 0.65,
    br = (p.brightness / 100) * 0.18;
  rr = (rr - 0.5) * c + 0.5 + br;
  gg = (gg - 0.5) * c + 0.5 + br;
  bb = (bb - 0.5) * c + 0.5 + br;
  const gray = luminance(rr, gg, bb),
    sat = 1 + p.saturation / 100;
  return [
    (gray + (rr - gray) * sat) * 255,
    (gray + (gg - gray) * sat) * 255,
    (gray + (bb - gray) * sat) * 255,
  ];
}
function fit(rows: number[][], values: number[]): number[] {
  const m = Array.from({ length: 6 }, () => new Array(7).fill(0));
  rows.forEach((a, i) => {
    for (let j = 0; j < 6; j++) {
      for (let k = 0; k < 6; k++) m[j][k] += a[j] * a[k];
      m[j][6] += a[j] * values[i];
    }
  });
  for (let j = 0; j < 6; j++) m[j][j] += 0.001;
  for (let j = 0; j < 6; j++) {
    let pivot = j;
    for (let k = j + 1; k < 6; k++)
      if (Math.abs(m[k][j]) > Math.abs(m[pivot][j])) pivot = k;
    [m[j], m[pivot]] = [m[pivot], m[j]];
    const d = m[j][j] || 1e-9;
    for (let k = j; k < 7; k++) m[j][k] /= d;
    for (let k = 0; k < 6; k++)
      if (k !== j) {
        const f = m[k][j];
        for (let n = j; n < 7; n++) m[k][n] -= f * m[j][n];
      }
  }
  return m.map((r) => r[6]);
}
const basis = (x: number, y: number) => [1, x, y, x * y, x * x, y * y];
function backgroundModel(
  input: Uint8ClampedArray,
  width: number,
  height: number,
  protect: Stroke[],
) {
  const factor = Math.min(1, 280 / Math.max(width, height));
  const w = Math.max(2, Math.round(width * factor)),
    h = Math.max(2, Math.round(height * factor));
  const n = w * h,
    small = new Float32Array(n * 3),
    light = new Float32Array(n),
    border: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        j =
          (Math.min(height - 1, Math.round((y * (height - 1)) / (h - 1))) *
            width +
            Math.min(
              width - 1,
              Math.round((x * (width - 1)) / Math.max(1, w - 1)),
            )) *
          4;
      const r = input[j],
        g = input[j + 1],
        b = input[j + 2];
      small.set([r, g, b], i * 3);
      light[i] = luminance(r, g, b);
      if (x < 3 || y < 3 || x > w - 4 || y > h - 4) border.push(i);
    }
  const bright = border.filter(
    (i) =>
      light[i] > 145 &&
      Math.max(...small.subarray(i * 3, i * 3 + 3)) -
        Math.min(...small.subarray(i * 3, i * 3 + 3)) <
        45,
  );
  const reference = [0, 1, 2].map((c) =>
    quantile(
      bright.map((i) => small[i * 3 + c]),
      0.6,
    ),
  );
  const q = quantile(
    bright.map((i) => light[i]),
    0.6,
  );
  const mask = new Float32Array(n);
  const visited = new Uint8Array(n),
    queue = new Int32Array(n);
  let tail = 0,
    head = 0;
  const eligible = (i: number) => {
    const r = small[i * 3],
      g = small[i * 3 + 1],
      b = small[i * 3 + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    return (
      light[i] > Math.max(140, q - 60) &&
      chroma < 48 &&
      Math.abs(r - g - (reference[0] - reference[1])) < 22 &&
      Math.abs(b - g - (reference[2] - reference[1])) < 22
    );
  };
  for (const i of border)
    if (eligible(i) && !visited[i]) {
      visited[i] = 1;
      queue[tail++] = i;
    }
  while (head < tail) {
    const i = queue[head++],
      x = i % w,
      y = Math.floor(i / w);
    mask[i] = 1;
    const neighbors = [
      x > 0 ? i - 1 : -1,
      x < w - 1 ? i + 1 : -1,
      y > 0 ? i - w : -1,
      y < h - 1 ? i + w : -1,
    ];
    for (const j of neighbors)
      if (
        j >= 0 &&
        !visited[j] &&
        eligible(j) &&
        Math.abs(light[i] - light[j]) < 12
      ) {
        visited[j] = 1;
        queue[tail++] = j;
      }
  }
  // Erode near uncertain edges, then soften inward. This does not produce an alpha matte.
  const distance = new Float32Array(n).fill(8);
  for (let i = 0; i < n; i++) if (!mask[i]) distance[i] = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
      if (y) distance[i] = Math.min(distance[i], distance[i - w] + 1);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
      if (y < h - 1) distance[i] = Math.min(distance[i], distance[i + w] + 1);
    }
  for (let i = 0; i < n; i++) {
    mask[i] *= clamp((distance[i] - 2) / 5) * clamp((light[i] - (q - 55)) / 30);
  }
  // Protection brushes are evaluated at working resolution, stored as normalized vectors.
  const protection = new Float32Array(n);
  for (const s of protect) {
    const radius = s.radius * w,
      cx = s.x * (w - 1),
      cy = s.y * (h - 1);
    for (
      let y = Math.max(0, Math.floor(cy - radius));
      y < Math.min(h, cy + radius + 1);
      y++
    )
      for (
        let x = Math.max(0, Math.floor(cx - radius));
        x < Math.min(w, cx + radius + 1);
        x++
      ) {
        const d = Math.hypot(x - cx, y - cy) / radius;
        if (d < 1) {
          const a = clamp((1 - d) * 5);
          const i = y * w + x;
          protection[i] = s.erase
            ? protection[i] * (1 - a)
            : Math.max(protection[i], a);
        }
      }
  }
  for (let i = 0; i < n; i++) mask[i] *= 1 - protection[i];
  const rows: number[][] = [],
    channels: number[][] = [[], [], []];
  let covered = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i] > 0.8) {
      covered++;
      if (i % 3 === 0) {
        rows.push(basis((i % w) / (w - 1), Math.floor(i / w) / (h - 1)));
        for (let c = 0; c < 3; c++) channels[c].push(small[i * 3 + c]);
      }
    }
  }
  const borderFraction = bright.length / Math.max(1, border.length),
    coverage = covered / n;
  let central = 0,
    centralCandidates = 0;
  for (let y = Math.floor(h * 0.2); y < h * 0.8; y++)
    for (let x = Math.floor(w * 0.25); x < w * 0.75; x++) {
      central++;
      if (mask[y * w + x] > 0.8) centralCandidates++;
    }
  const ambiguous = centralCandidates / Math.max(1, central) > 0.85;
  const confidence =
    rows.length < 30
      ? 0
      : Math.min(1, borderFraction) *
        Math.min(1, coverage / 0.3) *
        (ambiguous ? 0.25 : 1);
  const coeff = channels.map((v) =>
    rows.length >= 30 ? fit(rows, v) : [q, 0, 0, 0, 0, 0],
  );
  return {
    mask,
    w,
    h,
    coeff,
    confidence,
    coverage,
    protection,
    referenceLight: q,
    referenceColor: reference,
  };
}
function sample(
  mask: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
) {
  const xx = clamp(x) * (w - 1),
    yy = clamp(y) * (h - 1),
    ix = Math.floor(xx),
    iy = Math.floor(yy),
    fx = xx - ix,
    fy = yy - iy;
  return (
    (mask[iy * w + ix] * (1 - fx) +
      mask[iy * w + Math.min(w - 1, ix + 1)] * fx) *
      (1 - fy) +
    (mask[Math.min(h - 1, iy + 1) * w + ix] * (1 - fx) +
      mask[Math.min(h - 1, iy + 1) * w + Math.min(w - 1, ix + 1)] * fx) *
      fy
  );
}
export function processPixels(
  input: Uint8ClampedArray,
  width: number,
  height: number,
  p: Adjustments,
  protect: Stroke[] = [],
) {
  const bg = backgroundModel(input, width, height, protect),
    out = new Uint8ClampedArray(input.length);
  const target = [1, 3, 5].map((i) =>
    parseInt(p.background.slice(i, i + 2), 16),
  );
  let beforeSum = 0,
    afterSum = 0,
    beforeSq = 0,
    afterSq = 0,
    count = 0,
    delta = 0,
    subject = 0,
    clipped = 0;
  const strength =
    (p.uniformity / 100) * (bg.confidence >= 0.7 ? 1 : bg.confidence * 0.3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        xx = x / Math.max(1, width - 1),
        yy = y / Math.max(1, height - 1);
      let mask =
        sample(bg.mask, bg.w, bg.h, xx, yy) * (input[i + 3] === 255 ? 1 : 0);
      const rgb = [input[i], input[i + 1], input[i + 2]],
        pixelLight = luminance(...(rgb as [number, number, number]));
      // Gate again at full resolution: fine hair and dark lace may fall between analysis samples.
      mask *= clamp((pixelLight - (bg.referenceLight - 55)) / 30);
      if (
        Math.max(...rgb) - Math.min(...rgb) > 48 ||
        Math.abs(
          rgb[0] - rgb[1] - (bg.referenceColor[0] - bg.referenceColor[1]),
        ) >= 22 ||
        Math.abs(
          rgb[2] - rgb[1] - (bg.referenceColor[2] - bg.referenceColor[1]),
        ) >= 22
      )
        mask = 0;
      const original = [input[i], input[i + 1], input[i + 2]],
        color = globalPixel(...(original as [number, number, number]), p);
      if (strength && mask) {
        const features = basis(xx, yy),
          estimate = bg.coeff.map((c) =>
            c.reduce((sum, v, j) => sum + v * features[j], 0),
          );
        const adjusted = globalPixel(
          ...(estimate.map((v) => Math.round(clamp(v, 0, 255))) as [
            number,
            number,
            number,
          ]),
          p,
        );
        const gray = luminance(...(adjusted as [number, number, number]));
        const targetGray = luminance(...(target as [number, number, number]));
        for (let c = 0; c < 3; c++) {
          const correction =
            targetGray -
            gray +
            ((target[c] - targetGray - (adjusted[c] - gray)) *
              p.backgroundNeutral) /
              100;
          color[c] += mask * strength * clamp(correction, -45, 45);
        }
      }
      out[i] = color[0];
      out[i + 1] = color[1];
      out[i + 2] = color[2];
      out[i + 3] = input[i + 3];
      if (i % 40 === 0) {
        if (mask > 0.8) {
          const a = luminance(...(original as [number, number, number])),
            b = luminance(out[i], out[i + 1], out[i + 2]);
          beforeSum += a;
          beforeSq += a * a;
          afterSum += b;
          afterSq += b * b;
          count++;
        }
        if (mask < 0.05 && input[i + 3] > 0) {
          delta +=
            (Math.abs(out[i] - input[i]) +
              Math.abs(out[i + 1] - input[i + 1]) +
              Math.abs(out[i + 2] - input[i + 2])) /
            3;
          subject++;
        }
        if (color.some((c) => c > 255 || c < 0)) clipped++;
      }
    }
  const metrics: Metrics = {
    backgroundCoverage: bg.coverage,
    confidence: bg.confidence,
    backgroundStdBefore: Math.sqrt(
      Math.max(
        0,
        beforeSq / Math.max(1, count) - (beforeSum / Math.max(1, count)) ** 2,
      ),
    ),
    backgroundStdAfter: Math.sqrt(
      Math.max(
        0,
        afterSq / Math.max(1, count) - (afterSum / Math.max(1, count)) ** 2,
      ),
    ),
    subjectDelta: delta / Math.max(1, subject),
    clippedPercent:
      (clipped / Math.max(1, Math.ceil((width * height) / 10))) * 100,
  };
  return {
    pixels: out,
    metrics,
    mask: bg.mask,
    protection: bg.protection,
    maskWidth: bg.w,
    maskHeight: bg.h,
  };
}
export function autoAdjust(
  input: Uint8ClampedArray,
  width: number,
  height: number,
): Adjustments {
  const lights: number[] = [],
    channels: number[][] = [[], [], []];
  for (
    let i = 0;
    i < input.length;
    i += Math.max(4, Math.floor(input.length / 40000 / 4) * 4)
  ) {
    if (input[i + 3] < 255) continue;
    const rgb = [input[i], input[i + 1], input[i + 2]],
      l = luminance(...(rgb as [number, number, number]));
    lights.push(l);
    if (l > 165 && Math.max(...rgb) - Math.min(...rgb) < 35)
      for (let c = 0; c < 3; c++) channels[c].push(rgb[c]);
  }
  const high = quantile(lights, 0.9);
  const exposure = clamp(
    Math.log2(linear(0.92) / Math.max(0.03, linear(high / 255))),
    -0.6,
    0.6,
  );
  const r = quantile(channels[0], 0.5),
    g = quantile(channels[1], 0.5),
    b = quantile(channels[2], 0.5);
  const neutral = channels[0].length > lights.length * 0.1;
  void width;
  void height;
  return {
    ...defaults,
    exposure: Math.round(exposure * 100) / 100,
    temperature: neutral ? Math.round(clamp((b - r) / 2.55, -15, 15)) : 0,
    tint: neutral ? Math.round(clamp((g - (r + b) / 2) / 2.55, -10, 10)) : 0,
    highlights: -8,
    shadows: 5,
  };
}
