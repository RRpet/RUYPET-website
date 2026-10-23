import type { Asset } from "../model";
import type { Adjustments, Stroke, LogoSettings } from "./types";
import type { processPixels } from "./engine";
export const readData = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(Error("文件读取失败"));
    r.readAsDataURL(file);
  });
export async function decode(data: string) {
  // Browser decoder applies EXIF orientation once and converts embedded ICC into the canvas sRGB space.
  const response = await fetch(data);
  const bitmap = await createImageBitmap(await response.blob(), {
    imageOrientation: "from-image",
    colorSpaceConversion: "default",
  });
  return bitmap;
}
export function canvas(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d", {
    colorSpace: "srgb",
    willReadFrequently: true,
  });
  if (!ctx) throw Error("浏览器无法创建 sRGB 画布");
  return { c, ctx };
}
export async function imagePixels(data: string, maxSide = 0) {
  const image = await decode(data);
  try {
    if (image.width * image.height > 65e6)
      throw Error(
        "图片超过 6500 万像素，请先分批或缩小；佳能 R7 原尺寸可直接处理",
      );
    const scale = maxSide
      ? Math.min(1, maxSide / Math.max(image.width, image.height))
      : 1;
    const { c, ctx } = canvas(
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
    ctx.drawImage(image, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height);
  } finally {
    image.close();
  }
}
export type ProcessResult = ReturnType<typeof processPixels>;
export function runWorker(
  image: ImageData,
  params: Adjustments,
  protect: Stroke[],
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./processor.worker.ts", import.meta.url),
      { type: "module" },
    );
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      worker.terminate();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("处理已取消", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort);
    timer = setTimeout(() => {
      cleanup();
      reject(Error("处理超过 180 秒，请缩小图片或重新尝试"));
    }, 180000);
    worker.onerror = (e) => {
      cleanup();
      reject(Error(e.message || "处理线程失败"));
    };
    worker.onmessage = (e) => {
      cleanup();
      if (e.data.error) reject(Error(e.data.error));
      else resolve(e.data.result);
    };
    worker.postMessage(
      {
        pixels: image.data.buffer,
        width: image.width,
        height: image.height,
        params,
        protect,
      },
      { transfer: [image.data.buffer] },
    );
  });
}
export async function applyLogo(c: HTMLCanvasElement, logo?: LogoSettings) {
  if (!logo || logo.position === "none" || !logo.data) return;
  const image = await decode(logo.data);
  try {
    const ctx = c.getContext("2d")!;
    const w = (c.width * logo.width) / 100,
      h = (w * image.height) / image.width,
      margin = (Math.min(c.width, c.height) * logo.margin) / 100;
    let x = margin,
      y = margin;
    if (logo.position === "top-right") x = c.width - w - margin;
    if (logo.position === "top-center" || logo.position === "bottom-center")
      x = (c.width - w) / 2;
    if (logo.position === "bottom-center") y = c.height - h - margin;
    if (logo.position === "custom") {
      x = ((c.width - w) * logo.x) / 100;
      y = ((c.height - h) * logo.y) / 100;
    }
    ctx.save();
    ctx.globalAlpha = logo.opacity;
    ctx.drawImage(image, x, y, w, h);
    ctx.restore();
  } finally {
    image.close();
  }
}
export async function renderPhoto(
  asset: Asset,
  params: Adjustments,
  protect: Stroke[],
  logo?: LogoSettings,
  size?: { width: number; height: number },
) {
  const image = await imagePixels(asset.data);
  const width = image.width,
    height = image.height;
  const result = await runWorker(image, params, protect);
  const { c, ctx } = canvas(width, height);
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(result.pixels), width, height),
    0,
    0,
  );
  let output = c;
  if (size) {
    const target = canvas(size.width, size.height);
    target.ctx.imageSmoothingQuality = "high";
    target.ctx.drawImage(c, 0, 0, size.width, size.height);
    output = target.c;
    c.width = 0;
  }
  await applyLogo(output, logo);
  return { canvas: output, metrics: result.metrics };
}
export const blobOf = (c: HTMLCanvasElement, format: "png" | "jpeg") =>
  new Promise<Blob>((resolve, reject) => {
    let output = c;
    if (format === "jpeg") {
      const target = canvas(c.width, c.height);
      target.ctx.fillStyle = "#ffffff";
      target.ctx.fillRect(0, 0, c.width, c.height);
      target.ctx.drawImage(c, 0, 0);
      output = target.c;
    }
    output.toBlob(
      (b) => {
        if (output !== c) output.width = 0;
        if (b) resolve(b);
        else reject(Error("图片编码失败，可能超过浏览器尺寸限制"));
      },
      "image/" + format,
      0.96,
    );
  });
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export const safe = (s: string) =>
  s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 90) || "photo";
export async function logoFile(file: File) {
  if (file.size > 5e6) throw Error("LOGO 请小于 5MB");
  let data: string;
  if (
    file.type === "image/svg+xml" ||
    file.name.toLowerCase().endsWith(".svg")
  ) {
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    if (
      doc.doctype ||
      doc.querySelector("parsererror") ||
      doc.documentElement.localName !== "svg"
    )
      throw Error("无效 SVG");
    if (
      doc.querySelector(
        "script,foreignObject,image,use,style,animate,animateTransform,set",
      ) ||
      Array.from(doc.querySelectorAll("*")).some((el) =>
        Array.from(el.attributes).some(
          (a) =>
            /^on/i.test(a.name) ||
            /href/i.test(a.name) ||
            /url\s*\(/i.test(a.value),
        ),
      )
    )
      throw Error(
        "SVG 不允许脚本、外部引用或动态内容，请使用自包含路径 SVG / 透明 PNG",
      );
    data =
      "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(text)));
  } else {
    if (file.type !== "image/png")
      throw Error("LOGO 仅支持透明 PNG 或自包含 SVG");
    data = await readData(file);
  }
  const im = data.startsWith("data:image/svg")
    ? await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(Error("SVG 图像解码失败"));
        image.src = data;
      })
    : await decode(data);
  try {
    if (im.width * im.height > 16e6) throw Error("LOGO 像素过大");
    const { c, ctx } = canvas(im.width, im.height);
    ctx.drawImage(im, 0, 0);
    return c.toDataURL("image/png");
  } finally {
    if ("close" in im) im.close();
  }
}
