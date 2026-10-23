import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Stage,
  Layer,
  Rect,
  Text,
  Image as KImage,
  Transformer,
} from "react-konva";
import Konva from "konva";
import JSZip from "jszip";
import {
  WIDTH,
  id,
  initial,
  page,
  textElement,
  templatePages,
  parseProject,
  type Project,
  type Element,
  type Asset,
} from "./model";
import "./style.css";

function useImage(data?: string) {
  const [img, setImg] = useState<HTMLImageElement>();
  useEffect(() => {
    setImg(undefined);
    if (!data) return;
    const image = new window.Image();
    image.onload = () => setImg(image);
    image.src = data;
  }, [data]);
  return img;
}
function Picture({
  element,
  asset,
  ...props
}: {
  element: Element;
  asset?: Asset;
  [key: string]: unknown;
}) {
  const image = useImage(asset?.data);
  return (
    <KImage
      {...props}
      image={image}
      x={element.x}
      y={element.y}
      width={element.width}
      height={element.height}
      opacity={element.opacity}
      crop={
        asset
          ? {
              x: element.cropX * asset.width,
              y: element.cropY * asset.height,
              width: element.cropWidth * asset.width,
              height: element.cropHeight * asset.height,
            }
          : undefined
      }
    />
  );
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const safeName = (s: string) =>
  s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "RUYPET";
function App() {
  const [project, setProject] = useState<Project>(initial);
  const [active, setActive] = useState(project.pages[0].id);
  const [selected, setSelected] = useState<string>();
  const [zoom, setZoom] = useState(0.65);
  const [tab, setTab] = useState("图层属性");
  const [status, setStatus] = useState("就绪 · 所有图片仅在本机处理");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const stage = useRef<Konva.Stage>(null);
  const transformer = useRef<Konva.Transformer>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const openInput = useRef<HTMLInputElement>(null);
  const view = project.pages.find((p) => p.id === active) || project.pages[0];
  const element = view.elements.find((e) => e.id === selected);
  const projectRef = useRef(project);
  projectRef.current = project;
  const history = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  function update(fn: (p: Project) => Project) {
    const previous = projectRef.current;
    history.current.push(previous);
    if (history.current.length > 60) history.current.shift();
    future.current = [];
    const next = fn(previous);
    projectRef.current = next;
    setProject(next);
    setDirty(true);
  }
  function updatePage(fn: (p: typeof view) => typeof view) {
    update((p) => ({
      ...p,
      pages: p.pages.map((pg) => (pg.id === view.id ? fn(pg) : pg)),
    }));
  }
  function patch(values: Partial<Element>) {
    updatePage((pg) => ({
      ...pg,
      elements: pg.elements.map((e) =>
        e.id === selected ? { ...e, ...values } : e,
      ),
    }));
  }
  function undo() {
    const p = history.current.pop();
    if (p) {
      future.current.push(project);
      setProject(p);
      setDirty(true);
      setSelected(undefined);
    }
  }
  function redo() {
    const p = future.current.pop();
    if (p) {
      history.current.push(project);
      setProject(p);
      setDirty(true);
      setSelected(undefined);
    }
  }
  useEffect(() => {
    const t = transformer.current;
    const node = stage.current?.findOne("#" + selected);
    if (t) {
      t.nodes(node ? [node] : []);
      t.getLayer()?.batchDraw();
    }
  }, [selected, view, zoom]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "z" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  async function importImages(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    const assets: Asset[] = [];
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
          throw Error("仅支持 JPG、PNG、WebP");
        if (file.size > 30 * 1024 * 1024) throw Error("单张图片不得超过 30MB");
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(Error("读取失败"));
          reader.readAsDataURL(file);
        });
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new window.Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(Error("无法解码图片"));
          img.src = data;
        });
        assets.push({
          id: id(),
          name: file.name,
          data,
          width: image.width,
          height: image.height,
        });
      } catch (e) {
        errors.push(`${file.name}: ${(e as Error).message}`);
      }
    }
    if (assets.length)
      update((p) => ({ ...p, assets: [...p.assets, ...assets] }));
    setStatus(
      `已导入 ${assets.length} 张原图${errors.length ? "；" + errors.join("；") : ""}`,
    );
    setBusy(false);
    if (fileInput.current) fileInput.current.value = "";
  }
  function addImage(assetId: string, x = 70, y = 230) {
    const a = project.assets.find((a) => a.id === assetId);
    if (!a) return;
    const width = Math.min(650, a.width);
    const height = (width * a.height) / a.width;
    const e: Element = {
      ...textElement("", project.brand),
      id: id(),
      type: "image",
      assetId,
      x: Math.max(0, x),
      y: Math.max(0, y),
      width,
      height,
    };
    updatePage((pg) => ({ ...pg, elements: [...pg.elements, e] }));
    setSelected(e.id);
  }
  function addText() {
    const e = textElement("双击文字或在右侧编辑", project.brand, 100);
    updatePage((pg) => ({ ...pg, elements: [...pg.elements, e] }));
    setSelected(e.id);
  }
  function selectPage(pid: string) {
    setActive(pid);
    setSelected(undefined);
  }
  function movePage(direction: number) {
    const index = project.pages.findIndex((p) => p.id === view.id);
    if (index + direction < 0 || index + direction >= project.pages.length)
      return;
    update((p) => {
      const pages = [...p.pages];
      [pages[index], pages[index + direction]] = [
        pages[index + direction],
        pages[index],
      ];
      return { ...p, pages };
    });
  }
  function save() {
    download(
      new Blob([JSON.stringify(project)], { type: "application/json" }),
      safeName(project.name) + ".ruypet.json",
    );
    setDirty(false);
    setStatus("项目文件已生成，请在下载文件夹确认保存；文件包含全部原始图片");
  }
  async function restore(file?: File) {
    if (!file) return;
    try {
      if (dirty && !confirm("当前更改尚未保存，确认打开另一个项目？")) return;
      const p = parseProject(JSON.parse(await file.text()));
      await Promise.all(
        p.assets.map(
          (a) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              image.onload = () =>
                image.width === a.width && image.height === a.height
                  ? resolve()
                  : reject(Error("素材尺寸不匹配"));
              image.onerror = () => reject(Error("项目包含损坏图片"));
              image.src = a.data;
            }),
        ),
      );
      setProject(p);
      setActive(p.pages[0].id);
      setSelected(undefined);
      history.current = [];
      future.current = [];
      setDirty(false);
      setStatus("项目恢复成功 · 图片、页面与品牌配置已载入");
    } catch (e) {
      setStatus("打开失败：" + (e as Error).message);
    } finally {
      if (openInput.current) openInput.current.value = "";
    }
  }
  function warnings() {
    const results: string[] = [];
    for (const pg of project.pages)
      for (const e of pg.elements) {
        const label = `${pg.name} / ${e.type === "text" ? (e.text || "文字").slice(0, 12) : "图片"}`;
        if (
          e.x < 0 ||
          e.y < 0 ||
          e.x + e.width > WIDTH ||
          e.y + e.height > pg.height
        )
          results.push(label + "：图层超出页面");
        if (e.type === "image") {
          const a = project.assets.find((a) => a.id === e.assetId);
          if (!a) results.push(label + "：缺失图片");
          else if (
            a.width * e.cropWidth < e.width ||
            a.height * e.cropHeight < e.height
          )
            results.push(label + "：原图裁切区域分辨率低于导出尺寸");
        } else {
          const text = new Konva.Text({
            text: e.text,
            width: e.width,
            fontSize: e.fontSize,
            fontFamily: e.fontFamily,
            lineHeight: e.lineHeight,
          });
          if (text.height() > e.height + 1)
            results.push(label + "：文字溢出，请增高文本框");
          text.destroy();
        }
      }
    return results;
  }
  async function renderPage(pg: typeof view) {
    const container = document.createElement("div");
    const s = new Konva.Stage({ container, width: WIDTH, height: pg.height });
    const layer = new Konva.Layer();
    s.add(layer);
    layer.add(
      new Konva.Rect({
        width: WIDTH,
        height: pg.height,
        fill: project.brand.background,
      }),
    );
    try {
      for (const e of pg.elements) {
        const common = {
          x: e.x,
          y: e.y,
          width: e.width,
          height: e.height,
          opacity: e.opacity,
        };
        if (e.type === "text")
          layer.add(
            new Konva.Text({
              ...common,
              text: e.text,
              fontSize: e.fontSize,
              fontFamily: e.fontFamily,
              lineHeight: e.lineHeight,
              fill: e.color,
              align: e.align,
            }),
          );
        else {
          const a = project.assets.find((a) => a.id === e.assetId);
          if (!a) throw Error(`${pg.name} 缺失图片，请替换后导出`);
          const image = await new Promise<HTMLImageElement>(
            (resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = () => reject(Error("图片加载失败"));
              img.src = a.data;
            },
          );
          layer.add(
            new Konva.Image({
              ...common,
              image,
              crop: {
                x: e.cropX * a.width,
                y: e.cropY * a.height,
                width: e.cropWidth * a.width,
                height: e.cropHeight * a.height,
              },
            }),
          );
        }
      }
      layer.draw();
      return s.toCanvas({ pixelRatio: 1 });
    } finally {
      s.destroy();
    }
  }
  async function exportPages(mode: "page" | "zip" | "long") {
    setBusy(true);
    try {
      const pages = mode === "page" ? [view] : project.pages;
      const total = pages.reduce((n, p) => n + p.height, 0);
      if (mode === "long" && (total > 30000 || total * WIDTH > 24e6))
        throw Error("长图超过安全尺寸，请改用 ZIP 逐页导出");
      const ext = format === "png" ? "png" : "jpg";
      const blob = (canvas: HTMLCanvasElement) =>
        new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(Error("导出失败"))),
            "image/" + format,
            0.94,
          ),
        );
      if (mode === "long") {
        const c = document.createElement("canvas");
        c.width = WIDTH;
        c.height = total;
        const ctx = c.getContext("2d")!;
        let y = 0;
        for (const pg of pages) {
          const rendered = await renderPage(pg);
          ctx.drawImage(rendered, 0, y);
          y += pg.height;
          rendered.width = 0;
        }
        download(await blob(c), safeName(project.name) + "-长图." + ext);
      } else if (mode === "zip") {
        const zip = new JSZip();
        for (const [i, pg] of pages.entries()) {
          zip.file(
            `${String(i + 1).padStart(2, "0")}-${safeName(pg.name)}.${ext}`,
            await blob(await renderPage(pg)),
          );
        }
        download(
          await zip.generateAsync({ type: "blob" }),
          safeName(project.name) + ".zip",
        );
      } else
        download(
          await blob(await renderPage(view)),
          safeName(view.name) + "." + ext,
        );
      setStatus("导出完成 · 790px 宽，使用原始照片，无 AI 改图");
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const checks = warnings();
  function numeric(
    label: string,
    value: number,
    fn: (n: number) => void,
    min = 0,
    max = 10000,
    step = 1,
  ) {
    return (
      <label className="field">
        {label}
        <input
          aria-label={label}
          type="number"
          min={min}
          max={max}
          step={step}
          value={Math.round(value * 100) / 100}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) fn(Math.max(min, Math.min(max, n)));
          }}
        />
      </label>
    );
  }
  return (
    <div className="app">
      <header>
        <div className="wordmark">
          RUYPET <span>DETAIL STUDIO</span>
          <small>V1 / LOCAL WORKSPACE</small>
        </div>
        <input
          className="project-name"
          aria-label="项目名称"
          value={project.name}
          onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
        />
        <span className="save-state">
          {dirty ? "● 未保存" : "○ 当前会话无未保存更改"}
        </span>
        <button onClick={() => openInput.current?.click()}>打开项目</button>
        <button onClick={save}>保存项目</button>
        <button
          className="primary"
          onClick={() => exportPages("zip")}
          disabled={busy}
        >
          导出整套 ZIP ↗
        </button>
      </header>
      <div className="workspace">
        <aside className="left">
          <div className="panel-heading">
            素材工作台 <span>本地 · 原图保护</span>
          </div>
          <button
            className="upload"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            <b>＋ 导入原始照片</b>
            <small>JPG / PNG / WebP · 支持多选</small>
          </button>
          <input
            ref={fileInput}
            data-testid="image-input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            hidden
            onChange={(e) => importImages(e.target.files)}
          />
          <input
            ref={openInput}
            data-testid="project-input"
            type="file"
            accept=".json"
            hidden
            onChange={(e) => restore(e.target.files?.[0])}
          />
          <p className="hint">
            点击素材添加到当前页，也可拖入画板。所有裁切均可恢复。
          </p>
          <div className="assets">
            {project.assets.map((a) => (
              <button
                className="asset"
                key={a.id}
                aria-label={a.name}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("asset", a.id)}
                onClick={() => addImage(a.id)}
                title={a.name}
              >
                <img src={a.data} alt={a.name} />
                <span>{a.name}</span>
                <small>
                  {a.width} × {a.height}
                </small>
              </button>
            ))}
            {!project.assets.length && (
              <div className="empty">
                从一张真实照片开始
                <br />
                <small>原始素材将随项目文件一同保存</small>
              </div>
            )}
          </div>
          <div className="panel-heading">
            页面 <span>{project.pages.length} 页 · 790px</span>
          </div>
          <div className="pages">
            {project.pages.map((pg, i) => (
              <button
                key={pg.id}
                className={"page-item " + (pg.id === view.id ? "active" : "")}
                onClick={() => selectPage(pg.id)}
              >
                <span className="page-icon">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>
                  {pg.name}
                  <small>790 × {pg.height}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="button-row">
            <button
              onClick={() => {
                const pg = page();
                update((p) => ({ ...p, pages: [...p.pages, pg] }));
                selectPage(pg.id);
              }}
            >
              ＋ 新增页
            </button>
            <button
              onClick={() => {
                const pg = {
                  ...structuredClone(view),
                  id: id(),
                  name: view.name + " 副本",
                  elements: view.elements.map((e) => ({ ...e, id: id() })),
                };
                update((p) => ({ ...p, pages: [...p.pages, pg] }));
                selectPage(pg.id);
              }}
            >
              复制页
            </button>
          </div>
          <div className="button-row">
            <button onClick={() => movePage(-1)}>上移</button>
            <button onClick={() => movePage(1)}>下移</button>
            <button
              disabled={project.pages.length === 1}
              onClick={() => {
                if (confirm("删除当前页面？可使用撤销恢复。")) {
                  update((p) => ({
                    ...p,
                    pages: p.pages.filter((pg) => pg.id !== view.id),
                  }));
                  selectPage(project.pages.find((pg) => pg.id !== view.id)!.id);
                }
              }}
            >
              删除页
            </button>
          </div>
        </aside>
        <main>
          <div className="toolbar">
            <div>
              <button onClick={undo} disabled={!history.current.length}>
                ↶ 撤销
              </button>
              <button onClick={redo} disabled={!future.current.length}>
                ↷ 重做
              </button>
              <button onClick={addText}>T 添加文字</button>
            </div>
            <div>
              <span>画布缩放</span>
              <select
                aria-label="画布缩放"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
              >
                {[0.35, 0.5, 0.65, 0.8, 1].map((z) => (
                  <option key={z} value={z}>
                    {Math.round(z * 100)}%
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="canvas-scroll">
            <div className="canvas-label">
              {view.name} <span>790 × {view.height} PX</span>
            </div>
            <div
              className="canvas"
              style={{ width: WIDTH * zoom, height: view.height * zoom }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                addImage(
                  e.dataTransfer.getData("asset"),
                  (e.clientX - r.left) / zoom,
                  (e.clientY - r.top) / zoom,
                );
              }}
            >
              <Stage
                ref={stage}
                width={WIDTH * zoom}
                height={view.height * zoom}
                scaleX={zoom}
                scaleY={zoom}
                onMouseDown={(e) => {
                  if (
                    e.target === e.target.getStage() ||
                    e.target.name() === "background"
                  )
                    setSelected(undefined);
                }}
              >
                <Layer>
                  <Rect
                    name="background"
                    width={WIDTH}
                    height={view.height}
                    fill={project.brand.background}
                  />
                  {view.elements.map((e) => {
                    const props = {
                      id: e.id,
                      draggable: true,
                      onClick: () => setSelected(e.id),
                      onTap: () => setSelected(e.id),
                      onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => {
                        const n = event.target;
                        updatePage((pg) => ({
                          ...pg,
                          elements: pg.elements.map((el) =>
                            el.id === e.id ? { ...el, x: n.x(), y: n.y() } : el,
                          ),
                        }));
                      },
                      onTransformEnd: (
                        event: Konva.KonvaEventObject<Event>,
                      ) => {
                        const n = event.target;
                        const w = Math.max(10, n.width() * n.scaleX()),
                          h = Math.max(10, n.height() * n.scaleY());
                        n.scaleX(1);
                        n.scaleY(1);
                        updatePage((pg) => ({
                          ...pg,
                          elements: pg.elements.map((el) =>
                            el.id === e.id
                              ? {
                                  ...el,
                                  x: n.x(),
                                  y: n.y(),
                                  width: w,
                                  height: h,
                                }
                              : el,
                          ),
                        }));
                      },
                    };
                    return e.type === "image" ? (
                      <Picture
                        key={e.id}
                        {...props}
                        element={e}
                        asset={project.assets.find((a) => a.id === e.assetId)}
                      />
                    ) : (
                      <Text
                        key={e.id}
                        {...props}
                        x={e.x}
                        y={e.y}
                        width={e.width}
                        height={e.height}
                        text={e.text}
                        fontFamily={e.fontFamily}
                        fontSize={e.fontSize}
                        lineHeight={e.lineHeight}
                        fill={e.color}
                        align={e.align}
                        opacity={e.opacity}
                        onDblClick={() => {
                          setSelected(e.id);
                          setTab("图层属性");
                          setTimeout(
                            () =>
                              document
                                .querySelector<HTMLTextAreaElement>(
                                  "#text-editor",
                                )
                                ?.focus(),
                            0,
                          );
                        }}
                      />
                    );
                  })}
                  <Transformer
                    ref={transformer}
                    rotateEnabled={false}
                    flipEnabled={false}
                    boundBoxFunc={(old, b) =>
                      b.width < 10 || b.height < 10 ? old : b
                    }
                  />
                </Layer>
              </Stage>
            </div>
            <div className="canvas-note">
              仅排版原始照片 · 不生成、不重绘、不修改商品特征
            </div>
          </div>
          <footer>
            <span role="status">{busy ? "处理中，请稍候…" : status}</span>
            <span>
              {checks.length ? `⚠ ${checks.length} 项待检查` : "✓ 基础检查通过"}
            </span>
          </footer>
        </main>
        <aside className="right">
          <div className="tabs">
            {["图层属性", "品牌样式", "导出检查"].map((t) => (
              <button
                className={tab === t ? "active" : ""}
                key={t}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === "图层属性" && (
            <>
              <section>
                <h3>当前页面</h3>
                <label className="field">
                  页面名称
                  <input
                    aria-label="页面名称"
                    value={view.name}
                    onChange={(e) =>
                      updatePage((pg) => ({ ...pg, name: e.target.value }))
                    }
                  />
                </label>
                {numeric(
                  "页面高度",
                  view.height,
                  (height) => updatePage((pg) => ({ ...pg, height })),
                  100,
                  10000,
                )}
              </section>
              <section>
                <h3>
                  图层 <small>上方为顶层</small>
                </h3>
                <div className="layers">
                  {[...view.elements].reverse().map((e, i) => (
                    <button
                      key={e.id}
                      className={selected === e.id ? "active" : ""}
                      onClick={() => setSelected(e.id)}
                    >
                      {e.type === "image"
                        ? "▧ 图片"
                        : "T " + e.text?.slice(0, 15)}
                      <span>{view.elements.length - i}</span>
                    </button>
                  ))}
                </div>
              </section>
              {element ? (
                <section>
                  <h3>{element.type === "text" ? "文字编辑" : "图片编辑"}</h3>
                  <div className="grid2">
                    {numeric("X 位置", element.x, (x) => patch({ x }), -10000)}
                    {numeric("Y 位置", element.y, (y) => patch({ y }), -10000)}
                    {numeric(
                      "宽度",
                      element.width,
                      (width) => patch({ width }),
                      10,
                    )}
                    {numeric(
                      "高度",
                      element.height,
                      (height) => patch({ height }),
                      10,
                    )}
                    {numeric(
                      "透明度 %",
                      element.opacity * 100,
                      (n) => patch({ opacity: n / 100 }),
                      0,
                      100,
                    )}
                  </div>
                  {element.type === "text" ? (
                    <>
                      <label className="field">
                        文字内容
                        <textarea
                          id="text-editor"
                          aria-label="文字内容"
                          rows={5}
                          value={element.text}
                          onChange={(e) => patch({ text: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        字体
                        <select
                          aria-label="字体"
                          value={element.fontFamily}
                          onChange={(e) =>
                            patch({ fontFamily: e.target.value })
                          }
                        >
                          {[
                            "Arial",
                            "Helvetica",
                            "PingFang SC",
                            "Songti SC",
                            "sans-serif",
                            "serif",
                          ].map((f) => (
                            <option key={f}>{f}</option>
                          ))}
                        </select>
                      </label>
                      <div className="grid2">
                        {numeric(
                          "字号",
                          element.fontSize,
                          (fontSize) => patch({ fontSize }),
                          8,
                          300,
                        )}
                        {numeric(
                          "行距",
                          element.lineHeight,
                          (lineHeight) => patch({ lineHeight }),
                          0.5,
                          4,
                          0.1,
                        )}
                      </div>
                      <label className="field">
                        文字颜色
                        <input
                          aria-label="文字颜色"
                          type="color"
                          value={element.color}
                          onChange={(e) => patch({ color: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        对齐
                        <select
                          aria-label="对齐"
                          value={element.align}
                          onChange={(e) =>
                            patch({ align: e.target.value as Element["align"] })
                          }
                        >
                          <option value="left">左对齐</option>
                          <option value="center">居中</option>
                          <option value="right">右对齐</option>
                        </select>
                      </label>
                    </>
                  ) : (
                    <>
                      <p className="hint">
                        裁切以原图百分比设置，不改变原始文件。拖动边框可缩放；改变宽高可能拉伸图片。
                      </p>
                      <div className="grid2">
                        {numeric(
                          "裁切左侧 %",
                          element.cropX * 100,
                          (n) =>
                            patch({
                              cropX: n / 100,
                              cropWidth: Math.min(
                                element.cropWidth,
                                1 - n / 100,
                              ),
                            }),
                          0,
                          99,
                        )}
                        {numeric(
                          "裁切顶部 %",
                          element.cropY * 100,
                          (n) =>
                            patch({
                              cropY: n / 100,
                              cropHeight: Math.min(
                                element.cropHeight,
                                1 - n / 100,
                              ),
                            }),
                          0,
                          99,
                        )}
                        {numeric(
                          "裁切宽度 %",
                          element.cropWidth * 100,
                          (n) => patch({ cropWidth: n / 100 }),
                          1,
                          (1 - element.cropX) * 100,
                        )}
                        {numeric(
                          "裁切高度 %",
                          element.cropHeight * 100,
                          (n) => patch({ cropHeight: n / 100 }),
                          1,
                          (1 - element.cropY) * 100,
                        )}
                      </div>
                      <div className="button-row">
                        <button
                          onClick={() =>
                            patch({
                              cropX: 0,
                              cropY: 0,
                              cropWidth: 1,
                              cropHeight: 1,
                            })
                          }
                        >
                          重置裁切
                        </button>
                        <button
                          onClick={() => {
                            const a = project.assets.find(
                              (a) => a.id === element.assetId,
                            );
                            if (a)
                              patch({
                                height:
                                  (element.width *
                                    (a.height * element.cropHeight)) /
                                  (a.width * element.cropWidth),
                              });
                          }}
                        >
                          恢复比例
                        </button>
                      </div>
                      <label className="field">
                        替换图片（保留位置）
                        <select
                          aria-label="替换图片"
                          value={element.assetId}
                          onChange={(e) =>
                            patch({
                              assetId: e.target.value,
                              cropX: 0,
                              cropY: 0,
                              cropWidth: 1,
                              cropHeight: 1,
                            })
                          }
                        >
                          {project.assets.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  <div className="button-row">
                    <button
                      onClick={() =>
                        updatePage((pg) => {
                          const els = [...pg.elements],
                            i = els.findIndex((e) => e.id === selected);
                          if (i < els.length - 1)
                            [els[i], els[i + 1]] = [els[i + 1], els[i]];
                          return { ...pg, elements: els };
                        })
                      }
                    >
                      上移一层
                    </button>
                    <button
                      onClick={() =>
                        updatePage((pg) => {
                          const els = [...pg.elements],
                            i = els.findIndex((e) => e.id === selected);
                          if (i > 0)
                            [els[i], els[i - 1]] = [els[i - 1], els[i]];
                          return { ...pg, elements: els };
                        })
                      }
                    >
                      下移一层
                    </button>
                  </div>
                  <div className="button-row">
                    <button
                      onClick={() => {
                        const copy = {
                          ...element,
                          id: id(),
                          x: element.x + 20,
                          y: element.y + 20,
                        };
                        updatePage((pg) => ({
                          ...pg,
                          elements: [...pg.elements, copy],
                        }));
                        setSelected(copy.id);
                      }}
                    >
                      复制图层
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        updatePage((pg) => ({
                          ...pg,
                          elements: pg.elements.filter(
                            (e) => e.id !== selected,
                          ),
                        }));
                        setSelected(undefined);
                      }}
                    >
                      删除图层
                    </button>
                  </div>
                </section>
              ) : (
                <section className="empty">
                  选择一个图层开始编辑
                  <br />
                  <small>也可添加文字，或点击左侧素材</small>
                </section>
              )}
            </>
          )}
          {tab === "品牌样式" && (
            <section>
              <h3>品牌配置 / 待确认</h3>
              <p className="notice">
                当前为中性占位配置，不代表 RUYPET
                最终品牌色或字体。请按已确认规范调整。
              </p>
              <label className="field">
                统一字体
                <select
                  aria-label="统一字体"
                  value={project.brand.font}
                  onChange={(e) =>
                    update((p) => ({
                      ...p,
                      brand: { ...p.brand, font: e.target.value },
                    }))
                  }
                >
                  {[
                    "Arial",
                    "Helvetica",
                    "PingFang SC",
                    "Songti SC",
                    "sans-serif",
                    "serif",
                  ].map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
              {(["background", "text", "accent"] as const).map((k, i) => (
                <label className="field" key={k}>
                  {["页面背景", "正文颜色", "辅助文字颜色"][i]}
                  <input
                    type="color"
                    aria-label={["页面背景", "正文颜色", "辅助文字颜色"][i]}
                    value={project.brand[k]}
                    onChange={(e) =>
                      update((p) => ({
                        ...p,
                        brand: { ...p.brand, [k]: e.target.value },
                      }))
                    }
                  />
                </label>
              ))}
              {numeric(
                "统一留白",
                project.brand.margin,
                (n) =>
                  update((p) => ({ ...p, brand: { ...p.brand, margin: n } })),
                0,
                300,
              )}
              {numeric(
                "标题字号",
                project.brand.heading,
                (n) =>
                  update((p) => ({ ...p, brand: { ...p.brand, heading: n } })),
                12,
                150,
              )}
              {numeric(
                "正文字号",
                project.brand.body,
                (n) =>
                  update((p) => ({ ...p, brand: { ...p.brand, body: n } })),
                8,
                100,
              )}
              <button
                className="wide"
                onClick={() => {
                  if (
                    confirm(
                      "将字体、颜色与留白应用到全部文字？位置和字号将按层级更新，可撤销。",
                    )
                  )
                    update((p) => ({
                      ...p,
                      pages: p.pages.map((pg) => ({
                        ...pg,
                        elements: pg.elements.map((e) =>
                          e.type === "text"
                            ? {
                                ...e,
                                fontFamily: p.brand.font,
                                color:
                                  e.fontSize >= 36
                                    ? p.brand.text
                                    : p.brand.accent,
                                fontSize:
                                  e.fontSize >= 36
                                    ? p.brand.heading
                                    : p.brand.body,
                                x: p.brand.margin,
                                width: WIDTH - p.brand.margin * 2,
                              }
                            : e,
                        ),
                      })),
                    }));
                }}
              >
                应用到现有文字
              </button>
              <h3>基础服装模板</h3>
              <p className="hint">
                追加 7
                页：主视觉、模特、颜色、细节、尺码、故事、购买须知。不会替换现有页面。
              </p>
              <button
                className="wide"
                onClick={() => {
                  const pages = templatePages(project.brand);
                  update((p) => ({ ...p, pages: [...p.pages, ...pages] }));
                  selectPage(pages[0].id);
                  setStatus("已追加基础服装模板，请替换占位文案并添加真实照片");
                }}
              >
                ＋ 添加服装模板
              </button>
            </section>
          )}
          {tab === "导出检查" && (
            <section>
              <h3>交付设置</h3>
              <label className="field">
                图片格式
                <select
                  aria-label="图片格式"
                  value={format}
                  onChange={(e) => setFormat(e.target.value as typeof format)}
                >
                  <option value="png">PNG · 无损</option>
                  <option value="jpeg">JPG · 高质量</option>
                </select>
              </label>
              <p className="hint">
                导出固定宽度
                790px，高度使用各页面设置，背景为品牌背景色。画布缩放不影响导出质量。
              </p>
              <button
                className="wide"
                disabled={busy}
                onClick={() => exportPages("page")}
              >
                导出当前页
              </button>
              <button
                className="wide"
                disabled={busy}
                onClick={() => exportPages("zip")}
              >
                全部页面 ZIP
              </button>
              <button
                className="wide"
                disabled={busy}
                onClick={() => exportPages("long")}
              >
                整套长图
              </button>
              <h3>
                基础质量检查 <small>{checks.length} 项</small>
              </h3>
              {checks.length ? (
                checks.map((w, i) => (
                  <p className="warning" key={i}>
                    {w}
                  </p>
                ))
              ) : (
                <p className="notice">
                  ✓
                  未发现缺图、文本高度溢出或低分辨率问题。此检查不能代替人工校对。
                </p>
              )}
              <p className="hint">
                长图限制：高度不超过 30,000px、总像素不超过 2,400
                万。超出请使用逐页 ZIP。
              </p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
