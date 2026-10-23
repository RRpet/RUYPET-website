import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import JSZip from "jszip";
async function downloaded(page: Page, action: () => Promise<unknown>) {
  const promise = page.waitForEvent("download");
  await action();
  const d = await promise;
  const stream = await d.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return { name: d.suggestedFilename(), data: Buffer.concat(chunks) };
}
const fixture = "tests/fixtures/synthetic-studio.png";
async function waitPreview(page: Page) {
  await expect(page.getByText("正在计算…", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "导出当前优化图", exact: true }),
  ).toBeEnabled();
}
async function launch(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "PHOTO LAB · 批量修图", exact: true })
    .click();
}
test("模式 A 像素级验证：均匀化、主体/纹理/阴影保留与色彩参数", async ({
  page,
}) => {
  await page.goto("/");
  const source = (await readFile(fixture)).toString("base64");
  const result = await page.evaluate(async (source) => {
    // @ts-expect-error browser loads Vite-served TypeScript module
    const { processPixels } = await import("/src/photo-lab/engine.ts");
    // @ts-expect-error browser loads Vite-served TypeScript module
    const { defaults } = await import("/src/photo-lab/types.ts");
    const image = new Image();
    image.src = "data:image/png;base64," + source;
    await image.decode();
    const c = document.createElement("canvas");
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const input = ctx.getImageData(0, 0, c.width, c.height);
    const params = { ...defaults, uniformity: 90, backgroundNeutral: 90 };
    const result = processPixels(input.data, c.width, c.height, params);
    let changedSubject = 0;
    const changedSamples: unknown[] = [];
    for (let y = 180; y < 730; y++)
      for (let x = 170; x < 480; x++) {
        if (
          (x >= 190 && x <= 400 && y >= 200 && y <= 650) ||
          (x >= 420 && x < 480 && y >= 350 && y < 550) ||
          (x >= 180 &&
            x < 410 &&
            y >= 180 &&
            y < 200 &&
            input.data[(y * c.width + x) * 4] === 70) ||
          (x >= 200 && x < 400 && y >= 675 && y < 700)
        ) {
          const i = (y * c.width + x) * 4;
          for (let j = 0; j < 4; j++)
            if (input.data[i + j] !== result.pixels[i + j]) {
              changedSubject++;
              if (changedSamples.length < 8)
                changedSamples.push({
                  x,
                  y,
                  original: Array.from(input.data.slice(i, i + 3)),
                  after: Array.from(result.pixels.slice(i, i + 3)),
                });
            }
        }
      }
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(result.pixels), c.width, c.height),
      0,
      0,
    );
    const after = c.toDataURL("image/png");
    const identity = processPixels(input.data, c.width, c.height, defaults);
    const untouched = identity.pixels.every(
      (v: number, i: number) => v === input.data[i],
    );
    const exposed = processPixels(input.data, c.width, c.height, {
      ...defaults,
      exposure: 0.5,
    });
    const k = (300 * c.width + 210) * 4;
    const protectedResult = processPixels(
      input.data,
      c.width,
      c.height,
      params,
      [{ x: 0.1, y: 0.1, radius: 0.08, erase: false }],
    );
    const pos = (80 * c.width + 60) * 4;
    return {
      metrics: result.metrics,
      params,
      changedSubject,
      changedSamples,
      untouched,
      exposed: exposed.pixels[k] > input.data[k],
      protectedUnchanged: [0, 1, 2].every(
        (j) => protectedResult.pixels[pos + j] === input.data[pos + j],
      ),
      after,
    };
  }, source);
  expect(result.untouched).toBe(true);
  expect(result.exposed).toBe(true);
  expect(result.protectedUnchanged).toBe(true);
  expect(result.metrics.confidence).toBeGreaterThan(0.7);
  expect(result.metrics.backgroundStdAfter).toBeLessThan(
    result.metrics.backgroundStdBefore * 0.5,
  );
  expect(result.changedSubject).toBe(0);
  await mkdir("test-results/photo-lab", { recursive: true });
  await writeFile(
    "test-results/photo-lab/before.png",
    Buffer.from(source, "base64"),
  );
  await writeFile(
    "test-results/photo-lab/after.png",
    Buffer.from(result.after.split(",")[1], "base64"),
  );
  await writeFile(
    "test-results/photo-lab/measurements.json",
    JSON.stringify(
      {
        ...result,
        after: undefined,
        note: "Synthetic material/edge test, not a real dog photograph",
      },
      null,
      2,
    ),
  );
});
test("导入批次、逐张/批量预设、保护画笔、LOGO、项目恢复及商详复用", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await launch(page);
  await page
    .getByTestId("lab-import")
    .setInputFiles([fixture, "tests/fixtures/synthetic-studio.webp"]);
  await expect(page.locator(".lab-bottom")).toContainText("导入成功 2 张");
  await waitPreview(page);
  await page
    .getByRole("button", { name: "自动估计曝光 / 白平衡", exact: true })
    .click();
  await expect(page.locator(".lab-bottom")).toContainText("已估计曝光");
  await waitPreview(page);
  await page
    .getByRole("button", { name: "单张恢复原图参数", exact: true })
    .click();
  await page
    .getByRole("button", { name: "载入预设到本张", exact: true })
    .click();
  await page.getByLabel("背景均匀化", { exact: true }).fill("70");
  await page.getByLabel("新导入批次名称", { exact: true }).fill("重分组批次");
  await page
    .getByRole("button", { name: "所选归入新批次", exact: true })
    .click();
  await expect(page.locator(".lab-bottom")).toContainText(
    "已将 2 张原片归入新批次",
  );
  await page.getByLabel("预设名称", { exact: true }).fill("我的测试预设");
  await page
    .getByRole("button", { name: "保存当前参数为预设", exact: true })
    .click();
  await page
    .getByRole("button", { name: "应用到同拍摄批次", exact: true })
    .click();
  await waitPreview(page);
  await page.getByRole("button", { name: "保护主体", exact: true }).click();
  const box = (await page
    .getByLabel("背景作用区域和主体保护画笔", { exact: true })
    .boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7, {
    steps: 10,
  });
  await page.mouse.up();
  await waitPreview(page);
  await page.getByTestId("lab-logo").setInputFiles({
    name: "official-test.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="30"><path fill="black" d="M0 0h120v30H0z"/></svg>',
    ),
  });
  await expect(page.locator(".lab-bottom")).toContainText("LOGO 已作为独立");
  await page
    .getByLabel("LOGO 位置", { exact: true })
    .selectOption("bottom-center");
  await waitPreview(page);
  const saved = await downloaded(page, () =>
    page.getByRole("button", { name: "保存修图项目", exact: true }).click(),
  );
  const p = JSON.parse(saved.data.toString());
  expect(p.assets).toHaveLength(2);
  expect(Buffer.from(p.assets[0].data.split(",")[1], "base64")).toEqual(
    await readFile(fixture),
  );
  expect(p.lab.records[p.assets[0].id].protect.length).toBeGreaterThan(1);
  expect(p.lab.records[p.assets[1].id].adjustments.uniformity).toBe(70);
  expect(p.lab.logo.position).toBe("bottom-center");
  expect(p.lab.presets["我的测试预设"].uniformity).toBe(70);
  await page.reload();
  await page
    .getByRole("button", { name: "PHOTO LAB · 批量修图", exact: true })
    .click();
  await page.getByTestId("lab-open").setInputFiles({
    name: saved.name,
    mimeType: "application/json",
    buffer: saved.data,
  });
  await expect(page.locator(".lab-bottom")).toContainText("项目恢复成功");
  await waitPreview(page);
  await page.getByLabel("选择 synthetic-studio.png", { exact: true }).check();
  await page.getByLabel("选择 synthetic-studio.webp", { exact: true }).check();
  await page
    .getByRole("button", { name: "批量 ZIP 下载（所选）", exact: true })
    .click();
  await expect(page.locator(".lab-bottom")).toContainText("请先逐张审核");
  await page.getByLabel("已检查本张主体和透明材质", { exact: true }).check();
  await page
    .getByRole("button", { name: "预览 synthetic-studio.webp", exact: true })
    .click();
  await waitPreview(page);
  await page.getByLabel("亮度", { exact: true }).fill("3");
  await waitPreview(page);
  await page.getByLabel("已检查本张主体和透明材质", { exact: true }).check();
  const savedOverride = await downloaded(page, () =>
    page.getByRole("button", { name: "保存修图项目", exact: true }).click(),
  );
  const override = JSON.parse(savedOverride.data.toString());
  expect(
    override.lab.records[override.assets[0].id].adjustments.brightness,
  ).toBe(0);
  expect(
    override.lab.records[override.assets[1].id].adjustments.brightness,
  ).toBe(3);
  const zipFile = await downloaded(page, () =>
    page
      .getByRole("button", { name: "批量 ZIP 下载（所选）", exact: true })
      .click(),
  );
  await mkdir("test-results/photo-lab", { recursive: true });
  await writeFile("test-results/photo-lab/batch-output.zip", zipFile.data);
  await writeFile(
    "test-results/photo-lab/example.ruypet.json",
    savedOverride.data,
  );
  await page.screenshot({
    path: "test-results/photo-lab/workspace.png",
    fullPage: true,
  });
  const zip = await JSZip.loadAsync(zipFile.data);
  expect(Object.keys(zip.files).filter((n) => n.endsWith(".jpg"))).toHaveLength(
    2,
  );
  const report = JSON.parse(
    await zip.file("PHOTO-LAB-report.json")!.async("string"),
  );
  expect(report.photos).toHaveLength(2);
  expect(report.errors).toHaveLength(0);
  await page
    .getByRole("button", { name: "将所选优化图加入商详素材", exact: true })
    .click();
  await expect(page.locator(".lab-bottom")).toContainText(
    "新素材已加入 DETAIL BUILDER",
  );
  await page.getByRole("button", { name: "前往商详 →", exact: true }).click();
  await expect(page.locator(".assets .asset")).toHaveCount(4);
  await page
    .getByRole("button", {
      name: /001-synthetic-studio-optimized.png/,
      exact: false,
    })
    .click();
  await expect(page.getByLabel("宽度", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("ICC 转 sRGB、EXIF 转正、原尺寸/自定义输出和错误提示", async ({
  page,
}) => {
  await launch(page);
  await page
    .getByTestId("lab-import")
    .setInputFiles("tests/fixtures/adobe-rgb-orientation-6.jpg");
  await waitPreview(page);
  await page.getByLabel("修图导出格式", { exact: true }).selectOption("png");
  const output = await downloaded(page, () =>
    page.getByRole("button", { name: "导出当前优化图", exact: true }).click(),
  );
  const expected = (
    await readFile("tests/fixtures/adobe-rgb-expected-srgb.png")
  ).toString("base64");
  const diff = await page.evaluate(
    async ({ actual, expected }) => {
      const pixels = async (data: string) => {
        const i = new Image();
        i.src = "data:image/png;base64," + data;
        await i.decode();
        const c = document.createElement("canvas");
        c.width = i.width;
        c.height = i.height;
        const x = c.getContext("2d")!;
        x.drawImage(i, 0, 0);
        return {
          w: c.width,
          h: c.height,
          d: Array.from(x.getImageData(20, 20, 1, 1).data),
        };
      };
      const a = await pixels(actual),
        b = await pixels(expected);
      return {
        w: a.w,
        h: a.h,
        maxDelta: Math.max(...a.d.map((v, i) => Math.abs(v - b.d[i]))),
      };
    },
    { actual: output.data.toString("base64"), expected },
  );
  await mkdir("test-results/photo-lab", { recursive: true });
  await writeFile(
    "test-results/photo-lab/icc-orientation.json",
    JSON.stringify(diff, null, 2),
  );
  expect(diff.w).toBe(80);
  expect(diff.h).toBe(120);
  expect(diff.maxDelta).toBeLessThanOrEqual(4);
  await page.getByLabel("保持原始分辨率", { exact: true }).uncheck();
  await page.getByLabel("修图输出宽度", { exact: true }).fill("200");
  const small = await downloaded(page, () =>
    page.getByRole("button", { name: "导出当前优化图", exact: true }).click(),
  );
  const dimensions = await page.evaluate(async (data) => {
    const i = new Image();
    i.src = "data:image/png;base64," + data;
    await i.decode();
    return [i.width, i.height];
  }, small.data.toString("base64"));
  expect(dimensions).toEqual([200, 300]);
  await page.getByTestId("lab-logo").setInputFiles({
    name: "bad.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ),
  });
  await expect(page.locator(".lab-bottom")).toContainText("LOGO 导入失败");
  await page.getByTestId("lab-import").setInputFiles({
    name: "bad.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.locator(".lab-bottom")).toContainText("失败");
});
test("R7 级别 3230 万像素 worker 保持分辨率、低可信度降级与 alpha 保留", async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite browser module
    const { runWorker } = await import("/src/photo-lab/io.ts");
    // @ts-expect-error Vite browser module
    const { defaults } = await import("/src/photo-lab/types.ts");
    const width = 6960,
      height = 4640,
      data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] =
          data[i + 1] =
          data[i + 2] =
            220 + Math.round((20 * x) / width);
        data[i + 3] = 255;
      }
    data[3] = 100;
    const start = performance.now();
    const out = await runWorker(
      new ImageData(data, width, height),
      { ...defaults, uniformity: 80 },
      [],
    );
    return {
      width,
      height,
      pixels: out.pixels.length / 4,
      elapsedMs: Math.round(performance.now() - start),
      alpha: out.pixels[3],
      originalTransparentRGB: out.pixels[0],
      confidence: out.metrics.confidence,
    };
  });
  expect(result.pixels).toBe(6960 * 4640);
  expect(result.alpha).toBe(100);
  expect(result.originalTransparentRGB).toBe(220);
  expect(result.confidence).toBeLessThan(0.7);
  await mkdir("test-results/photo-lab", { recursive: true });
  await writeFile(
    "test-results/photo-lab/r7-resolution.json",
    JSON.stringify(
      {
        ...result,
        note: "Synthetic flat field at Canon R7 pixel dimensions; not a Canon photograph",
      },
      null,
      2,
    ),
  );
});
test("各项摄影参数确实改变像素且方向正确，JPG 透明区域为白底", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite browser module
    const { processPixels } = await import("/src/photo-lab/engine.ts");
    // @ts-expect-error Vite browser module
    const { defaults } = await import("/src/photo-lab/types.ts");
    // @ts-expect-error Vite browser module
    const { canvas, blobOf } = await import("/src/photo-lab/io.ts");
    const run = (rgb: number[], p: Record<string, number>) =>
      Array.from(
        processPixels(new Uint8ClampedArray([...rgb, 255]), 1, 1, {
          ...defaults,
          ...p,
        }).pixels.slice(0, 3),
      ) as number[];
    const bright = run([128, 128, 128], { brightness: 30 }),
      warm = run([128, 128, 128], { temperature: 30 }),
      magenta = run([128, 128, 128], { tint: 30 }),
      highlight = run([230, 230, 230], { highlights: -40 }),
      shadow = run([40, 40, 40], { shadows: 40 }),
      desat = run([180, 70, 50], { saturation: -100 }),
      darkContrast = run([60, 60, 60], { contrast: 30 }),
      lightContrast = run([200, 200, 200], { contrast: 30 });
    const { c } = canvas(2, 2),
      blob = await blobOf(c, "jpeg"),
      image = await createImageBitmap(blob),
      target = canvas(2, 2);
    target.ctx.drawImage(image, 0, 0);
    const matte = Array.from(target.ctx.getImageData(0, 0, 1, 1).data);
    image.close();
    return {
      bright,
      warm,
      magenta,
      highlight,
      shadow,
      desat,
      darkContrast,
      lightContrast,
      matte,
    };
  });
  expect(result.bright[0]).toBeGreaterThan(128);
  expect(result.warm[0]).toBeGreaterThan(result.warm[2]);
  expect(result.magenta[0]).toBeGreaterThan(result.magenta[1]);
  expect(result.highlight[0]).toBeLessThan(230);
  expect(result.shadow[0]).toBeGreaterThan(40);
  expect(
    Math.max(...result.desat) - Math.min(...result.desat),
  ).toBeLessThanOrEqual(1);
  expect(result.darkContrast[0]).toBeLessThan(60);
  expect(result.lightContrast[0]).toBeGreaterThan(200);
  expect(result.matte).toEqual([255, 255, 255, 255]);
});
