import { test, expect, type Page } from "@playwright/test";
import JSZip from "jszip";
async function downloaded(page: Page, action: () => Promise<unknown>) {
  const promise = page.waitForEvent("download");
  await action();
  const d = await promise;
  const stream = await d.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return { name: d.suggestedFilename(), data: Buffer.concat(chunks) };
}
async function dimensions(page: Page, data: Buffer, mime = "image/png") {
  return page.evaluate(
    async ({ data, mime }) => {
      const im = new Image();
      im.src = `data:${mime};base64,${data}`;
      await im.decode();
      return [im.width, im.height];
    },
    { data: data.toString("base64"), mime },
  );
}
test("完整工作流：导入、编辑、保存恢复、页面与各种导出", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("素材工作台")).toBeVisible();
  const image = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 800;
    const x = c.getContext("2d")!;
    x.fillStyle = "#ae7663";
    x.fillRect(0, 0, 600, 800);
    x.fillStyle = "#242833";
    x.fillRect(600, 0, 600, 800);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.getByTestId("image-input").setInputFiles([
    {
      name: "原始商品.png",
      mimeType: "image/png",
      buffer: Buffer.from(image, "base64"),
    },
    {
      name: "第二张.png",
      mimeType: "image/png",
      buffer: Buffer.from(image, "base64"),
    },
  ]);
  await expect(page.getByRole("status")).toContainText("已导入 2 张");
  await page.getByRole("button", { name: "原始商品.png", exact: true }).click();
  await page.getByLabel("X 位置", { exact: true }).fill("40");
  await page.getByLabel("Y 位置", { exact: true }).fill("200");
  await page.getByLabel("裁切左侧 %", { exact: true }).fill("10");
  await page.getByLabel("裁切宽度 %", { exact: true }).fill("70");
  await page.getByRole("button", { name: "恢复比例", exact: true }).click();
  await page.getByRole("button", { name: "T 添加文字", exact: true }).click();
  await page
    .getByLabel("文字内容", { exact: true })
    .fill("RUYPET 商品介绍\n真实照片 · 原样呈现");
  await page.getByLabel("字号", { exact: true }).fill("32");
  await page.getByLabel("对齐", { exact: true }).selectOption("center");
  await page.getByLabel("项目名称", { exact: true }).fill("商品测试");
  await page.getByLabel("页面高度", { exact: true }).fill("1200");
  const saved = await downloaded(page, () =>
    page.getByRole("button", { name: "保存项目", exact: true }).click(),
  );
  const project = JSON.parse(saved.data.toString());
  expect(project.assets).toHaveLength(2);
  expect(project.assets[0].data).toBe("data:image/png;base64," + image);
  expect(project.pages[0].elements[0].cropX).toBe(0.1);
  expect(project.pages[0].elements[1].fontSize).toBe(32);
  expect(project.pages[0].height).toBe(1200);
  await page.reload();
  await page
    .getByTestId("project-input")
    .setInputFiles({
      name: saved.name,
      mimeType: "application/json",
      buffer: saved.data,
    });
  await expect(page.getByRole("status")).toContainText("项目恢复成功");
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(
    "商品测试",
  );
  await page.getByRole("button", { name: "复制页", exact: true }).click();
  await expect(page.getByLabel("页面名称", { exact: true })).toHaveValue(
    "主视觉 副本",
  );
  await page.getByRole("button", { name: "上移", exact: true }).click();
  await page.getByRole("button", { name: "导出检查", exact: true }).click();
  const png = await downloaded(page, () =>
    page.getByRole("button", { name: "导出当前页", exact: true }).click(),
  );
  expect(await dimensions(page, png.data)).toEqual([790, 1200]);
  const zip = await downloaded(page, () =>
    page.getByRole("button", { name: "全部页面 ZIP", exact: true }).click(),
  );
  const archive = await JSZip.loadAsync(zip.data);
  const entries = Object.keys(archive.files);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toContain("副本");
  for (const name of entries)
    expect(
      await dimensions(page, await archive.files[name].async("nodebuffer")),
    ).toEqual([790, 1200]);
  const long = await downloaded(page, () =>
    page.getByRole("button", { name: "整套长图", exact: true }).click(),
  );
  expect(await dimensions(page, long.data)).toEqual([790, 2400]);
  await page.getByLabel("图片格式", { exact: true }).selectOption("jpeg");
  const jpg = await downloaded(page, () =>
    page.getByRole("button", { name: "导出当前页", exact: true }).click(),
  );
  expect(jpg.name).toMatch(/\.jpg$/);
  expect(await dimensions(page, jpg.data, "image/jpeg")).toEqual([790, 1200]);
  await page.getByRole("button", { name: "品牌样式", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 添加服装模板", exact: true })
    .click();
  const templated = await downloaded(page, () =>
    page.getByRole("button", { name: "保存项目", exact: true }).click(),
  );
  expect(JSON.parse(templated.data.toString()).pages).toHaveLength(9);
  await page.getByRole("button", { name: "↶ 撤销", exact: true }).click();
  const undone = await downloaded(page, () =>
    page.getByRole("button", { name: "保存项目", exact: true }).click(),
  );
  expect(JSON.parse(undone.data.toString()).pages).toHaveLength(2);
  expect(errors).toEqual([]);
});
test("损坏文件保护、质量警告与缺图导出阻止", async ({ page }) => {
  await page.goto("/");
  await page
    .getByTestId("project-input")
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"version":99}'),
    });
  await expect(page.getByRole("status")).toContainText("打开失败");
  await page.getByRole("button", { name: "T 添加文字", exact: true }).click();
  await page
    .getByLabel("文字内容", { exact: true })
    .fill("非常长的文字\n".repeat(100));
  await page.getByRole("button", { name: "导出检查", exact: true }).click();
  await expect(page.getByText(/文字溢出，请增高文本框/)).toBeVisible();
  const saved = await downloaded(page, () =>
    page.getByRole("button", { name: "保存项目", exact: true }).click(),
  );
  const p = JSON.parse(saved.data.toString());
  p.pages[0].elements[0].type = "image";
  p.pages[0].elements[0].assetId = "missing";
  await page
    .getByTestId("project-input")
    .setInputFiles({
      name: "missing.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(p)),
    });
  await expect(page.getByText(/：缺失图片/)).toBeVisible();
  await page.getByRole("button", { name: "导出当前页", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "缺失图片，请替换后导出",
  );
});
test("实际拖拽、缩放、裁切、图层与低清警告", async ({ page }) => {
  await page.goto("/");
  const images = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 100;
    c.height = 100;
    const x = c.getContext("2d")!;
    x.fillStyle = "red";
    x.fillRect(0, 0, 50, 100);
    x.fillStyle = "blue";
    x.fillRect(50, 0, 50, 100);
    return ["image/jpeg", "image/webp"].map((type) => ({
      type,
      data: c.toDataURL(type).split(",")[1],
    }));
  });
  await page
    .getByTestId("image-input")
    .setInputFiles(
      images.map((im, i) => ({
        name: i ? "small.webp" : "small.jpg",
        mimeType: im.type,
        buffer: Buffer.from(im.data, "base64"),
      })),
    );
  await expect(page.getByRole("status")).toContainText("已导入 2 张");
  await page
    .getByRole("button", { name: "small.webp", exact: true })
    .dragTo(page.locator(".canvas"), { targetPosition: { x: 70, y: 100 } });
  await expect(page.getByLabel("宽度", { exact: true })).toHaveValue("100");
  // Drag the Konva node using actual browser pointer input.
  const box = (await page.locator(".canvas").boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 110);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 150, { steps: 10 });
  await page.mouse.up();
  expect(
    Number(await page.getByLabel("X 位置", { exact: true }).inputValue()),
  ).toBeGreaterThan(120);
  await page.getByLabel("X 位置", { exact: true }).fill("0");
  await page.getByLabel("Y 位置", { exact: true }).fill("0");
  // Resize through the bottom-right transformer handle.
  await page.mouse.move(box.x + 65, box.y + 65);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 130, { steps: 10 });
  await page.mouse.up();
  expect(
    Number(await page.getByLabel("宽度", { exact: true }).inputValue()),
  ).toBeGreaterThan(150);
  await page.getByLabel("裁切左侧 %", { exact: true }).fill("50");
  await page.getByLabel("裁切宽度 %", { exact: true }).fill("50");
  await page.getByLabel("宽度", { exact: true }).fill("790");
  await page.getByLabel("高度", { exact: true }).fill("1000");
  await page.getByRole("button", { name: "导出检查", exact: true }).click();
  await expect(page.getByText(/原图裁切区域分辨率低于导出尺寸/)).toBeVisible();
  const png = await downloaded(page, () =>
    page.getByRole("button", { name: "导出当前页", exact: true }).click(),
  );
  const pixel = await page.evaluate(async (data) => {
    const im = new Image();
    im.src = "data:image/png;base64," + data;
    await im.decode();
    const c = document.createElement("canvas");
    c.width = 790;
    c.height = 1000;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(im, 0, 0);
    return Array.from(ctx.getImageData(400, 400, 1, 1).data);
  }, png.data.toString("base64"));
  expect(pixel[2]).toBeGreaterThan(230);
  expect(pixel[0]).toBeLessThan(30);
  await page.getByRole("button", { name: "图层属性", exact: true }).click();
  await page.getByRole("button", { name: "重置裁切", exact: true }).click();
  await expect(page.getByLabel("裁切宽度 %", { exact: true })).toHaveValue(
    "100",
  );
  await page.getByRole("button", { name: "复制图层", exact: true }).click();
  await page.getByRole("button", { name: "下移一层", exact: true }).click();
  const saved = await downloaded(page, () =>
    page.getByRole("button", { name: "保存项目", exact: true }).click(),
  );
  expect(JSON.parse(saved.data.toString()).pages[0].elements).toHaveLength(2);
  await page.screenshot({
    path: "test-results/editor-desktop.png",
    fullPage: true,
  });
});
