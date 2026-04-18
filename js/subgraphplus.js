import { app } from "../../../scripts/app.js";

const EXTENSION_NAME = "Comfy.SubgraphPlus";
const MENU_LABEL = "Show Subgraph";
const STYLE_ELEMENT_ID = "subgraphplus-inline-styles";
const WINDOW_BASE_Z_INDEX = 2500;
const WINDOW_MIN_WIDTH = 520;
const WINDOW_MIN_HEIGHT = 380;
const VIEWPORT_PADDING = 40;
const CLEANUP_SWEEP_MS = 3000;
const POPUP_CLOSE_MS = 250;
const POPUP_OPEN_SYNC_MS = 100;

// Unique symbols to guard against double-patching across hot-reloads
const GRAPH_HOOK_FLAG = Symbol.for("subgraphplus.graph-hooked");
const NODE_INSTANCE_PATCH_FLAG = Symbol.for("subgraphplus.node-instance-patched");
const POPUP_CANVAS_PATCH_STATE = Symbol.for("subgraphplus.popup-canvas-patch-state");

const POPUP_CONTEXT_PROPS = [
  "theme", "links_render_mode", "render_shadows", "render_connections_border",
  "render_curved_connections", "node_title_color", "default_connection_color",
  "high_quality_render", "editor_alpha", "render_canvas_border", "render_nodes",
  "render_widgets", "background_image", "clear_background", "is_subgraph_canvas",
  "allow_interaction", "allow_dragnodes", "allow_dragcanvas", "read_only",
];

const POPUP_CONTEXT_METHODS = [
  "drawNodeWidgets",
  "adjustMouseEvent",
  "processMouseDown",
  "processMouseMove",
  "processMouseUp",
  "processContextMenu",
  "createDialog",
  "prompt",
  "showSearchBox",
];

const POPUP_CANVAS_DEFAULTS = Object.freeze({
  allow_interaction: true,
  allow_dragnodes: true,
  allow_dragcanvas: true,
  read_only: false,
  dragging_canvas: false,
});

const OPEN_POPUPS = new Map();
let cleanupIntervalId = null, loadGraphDataHooked = false;
let zIndexCounter = WINDOW_BASE_Z_INDEX, lastActivePopup = null, globalResizeObserver = null;
let queuedRefreshFrame = null;
let primaryCanvas = null;
const queuedRefreshSet = new Set();

function mkEl(tag, className, parent, props = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (parent) parent.appendChild(el);

  for (const [k, v] of Object.entries(props)) {
    if (k === "dataset") Object.assign(el.dataset, v);
    else el[k] = v;
  }
  return el;
}

function refreshMainUI() {
  app.graph?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
}

function markCanvasDirty(graphCanvas) {
  graphCanvas?.setDirty(true, true);
}

function copyDefinedProps(target, source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

function copyPatchedMethods(target, source, methodNames) {
  for (const methodName of methodNames) {
    if (typeof source[methodName] === "function" && source[methodName] !== target.constructor?.prototype?.[methodName]) {
      target[methodName] = source[methodName];
    }
  }
}

const INLINE_STYLES = `
:root {
  --sgp-bg: #111113;
  --sgp-surface: #1e1e21;
  --sgp-border: rgba(255, 255, 255, 0.08);
  --sgp-divider: rgba(255, 255, 255, 0.05);
  --sgp-text: #e2e8f0;
  --sgp-text-dim: #94a3b8;
  --sgp-text-muted: #475569;
  --sgp-accent: #3b82f6;
  --sgp-font: "Inter", system-ui, sans-serif;
  --sgp-mono: "JetBrains Mono", monospace;
}

.subgraphplus-window {
  position: fixed;
  left: 100px;
  top: 100px;
  width: 900px;
  height: 600px;
  min-width: ${WINDOW_MIN_WIDTH}px;
  min-height: ${WINDOW_MIN_HEIGHT}px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 12px;
  background: var(--sgp-bg);
  border: 1px solid var(--sgp-border);
  box-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.5);
  color: var(--sgp-text);
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 350ms cubic-bezier(0.4, 0, 0.2, 1), transform 350ms cubic-bezier(0.4, 0, 0.2, 1);
  z-index: ${WINDOW_BASE_Z_INDEX};
}

.subgraphplus-window--mounted {
  opacity: 1;
  transform: translateY(0);
}

.subgraphplus-window--active {
  border-color: rgba(59, 130, 246, 0.25);
  box-shadow: 0 20px 60px -15px rgba(0, 0, 0, 0.6);
}

.subgraphplus-window--active .subgraphplus-header {
  background: linear-gradient(to bottom, rgba(59, 130, 246, 0.05), var(--sgp-surface));
}

.subgraphplus-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 14px;
  background: var(--sgp-surface);
  border-bottom: 1px solid var(--sgp-divider);
  cursor: move;
  user-select: none;
  flex-shrink: 0;
}

.subgraphplus-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.subgraphplus-glyph-box {
  color: var(--sgp-text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.subgraphplus-titlewrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.subgraphplus-title {
  font-family: var(--sgp-font);
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subgraphplus-stat-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--sgp-divider);
  border-radius: 4px;
  font-family: var(--sgp-mono);
  font-size: 10px;
  color: var(--sgp-text-muted);
}

.subgraphplus-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.subgraphplus-control-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--sgp-text-dim);
  cursor: pointer;
  transition: all 0.15s ease;
}

.subgraphplus-control-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
}

.subgraphplus-control-btn--fit:hover {
  color: var(--sgp-accent);
  background: rgba(59, 130, 246, 0.1);
}

.subgraphplus-control-btn--close:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
}

.subgraphplus-body {
  position: relative;
  flex: 1;
  background: #000;
  overflow: hidden;
}

.subgraphplus-viewport {
  position: absolute;
  inset: 0;
  overflow: visible;
}

.subgraphplus-canvas {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
}

.subgraphplus-viewport > .graphdialog,
.subgraphplus-viewport > .litegraph.dialog,
.subgraphplus-viewport > .litegraph.litesearchbox.graphdialog,
.subgraphplus-viewport > .litecontextmenu {
  z-index: 12;
}

.subgraphplus-resize-handle {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  z-index: 100;
}

.subgraphplus-resize-handle::after {
  content: "";
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 4px;
  height: 4px;
  border-right: 1px solid var(--sgp-text-muted);
  border-bottom: 1px solid var(--sgp-text-muted);
}

.subgraphplus-window--resizing { transition: none !important; }
.subgraphplus-window--closing {
  opacity: 0 !important;
  transform: translateY(4px) !important;
  pointer-events: none !important;
}
`;

let _cachedGC = null;
function getCanvasClass() {
  return _cachedGC ??= globalThis.LGraphCanvas ?? globalThis.LiteGraph?.LGraphCanvas ?? app?.canvas?.constructor ?? null;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const el = mkEl("style");
  el.id = STYLE_ELEMENT_ID;
  el.textContent = INLINE_STYLES;
  document.head.appendChild(el);
}

function getStaggerPos(count) {
  const i = count % 8;
  return { x: 120 + i * 34, y: 110 + i * 28 };
}

function isSubgraphNode(node) {
  return node && typeof node.isSubgraphNode === "function" && node.isSubgraphNode() && !!node.subgraph;
}

function getRootGraph() {
  return app.rootGraph ?? app.graph?.rootGraph ?? app.graph ?? null;
}

function getNodeKey(node) {
  return `${node?.graph?.id ?? "g"}:${node?.id ?? "n"}`;
}

function getTitleText(node) {
  if (!node) return "Subgraph";
  return (typeof node.getTitle === "function" ? node.getTitle() : node.title) || node.subgraph?.name || "Subgraph";
}

function getGraphNodes(graph) {
  const nodes = graph?._nodes ?? graph?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function toVec2(value) {
  if (!value) return null;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  if (typeof value === "object") {
    const x = Number(value.x ?? value[0]);
    const y = Number(value.y ?? value[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  return null;
}

function getItemSize(item) {
  const explicitSize = toVec2(item?.size);
  if (explicitSize) return explicitSize;
  if (typeof item?.computeSize === "function") {
    const computedSize = toVec2(item.computeSize());
    if (computedSize) return computedSize;
  }
  return [160, 90];
}

function computeNodeBounds(graph) {
  const items = getGraphNodes(graph).filter(Boolean);
  if (!items.length) return null;

  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const item of items) {
    const pos = toVec2(item?.pos);
    const size = getItemSize(item);
    const [x, y] = pos || [];
    const [width, height] = size || [];
    if (![x, y, width, height].every(Number.isFinite)) continue;

    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x + width);
    bounds.maxY = Math.max(bounds.maxY, y + height);
  }

  if (!Number.isFinite(bounds.minX)) return null;

  return {
    minX: bounds.minX,
    minY: bounds.minY,
    width: Math.max(1, bounds.maxX - bounds.minX),
    height: Math.max(1, bounds.maxY - bounds.minY),
  };
}

function setOffset(ds, x, y) {
  if (typeof ds.offset?.set === "function") ds.offset.set([x, y]);
  else if (Array.isArray(ds.offset) || ArrayBuffer.isView(ds.offset)) { ds.offset[0] = x; ds.offset[1] = y; }
  else ds.offset = [x, y];
}

function fitGraphToViewport(entry) {
  const { graphCanvas, graph, canvasElement } = entry;
  const ds = graphCanvas?.ds;
  if (!ds || !canvasElement) return;

  const w = canvasElement.width || canvasElement.clientWidth || 1;
  const h = canvasElement.height || canvasElement.clientHeight || 1;
  const bounds = computeNodeBounds(graph);

  if (!bounds) {
    ds.scale = 1;
    setOffset(ds, VIEWPORT_PADDING, VIEWPORT_PADDING);
    markCanvasDirty(graphCanvas);
    return;
  }

  const scale = Math.max(0.1, Math.min((w - VIEWPORT_PADDING * 2) / bounds.width, (h - VIEWPORT_PADDING * 2) / bounds.height, 1.25));
  ds.scale = scale;
  setOffset(ds,
    w / (2 * scale) - bounds.minX - bounds.width / 2,
    h / (2 * scale) - bounds.minY - bounds.height / 2,
  );

  markCanvasDirty(graphCanvas);
}

function queueGraphRefresh(graph) {
  if (!graph) return;
  queuedRefreshSet.add(graph);
  if (queuedRefreshFrame != null) return;

  queuedRefreshFrame = requestAnimationFrame(() => {
    queuedRefreshFrame = null;
    for (const g of queuedRefreshSet) {
      for (const entry of OPEN_POPUPS.values()) {
        if (entry.graph !== g) continue;
        updateWindowLabels(entry);
        markCanvasDirty(entry.graphCanvas);
      }
    }
    refreshMainUI();
    queuedRefreshSet.clear();
  });
}

function installGraphHook(graph) {
  if (!graph || graph[GRAPH_HOOK_FLAG]) return;
  const orig = graph.change;
  graph.change = function () {
    orig?.apply?.(this, arguments);
    queueGraphRefresh(this);
  };
  graph[GRAPH_HOOK_FLAG] = true;
}

function bringToFront(entry) {
  if (lastActivePopup === entry && entry.root.style.zIndex === String(zIndexCounter) && app.canvas === entry.graphCanvas) return;
  if (lastActivePopup) lastActivePopup.root.classList.remove("subgraphplus-window--active");

  entry.root.style.zIndex = String(++zIndexCounter);
  entry.root.classList.add("subgraphplus-window--active");
  lastActivePopup = entry;

  setActiveCanvas(entry.graphCanvas);
  markCanvasDirty(entry.graphCanvas);
}

function restoreMainCanvas() {
  const fallback = isPopupCanvas(app.canvas) ? primaryCanvas : app.canvas;
  if (fallback) setActiveCanvas(fallback);
}

function ensureGlobalResizeObserver() {
  if (globalResizeObserver || typeof ResizeObserver !== "function") return;
  globalResizeObserver = new ResizeObserver((entries) => {
    for (const resEntry of entries) {
      const entry = OPEN_POPUPS.get(resEntry.target.dataset.subgraphplusKey);
      if (entry) syncCanvasSize(entry);
    }
  });
}

function updateWindowLabels(entry) {
  const title = getTitleText(entry.node);
  const count = getGraphNodes(entry.graph).filter(Boolean).length;
  if (entry.titleElement.textContent !== title) entry.titleElement.textContent = title;
  const stat = String(count);
  if (entry.statValue.textContent !== stat) entry.statValue.textContent = stat;
}

function syncCanvasSize(entry, doFit = false) {
  const rect = entry.viewport.getBoundingClientRect();
  const w = Math.floor(rect.width), h = Math.floor(rect.height);

  if (entry.canvasElement.width !== w || entry.canvasElement.height !== h) {
    entry.canvasElement.width = w;
    entry.canvasElement.height = h;
    entry.canvasElement.style.width = `${w}px`;
    entry.canvasElement.style.height = `${h}px`;
  }

  if (doFit || !entry.didInitialFit) {
    entry.didInitialFit = true;
    fitGraphToViewport(entry);
  } else {
    markCanvasDirty(entry.graphCanvas);
  }
}

function isNodeStillAlive(entry) {
  const node = entry.node;
  return !!(
    node
    && node.graph
    && typeof node.graph.getNodeById === "function"
    && node.graph.getNodeById(node.id) === node
  );
}

function drawPopupWidget(ctx, x, y, width, height, widget) {
  if (!widget) return;

  ctx.fillStyle = "#161618";
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, [4]);
  ctx.fill();
  ctx.strokeStyle = "#333";
  ctx.stroke();

  ctx.fillStyle = "#888";
  ctx.font = "10px " + (this.inner_text_font || "Arial");
  ctx.fillText(widget.name?.toUpperCase() || "WIDGET", x + 6, y + 12);

  let val = String(widget.value ?? "");
  if (val.length > 50) val = val.substring(0, 47) + "...";

  ctx.fillStyle = "#eee";
  const valueFont = widget.type === "string" || widget.type === "text"
    ? "11px 'JetBrains Mono', monospace"
    : "11px Inter, system-ui, sans-serif";
  ctx.font = valueFont;
  ctx.fillText(val, x + 6, y + height - 8);

  if (widget.type === "combo") {
    ctx.fillStyle = "#666";
    ctx.beginPath();
    ctx.moveTo(x + width - 12, y + height / 2 - 2);
    ctx.lineTo(x + width - 6, y + height / 2 - 2);
    ctx.lineTo(x + width - 9, y + height / 2 + 2);
    ctx.fill();
  }
}

function ensurePopupCanvasPatched(targetGC) {
  if (!targetGC) return;

  const state = targetGC[POPUP_CANVAS_PATCH_STATE] || (targetGC[POPUP_CANVAS_PATCH_STATE] = {});
  if (targetGC.drawWidget !== drawPopupWidget) targetGC.drawWidget = drawPopupWidget;

  if (!state.origDraw) {
    state.origDraw = targetGC.draw || targetGC.constructor?.prototype?.draw;
  }
  if (state.drawWrapped || typeof state.origDraw !== "function") return;

  targetGC.draw = function subgraphPlusPopupDraw() {
    const oldCanvas = app.canvas;
    app.canvas = this;
    try {
      if (primaryCanvas && primaryCanvas !== this) {
        copyDefinedProps(this, primaryCanvas, POPUP_CONTEXT_PROPS);
        this.render_widgets = true;
        this.render_connections = true;
        this.is_subgraph_canvas = true;
        this.use_render_buffer = false;
      }
      return state.origDraw.apply(this, arguments);
    } finally {
      app.canvas = oldCanvas;
    }
  };
  state.drawWrapped = true;
}

function isPopupCanvas(canvas) {
  return !!canvas?.[POPUP_CANVAS_PATCH_STATE];
}

function rememberPrimaryCanvas(canvas) {
  if (canvas && !isPopupCanvas(canvas)) primaryCanvas = canvas;
}

function setActiveCanvas(canvas) {
  if (!canvas) return;
  rememberPrimaryCanvas(canvas);
  const cls = getCanvasClass();
  if (cls) cls.active_canvas = canvas;
  app.canvas = canvas;
}

function applyPopupCanvasInteractionDefaults(gc) {
  if (!gc) return;

  for (const [prop, value] of Object.entries(POPUP_CANVAS_DEFAULTS)) {
    if (prop in gc) gc[prop] = value;
  }
}

function injectComfyContext(targetGC) {
  const source = app.canvas;
  if (!targetGC || !source) return;
  rememberPrimaryCanvas(source);
  copyDefinedProps(targetGC, source, POPUP_CONTEXT_PROPS);

  targetGC.render_widgets = true;
  targetGC.render_connections = true;
  targetGC.is_subgraph_canvas = true;
  targetGC.use_render_buffer = false;

  copyPatchedMethods(targetGC, source, POPUP_CONTEXT_METHODS);

  ensurePopupCanvasPatched(targetGC);
}

function bindPopupGraph(entry, graph) {
  if (!entry?.graphCanvas || !graph) return;
  entry.graph = graph;
  injectComfyContext(entry.graphCanvas);

  const gc = entry.graphCanvas;
  if (typeof gc.openSubgraph === "function") {
    gc.openSubgraph(graph, entry.node);
  } else if (typeof gc.setGraph === "function") {
    gc.setGraph(graph);
  }
  applyPopupCanvasInteractionDefaults(gc);

  installGraphHook(graph);
}

function closePopup(key) {
  const entry = OPEN_POPUPS.get(key);
  if (!entry) return;
  OPEN_POPUPS.delete(key);
  entry.root.classList.add("subgraphplus-window--closing");

  const teardown = () => {
    if (globalResizeObserver) globalResizeObserver.unobserve(entry.viewport);
    entry.graphCanvas?.stopRendering?.();
    entry.graphCanvas?.unbindEvents?.();
    try { entry.graphCanvas?.graph?.detachCanvas?.(entry.graphCanvas); } catch(_) {}
    entry.abortController?.abort();
    entry.root.remove();
    if (lastActivePopup === entry) lastActivePopup = null;
    const fallbackEntry = lastActivePopup ?? Array.from(OPEN_POPUPS.values()).at(-1) ?? null;
    if (fallbackEntry) bringToFront(fallbackEntry);
    else restoreMainCanvas();
    if (OPEN_POPUPS.size === 0) {
      if (cleanupIntervalId) { clearInterval(cleanupIntervalId); cleanupIntervalId = null; }
      zIndexCounter = WINDOW_BASE_Z_INDEX;
    }
    refreshMainUI();
  };
  setTimeout(teardown, POPUP_CLOSE_MS);
}

function closeAllPopups() {
  for (const key of [...OPEN_POPUPS.keys()]) closePopup(key);
}

function sweepPopups() {
  for (const [key, entry] of OPEN_POPUPS.entries()) {
    if (!document.body.contains(entry.root) || !isNodeStillAlive(entry)) {
      closePopup(key);
      continue;
    }
    if (entry.node?.subgraph && entry.graph !== entry.node.subgraph) {
      bindPopupGraph(entry, entry.node.subgraph);
      syncCanvasSize(entry, true);
    }
    updateWindowLabels(entry);
  }
}

function ensureCleanupSweep() {
  if (cleanupIntervalId) return;
  cleanupIntervalId = setInterval(sweepPopups, CLEANUP_SWEEP_MS);
}

function patchLifecycleMethods() {
  if (loadGraphDataHooked) return;
  const origLoad = app.loadGraphData;
  const origClean = app.clean;
  app.loadGraphData = async function () {
    closeAllPopups();
    return origLoad?.apply(this, arguments);
  };
  app.clean = function () {
    closeAllPopups();
    return origClean?.apply(this, arguments);
  };
  loadGraphDataHooked = true;
}

function setupPointerAction(entry, target, onMoveCallback, onStart, onEnd) {
  const signal = entry.abortController.signal;
  let state = null;
  const onPointerMove = (e) => {
    if (!state) return;
    onMoveCallback(e, state);
  };
  const finishPointerAction = (e) => {
    if (!state) return;
    state = null;
    target.releasePointerCapture?.(e.pointerId);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", finishPointerAction);
    window.removeEventListener("pointercancel", finishPointerAction);
    onEnd?.(e);
  };
  target.addEventListener("pointerdown", (e) => {
    const isButtonTarget = e.target instanceof Element && e.target.closest("button");
    if (e.button !== 0 || isButtonTarget) return;

    const nextState = onStart(e);
    if (!nextState) return;

    state = nextState;
    target.setPointerCapture?.(e.pointerId);
    window.addEventListener("pointermove", onPointerMove, { signal });
    window.addEventListener("pointerup", finishPointerAction, { signal });
    window.addEventListener("pointercancel", finishPointerAction, { signal });
    e.preventDefault();
  }, { signal });
}

function makeWindowDraggable(entry) {
  setupPointerAction(entry, entry.header,
    (e, s) => {
      entry.root.style.left = `${Math.max(0, s.x0 + (e.clientX - s.cx0))}px`;
      entry.root.style.top = `${Math.max(0, s.y0 + (e.clientY - s.cy0))}px`;
    },
    (e) => ({ cx0: e.clientX, cy0: e.clientY, x0: entry.root.offsetLeft, y0: entry.root.offsetTop })
  );
}

function makeWindowResizable(entry) {
  setupPointerAction(entry, entry.resizeHandle,
    (e, s) => {
      entry.root.style.width = `${Math.max(s.minW, Math.min(window.innerWidth - s.left - 10, s.w0 + (e.clientX - s.cx0)))}px`;
      entry.root.style.height = `${Math.max(s.minH, Math.min(window.innerHeight - s.top - 10, s.h0 + (e.clientY - s.cy0)))}px`;
      syncCanvasSize(entry);
    },
    (e) => {
      entry.root.classList.add("subgraphplus-window--resizing");
      const s = getComputedStyle(entry.root);
      return { cx0: e.clientX, cy0: e.clientY, w0: entry.root.offsetWidth, h0: entry.root.offsetHeight,
               left: entry.root.offsetLeft, top: entry.root.offsetTop,
               minW: parseFloat(s.minWidth) || WINDOW_MIN_WIDTH, minH: parseFloat(s.minHeight) || WINDOW_MIN_HEIGHT };
    },
    () => entry.root.classList.remove("subgraphplus-window--resizing")
  );
}

const ICONS = {
  fit: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>`,
  close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  nodes: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`,
  glyph: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="2"></circle></svg>`
};

function createControlButton(iconKey, title, className, onClick) {
  const btn = mkEl("button", `subgraphplus-control-btn ${className || ""}`.trim());
  btn.type = "button";
  btn.innerHTML = ICONS[iconKey] || "";
  btn.title = title;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function createPopupShell(nodeKey) {
  const root = mkEl("div", "subgraphplus-window", document.body, { dataset: { subgraphplusKey: nodeKey } });
  const header = mkEl("div", "subgraphplus-header", root);
  const identity = mkEl("div", "subgraphplus-identity", header);
  const body = mkEl("div", "subgraphplus-body", root);

  mkEl("div", "subgraphplus-glyph-box", identity, { innerHTML: ICONS.glyph });
  const titleElement = mkEl("div", "subgraphplus-title", mkEl("div", "subgraphplus-titlewrap", identity));

  const statBadge = mkEl("div", "subgraphplus-stat-badge", identity, { innerHTML: ICONS.nodes });
  const statValue = mkEl("span", "subgraphplus-stat-value", statBadge);

  const actions = mkEl("div", "subgraphplus-actions", header);
  const viewport = mkEl("div", "subgraphplus-viewport", body, { dataset: { subgraphplusKey: nodeKey } });
  const canvasElement = mkEl("canvas", "subgraphplus-canvas", viewport, { tabIndex: 0 });

  actions.append(
    createControlButton("fit", "Center View", "subgraphplus-control-btn--fit", () => {
      const entry = OPEN_POPUPS.get(nodeKey);
      if (entry) fitGraphToViewport(entry);
    }),
    createControlButton("close", "Close Viewer", "subgraphplus-control-btn--close", () => closePopup(nodeKey))
  );

  return {
    root,
    header,
    viewport,
    canvasElement,
    titleElement,
    statValue,
    resizeHandle: mkEl("div", "subgraphplus-resize-handle", root),
  };
}

function openSubgraphPopup(node) {
  if (!isSubgraphNode(node)) return;
  const key = getNodeKey(node);
  const existing = OPEN_POPUPS.get(key);
  if (existing) {
    bringToFront(existing);
    syncCanvasSize(existing);
    return;
  }

  const CanvasClass = getCanvasClass();
  const rootGraph = getRootGraph();
  if (!CanvasClass || !rootGraph) return;

  const shell = createPopupShell(key);
  const pos = getStaggerPos(OPEN_POPUPS.size);
  shell.root.style.left = `${pos.x}px`;
  shell.root.style.top = `${pos.y}px`;

  const graphCanvas = new CanvasClass(shell.canvasElement, rootGraph, { autoresize: false, skip_render: true });
  graphCanvas.parent_el = shell.viewport;

  const entry = {
    key,
    node,
    graph: node.subgraph,
    graphCanvas,
    didInitialFit: false,
    abortController: new AbortController(),
    ...shell,
  };

  bindPopupGraph(entry, node.subgraph);
  OPEN_POPUPS.set(key, entry);
  updateWindowLabels(entry);
  makeWindowDraggable(entry);
  makeWindowResizable(entry);
  bringToFront(entry);

  requestAnimationFrame(() => shell.root.classList.add("subgraphplus-window--mounted"));
  ensureGlobalResizeObserver();
  if (globalResizeObserver) globalResizeObserver.observe(entry.viewport);

  const signal = entry.abortController.signal;
  const onFocus = (e) => {
    if (e.type === "contextmenu") e.stopPropagation();
    bringToFront(entry);
    if (e.target === shell.canvasElement) shell.canvasElement.focus();
  };
  const onDocumentPointerDown = (e) => {
    if (!(e.target instanceof Element) || !e.target.closest(".subgraphplus-window")) {
      restoreMainCanvas();
    }
  };

  [shell.root, shell.canvasElement].forEach(el => el.addEventListener("pointerdown", onFocus, { signal }));
  shell.canvasElement.addEventListener("contextmenu", onFocus, { signal });
  document.addEventListener("pointerdown", onDocumentPointerDown, { capture: true, signal });
  ["pointerup", "keyup"].forEach((ev) => shell.canvasElement.addEventListener(ev, () => {
    entry.node?.setDirtyCanvas?.(true, true);
    refreshMainUI();
  }, { signal }));

  graphCanvas.startRendering?.();
  ensureCleanupSweep();

  setTimeout(() => syncCanvasSize(entry, true), POPUP_OPEN_SYNC_MS);
}

app.registerExtension({
  name: EXTENSION_NAME,

  setup() {
    ensureStyles();
    patchLifecycleMethods();
  },

  getCanvasMenuItems() {
    if (OPEN_POPUPS.size === 0) return [];
    return [null, { content: "Close All Subgraphs", callback: closeAllPopups }];
  },

  loadedGraphNode(node) {
    if (!isSubgraphNode(node) || node[NODE_INSTANCE_PATCH_FLAG]) return;
    const orig = node.getExtraMenuOptions;
    node.getExtraMenuOptions = function(_, options) {
      const res = orig?.apply?.(this, arguments);
      const opts = Array.isArray(res) ? res : options;
      if (isSubgraphNode(this) && !opts.some(o => o?.content === MENU_LABEL)) {
        opts.unshift({ content: MENU_LABEL, callback: () => openSubgraphPopup(this) });
      }
      return res;
    };

    const origTitleClick = node.onTitleButtonClick;
    node.onTitleButtonClick = function(button) {
      if (button?.name === "enter_subgraph" && isSubgraphNode(this)) {
        openSubgraphPopup(this);
        return;
      }
      return origTitleClick?.apply(this, arguments);
    };

    node[NODE_INSTANCE_PATCH_FLAG] = true;
  },

  nodeCreated(node) { this.loadedGraphNode(node); }
});
