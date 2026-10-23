import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type PointerEvent,
} from "react";
import JSZip from "jszip";
import { id, parseProject, type Project, type Asset } from "../model";
import { autoAdjust } from "./engine";
import {
  newLab,
  recordFor,
  defaults,
  type Adjustments,
  type Stroke,
  type Metrics,
  type LabState,
  type LogoSettings,
} from "./types";
import {
  readData,
  decode,
  imagePixels,
  runWorker,
  canvas,
  applyLogo,
  renderPhoto,
  blobOf,
  download,
  safe,
  logoFile,
} from "./io";
import { unavailableMatting } from "./segmentation";
import "./photo-lab.css";
type Props = {
  project: Project;
  setProject: Dispatch<SetStateAction<Project>>;
  dirty: boolean;
  setDirty: Dispatch<SetStateAction<boolean>>;
  openBuilder: () => void;
};
const labels: Record<keyof Omit<Adjustments, "background">, string> = {
  exposure: "曝光 EV",
  brightness: "亮度",
  temperature: "色温（冷 → 暖）",
  tint: "色调（绿 → 洋红）",
  highlights: "高光",
  shadows: "阴影",
  contrast: "对比度",
  saturation: "饱和度",
  uniformity: "背景均匀化",
  backgroundNeutral: "背景偏色校正",
};
const emptyLab = newLab();
export default function PhotoLab({
  project,
  setProject,
  dirty,
  setDirty,
  openBuilder,
}: Props) {
  const lab = project.lab || emptyLab;
  const originals = project.assets.filter((a) => !a.sourceId);
  const [active, setActive] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState("all");
  const [batchName, setBatchName] = useState("拍摄批次 01");
  const [preset, setPreset] = useState("RUYPET Clean White");
  const [presetName, setPresetName] = useState("");
  const [status, setStatus] = useState("本机 sRGB 工作流 · 原图只读");
  const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [metrics, setMetrics] = useState<Metrics>();
  const [zoom, setZoom] = useState("fit");
  const [overlay, setOverlay] = useState(false);
  const [brush, setBrush] = useState<"off" | "protect" | "erase">("off");
  const [radius, setRadius] = useState(4);
  const [format, setFormat] = useState<"png" | "jpeg">("jpeg");
  const [outputWidth, setOutputWidth] = useState(2000);
  const [originalSize, setOriginalSize] = useState(true);
  const [progress, setProgress] = useState("");
  const fileInput = useRef<HTMLInputElement>(null),
    openInput = useRef<HTMLInputElement>(null),
    logoInput = useRef<HTMLInputElement>(null);
  const beforeRef = useRef<HTMLCanvasElement>(null),
    afterRef = useRef<HTMLCanvasElement>(null),
    overlayRef = useRef<HTMLCanvasElement>(null),
    beforeScroll = useRef<HTMLDivElement>(null),
    afterScroll = useRef<HTMLDivElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const drawing = useRef(false);
  const visible = originals.filter(
    (a) =>
      batch === "all" ||
      (batch === "unassigned" ? !a.batchId : a.batchId === batch),
  );
  const current = visible.find((a) => a.id === active) || visible[0];
  const record = useMemo(
    () => recordFor(lab, current?.id || ""),
    [lab.records, current?.id],
  );
  const params = record.adjustments;
  const selectedAssets = originals.filter((a) => selected.includes(a.id));
  function editLab(fn: (l: LabState) => LabState) {
    setProject((p) => ({ ...p, lab: fn(p.lab || newLab()) }));
    setDirty(true);
  }
  function patch(values: Partial<Adjustments>) {
    if (!current) return;
    editLab((l) => ({
      ...l,
      records: {
        ...l.records,
        [current.id]: {
          ...recordFor(l, current.id),
          adjustments: { ...recordFor(l, current.id).adjustments, ...values },
          reviewed: false,
        },
      },
    }));
  }
  function setRecordProtect(protect: Stroke[]) {
    if (current)
      editLab((l) => ({
        ...l,
        records: {
          ...l.records,
          [current.id]: {
            ...recordFor(l, current.id),
            protect,
            reviewed: false,
          },
        },
      }));
  }
  function patchLogo(values: Partial<LogoSettings>) {
    editLab((l) => ({
      ...l,
      logo: l.logo ? { ...l.logo, ...values } : undefined,
      records: Object.fromEntries(
        Object.entries(l.records).map(([k, r]) => [
          k,
          { ...r, reviewed: false },
        ]),
      ),
    }));
  }
  async function importFiles(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    const assets: Asset[] = [],
      errors: string[] = [];
    const batchId = id();
    for (const file of Array.from(files)) {
      try {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
          throw Error(
            "仅支持 JPG / PNG / WebP；CR3 请先用佳能 DPP 转为嵌入 ICC 的 JPG",
          );
        if (file.size > 80e6) throw Error("单张文件超过 80MB");
        const data = await readData(file),
          image = await decode(data);
        try {
          if (image.width * image.height > 65e6)
            throw Error("超过 6500 万像素");
          assets.push({
            id: id(),
            name: file.name,
            data,
            width: image.width,
            height: image.height,
            batchId,
          });
        } finally {
          image.close();
        }
      } catch (e) {
        errors.push(file.name + "：" + (e as Error).message);
      }
    }
    if (assets.length) {
      setProject((p) => ({
        ...p,
        assets: [...p.assets, ...assets],
        lab: {
          ...(p.lab || newLab()),
          batches: [
            ...(p.lab || newLab()).batches,
            { id: batchId, name: batchName.trim() || "未命名批次" },
          ],
        },
      }));
      setActive(assets[0].id);
      setSelected(assets.map((a) => a.id));
      setBatch(batchId);
      setDirty(true);
    }
    setStatus(
      `导入成功 ${assets.length} 张${errors.length ? "；失败 " + errors.join("；") : " · 原始字节保留"}`,
    );
    setBusy(false);
    if (fileInput.current) fileInput.current.value = "";
  }
  async function automatic() {
    if (!current) return;
    setBusy(true);
    try {
      const pixels = await imagePixels(current.data, 800);
      const suggested = autoAdjust(pixels.data, pixels.width, pixels.height);
      patch(suggested);
      setStatus(
        "已估计曝光和中性区域白平衡；请对照真实商品校正，自动结果不是色彩承诺",
      );
    } catch (e) {
      setStatus("自动调整失败：" + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function applyGroup(scope: "selected" | "batch") {
    if (!current) return;
    if (scope === "batch" && !current.batchId) {
      setStatus("当前原片未分组，请先将所选照片归入拍摄批次");
      return;
    }
    const targets =
      scope === "selected"
        ? selectedAssets
        : originals.filter((a) => a.batchId === current.batchId);
    if (!targets.length) {
      setStatus("请先选择照片");
      return;
    }
    editLab((l) => {
      const records = { ...l.records };
      for (const a of targets)
        records[a.id] = {
          ...recordFor(l, a.id),
          adjustments: { ...params },
          reviewed: false,
        };
      return { ...l, records };
    });
    setStatus(
      `参数已应用到 ${targets.length} 张；逐张保护画笔保留，审核状态已重置`,
    );
  }
  // Debounced previews and a disposable worker prevent stale processing from overwriting a newer edit.
  useEffect(() => {
    if (!current) {
      for (const ref of [beforeRef, afterRef, overlayRef])
        if (ref.current) {
          ref.current.width = 1;
          ref.current.height = 1;
        }
      setMetrics(undefined);
      setPreviewError("");
      setPreviewBusy(false);
      return;
    }
    const controller = new AbortController();
    let dead = false;
    setPreviewBusy(true);
    const timer = setTimeout(async () => {
      try {
        const image = await imagePixels(
          current.data,
          zoom === "fit" ? 1400 : 0,
        );
        if (dead) return;
        const before = beforeRef.current!;
        before.width = image.width;
        before.height = image.height;
        before
          .getContext("2d", { colorSpace: "srgb" })!
          .putImageData(image, 0, 0);
        const result = await runWorker(
          image,
          params,
          record.protect,
          controller.signal,
        );
        if (dead) return;
        const after = afterRef.current!;
        after.width = before.width;
        after.height = before.height;
        after
          .getContext("2d", { colorSpace: "srgb" })!
          .putImageData(
            new ImageData(
              new Uint8ClampedArray(result.pixels),
              after.width,
              after.height,
            ),
            0,
            0,
          );
        await applyLogo(after, lab.logo);
        if (dead) return;
        const over = overlayRef.current!;
        over.width = result.maskWidth;
        over.height = result.maskHeight;
        const data = new ImageData(over.width, over.height);
        for (let i = 0; i < result.mask.length; i++) {
          const protectedArea = result.protection[i];
          data.data[i * 4] = protectedArea > 0.1 ? 30 : 240;
          data.data[i * 4 + 1] = protectedArea > 0.1 ? 140 : 140;
          data.data[i * 4 + 2] = protectedArea > 0.1 ? 255 : 40;
          data.data[i * 4 + 3] = Math.max(protectedArea, result.mask[i]) * 120;
        }
        over.getContext("2d")!.putImageData(data, 0, 0);
        setMetrics(result.metrics);
        setPreviewError("");
      } catch (e) {
        if (!dead && (e as Error).name !== "AbortError") {
          setPreviewError((e as Error).message);
          setMetrics(undefined);
        }
      } finally {
        if (!dead) setPreviewBusy(false);
      }
    }, 180);
    return () => {
      dead = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [current?.id, current?.data, params, record.protect, lab.logo, zoom]);
  function paint(e: PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const s: Stroke = {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
      radius: radius / 100,
      erase: brush === "erase",
    };
    const previous = strokes.current.at(-1);
    if (previous) {
      const distance = Math.hypot(
          (s.x - previous.x) * rect.width,
          (s.y - previous.y) * rect.height,
        ),
        steps = Math.ceil(distance / Math.max(1, s.radius * rect.width * 0.35));
      for (let i = 1; i < steps; i++)
        strokes.current.push({
          ...s,
          x: previous.x + ((s.x - previous.x) * i) / steps,
          y: previous.y + ((s.y - previous.y) * i) / steps,
        });
    }
    strokes.current.push(s);
    const ctx = e.currentTarget.getContext("2d")!;
    ctx.fillStyle =
      brush === "erase" ? "rgba(255,255,255,.5)" : "rgba(30,140,255,.7)";
    ctx.beginPath();
    ctx.arc(
      s.x * e.currentTarget.width,
      s.y * e.currentTarget.height,
      s.radius * e.currentTarget.width,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  function endPaint(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (record.protect.length + strokes.current.length > 20000) {
      setStatus(
        "保护笔迹达到安全上限，本次笔迹未保存；请先保存项目，使用较大画笔减少笔迹数量",
      );
    } else setRecordProtect([...record.protect, ...strokes.current]);
    strokes.current = [];
  }
  function save() {
    download(
      new Blob([JSON.stringify(project)], { type: "application/json" }),
      safe(project.name) + ".ruypet.json",
    );
    setDirty(false);
    setStatus(
      "项目已生成：含原图、批次、调整、保护画笔、预设与独立 LOGO，请确认下载成功",
    );
  }
  async function restore(file?: File) {
    if (!file) return;
    try {
      if (
        dirty &&
        !confirm("打开项目将替换当前会话，未保存更改会丢失，是否继续？")
      )
        return;
      const next = parseProject(JSON.parse(await file.text()));
      for (const a of next.assets) {
        const im = await decode(a.data);
        try {
          if (im.width !== a.width || im.height !== a.height)
            throw Error("图片尺寸与项目不符");
        } finally {
          im.close();
        }
      }
      setProject(next);
      setSelected([]);
      setActive(next.assets[0]?.id || "");
      setBatch("all");
      setDirty(false);
      setStatus("项目恢复成功 · PHOTO LAB 与商详共用素材已恢复");
    } catch (e) {
      setStatus("恢复失败：" + (e as Error).message);
    } finally {
      if (openInput.current) openInput.current.value = "";
    }
  }
  async function importLogo(file?: File) {
    if (!file) return;
    try {
      const data = await logoFile(file);
      editLab((l) => ({
        ...l,
        logo: {
          data,
          name: file.name,
          position: "top-right",
          width: 12,
          margin: 4,
          opacity: 1,
          x: 50,
          y: 50,
        },
      }));
      setStatus(
        "LOGO 已作为独立配置图层载入，不改写原图；SVG 已安全栅格化为 PNG",
      );
    } catch (e) {
      setStatus("LOGO 导入失败：" + (e as Error).message);
    } finally {
      if (logoInput.current) logoInput.current.value = "";
    }
  }
  async function deliver(mode: "zip" | "single" | "builder") {
    const targets =
      mode === "single" ? (current ? [current] : []) : selectedAssets;
    if (!targets.length) {
      setStatus("请先选择需要输出的照片");
      return;
    }
    const pending = targets.filter(
      (a) =>
        recordFor(lab, a.id).adjustments.uniformity > 0 &&
        !recordFor(lab, a.id).reviewed,
    );
    if (pending.length) {
      setStatus(
        `请先逐张审核背景作用区域：${pending.map((a) => a.name).join("、")}`,
      );
      return;
    }
    setBusy(true);
    const errors: string[] = [],
      results: Asset[] = [],
      zip = new JSZip(),
      report: {
        name: string;
        sourceId: string;
        adjustments: Adjustments;
        metrics: Metrics;
      }[] = [];
    try {
      for (const [i, a] of targets.entries()) {
        setProgress(`${i + 1} / ${targets.length} · ${a.name}`);
        try {
          const rec = recordFor(lab, a.id),
            size = originalSize
              ? undefined
              : {
                  width: outputWidth,
                  height: Math.max(
                    1,
                    Math.round((outputWidth * a.height) / a.width),
                  ),
                };
          if (size && size.width * size.height > 65e6)
            throw Error("自定义尺寸超过 6500 万像素");
          const rendered = await renderPhoto(
            a,
            rec.adjustments,
            rec.protect,
            lab.logo,
            size,
          );
          try {
            const blob = await blobOf(
                rendered.canvas,
                mode === "builder" ? "png" : format,
              ),
              name = `${String(i + 1).padStart(3, "0")}-${safe(a.name.replace(/\.[^.]+$/, ""))}-optimized.${mode === "builder" || format === "png" ? "png" : "jpg"}`;
            if (mode === "zip") zip.file(name, blob);
            else if (mode === "single") download(blob, name);
            else
              results.push({
                id: id(),
                sourceId: a.id,
                batchId: a.batchId,
                name,
                data: await readData(blob),
                width: rendered.canvas.width,
                height: rendered.canvas.height,
              });
            report.push({
              name,
              sourceId: a.id,
              adjustments: rec.adjustments,
              metrics: rendered.metrics,
            });
          } finally {
            rendered.canvas.width = 0;
          }
        } catch (e) {
          errors.push(a.name + "：" + (e as Error).message);
        }
      }
      if (mode === "zip" && report.length) {
        zip.file(
          "PHOTO-LAB-report.json",
          JSON.stringify(
            {
              colorSpace: "sRGB",
              orientation: "baked into pixels; EXIF stripped",
              createdAt: new Date().toISOString(),
              photos: report,
              errors,
            },
            null,
            2,
          ),
        );
        download(
          await zip.generateAsync({ type: "blob" }),
          "RUYPET-PHOTO-LAB.zip",
        );
      }
      if (results.length)
        setProject((p) => ({ ...p, assets: [...p.assets, ...results] }));
      setStatus(
        `处理完成 ${report.length}/${targets.length}${errors.length ? "；失败：" + errors.join("；") : ""}${mode === "builder" && results.length ? " · 新素材已加入 DETAIL BUILDER，原图保留" : ""}`,
      );
    } catch (e) {
      setStatus("输出失败：" + (e as Error).message);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }
  const styleSize =
    zoom === "fit"
      ? { width: "100%" }
      : { width: (current?.width || 1) * Number(zoom) + "px" };
  const warning = metrics && metrics.confidence < 0.7;
  const selectedSummary = useMemo(
    () => `${selectedAssets.length} 张已选 / ${originals.length} 张原片`,
    [selectedAssets.length, originals.length],
  );
  return (
    <div className="photo-lab">
      <div className="lab-top">
        <div>
          <b>
            PHOTO LAB <span>V2 / 第一阶段</span>
          </b>
          <p>真实摄影优化 · 模式 A · 本机处理，不生成、不重绘</p>
        </div>
        <input
          aria-label="修图项目名称"
          value={project.name}
          onChange={(e) => {
            setProject((p) => ({ ...p, name: e.target.value }));
            setDirty(true);
          }}
        />
        <span>{dirty ? "● 未保存" : "○ 无未保存更改"}</span>
        <button onClick={() => openInput.current?.click()} disabled={busy}>
          打开修图项目
        </button>
        <button onClick={save}>保存修图项目</button>
        <button onClick={openBuilder}>前往商详 →</button>
      </div>
      <div className="lab-body">
        <aside className="lab-library">
          <h3>拍摄批次</h3>
          <input
            aria-label="新导入批次名称"
            value={batchName}
            onChange={(e) => setBatchName(e.target.value)}
          />
          <button
            className="wide"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            ＋ 批量导入照片
          </button>
          <input
            data-testid="lab-import"
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            hidden
            onChange={(e) => importFiles(e.target.files)}
          />
          <input
            data-testid="lab-open"
            ref={openInput}
            type="file"
            accept=".json"
            hidden
            onChange={(e) => restore(e.target.files?.[0])}
          />
          <select
            aria-label="批次筛选"
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
          >
            <option value="all">所有原片</option>
            <option value="unassigned">未分组（商详导入）</option>
            {lab.batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          {batch !== "all" && batch !== "unassigned" && (
            <input
              aria-label="当前批次名称"
              value={lab.batches.find((b) => b.id === batch)?.name || ""}
              onChange={(e) =>
                editLab((l) => ({
                  ...l,
                  batches: l.batches.map((b) =>
                    b.id === batch ? { ...b, name: e.target.value } : b,
                  ),
                }))
              }
            />
          )}
          <div className="button-row">
            <button
              onClick={() =>
                setSelected((s) =>
                  Array.from(new Set([...s, ...visible.map((a) => a.id)])),
                )
              }
            >
              全选本批
            </button>
            <button onClick={() => setSelected([])}>清空选择</button>
          </div>
          <button
            className="wide"
            disabled={!selectedAssets.length || busy}
            onClick={() => {
              const batchId = id();
              setProject((p) => ({
                ...p,
                assets: p.assets.map((a) =>
                  selected.includes(a.id) ? { ...a, batchId } : a,
                ),
                lab: {
                  ...(p.lab || newLab()),
                  batches: [
                    ...(p.lab || newLab()).batches,
                    { id: batchId, name: batchName.trim() || "新拍摄批次" },
                  ],
                },
              }));
              setBatch(batchId);
              setStatus(`已将 ${selectedAssets.length} 张原片归入新批次`);
            }}
          >
            所选归入新批次
          </button>
          <p className="hint">{selectedSummary}</p>
          <div className="lab-thumbnails">
            {visible.map((a) => (
              <div
                key={a.id}
                className={
                  "lab-thumb " + (current?.id === a.id ? "active" : "")
                }
              >
                <input
                  type="checkbox"
                  aria-label={"选择 " + a.name}
                  checked={selected.includes(a.id)}
                  onChange={(e) =>
                    setSelected((s) =>
                      e.target.checked
                        ? [...s, a.id]
                        : s.filter((i) => i !== a.id),
                    )
                  }
                />
                <button
                  onClick={() => {
                    setActive(a.id);
                    setBrush("off");
                  }}
                  aria-label={"预览 " + a.name}
                >
                  <img src={a.data} alt={a.name} />
                  <span>{a.name}</span>
                  <small>
                    {a.width} × {a.height} ·{" "}
                    {lab.records[a.id] ? "已调整" : "原片"}
                  </small>
                </button>
              </div>
            ))}
          </div>
          {!originals.length && (
            <p className="notice">
              请导入真实摄影照片。JPG / PNG / WebP，单张最高 6500 万像素，CR3
              请先在佳能 DPP 转出。
            </p>
          )}
        </aside>
        <div className="lab-main">
          <div className="lab-preview-tools">
            <strong>{current?.name || "等待照片"}</strong>
            <label>
              缩放
              <select
                aria-label="修图预览缩放"
                value={zoom}
                onChange={(e) => setZoom(e.target.value)}
              >
                <option value="fit">适应窗口</option>
                <option value="0.5">50% 原尺寸</option>
                <option value="1">100% 原尺寸</option>
                <option value="2">200% 原尺寸</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={overlay}
                onChange={(e) => setOverlay(e.target.checked)}
              />
              作用区域预览
            </label>
          </div>
          <div className="lab-comparison">
            <div className="lab-pane">
              <div className="lab-pane-label">
                原图 <span>只读 · EXIF 已转正</span>
              </div>
              <div
                className="lab-image-scroll"
                ref={beforeScroll}
                onScroll={(e) => {
                  const b = afterScroll.current;
                  if (
                    b &&
                    (b.scrollLeft !== e.currentTarget.scrollLeft ||
                      b.scrollTop !== e.currentTarget.scrollTop)
                  ) {
                    b.scrollLeft = e.currentTarget.scrollLeft;
                    b.scrollTop = e.currentTarget.scrollTop;
                  }
                }}
              >
                <canvas
                  aria-label="原图预览"
                  ref={beforeRef}
                  style={styleSize}
                />
              </div>
            </div>
            <div className="lab-pane">
              <div className="lab-pane-label">
                优化预览 <span>{previewBusy ? "正在计算…" : "sRGB"}</span>
              </div>
              <div
                className="lab-image-scroll"
                ref={afterScroll}
                onScroll={(e) => {
                  const b = beforeScroll.current;
                  if (
                    b &&
                    (b.scrollLeft !== e.currentTarget.scrollLeft ||
                      b.scrollTop !== e.currentTarget.scrollTop)
                  ) {
                    b.scrollLeft = e.currentTarget.scrollLeft;
                    b.scrollTop = e.currentTarget.scrollTop;
                  }
                }}
              >
                <div className="lab-output-stack" style={styleSize}>
                  <canvas aria-label="优化图预览" ref={afterRef} />
                  <canvas
                    aria-label="背景作用区域和主体保护画笔"
                    ref={overlayRef}
                    className="lab-mask"
                    style={{
                      opacity: overlay || brush !== "off" ? 1 : 0,
                      pointerEvents: brush === "off" ? "none" : "auto",
                      cursor: brush === "off" ? "default" : "crosshair",
                    }}
                    onPointerDown={(e) => {
                      if (!current || previewBusy) return;
                      drawing.current = true;
                      strokes.current = [];
                      e.currentTarget.setPointerCapture(e.pointerId);
                      paint(e);
                    }}
                    onPointerMove={(e) => {
                      if (drawing.current) paint(e);
                    }}
                    onPointerUp={endPaint}
                    onPointerCancel={endPaint}
                  />
                </div>
              </div>
            </div>
          </div>
          {previewError && (
            <p role="alert" className="lab-error">
              预览失败：{previewError}；请重新选择照片或降低预览缩放。
            </p>
          )}
          <div className="lab-analysis">
            {metrics && (
              <>
                <span>
                  背景候选覆盖 {Math.round(metrics.backgroundCoverage * 100)}%
                </span>
                <span>
                  启发式可信度 {Math.round(metrics.confidence * 100)}%
                </span>
                <span>
                  背景亮度离散度 {metrics.backgroundStdBefore.toFixed(1)} →{" "}
                  {metrics.backgroundStdAfter.toFixed(1)}
                </span>
                <span>
                  主体候选平均通道变化 {metrics.subjectDelta.toFixed(2)} / 255
                </span>
                <span>剪切风险 {metrics.clippedPercent.toFixed(2)}%</span>
              </>
            )}
          </div>
          <div className="lab-notes">
            <p>
              橙色 = 背景校正候选区域；蓝色 =
              人工保护。候选检测不是主体分割，离散度只统计候选区域，不代表真实商品验收。
            </p>
            {warning && (
              <p className="lab-error">
                主体与背景无法可靠区分或背景样本不足，已自动降低背景处理强度。请人工检查，必要时将背景均匀化设为
                0。
              </p>
            )}
            <p>
              浅色毛发、黑纱、蕾丝、透明面料、豹纹和接触阴影必须放大检查；保护画笔只阻止背景调整，全局曝光/白平衡仍会作用于整张照片。
            </p>
            {metrics && metrics.subjectDelta > 3 && (
              <p className="lab-error">
                全局调整导致主体候选色值发生明显变化，请与实物或色卡校对，不能保证商品颜色一致。
              </p>
            )}
          </div>
          <div className="lab-bottom" role="status">
            {busy ? `处理中 ${progress}` : status}
          </div>
        </div>
        <aside className="lab-controls">
          <section>
            <h3>模式 A / 基础摄影优化</h3>
            <button
              className="wide"
              onClick={automatic}
              disabled={!current || busy}
            >
              自动估计曝光 / 白平衡
            </button>
            <p className="hint">
              自动白平衡假设亮部存在中性色，非色卡校准。下列参数均可微调。
            </p>
            {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => (
              <label className="lab-slider" key={key}>
                <span>
                  {labels[key]}
                  <output>{params[key]}</output>
                </span>
                <input
                  type="range"
                  aria-label={labels[key]}
                  min={
                    key === "exposure"
                      ? -2
                      : key === "uniformity" || key === "backgroundNeutral"
                        ? 0
                        : -100
                  }
                  max={key === "exposure" ? 2 : 100}
                  step={key === "exposure" ? 0.05 : 1}
                  value={params[key]}
                  disabled={!current}
                  onChange={(e) => patch({ [key]: Number(e.target.value) })}
                />
              </label>
            ))}
            <label className="field">
              背景参考（不是替换）
              <input
                aria-label="背景参考色"
                type="color"
                value={params.background}
                onChange={(e) => patch({ background: e.target.value })}
              />
            </label>
            <p className="hint">
              仅校正低频亮度场与背景偏色，保留原像素纹理及暗部阴影；每通道最大校正
              45/255。浅毛和透纱仍可能误判。
            </p>
            <button
              className="wide"
              disabled={!current || busy}
              onClick={() => {
                editLab((l) => ({
                  ...l,
                  records: {
                    ...l.records,
                    [current.id]: {
                      adjustments: { ...defaults },
                      protect: [],
                      reviewed: false,
                    },
                  },
                }));
                setStatus("单张已恢复原图参数，独立 LOGO 可在下方关闭");
              }}
            >
              单张恢复原图参数
            </button>
          </section>
          <section>
            <h3>保护画笔 / 背景审核</h3>
            <div className="button-row">
              <button
                className={brush === "protect" ? "active" : ""}
                onClick={() => {
                  setBrush(brush === "protect" ? "off" : "protect");
                  setOverlay(true);
                }}
              >
                保护主体
              </button>
              <button
                className={brush === "erase" ? "active" : ""}
                onClick={() => {
                  setBrush(brush === "erase" ? "off" : "erase");
                  setOverlay(true);
                }}
              >
                擦除保护
              </button>
              <button onClick={() => setBrush("off")}>浏览</button>
            </div>
            <label className="field">
              画笔半径（原图宽 %）
              <input
                aria-label="保护画笔半径"
                type="number"
                min={1}
                max={25}
                value={radius}
                onChange={(e) =>
                  setRadius(
                    Math.max(1, Math.min(25, Number(e.target.value) || 1)),
                  )
                }
              />
            </label>
            <button className="wide" onClick={() => setRecordProtect([])}>
              清空本张保护
            </button>
            <label className="lab-review">
              <input
                aria-label="已检查本张主体和透明材质"
                type="checkbox"
                checked={record.reviewed}
                disabled={!current || previewBusy}
                onChange={(e) =>
                  editLab((l) => ({
                    ...l,
                    records: {
                      ...l.records,
                      [current.id]: {
                        ...recordFor(l, current.id),
                        reviewed: e.target.checked,
                      },
                    },
                  }))
                }
              />
              已放大检查本张主体、毛发、透明材质及阴影
            </label>
          </section>
          <section>
            <h3>可编辑预设 / 批量应用</h3>
            <select
              aria-label="修图预设"
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
            >
              {Object.keys(lab.presets).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
            <button
              className="wide"
              onClick={() => {
                if (lab.presets[preset]) patch(lab.presets[preset]);
              }}
            >
              载入预设到本张
            </button>
            <input
              aria-label="预设名称"
              placeholder="新预设名称 / 留空更新所选"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <button
              className="wide"
              disabled={!current}
              onClick={() => {
                const name = presetName.trim() || preset;
                editLab((l) => ({
                  ...l,
                  presets: { ...l.presets, [name]: { ...params } },
                }));
                setPreset(name);
                setPresetName("");
                setStatus("预设已保存到项目，请下载项目文件长期保留");
              }}
            >
              保存当前参数为预设
            </button>
            <div className="button-row">
              <button onClick={() => applyGroup("selected")}>应用到所选</button>
              <button onClick={() => applyGroup("batch")}>
                应用到同拍摄批次
              </button>
            </div>
            <p className="hint">
              只复制参数，不复制主体保护画笔；逐张微调可覆盖批量结果。
            </p>
          </section>
          <section>
            <h3>官方 LOGO / 独立图层</h3>
            <button className="wide" onClick={() => logoInput.current?.click()}>
              导入透明 PNG / SVG LOGO
            </button>
            <input
              ref={logoInput}
              data-testid="lab-logo"
              type="file"
              accept="image/png,image/svg+xml,.svg"
              hidden
              onChange={(e) => importLogo(e.target.files?.[0])}
            />
            {lab.logo && (
              <>
                <p className="hint">{lab.logo.name} · 独立保存，可随时关闭</p>
                <select
                  aria-label="LOGO 位置"
                  value={lab.logo.position}
                  onChange={(e) =>
                    patchLogo({
                      position: e.target.value as LogoSettings["position"],
                    })
                  }
                >
                  {Object.entries({
                    none: "不添加",
                    "top-left": "左上角",
                    "top-right": "右上角",
                    "top-center": "顶部居中",
                    "bottom-center": "底部居中",
                    custom: "自定义位置",
                  }).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                {(
                  [
                    "width",
                    "margin",
                    "opacity",
                    ...(lab.logo.position === "custom" ? ["x", "y"] : []),
                  ] as (keyof LogoSettings)[]
                ).map((key) => (
                  <label className="field" key={key}>
                    {
                      (
                        {
                          width: "LOGO 宽度 %",
                          margin: "LOGO 边距 %",
                          opacity: "LOGO 透明度",
                          x: "LOGO 水平位置 %",
                          y: "LOGO 垂直位置 %",
                        } as Record<string, string>
                      )[key]
                    }
                    <input
                      type="number"
                      aria-label={"LOGO " + key}
                      value={lab.logo![key] as number}
                      min={key === "width" ? 1 : 0}
                      max={
                        key === "width"
                          ? 80
                          : key === "margin"
                            ? 40
                            : key === "opacity"
                              ? 1
                              : 100
                      }
                      step={key === "opacity" ? 0.05 : 1}
                      onChange={(e) => {
                        const max =
                          key === "width"
                            ? 80
                            : key === "margin"
                              ? 40
                              : key === "opacity"
                                ? 1
                                : 100;
                        patchLogo({
                          [key]: Math.max(
                            key === "width" ? 1 : 0,
                            Math.min(max, Number(e.target.value) || 0),
                          ),
                        });
                      }}
                    />
                  </label>
                ))}
              </>
            )}
          </section>
          <section>
            <h3>输出 / sRGB</h3>
            <select
              aria-label="修图导出格式"
              value={format}
              onChange={(e) => setFormat(e.target.value as typeof format)}
            >
              <option value="jpeg">JPG · 质量 96%</option>
              <option value="png">PNG · 无损</option>
            </select>
            <label className="lab-review">
              <input
                type="checkbox"
                aria-label="保持原始分辨率"
                checked={originalSize}
                onChange={(e) => setOriginalSize(e.target.checked)}
              />
              保持转正后的原始分辨率
            </label>
            {!originalSize && (
              <label className="field">
                输出宽度（按比例缩放）
                <input
                  aria-label="修图输出宽度"
                  type="number"
                  min={100}
                  max={12000}
                  value={outputWidth}
                  onChange={(e) =>
                    setOutputWidth(
                      Math.max(
                        100,
                        Math.min(12000, Number(e.target.value) || 100),
                      ),
                    )
                  }
                />
              </label>
            )}
            <button
              className="wide"
              disabled={busy || previewBusy || !current}
              onClick={() => deliver("single")}
            >
              导出当前优化图
            </button>
            <button
              className="wide"
              disabled={busy || previewBusy || !selectedAssets.length}
              onClick={() => deliver("zip")}
            >
              批量 ZIP 下载（所选）
            </button>
            <button
              className="wide"
              disabled={busy || previewBusy || !selectedAssets.length}
              onClick={() => deliver("builder")}
            >
              将所选优化图加入商详素材
            </button>
            <p className="hint">
              浏览器将嵌入 ICC 的图片转换到 sRGB，并将 EXIF
              方向烘焙到像素；导出不复制原 ICC 或 EXIF。不支持 RAW / 印刷 CMYK
              的保真承诺。请使用近期 Safari /
              Chrome，关键商品需色卡及受控显示器校对。
            </p>
          </section>
          <section>
            <h3>模式 B / 智能背景替换</h3>
            <p className="notice">
              {unavailableMatting.name}。本阶段不可用；不会把模式 A
              的背景候选区冒充精细分割。集成接口与 Mac 方案见
              docs/PHOTO-LAB.md。
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
