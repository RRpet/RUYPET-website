export type Adjustments = {
  exposure: number;
  brightness: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  contrast: number;
  saturation: number;
  uniformity: number;
  backgroundNeutral: number;
  background: string;
};
export type Stroke = { x: number; y: number; radius: number; erase: boolean };
export type PhotoRecord = {
  adjustments: Adjustments;
  protect: Stroke[];
  reviewed: boolean;
};
export type LogoSettings = {
  data: string;
  name: string;
  position:
    | "none"
    | "top-left"
    | "top-right"
    | "top-center"
    | "bottom-center"
    | "custom";
  width: number;
  margin: number;
  opacity: number;
  x: number;
  y: number;
};
export type LabState = {
  records: Record<string, PhotoRecord>;
  presets: Record<string, Adjustments>;
  batches: { id: string; name: string }[];
  logo?: LogoSettings;
};
export type Metrics = {
  backgroundCoverage: number;
  confidence: number;
  backgroundStdBefore: number;
  backgroundStdAfter: number;
  subjectDelta: number;
  clippedPercent: number;
};
export const defaults: Adjustments = {
  exposure: 0,
  brightness: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  contrast: 0,
  saturation: 0,
  uniformity: 0,
  backgroundNeutral: 0,
  background: "#f7f7f5",
};
// Editable starting points, not automatic promises for every product/material.
export const presets: Record<string, Adjustments> = {
  "RUYPET Clean White": {
    ...defaults,
    highlights: -8,
    shadows: 5,
    uniformity: 65,
    backgroundNeutral: 40,
    background: "#fafafa",
  },
  "RUYPET Soft Gray": {
    ...defaults,
    highlights: -12,
    shadows: 8,
    uniformity: 50,
    backgroundNeutral: 35,
    background: "#f0f0ee",
  },
  "RUYPET Natural Studio": {
    ...defaults,
    highlights: -6,
    shadows: 4,
    uniformity: 25,
    backgroundNeutral: 15,
    background: "#f5f5f3",
  },
};
export const newLab = (): LabState => ({
  records: {},
  presets: structuredClone(presets),
  batches: [],
});
export const recordFor = (lab: LabState, id: string): PhotoRecord =>
  (Object.hasOwn(lab.records, id) ? lab.records[id] : undefined) || {
    adjustments: { ...defaults },
    protect: [],
    reviewed: false,
  };
export function validateLab(value: unknown): LabState {
  const l = value as LabState;
  const number = (v: unknown, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  const adjustment = (a: Adjustments) =>
    a &&
    number(a.exposure, -2, 2) &&
    [
      "brightness",
      "temperature",
      "tint",
      "highlights",
      "shadows",
      "contrast",
      "saturation",
    ].every((k) => number(a[k as keyof Adjustments], -100, 100)) &&
    number(a.uniformity, 0, 100) &&
    number(a.backgroundNeutral, 0, 100) &&
    /^#[0-9a-f]{6}$/i.test(a.background);
  if (
    !l ||
    !l.records ||
    !l.presets ||
    !Array.isArray(l.batches) ||
    !l.batches.every(
      (b) => typeof b.id === "string" && typeof b.name === "string",
    ) ||
    !Object.values(l.presets).every(adjustment)
  )
    throw Error("PHOTO LAB 预设或批次数据无效");
  for (const r of Object.values(l.records)) {
    if (
      !r ||
      !adjustment(r.adjustments) ||
      !Array.isArray(r.protect) ||
      r.protect.length > 20000 ||
      typeof r.reviewed !== "boolean" ||
      !r.protect.every(
        (s) =>
          number(s.x, 0, 1) &&
          number(s.y, 0, 1) &&
          number(s.radius, 0.001, 1) &&
          typeof s.erase === "boolean",
      )
    )
      throw Error("PHOTO LAB 调整或保护画笔数据无效");
  }
  if (l.logo) {
    const g = l.logo;
    if (
      typeof g.data !== "string" ||
      !/^data:image\/png;base64,/.test(g.data) ||
      typeof g.name !== "string" ||
      ![
        "none",
        "top-left",
        "top-right",
        "top-center",
        "bottom-center",
        "custom",
      ].includes(g.position) ||
      !number(g.width, 1, 80) ||
      !number(g.margin, 0, 40) ||
      !number(g.opacity, 0, 1) ||
      !number(g.x, 0, 100) ||
      !number(g.y, 0, 100)
    )
      throw Error("LOGO 数据无效");
  }
  return l;
}
