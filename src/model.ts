export const WIDTH = 790;
export type Asset = {
  id: string;
  name: string;
  data: string;
  width: number;
  height: number;
};
export type Element = {
  id: string;
  type: "image" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  assetId?: string;
  text?: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
};
export type Page = {
  id: string;
  name: string;
  height: number;
  elements: Element[];
};
export type Brand = {
  font: string;
  background: string;
  text: string;
  accent: string;
  margin: number;
  heading: number;
  body: number;
};
export type Project = {
  version: 1;
  name: string;
  brand: Brand;
  assets: Asset[];
  pages: Page[];
};
export const id = () => crypto.randomUUID();
export const neutralBrand: Brand = {
  font: "Arial",
  background: "#ffffff",
  text: "#222222",
  accent: "#666666",
  margin: 56,
  heading: 48,
  body: 24,
};
export const page = (name = "新页面"): Page => ({
  id: id(),
  name,
  height: 1000,
  elements: [],
});
export const initial = (): Project => ({
  version: 1,
  name: "未命名商品详情",
  brand: { ...neutralBrand },
  assets: [],
  pages: [page("主视觉")],
});
export function textElement(
  text: string,
  brand: Brand,
  y = 80,
  heading = false,
): Element {
  return {
    id: id(),
    type: "text",
    x: brand.margin,
    y,
    width: WIDTH - brand.margin * 2,
    height: heading ? 100 : 180,
    opacity: 1,
    text,
    fontSize: heading ? brand.heading : brand.body,
    fontFamily: brand.font,
    color: brand.text,
    align: "left",
    lineHeight: 1.5,
    cropX: 0,
    cropY: 0,
    cropWidth: 1,
    cropHeight: 1,
  };
}
// Template content remains independent of brand configuration.
export const clothingTemplate = [
  ["主视觉", "商品名称", "填写商品卖点与系列介绍"],
  ["模特展示", "穿着展示", "请放入原始模特照片"],
  ["颜色展示", "可选颜色", "请使用真实商品照片展示颜色"],
  ["工艺细节", "细节与材质", "填写真实面料、工艺与护理说明"],
  [
    "尺码信息",
    "尺码指南",
    "尺码    胸围    衣长\nS         —         —\nM        —         —\nL         —         —\n请替换为实测数据，注明单位与测量误差",
  ],
  ["品牌故事", "关于品牌", "填写经确认的品牌故事"],
  ["购买须知", "购买须知", "填写发货、退换货与洗护说明"],
];
export function templatePages(brand: Brand): Page[] {
  return clothingTemplate.map(([name, title, body]) => ({
    ...page(name),
    elements: [
      textElement(title, brand, 80, true),
      textElement(body, brand, 210),
    ],
  }));
}
export function parseProject(value: unknown): Project {
  const p = value as Project;
  if (
    !p ||
    p.version !== 1 ||
    typeof p.name !== "string" ||
    !Array.isArray(p.pages) ||
    !p.pages.length ||
    p.pages.length > 100 ||
    !Array.isArray(p.assets) ||
    !p.brand
  )
    throw Error("不是有效的 V1 项目文件");
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (
    !["font", "background", "text", "accent"].every(
      (k) =>
        typeof (p.brand as unknown as Record<string, unknown>)[k] === "string",
    ) ||
    ![p.brand.margin, p.brand.heading, p.brand.body].every(finite)
  )
    throw Error("品牌配置无效");
  if (
    p.brand.margin < 0 ||
    p.brand.margin > 300 ||
    p.brand.heading < 12 ||
    p.brand.heading > 150 ||
    p.brand.body < 8 ||
    p.brand.body > 100
  )
    throw Error("品牌尺寸超出范围");
  const ids = new Set<string>();
  const pageIds = new Set<string>();
  const elementIds = new Set<string>();
  for (const a of p.assets) {
    if (
      typeof a.id !== "string" ||
      ids.has(a.id) ||
      typeof a.name !== "string" ||
      !/^data:image\/(png|jpeg|webp);base64,/.test(a.data) ||
      !finite(a.width) ||
      !finite(a.height) ||
      a.width <= 0 ||
      a.height <= 0
    )
      throw Error("素材数据无效");
    ids.add(a.id);
  }
  for (const pg of p.pages) {
    if (pageIds.has(pg.id)) throw Error("页面标识重复");
    pageIds.add(pg.id);
    if (
      typeof pg.id !== "string" ||
      typeof pg.name !== "string" ||
      !finite(pg.height) ||
      pg.height < 100 ||
      pg.height > 10000 ||
      !Array.isArray(pg.elements)
    )
      throw Error("页面数据无效");
    for (const e of pg.elements) {
      if (elementIds.has(e.id)) throw Error("图层标识重复");
      elementIds.add(e.id);
      if (
        typeof e.id !== "string" ||
        !["image", "text"].includes(e.type) ||
        ![
          e.x,
          e.y,
          e.width,
          e.height,
          e.opacity,
          e.fontSize,
          e.lineHeight,
          e.cropX,
          e.cropY,
          e.cropWidth,
          e.cropHeight,
        ].every(finite) ||
        e.width <= 0 ||
        e.height <= 0 ||
        e.opacity < 0 ||
        e.opacity > 1 ||
        e.fontSize <= 0 ||
        e.lineHeight <= 0 ||
        e.cropX < 0 ||
        e.cropY < 0 ||
        e.cropWidth <= 0 ||
        e.cropHeight <= 0 ||
        e.cropX + e.cropWidth > 1.001 ||
        e.cropY + e.cropHeight > 1.001 ||
        typeof e.fontFamily !== "string" ||
        typeof e.color !== "string" ||
        !["left", "center", "right"].includes(e.align) ||
        (e.type === "text" && typeof e.text !== "string")
      )
        throw Error("图层数据无效");
    }
  }
  return p;
}
