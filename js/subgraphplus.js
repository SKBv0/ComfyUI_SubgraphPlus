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
const POPUP_OVERLAY_SELECTOR = ".graphdialog, .litesearchbox, .litecontextmenu";
const LITEGRAPH_DIALOG_OFFSET = 20;

// Unique symbols to guard against double-patching across hot-reloads
const GRAPH_HOOK_FLAG = Symbol.for("subgraphplus.graph-hooked");
const NODE_INSTANCE_PATCH_FLAG = Symbol.for("subgraphplus.node-instance-patched");
const POPUP_CANVAS_PATCH_STATE = Symbol.for("subgraphplus.popup-canvas-patch-state");
const CANVAS_STATIC_PATCH_FLAG = Symbol.for("subgraphplus.canvas-static-patched");

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

const POPUP_ACTIVATION_METHODS = new Set([
  "processMouseDown",
  "processMouseUp",
  "processContextMenu",
  "createDialog",
  "prompt",
  "showSearchBox",
]);

const POPUP_CANVAS_DEFAULTS = Object.freeze({
  allow_interaction: true,
  allow_dragnodes: true,
  allow_dragcanvas: true,
  read_only: false,
  dragging_canvas: false,
});

const OPEN_POPUPS = new Map();
const PENDING_POPUP_OPEN_KEYS = new Set();
const POPUP_VIEW_STATE = new Map();
let cleanupIntervalId = null, loadGraphDataHooked = false;
let zIndexCounter = WINDOW_BASE_Z_INDEX, lastActivePopup = null, globalResizeObserver = null;
let queuedRefreshFrame = null;
let primaryCanvas = null;
let activePopupOwner = null;
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
  if (primaryCanvas && primaryCanvas !== app.canvas) {
    primaryCanvas.setDirty?.(true, true);
  }
}

function markCanvasDirty(graphCanvas) {
  graphCanvas?.setDirty(true, true);
}

function copyDefinedProps(target, source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

function restoreCanvasBinding(prevAppCanvas, prevActive) {
  const cls = getCanvasClass();
  // Keep global canvas refs pinned to the main canvas outside scoped calls.
  if (prevAppCanvas && !isPopupCanvas(prevAppCanvas)) {
    app.canvas = prevAppCanvas;
  } else if (primaryCanvas) {
    app.canvas = primaryCanvas;
  }
  if (cls) {
    if (prevActive && !isPopupCanvas(prevActive)) cls.active_canvas = prevActive;
    else if (primaryCanvas) cls.active_canvas = primaryCanvas;
  }
}

// Some ComfyUI/LiteGraph methods read global canvas refs instead of `this`.
function wrapWithAppCanvasBinding(sourceFn) {
  return function subgraphPlusCanvasBinding() {
    const prevAppCanvas = app.canvas;
    const cls = getCanvasClass();
    const prevActive = cls ? cls.active_canvas : undefined;
    app.canvas = this;
    if (cls) cls.active_canvas = this;
    try {
      return sourceFn.apply(this, arguments);
    } finally {
      restoreCanvasBinding(prevAppCanvas, prevActive);
    }
  };
}

function wrapWithPopupActivation(sourceFn) {
  return function subgraphPlusPopupActivation() {
    const entry = this?._subgraphplusEntry;
    if (entry) activatePopupEntry(entry);
    return sourceFn.apply(this, arguments);
  };
}

// These methods choose dialog/searchbox parents from LGraphCanvas.active_canvas.
const POPUP_DIALOG_METHODS = new Set([
  "prompt",
  "createDialog",
  "showSearchBox",
  "processContextMenu",
]);

function collectPopupOverlayElements() {
  return new Set(Array.from(document.querySelectorAll(POPUP_OVERLAY_SELECTOR))
    .filter((el) => el instanceof HTMLElement));
}

function moveOverlayIntoPopup(entry, overlay, preferredPosition = null) {
  if (!entry?.viewport?.isConnected || !(overlay instanceof HTMLElement)) return;

  const overlayRect = overlay.getBoundingClientRect();
  const viewportRect = entry.viewport.getBoundingClientRect();

  if (overlay.parentElement !== entry.viewport) {
    entry.viewport.appendChild(overlay);
  }

  const maxLeft = Math.max(0, viewportRect.width - overlayRect.width);
  const maxTop = Math.max(0, viewportRect.height - overlayRect.height);
  const baseLeft = Number(preferredPosition?.left);
  const baseTop = Number(preferredPosition?.top);
  const nextLeft = Math.max(0, Math.min(
    Number.isFinite(baseLeft) ? baseLeft : overlayRect.left - viewportRect.left,
    maxLeft,
  ));
  const nextTop = Math.max(0, Math.min(
    Number.isFinite(baseTop) ? baseTop : overlayRect.top - viewportRect.top,
    maxTop,
  ));

  const left = `${nextLeft}px`;
  const top = `${nextTop}px`;

  if (overlay.style.position !== "absolute") overlay.style.position = "absolute";
  if (overlay.style.left !== left) overlay.style.left = left;
  if (overlay.style.top !== top) overlay.style.top = top;
  if (overlay.style.right !== "") overlay.style.right = "";
  if (overlay.style.bottom !== "") overlay.style.bottom = "";
  if (overlay.style.zIndex !== "12") overlay.style.zIndex = "12";
  if (overlay.dataset.subgraphplusOwner !== entry.key) overlay.dataset.subgraphplusOwner = entry.key;
}

function adoptPopupOverlays(entry, beforeOverlays, result, preferredPosition = null) {
  if (!entry?.viewport?.isConnected) return;

  const candidates = new Set();
  if (result instanceof HTMLElement && result.matches?.(POPUP_OVERLAY_SELECTOR)) {
    candidates.add(result);
  }

  for (const overlay of document.querySelectorAll(POPUP_OVERLAY_SELECTOR)) {
    if (!(overlay instanceof HTMLElement) || beforeOverlays?.has(overlay)) continue;
    candidates.add(overlay);
  }

  for (const overlay of candidates) {
    moveOverlayIntoPopup(entry, overlay, preferredPosition);
  }
}

function wrapWithPopupOverlayAdoption(sourceFn) {
  return function subgraphPlusPopupOverlayAdoption() {
    const entry = this?._subgraphplusEntry ?? null;
    const beforeOverlays = entry ? collectPopupOverlayElements() : null;
    const result = sourceFn.apply(this, arguments);
    if (entry) adoptPopupOverlays(entry, beforeOverlays, result);
    return result;
  };
}

function copyPatchedMethods(target, source, methodNames) {
  for (const methodName of methodNames) {
    const sourceFn = source[methodName];
    if (typeof sourceFn !== "function") continue;
    const isPrototypeMethod = sourceFn === target.constructor?.prototype?.[methodName];
    if (isPrototypeMethod && !POPUP_DIALOG_METHODS.has(methodName)) continue;
    let wrappedFn = wrapWithAppCanvasBinding(sourceFn);
    if (POPUP_DIALOG_METHODS.has(methodName)) {
      wrappedFn = wrapWithPopupOverlayAdoption(wrappedFn);
    }
    target[methodName] = POPUP_ACTIVATION_METHODS.has(methodName)
      ? wrapWithPopupActivation(wrappedFn)
      : wrappedFn;
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

.subgraphplus-textarea {
  position: absolute;
  margin: 0;
  resize: none;
  box-sizing: border-box;
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

/* Keep LiteGraph dialogs/searchboxes above popup windows when they render in body. */
body > .graphdialog,
body > .litegraph.dialog,
body > .litegraph.litesearchbox,
body > .litesearchbox,
body > .litecontextmenu {
  z-index: 1000000 !important;
}

body.subgraphplus-popup-active .dom-widget,
body.subgraphplus-popup-active div[style*="--tb-x"] {
  z-index: 1000000 !important;
}

/* Hide the main GraphView selection overlay while a popup canvas is active. */
body.subgraphplus-popup-active div.pointer-events-none.absolute.z-9999.border.border-blue-400.bg-blue-500\\/20 {
  display: none !important;
}

.subgraphplus-selection-rect {
  position: absolute;
  pointer-events: none;
  border: 1px solid rgba(96, 165, 250, 0.9);
  background: rgba(59, 130, 246, 0.18);
  z-index: 9;
  display: none;
}
`;

let _cachedGC = null;
function getCanvasClass() {
  return _cachedGC ??= globalThis.LGraphCanvas ?? globalThis.LiteGraph?.LGraphCanvas ?? app?.canvas?.constructor ?? null;
}

function getPinia() {
  const vueApp = app?.vueApp ?? null;
  const directPinia = vueApp?.config?.globalProperties?.$pinia ?? null;
  if (directPinia?._s instanceof Map) return directPinia;

  const provides = vueApp?._context?.provides;
  if (!provides) return null;

  for (const key of Reflect.ownKeys(provides)) {
    const value = provides[key];
    if (value?._s instanceof Map) return value;
  }
  return null;
}

function getPiniaStore(id) {
  return getPinia()?._s?.get?.(id) ?? null;
}

function getCanvasStore() {
  return getPiniaStore("canvas");
}

function getWorkflowStore() {
  return getPiniaStore("workflow");
}

function getActiveChangeTracker() {
  return getWorkflowStore()?.activeWorkflow?.changeTracker ?? null;
}

function recordPopupGraphChange() {
  getActiveChangeTracker()?.checkState?.();
}

function syncCanvasStoreFromCanvas(canvas) {
  const canvasStore = getCanvasStore();
  if (!canvasStore || !canvas) return;

  // Pinia canvas watchers are expensive; never point them at popup canvases.
  if (isPopupCanvas(canvas)) return;

  if (canvasStore.canvas !== canvas) canvasStore.canvas = canvas;
  if ("currentGraph" in canvasStore) canvasStore.currentGraph = canvas.graph ?? null;
  if ("isInSubgraph" in canvasStore) canvasStore.isInSubgraph = Boolean(canvas.subgraph);
  canvasStore.updateSelectedItems?.();
}

function setPopupUiState(active) {
  document.body.classList.toggle("subgraphplus-popup-active", !!active);
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

function getNodePathIds(targetNode, graph = getRootGraph(), trail = [], seenGraphs = new Set()) {
  if (!targetNode || !graph) return null;
  if (seenGraphs.has(graph)) return null;
  seenGraphs.add(graph);

  for (const node of getGraphNodes(graph)) {
    if (!node) continue;

    const nextTrail = [...trail, String(node.id)];
    if (node === targetNode) return nextTrail;

    if (!isSubgraphNode(node)) continue;
    const nestedPath = getNodePathIds(targetNode, node.subgraph, nextTrail, new Set(seenGraphs));
    if (nestedPath) return nestedPath;
  }

  return null;
}

function findSubgraphNodeByPath(nodeKey, graph = getRootGraph()) {
  if (!nodeKey || !graph) return null;
  const path = String(nodeKey).split(":").filter(Boolean);
  if (!path.length) return null;

  let currentGraph = graph;
  for (let i = 0; i < path.length; i++) {
    const node = currentGraph?.getNodeById?.(path[i]) ?? currentGraph?.getNodeById?.(Number(path[i]));
    if (!node || !isSubgraphNode(node)) return null;
    if (i === path.length - 1) return node;
    currentGraph = node.subgraph;
  }

  return null;
}

function getNodeKey(node) {
  const path = getNodePathIds(node);
  return path?.join(":") ?? `${node?.graph?.id ?? "g"}:${node?.id ?? "n"}`;
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

function getPopupViewState(key) {
  return key ? POPUP_VIEW_STATE.get(key) ?? null : null;
}

function savePopupViewState(entry) {
  const ds = entry?.graphCanvas?.ds;
  const offset = toVec2(ds?.offset);
  const scale = Number(ds?.scale);
  if (!entry?.key || !offset || !Number.isFinite(scale)) return;

  POPUP_VIEW_STATE.set(entry.key, {
    scale,
    offset,
  });
}

function applyPopupViewState(entry) {
  const ds = entry?.graphCanvas?.ds;
  const state = getPopupViewState(entry?.key);
  if (!ds || !state) return false;

  ds.scale = state.scale;
  setOffset(ds, state.offset[0], state.offset[1]);
  markCanvasDirty(entry.graphCanvas);
  return true;
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
    savePopupViewState(entry);
    markCanvasDirty(graphCanvas);
    return;
  }

  const scale = Math.max(0.1, Math.min((w - VIEWPORT_PADDING * 2) / bounds.width, (h - VIEWPORT_PADDING * 2) / bounds.height, 1.25));
  ds.scale = scale;
  setOffset(ds,
    w / (2 * scale) - bounds.minX - bounds.width / 2,
    h / (2 * scale) - bounds.minY - bounds.height / 2,
  );

  savePopupViewState(entry);
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

function isPopupOverlayElement(target) {
  return target instanceof Element && !!target.closest(POPUP_OVERLAY_SELECTOR);
}

function setMutableCanvasProp(canvas, key, value) {
  if (!canvas) return;

  let proto = canvas;
  let descriptor;
  while (proto && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(proto, key);
    proto = Object.getPrototypeOf(proto);
  }

  if (descriptor && !descriptor.writable && typeof descriptor.set !== "function") return;

  try {
    canvas[key] = value;
  } catch (_) {
    /* ignore readonly canvas internals */
  }
}

function resetCanvasInteractionState(canvas) {
  if (!canvas) return;

  setMutableCanvasProp(canvas, "dragging_canvas", false);
  setMutableCanvasProp(canvas, "dragging_rectangle", null);
  setMutableCanvasProp(canvas, "node_dragged", null);
  setMutableCanvasProp(canvas, "connecting_node", null);
  setMutableCanvasProp(canvas, "connecting_input", null);
  setMutableCanvasProp(canvas, "connecting_output", null);
  setMutableCanvasProp(canvas, "resizing_node", null);
  setMutableCanvasProp(canvas, "selected_group", null);
  setMutableCanvasProp(canvas, "dragging_connection", false);
  setMutableCanvasProp(canvas, "pointer_is_down", false);
  setMutableCanvasProp(canvas, "block_click", false);
}

function deselectCanvasItems(canvas) {
  if (!canvas) return;

  const items = getSelectedCanvasItems(canvas);

  try { canvas.deselectAll?.(); } catch (_) {}
  try { canvas.deselectAllNodes?.(); } catch (_) {}

  for (const item of items) {
    try { item.onDeselected?.(); } catch (_) {}
    if (item && typeof item === "object") item.selected = false;
  }

  try { canvas.selectedItems?.clear?.(); } catch (_) {}
  if (canvas.selected_nodes && typeof canvas.selected_nodes === "object") canvas.selected_nodes = {};
  if (canvas.highlighted_links && typeof canvas.highlighted_links === "object") canvas.highlighted_links = {};
  setMutableCanvasProp(canvas, "current_node", null);
  setMutableCanvasProp(canvas, "selected_group", null);
  notifyCanvasSelectionChanged(canvas);
}

function getSelectedCanvasItems(canvas) {
  if (!canvas) return [];
  const items = canvas.selectedItems;
  if (!items || typeof items[Symbol.iterator] !== "function") return getSelectedCanvasNodes(canvas);
  const collected = Array.from(items).filter(Boolean);
  return collected.length ? collected : getSelectedCanvasNodes(canvas);
}

function getSelectedCanvasNodes(canvas) {
  if (!canvas) return [];

  const items = canvas.selectedItems;
  if (items && typeof items[Symbol.iterator] === "function") {
    const nodes = Array.from(items).filter((item) => item && typeof item === "object" && "id" in item && "mode" in item);
    if (nodes.length) return nodes;
  }

  const selectedNodes = canvas.selected_nodes;
  if (selectedNodes instanceof Map) {
    return Array.from(selectedNodes.values()).filter(Boolean);
  }
  if (selectedNodes && typeof selectedNodes === "object") {
    return Object.values(selectedNodes).filter(Boolean);
  }

  return [];
}

function notifyCanvasSelectionChanged(canvas) {
  if (!canvas) return;

  if (canvas.state && typeof canvas.state === "object") {
    canvas.state.selectionChanged = true;
  }

  try { canvas.onSelectionChange?.(canvas.selected_nodes ?? {}); } catch (_) {}
  canvas.setDirty?.(true, true);
}

function isTextEditingTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    const type = String(target.type || "text").toLowerCase();
    return !["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"].includes(type);
  }
  return target.isContentEditable || !!target.closest("[contenteditable=''], [contenteditable='true'], input, textarea");
}

function toggleCanvasNodesMode(canvas, mode) {
  const MODE_ALWAYS = 0;
  const nodes = getSelectedCanvasNodes(canvas);
  if (!nodes.length) return false;

  const nextMode = nodes.every((node) => node?.mode === mode) ? MODE_ALWAYS : mode;
  for (const node of nodes) {
    if (node) node.mode = nextMode;
  }

  canvas.graph?.change?.();
  canvas.setDirty?.(true, true);
  refreshMainUI();
  return true;
}

function consumePopupKeyEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

function neutralizeDeferredCoreKeyEvent(event) {
  for (const [key, value] of [
    ["key", "__subgraphplus_consumed__"],
    ["code", "__subgraphplus_consumed__"],
    ["ctrlKey", false],
    ["metaKey", false],
    ["shiftKey", false],
  ]) {
    try {
      Object.defineProperty(event, key, { configurable: true, value });
    } catch (_) {}
  }
}

function handlePopupDeleteKey(entry, event) {
  if (!entry?.graphCanvas || event.type !== "keydown") return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!["Delete", "Backspace"].includes(event.key)) return false;
  if (isTextEditingTarget(event.target instanceof Element ? event.target : document.activeElement)) return false;

  const canvas = entry.graphCanvas;
  activatePopupEntry(entry);
  setActiveCanvas(canvas);

  if (getSelectedCanvasItems(canvas).length) {
    canvas.deleteSelected?.();
    notifyCanvasSelectionChanged(primaryCanvas);
    notifyCanvasSelectionChanged(canvas);
    syncPopupTextareaWidgets(entry);
    savePopupViewState(entry);
    recordPopupGraphChange();
    refreshMainUI();
  }

  consumePopupKeyEvent(event);
  return true;
}

function handlePopupUndoRedoKey(entry, event) {
  if (!entry?.graphCanvas || event.type !== "keydown") return false;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  if (isTextEditingTarget(event.target instanceof Element ? event.target : document.activeElement)) return false;

  const key = String(event.key || "").toUpperCase();
  const isRedo = (key === "Y" && !event.shiftKey) || (key === "Z" && event.shiftKey);
  const isUndo = key === "Z" && !event.shiftKey;
  if (!isUndo && !isRedo) return false;

  const tracker = getActiveChangeTracker();
  if (!tracker) return false;

  activatePopupEntry(entry);
  setActiveCanvas(entry.graphCanvas);
  recordPopupGraphChange();
  neutralizeDeferredCoreKeyEvent(event);
  consumePopupKeyEvent(event);

  requestAnimationFrame(() => {
    Promise.resolve(isRedo ? tracker.redo?.() : tracker.undo?.()).finally(() => {
      syncPopupTextareaWidgets(entry);
      refreshMainUI();
    });
  });

  return true;
}

function handlePopupShortcut(entry, event) {
  if (!entry?.graphCanvas) return false;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  if (isTextEditingTarget(event.target instanceof Element ? event.target : document.activeElement)) return false;

  const key = String(event.key || "").toLowerCase();
  const canvas = entry.graphCanvas;
  if (key === "b") {
    if (!toggleCanvasNodesMode(canvas, 4)) return false;
  } else if (key === "m") {
    if (!toggleCanvasNodesMode(canvas, 2)) return false;
  } else if (key === "c") {
    if (!getSelectedCanvasItems(canvas).length) return false;
    activatePopupEntry(entry);
    canvas.copyToClipboard?.();
  } else if (key === "x") {
    if (!getSelectedCanvasItems(canvas).length) return false;
    activatePopupEntry(entry);
    canvas.copyToClipboard?.();
    canvas.deleteSelected?.();
    notifyCanvasSelectionChanged(primaryCanvas);
    notifyCanvasSelectionChanged(canvas);
    recordPopupGraphChange();
    refreshMainUI();
  } else if (key === "v") {
    activatePopupEntry(entry);
    canvas.pasteFromClipboard?.({ connectInputs: !!event.shiftKey });
    syncPopupTextareaWidgets(entry);
    savePopupViewState(entry);
    recordPopupGraphChange();
  } else {
    return false;
  }

  consumePopupKeyEvent(event);
  return true;
}

const POPUP_TEXTAREA_TYPES = new Set(["textarea", "multiline", "customtext"]);

function isPopupTextareaWidget(widget) {
  return POPUP_TEXTAREA_TYPES.has(String(widget?.type ?? "").toLowerCase());
}

function getPopupTextareaMap(entry) {
  if (!entry) return null;
  entry.textareaElements ??= new Map();
  return entry.textareaElements;
}

function getWidgetElement(widget) {
  const el = widget?.element ?? widget?.inputEl ?? null;
  return el instanceof HTMLElement ? el : null;
}

function restoreWidgetElementToMain(entry, el) {
  const fallbackHost = primaryCanvas?.canvas?.parentElement ?? document.body;
  if (el.dataset.subgraphplusOwner === entry?.key) {
    delete el.dataset.subgraphplusOwner;
    if (el.style.zIndex === "8") el.style.zIndex = "";
  }
  if (el.parentElement === entry?.viewport && fallbackHost) fallbackHost.appendChild(el);
}

function forEachGraphWidgetElement(graph, visitor) {
  for (const node of getGraphNodes(graph)) {
    if (!node?.widgets?.length) continue;
    for (const widget of node.widgets) {
      const el = getWidgetElement(widget);
      if (el) visitor(node, widget, el);
    }
  }
}

// Avoid redundant DOM writes during popup draw frames.
function syncPopupWidgetElements(entry) {
  if (!entry?.viewport?.isConnected) return;

  forEachGraphWidgetElement(entry.graph, (_, widget, el) => {
    if (isPopupTextareaWidget(widget)) {
      restoreWidgetElementToMain(entry, el);
      return;
    }

    if (el.parentElement !== entry.viewport) entry.viewport.appendChild(el);
    if (el.style.zIndex !== "8") el.style.zIndex = "8";
    if (el.style.pointerEvents !== "") el.style.pointerEvents = "";
    if (el.style.display !== "") el.style.display = "";
    if (el.dataset.subgraphplusOwner !== entry.key) el.dataset.subgraphplusOwner = entry.key;
  });
}

function restorePopupWidgetElements(entry) {
  forEachGraphWidgetElement(entry?.graph, (_, __, el) => {
    if (el.dataset.subgraphplusOwner !== entry?.key) return;
    restoreWidgetElementToMain(entry, el);
  });
}

function getPopupTextareaLayout(node, widget) {
  if (!node || !widget) return null;

  const margin = Number(widget.margin ?? 10);
  const width = Math.max(40, Number(widget.width ?? node.size?.[0] ?? 0) - margin * 2);
  const height = Math.max(48, Number(widget.computedHeight ?? 90) - margin * 2);
  const y = Number(widget.y ?? 0);

  if (![width, height, y].every(Number.isFinite)) return null;

  return {
    x: Number(node.pos?.[0] ?? 0) + margin,
    y: Number(node.pos?.[1] ?? 0) + margin + y,
    width,
    height,
  };
}

function syncPopupTextareaWidgets(entry) {
  const graphCanvas = entry?.graphCanvas;
  const viewport = entry?.viewport;
  const ds = graphCanvas?.ds;
  const store = getPopupTextareaMap(entry);
  if (!viewport?.isConnected || !graphCanvas || !ds || !store) return;

  const activeWidgets = new Set();
  const scale = Number(ds.scale) || 1;
  const offset = toVec2(ds.offset) ?? [0, 0];

  for (const node of getGraphNodes(entry.graph)) {
    if (!node?.widgets?.length) continue;

    for (const widget of node.widgets) {
      if (!isPopupTextareaWidget(widget)) continue;
      const layout = getPopupTextareaLayout(node, widget);
      if (!layout) continue;

      let textarea = store.get(widget);
      if (!textarea) {
        textarea = mkEl("textarea", "subgraphplus-textarea", viewport, {
          dataset: {
            subgraphplusKey: entry.key,
            subgraphplusTextarea: String(widget.name ?? "textarea"),
          },
          className: "subgraphplus-textarea comfy-multiline-input",
          spellcheck: true,
          wrap: "soft",
        });

        textarea.addEventListener("pointerdown", (event) => {
          event.stopPropagation();
          activatePopupEntry(entry);
          entry.graphCanvas.selectNode?.(node);
        });

        textarea.addEventListener("focus", () => {
          activatePopupEntry(entry);
          entry.graphCanvas.selectNode?.(node);
        });

        textarea.addEventListener("input", (event) => {
          const value = textarea.value;
          if (typeof widget.setValue === "function") {
            widget.setValue(value, { e: event, node, canvas: entry.graphCanvas });
          } else {
            const oldValue = widget.value;
            widget.value = value;
            widget.callback?.(widget.value, entry.graphCanvas, node, entry.graphCanvas.graph_mouse, event);
            node.onWidgetChanged?.(widget.name ?? "", value, oldValue, widget);
            if (node.graph) node.graph._version++;
          }
          markCanvasDirty(entry.graphCanvas);
          refreshMainUI();
        });

        store.set(widget, textarea);
      }

      activeWidgets.add(widget);

      const visible = !widget.hidden
        && node.graph === entry.graph
        && node.isWidgetVisible?.(widget) !== false
        && scale >= 0.35;

      if (!visible) {
        if (textarea.style.display !== "none") textarea.style.display = "none";
        continue;
      }

      const left = `${(layout.x + offset[0]) * scale}px`;
      const top = `${(layout.y + offset[1]) * scale}px`;
      const width = `${layout.width}px`;
      const height = `${layout.height}px`;
      const transform = `scale(${scale})`;
      const pointerEvents = graphCanvas.read_only || widget.computedDisabled ? "none" : "auto";
      const opacity = widget.computedDisabled ? "0.55" : "1";
      const readOnly = !!(graphCanvas.read_only || widget.computedDisabled);

      if (textarea.style.display !== "") textarea.style.display = "";
      if (textarea.style.left !== left) textarea.style.left = left;
      if (textarea.style.top !== top) textarea.style.top = top;
      if (textarea.style.width !== width) textarea.style.width = width;
      if (textarea.style.height !== height) textarea.style.height = height;
      if (textarea.style.transformOrigin !== "0px 0px") textarea.style.transformOrigin = "0 0";
      if (textarea.style.transform !== transform) textarea.style.transform = transform;
      if (textarea.style.pointerEvents !== pointerEvents) textarea.style.pointerEvents = pointerEvents;
      if (textarea.style.opacity !== opacity) textarea.style.opacity = opacity;
      if (textarea.readOnly !== readOnly) textarea.readOnly = readOnly;

      const value = String(widget.value ?? "");
      if (document.activeElement !== textarea && textarea.value !== value) {
        textarea.value = value;
      }
    }
  }

  for (const [widget, textarea] of store.entries()) {
    if (activeWidgets.has(widget)) continue;
    textarea.remove();
    store.delete(widget);
  }
}

function destroyPopupTextareaWidgets(entry) {
  const store = entry?.textareaElements;
  if (!store) return;
  for (const textarea of store.values()) textarea.remove();
  store.clear();
}

// Mirror popup drag-selection into the popup viewport.
function syncPopupSelectionRect(entry) {
  const gc = entry?.graphCanvas;
  const viewport = entry?.viewport;
  if (!gc || !viewport?.isConnected) return;

  let rectEl = entry.selectionRectElement;
  if (!rectEl) {
    rectEl = mkEl("div", "subgraphplus-selection-rect", viewport);
    entry.selectionRectElement = rectEl;
  }

  const dragRect = gc.dragging_rectangle;
  if (!dragRect || dragRect.length < 4) {
    if (rectEl.style.display !== "none") rectEl.style.display = "none";
    return;
  }

  const ds = gc.ds;
  const scale = Number(ds?.scale) || 1;
  const offset = toVec2(ds?.offset) ?? [0, 0];
  const x = Number(dragRect[0]);
  const y = Number(dragRect[1]);
  const w = Number(dragRect[2]);
  const h = Number(dragRect[3]);
  if (![x, y, w, h].every(Number.isFinite)) {
    rectEl.style.display = "none";
    return;
  }

  const left = `${(Math.min(x, x + w) + offset[0]) * scale}px`;
  const top = `${(Math.min(y, y + h) + offset[1]) * scale}px`;
  const width = `${Math.abs(w) * scale}px`;
  const height = `${Math.abs(h) * scale}px`;

  if (rectEl.style.display !== "") rectEl.style.display = "";
  if (rectEl.style.left !== left) rectEl.style.left = left;
  if (rectEl.style.top !== top) rectEl.style.top = top;
  if (rectEl.style.width !== width) rectEl.style.width = width;
  if (rectEl.style.height !== height) rectEl.style.height = height;
}

function getPopupEntryFromElement(target) {
  if (!(target instanceof Element)) return null;
  const owner = target.closest(".subgraphplus-window");
  if (!owner) return null;
  const key = owner.dataset.subgraphplusKey;
  return key ? OPEN_POPUPS.get(key) ?? null : null;
}

function getPopupGraphPointClient(entry, originalEvent) {
  const rect = entry?.canvasElement?.getBoundingClientRect?.();
  if (!rect) return null;

  const ds = entry?.graphCanvas?.ds;
  const offset = toVec2(ds?.offset) ?? [0, 0];
  const scale = Number(ds?.scale) || 1;
  const canvasX = Number(originalEvent?.canvasX);
  const canvasY = Number(originalEvent?.canvasY);
  if (![canvasX, canvasY].every(Number.isFinite)) return null;

  return {
    clientX: rect.left + (canvasX + offset[0]) * scale,
    clientY: rect.top + (canvasY + offset[1]) * scale,
  };
}

function getPopupEventClientPoint(entry, originalEvent) {
  const graphPoint = getPopupGraphPointClient(entry, originalEvent);
  if (graphPoint) return graphPoint;

  const clientX = Number(originalEvent?.clientX);
  const clientY = Number(originalEvent?.clientY);
  if ([clientX, clientY].every(Number.isFinite)) {
    return { clientX, clientY };
  }
  return null;
}

function getPopupLocalPoint(entry, originalEvent) {
  const rect = entry?.canvasElement?.getBoundingClientRect?.();
  const point = getPopupEventClientPoint(entry, originalEvent);
  if (!rect || !point) return null;
  return {
    left: point.clientX - rect.left,
    top: point.clientY - rect.top,
  };
}

function createPopupTitleEditorEvent(entry, originalEvent) {
  const point = getPopupEventClientPoint(entry, originalEvent);
  const x = point?.clientX;
  const y = point?.clientY;
  const titleEvent = {
    clientX: Number.isFinite(x) ? x + LITEGRAPH_DIALOG_OFFSET : LITEGRAPH_DIALOG_OFFSET,
    clientY: Number.isFinite(y) ? y + LITEGRAPH_DIALOG_OFFSET : LITEGRAPH_DIALOG_OFFSET,
    subgraphplusOverlayPosition: getPopupLocalPoint(entry, originalEvent),
    target: entry?.canvasElement ?? originalEvent?.target ?? null,
  };

  return titleEvent;
}

function openPopupTitleEditor(entry, originalEvent, target) {
  const CanvasClass = getCanvasClass();
  const showPropertyEditor = CanvasClass?.onShowPropertyEditor;
  if (!entry?.graphCanvas || typeof showPropertyEditor !== "function") return false;

  showPropertyEditor.call(
    CanvasClass,
    { property: "title", type: "string" },
    undefined,
    createPopupTitleEditorEvent(entry, originalEvent),
    undefined,
    target,
  );
  return true;
}

function shouldHandlePopupDoubleClick(entry, event) {
  if (!entry?.graphCanvas || !(event instanceof CustomEvent)) return false;

  const { subType, originalEvent, node, group } = event.detail ?? {};
  if (subType === "empty-double-click") return true;

  if (subType === "node-double-click") {
    const nodeY = Number(node?.pos?.[1]);
    const canvasY = Number(originalEvent?.canvasY);
    if ([nodeY, canvasY].every(Number.isFinite) && canvasY - nodeY <= 0) {
      return openPopupTitleEditor(entry, originalEvent, node);
    }
    return false;
  }

  if (subType === "group-double-click") {
    const groupY = Number(group?.pos?.[1]);
    const titleHeight = Number(group?.titleHeight);
    const canvasY = Number(originalEvent?.canvasY);
    if ([groupY, titleHeight, canvasY].every(Number.isFinite) && canvasY - groupY <= titleHeight) {
      return openPopupTitleEditor(entry, originalEvent, group);
    }

    return true;
  }

  return false;
}

function patchCanvasStatics() {
  const CanvasClass = getCanvasClass();
  if (!CanvasClass || CanvasClass[CANVAS_STATIC_PATCH_FLAG]) return;

  const origShowPropertyEditor = CanvasClass.onShowPropertyEditor;
  if (typeof origShowPropertyEditor === "function") {
    CanvasClass.onShowPropertyEditor = function subgraphPlusShowPropertyEditor() {
      const entry = getPopupEntryFromElement(arguments[2]?.target);
      if (!entry?.graphCanvas || !isPopupCanvas(entry.graphCanvas)) {
        return origShowPropertyEditor.apply(this, arguments);
      }

      const prevAppCanvas = app.canvas;
      const prevActive = CanvasClass.active_canvas;
      const beforeOverlays = collectPopupOverlayElements();
      const preferredPosition = arguments[2]?.subgraphplusOverlayPosition ?? null;

      app.canvas = entry.graphCanvas;
      CanvasClass.active_canvas = entry.graphCanvas;
      try {
        const result = origShowPropertyEditor.apply(this, arguments);
        adoptPopupOverlays(entry, beforeOverlays, result, preferredPosition);
        return result;
      } finally {
        restoreCanvasBinding(prevAppCanvas, prevActive);
      }
    };
  }

  CanvasClass[CANVAS_STATIC_PATCH_FLAG] = true;
}

// Prevent activation recursion while clearing sibling popup selections.
let activationInProgress = false;

function clearNonActiveSelections(activeCanvas) {
  deselectCanvasItems(primaryCanvas);
  for (const entry of OPEN_POPUPS.values()) {
    if (entry.graphCanvas === activeCanvas) continue;
    deselectCanvasItems(entry.graphCanvas);
  }
  refreshMainUI();
}

// Keep inactive popup render loops paused; setDirty still redraws on demand.
function applyPopupRenderingFocus(activeEntry) {
  for (const other of OPEN_POPUPS.values()) {
    const gc = other?.graphCanvas;
    if (!gc) continue;
    gc.pause_rendering = other !== activeEntry;
  }
}

function activatePopupEntry(entry, { raise = false } = {}) {
  if (!entry) return;
  if (activationInProgress) return;

  // Avoid re-running full activation on every popup pointermove.
  if (!raise && activePopupOwner === entry && lastActivePopup === entry) return;

  activationInProgress = true;
  try {
    if (lastActivePopup && lastActivePopup !== entry) {
      lastActivePopup.root.classList.remove("subgraphplus-window--active");
    }
    if (raise || lastActivePopup !== entry) {
      entry.root.style.zIndex = String(++zIndexCounter);
    }

    entry.root.classList.add("subgraphplus-window--active");
    lastActivePopup = entry;
    activePopupOwner = entry;

    clearNonActiveSelections(entry.graphCanvas);
    setActiveCanvas(entry.graphCanvas);
    syncPopupWidgetElements(entry);
    syncPopupTextareaWidgets(entry);
    applyPopupRenderingFocus(entry);
    restoreRootGraphPrimaryCanvas();
    markCanvasDirty(entry.graphCanvas);
  } finally {
    activationInProgress = false;
  }
}

function bringToFront(entry) {
  activatePopupEntry(entry, { raise: true });
}

// Do not activate here; selection methods also run on sibling popups.
function wrapPopupCanvasMethod(sourceFn, { before, after } = {}) {
  return wrapWithAppCanvasBinding(function subgraphPlusPopupCanvasMethod() {
    const entry = this?._subgraphplusEntry ?? null;
    before?.call(this, entry, arguments);
    const result = sourceFn.apply(this, arguments);
    after?.call(this, entry, arguments, result);
    return result;
  });
}

function patchPopupCanvasMethod(targetGC, state, methodName, options = {}) {
  const sourceKey = `orig_${methodName}`;
  const wrappedKey = `wrapped_${methodName}`;
  if (!state[sourceKey]) {
    state[sourceKey] = targetGC[methodName] || targetGC.constructor?.prototype?.[methodName];
  }
  if (state[wrappedKey] || typeof state[sourceKey] !== "function") return;
  targetGC[methodName] = wrapPopupCanvasMethod(state[sourceKey], options);
  state[wrappedKey] = true;
}

function installPopupBubbleEventGuards(targetGC, state) {
  const canvasElement = targetGC?.canvas;
  if (state.bubbleEventGuardsInstalled || !canvasElement?.addEventListener) return;

  canvasElement.addEventListener("litegraph:canvas", (event) => {
    const entry = targetGC?._subgraphplusEntry ?? null;
    if (!shouldHandlePopupDoubleClick(entry, event)) return;
    event.stopPropagation();
  });

  state.bubbleEventGuardsInstalled = true;
}

function restoreMainCanvas() {
  if (activePopupOwner) {
    savePopupViewState(activePopupOwner);
    resetCanvasInteractionState(activePopupOwner.graphCanvas);
  }
  activePopupOwner = null;
  applyPopupRenderingFocus(null);
  const fallback = isPopupCanvas(app.canvas) ? primaryCanvas : app.canvas;
  if (fallback) setActiveCanvas(fallback);
  else setPopupUiState(false);
  restoreRootGraphPrimaryCanvas();
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
    if (doFit || !applyPopupViewState(entry)) {
      fitGraphToViewport(entry);
    }
  } else {
    markCanvasDirty(entry.graphCanvas);
  }
  syncPopupTextareaWidgets(entry);
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

function ensurePopupCanvasPatched(targetGC) {
  if (!targetGC) return;

  const state = targetGC[POPUP_CANVAS_PATCH_STATE] || (targetGC[POPUP_CANVAS_PATCH_STATE] = {});
  installPopupBubbleEventGuards(targetGC, state);

  if (!state.origDraw) {
    state.origDraw = targetGC.draw || targetGC.constructor?.prototype?.draw;
  }
  if (!state.drawWrapped && typeof state.origDraw === "function") {
    targetGC.draw = function subgraphPlusPopupDraw() {
      const oldCanvas = app.canvas;
      const cls = getCanvasClass();
      const prevActive = cls ? cls.active_canvas : undefined;
      app.canvas = this;
      if (cls) cls.active_canvas = this;
      try {
        if (primaryCanvas && primaryCanvas !== this) {
          copyDefinedProps(this, primaryCanvas, POPUP_CONTEXT_PROPS);
          this.render_widgets = true;
          this.render_connections = true;
          this.is_subgraph_canvas = true;
          this.use_render_buffer = false;
        }
        const result = state.origDraw.apply(this, arguments);
        syncPopupWidgetElements(this._subgraphplusEntry);
        syncPopupTextareaWidgets(this._subgraphplusEntry);
        syncPopupSelectionRect(this._subgraphplusEntry);
        return result;
      } finally {
        restoreCanvasBinding(oldCanvas, prevActive);
      }
    };
    state.drawWrapped = true;
  }

  if (!state.origOpenSubgraph) {
    state.origOpenSubgraph = targetGC.openSubgraph || targetGC.constructor?.prototype?.openSubgraph;
  }
  if (!state.openSubgraphWrapped && typeof state.origOpenSubgraph === "function") {
    targetGC.openSubgraph = wrapPopupCanvasMethod(function subgraphPlusPopupOpenSubgraph(subgraph, fromNode) {
      if (fromNode && isSubgraphNode(fromNode)) {
        queueOpenSubgraphPopup(fromNode);
        return;
      }
      return state.origOpenSubgraph.apply(this, arguments);
    });
    state.openSubgraphWrapped = true;
  }

  const syncSelectionAfterPopupMethod = function() {
    notifyCanvasSelectionChanged(primaryCanvas);
    notifyCanvasSelectionChanged(this);
    refreshMainUI();
  };
  const clearOtherSelections = function() {
    clearNonActiveSelections(this);
  };

  patchPopupCanvasMethod(targetGC, state, "processSelect", {
    before: clearOtherSelections,
    after: syncSelectionAfterPopupMethod,
  });
  patchPopupCanvasMethod(targetGC, state, "select", {
    before: clearOtherSelections,
    after: syncSelectionAfterPopupMethod,
  });
  patchPopupCanvasMethod(targetGC, state, "selectItems", {
    before: clearOtherSelections,
    after: syncSelectionAfterPopupMethod,
  });
  patchPopupCanvasMethod(targetGC, state, "deselect", {
    after: syncSelectionAfterPopupMethod,
  });
  patchPopupCanvasMethod(targetGC, state, "deselectAll", {
    after: syncSelectionAfterPopupMethod,
  });
  patchPopupCanvasMethod(targetGC, state, "copyToClipboard", {
    before: clearOtherSelections,
  });
  patchPopupCanvasMethod(targetGC, state, "pasteFromClipboard", {
    before: clearOtherSelections,
    after(entry) {
      syncSelectionAfterPopupMethod.call(this);
      syncPopupTextareaWidgets(entry);
      savePopupViewState(entry);
    },
  });
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

  // Popup canvases only become active through scoped wrappers to avoid Pinia churn.
  if (isPopupCanvas(canvas)) {
    setPopupUiState(true);
    return;
  }

  app.canvas = canvas;
  syncCanvasStoreFromCanvas(canvas);
  setPopupUiState(false);
}

function applyPopupCanvasInteractionDefaults(gc) {
  if (!gc) return;

  for (const [prop, value] of Object.entries(POPUP_CANVAS_DEFAULTS)) {
    if (prop in gc) gc[prop] = value;
  }
}

function injectComfyContext(targetGC) {
  const source = primaryCanvas ?? app.canvas;
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

// LGraph.attachCanvas can overwrite rootGraph.primaryCanvas with the popup canvas.
function restoreRootGraphPrimaryCanvas() {
  if (!primaryCanvas) return;
  const root = getRootGraph();
  if (root && root._canvas !== primaryCanvas) root._canvas = primaryCanvas;
}

function bindPopupGraph(entry, graph) {
  if (!entry?.graphCanvas || !graph) return;
  if (entry.graph && entry.graph !== graph) {
    restorePopupWidgetElements(entry);
    destroyPopupTextareaWidgets(entry);
  }
  entry.graph = graph;
  entry.graphCanvas._subgraphplusEntry = entry;
  injectComfyContext(entry.graphCanvas);

  const gc = entry.graphCanvas;
  if (typeof gc.setGraph === "function") {
    gc.setGraph(graph);
  } else if (typeof gc.openSubgraph === "function") {
    gc.openSubgraph(graph, entry.node);
  }
  applyPopupCanvasInteractionDefaults(gc);
  resetCanvasInteractionState(gc);
  syncPopupWidgetElements(entry);
  syncPopupTextareaWidgets(entry);

  installGraphHook(graph);
  restoreRootGraphPrimaryCanvas();
}

function closePopup(key, { preserveViewState = true } = {}) {
  const entry = OPEN_POPUPS.get(key);
  if (!entry) return;
  if (preserveViewState) savePopupViewState(entry);
  OPEN_POPUPS.delete(key);
  entry.root.classList.add("subgraphplus-window--closing");

  const teardown = () => {
    if (globalResizeObserver) globalResizeObserver.unobserve(entry.viewport);
    restorePopupWidgetElements(entry);
    destroyPopupTextareaWidgets(entry);
    entry.selectionRectElement?.remove();
    entry.selectionRectElement = null;
    resetCanvasInteractionState(entry.graphCanvas);
    entry.graphCanvas?.stopRendering?.();
    entry.graphCanvas?.unbindEvents?.();
    try { entry.graphCanvas?.graph?.detachCanvas?.(entry.graphCanvas); } catch(_) {}
    entry.abortController?.abort();
    entry.root.remove();
    if (lastActivePopup === entry) lastActivePopup = null;
    if (activePopupOwner === entry) activePopupOwner = null;
    const fallbackEntry = lastActivePopup ?? Array.from(OPEN_POPUPS.values()).at(-1) ?? null;
    if (fallbackEntry) bringToFront(fallbackEntry);
    else restoreMainCanvas();
    if (OPEN_POPUPS.size === 0) {
      if (cleanupIntervalId) { clearInterval(cleanupIntervalId); cleanupIntervalId = null; }
      zIndexCounter = WINDOW_BASE_Z_INDEX;
    }
    restoreRootGraphPrimaryCanvas();
    refreshMainUI();
  };
  setTimeout(teardown, POPUP_CLOSE_MS);
}

function closeAllPopups(options) {
  for (const key of [...OPEN_POPUPS.keys()]) closePopup(key, options);
}

function sweepPopups() {
  for (const [key, entry] of OPEN_POPUPS.entries()) {
    if (!document.body.contains(entry.root) || !isNodeStillAlive(entry)) {
      closePopup(key);
      continue;
    }
    if (entry.node?.subgraph && entry.graph !== entry.node.subgraph) {
      bindPopupGraph(entry, entry.node.subgraph);
      entry.didInitialFit = false;
      syncCanvasSize(entry);
    }
    updateWindowLabels(entry);
  }
}

function ensureCleanupSweep() {
  if (cleanupIntervalId) return;
  cleanupIntervalId = setInterval(sweepPopups, CLEANUP_SWEEP_MS);
}

function rebindPopupEntry(entry, nextNode) {
  if (!entry || !nextNode || !isSubgraphNode(nextNode)) return false;

  savePopupViewState(entry);
  entry.node = nextNode;
  entry.graph = nextNode.subgraph;
  entry.didInitialFit = false;
  bindPopupGraph(entry, nextNode.subgraph);
  updateWindowLabels(entry);
  syncCanvasSize(entry);
  return true;
}

function rebindOpenPopupsAfterGraphLoad(activeKey) {
  const root = getRootGraph();
  if (!root) return;

  const entries = [...OPEN_POPUPS.values()];
  for (const entry of entries) {
    const nextNode = findSubgraphNodeByPath(entry.key, root);
    if (!nextNode) {
      POPUP_VIEW_STATE.delete(entry.key);
      closePopup(entry.key, { preserveViewState: false });
      continue;
    }
    rebindPopupEntry(entry, nextNode);
  }

  const activeEntry = activeKey ? OPEN_POPUPS.get(activeKey) ?? null : null;
  if (activeEntry) bringToFront(activeEntry);
  else restoreMainCanvas();
}

function patchLifecycleMethods() {
  if (loadGraphDataHooked) return;
  const origLoad = app.loadGraphData;
  const origClean = app.clean;
  app.loadGraphData = async function () {
    const activeKey = activePopupOwner?.key ?? null;
    for (const entry of OPEN_POPUPS.values()) savePopupViewState(entry);

    const result = await origLoad?.apply(this, arguments);

    rememberPrimaryCanvas(app.canvas);
    if (OPEN_POPUPS.size) {
      setTimeout(() => rebindOpenPopupsAfterGraphLoad(activeKey), POPUP_OPEN_SYNC_MS);
    }

    return result;
  };
  app.clean = function () {
    POPUP_VIEW_STATE.clear();
    closeAllPopups({ preserveViewState: false });
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

function queueOpenSubgraphPopup(node) {
  if (!isSubgraphNode(node)) return;
  const key = getNodeKey(node);
  if (!key || OPEN_POPUPS.has(key) || PENDING_POPUP_OPEN_KEYS.has(key)) return;

  PENDING_POPUP_OPEN_KEYS.add(key);
  requestAnimationFrame(() => {
    PENDING_POPUP_OPEN_KEYS.delete(key);
    if (isSubgraphNode(node)) openSubgraphPopup(node);
  });
}

function openSubgraphPopup(node) {
  if (!isSubgraphNode(node)) return;
  const key = getNodeKey(node);
  PENDING_POPUP_OPEN_KEYS.delete(key);
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
  restoreRootGraphPrimaryCanvas();

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
    activatePopupEntry(entry);
    if (!(e.target instanceof Element) || !isTextEditingTarget(e.target)) {
      shell.canvasElement.focus();
    }
  };
  const onDocumentPointerDown = (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) {
      restoreMainCanvas();
      return;
    }

    const clickedEntry = getPopupEntryFromElement(target);
    if (clickedEntry) {
      if (clickedEntry === entry) bringToFront(clickedEntry);
      return;
    }

    if (isPopupOverlayElement(target) && activePopupOwner === entry) {
      setActiveCanvas(entry.graphCanvas);
      return;
    }

    savePopupViewState(entry);
    restoreMainCanvas();
  };
  const onDocumentKeyEvent = (e) => {
    if (activePopupOwner !== entry) return;

    activatePopupEntry(entry);
    if (handlePopupDeleteKey(entry, e)) return;
    if (handlePopupUndoRedoKey(entry, e)) return;
    if (e.type === "keydown" && handlePopupShortcut(entry, e)) return;

    setActiveCanvas(entry.graphCanvas);
  };
  const persistViewState = () => savePopupViewState(entry);
  const afterPopupInteraction = () => {
    persistViewState();
    syncPopupTextareaWidgets(entry);
    entry.node?.setDirtyCanvas?.(true, true);
    refreshMainUI();
  };

  [shell.root, shell.canvasElement].forEach(el => el.addEventListener("pointerdown", onFocus, { signal }));
  shell.canvasElement.addEventListener("contextmenu", onFocus, { signal });
  shell.canvasElement.addEventListener("wheel", onFocus, { signal, passive: true });
  document.addEventListener("pointerdown", onDocumentPointerDown, { capture: true, signal });
  ["keydown", "keyup"].forEach((ev) => document.addEventListener(ev, onDocumentKeyEvent, { capture: true, signal }));
  ["pointerup", "keyup", "wheel"].forEach((ev) => shell.canvasElement.addEventListener(ev, afterPopupInteraction, { signal }));

  graphCanvas.startRendering?.();
  ensureCleanupSweep();

  setTimeout(() => syncCanvasSize(entry), POPUP_OPEN_SYNC_MS);
}

app.registerExtension({
  name: EXTENSION_NAME,

  setup() {
    ensureStyles();
    patchCanvasStatics();
    patchLifecycleMethods();
  },

  getCanvasMenuItems() {
    if (OPEN_POPUPS.size === 0) return [];
    return [null, { content: "Close All Subgraphs", callback: () => closeAllPopups() }];
  },

  loadedGraphNode(node) {
    if (!isSubgraphNode(node) || node[NODE_INSTANCE_PATCH_FLAG]) return;
    const orig = node.getExtraMenuOptions;
    node.getExtraMenuOptions = function(_, options) {
      const res = orig?.apply?.(this, arguments);
      const opts = Array.isArray(res) ? res : options;
      if (isSubgraphNode(this) && !opts.some(o => o?.content === MENU_LABEL)) {
        opts.unshift({ content: MENU_LABEL, callback: () => queueOpenSubgraphPopup(this) });
      }
      return res;
    };

    const origTitleClick = node.onTitleButtonClick;
    node.onTitleButtonClick = function(button) {
      if (button?.name === "enter_subgraph" && isSubgraphNode(this)) {
        queueOpenSubgraphPopup(this);
        return;
      }
      return origTitleClick?.apply(this, arguments);
    };

    node[NODE_INSTANCE_PATCH_FLAG] = true;
  },

  nodeCreated(node) { this.loadedGraphNode(node); }
});
