/**
 * the_file —— Tauri 壳 + WebView 自绘文件列表（原 TE Host PoC，2026-10-30 去嵌入定稿）。
 *
 * 书签系统（2026-10-30 二期）：
 * - 临时组：本次会话有效（内存），+ 收藏当前文件夹、× 删除、右键编辑
 * - 常驻组：config/bookmarks.json 持久化（[{name, path}]），增删改即时写回
 * - 路径支持 Windows 盘符 / UNC / WSL 写法（~/…、/linux/…、\\wsl.localhost\…、\\wsl$\…），
 *   归一化在 fileview.normalizeAddress（导航与保存统一走它）
 * - 地址栏（#nav-path）是输入框：回车跳转、Esc 回填、聚焦时不被导航覆盖
 */
import {
  Maximize2,
  Minus,
  Plus,
  X,
  createIcons,
} from "lucide";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import "./styles.css";
import { backend, isTauri } from "./backend";
import { currentPath, fvBack, fvForward, fvUp, initFileview, navigateTo, normalizeAddressExport } from "./fileview";
import { xpIcon } from "./xpicons";

type ResizeDirection =
  | "North"
  | "NorthEast"
  | "East"
  | "SouthEast"
  | "South"
  | "SouthWest"
  | "West"
  | "NorthWest";

const iconSet = {
  Maximize2,
  Minus,
  Plus,
  X,
};

function icon(name: keyof typeof iconSet, size = 16): string {
  return `<i data-lucide="${name}" data-size="${size}" aria-hidden="true"></i>`;
}

function refreshIcons(): void {
  createIcons({ icons: iconSet });
}

function query<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`缺少元素：${selector}`);
  return el;
}

// ============================ 书签模型 ============================

interface BmEntry {
  name: string;
  path: string; // 保存时已归一化（WSL 写法 → \\wsl.localhost\UNC）
}

/** 常驻书签（bookmarks.json，[{name,path}] 新格式） */
let persistent: BmEntry[] = [];
/** 临时书签（本次会话，内存） */
let session: BmEntry[] = [];

/** 名称默认取路径尾部；盘根给"X: 盘"；WSL 家目录给友好名 */
function defaultName(path: string): string {
  const p = path.replace(/[\\/]+$/, "");
  if (/^[a-zA-Z]:$/.test(p)) return `${p.substring(0, 1)}: 盘`;
  if (/^\\\\wsl\.localhost\\[^\\]+$/i.test(p)) return p.split("\\").pop() ?? p;
  const tail = p.split(/[\\/]/).pop() ?? p;
  return tail || p;
}

/** 路径归一化（fileview 单一实现，导航/保存同源） */
function normalizePath(p: string): string {
  return normalizeAddressExport(p);
}

/**
 * 解析 bookmarks.json：新格式 [{name,path}]；旧格式 {组名:[路径]} 自动平铺迁移
 * （::开头的系统位置直接丢弃——自绘列表打不开）。
 */
function parseBookmarks(raw: string): BmEntry[] {
  const out: BmEntry[] = [];
  try {
    const obj = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
    if (Array.isArray(obj)) {
      for (const it of obj) {
        if (it && typeof it === "object" && typeof (it as BmEntry).path === "string") {
          const e = it as BmEntry;
          const path = normalizeAddressExport(e.path);
          if (!path || path.startsWith("::")) continue;
          out.push({ name: (e.name ?? "").trim() || defaultName(path), path });
        }
      }
    } else if (obj && typeof obj === "object") {
      for (const paths of Object.values(obj as Record<string, unknown>)) {
        const list = typeof paths === "string" ? [paths] : Array.isArray(paths) ? paths : [];
        for (const p of list) {
          if (typeof p !== "string" || !p.trim()) continue;
          const path = normalizeAddressExport(p);
          if (path.startsWith("::")) continue;
          out.push({ name: defaultName(path), path });
        }
      }
    }
  } catch {
    // 书签文件坏了 → 空面板
  }
  return out;
}

function serializeBookmarks(): string {
  return JSON.stringify(persistent, null, "\t");
}

async function savePersistent(): Promise<void> {
  const err = await backend.writeBookmarks(serializeBookmarks()).catch((e) => String(e));
  if (err !== undefined) {
    showToast(`写入 bookmarks.json 失败：${err}`);
  }
}

// ============================ DOM 骨架 ============================

const appRoot = query<HTMLElement>("#app");

appRoot.innerHTML = `
  <main class="app-shell" id="app-shell">
    <header class="xp-titlebar" id="window-drag-region">
      <div class="window-title">
        <span class="title-icon" id="title-icon">${xpIcon("folder", 14)}</span>
        <span id="window-title-text">the_file</span>
      </div>
      <div class="window-controls" aria-label="窗口控制">
        <button class="window-button" id="minimize-window" aria-label="最小化" title="最小化">${icon("Minus", 13)}</button>
        <button class="window-button" id="maximize-window" aria-label="最大化" title="最大化">${icon("Maximize2", 12)}</button>
        <button class="window-button close" id="close-window" aria-label="关闭" title="关闭">${icon("X", 13)}</button>
      </div>
    </header>

    <nav class="menu-bar" aria-label="应用菜单">
      <button class="menu-trigger" data-menu="file"><u>文</u>件(F)</button>
      <button class="menu-trigger" data-menu="view"><u>查</u>看(V)</button>
      <button class="menu-trigger" data-menu="help"><u>帮</u>助(H)</button>
    </nav>

    <div class="workspace">
      <aside class="roster-pane" id="roster-pane" aria-label="文件夹书签">
        <div class="bookmark-head">
          <span class="bookmark-head-title">${xpIcon("folder", 14)}<span>资源书签</span></span>
          <button class="bookmark-refresh" id="bookmark-refresh" title="重新载入 bookmarks.json">${xpIcon("refresh", 13)}</button>
        </div>
        <div class="bookmark-list" id="bookmark-list" role="listbox" aria-label="书签列表"></div>
      </aside>

      <div class="workspace-splitter" id="workspace-splitter" aria-hidden="true"></div>

      <section class="file-pane" aria-label="文件列表">
        <nav class="file-navbar" aria-label="导航">
          <button class="nav-btn" id="nav-back" title="后退" disabled>${xpIcon("back", 16)}</button>
          <button class="nav-btn" id="nav-forward" title="前进" disabled>${xpIcon("forward", 16)}</button>
          <button class="nav-btn" id="nav-up" title="上一级">${xpIcon("folderUp", 16)}</button>
          <input class="nav-path" id="nav-path" type="text" spellcheck="false"
                 placeholder="输入路径跳转（支持 /home/…、~/…、\\\\wsl.localhost\\…）" value="" />
          <span class="nav-live" id="nav-live">…</span>
        </nav>
      </section>
    </div>

    <footer class="status-bar">
      <div class="status-pane connection"><span class="connection-lamp" id="connection-lamp"></span><span id="connection-status">就绪</span></div>
      <div class="status-pane path" id="status-path">--</div>
      <div class="status-pane clock" id="status-clock">--:--</div>
    </footer>

    <span class="resize-handle resize-n" data-resize-direction="North" aria-hidden="true"></span>
    <span class="resize-handle resize-ne" data-resize-direction="NorthEast" aria-hidden="true"></span>
    <span class="resize-handle resize-e" data-resize-direction="East" aria-hidden="true"></span>
    <span class="resize-handle resize-se" data-resize-direction="SouthEast" aria-hidden="true"></span>
    <span class="resize-handle resize-s" data-resize-direction="South" aria-hidden="true"></span>
    <span class="resize-handle resize-sw" data-resize-direction="SouthWest" aria-hidden="true"></span>
    <span class="resize-handle resize-w" data-resize-direction="West" aria-hidden="true"></span>
    <span class="resize-handle resize-nw" data-resize-direction="NorthWest" aria-hidden="true"></span>

    <div class="popup-menu" id="popup-menu" hidden></div>
    <div class="toast" id="toast" role="status" hidden></div>

    <div class="bm-edit-overlay" id="bm-edit-overlay" hidden>
      <div class="bm-edit" role="dialog" aria-label="编辑书签">
        <div class="bm-edit-title" id="bm-edit-title">编辑书签</div>
        <label class="bm-edit-row">名称<input id="bm-edit-name" type="text" spellcheck="false" /></label>
        <label class="bm-edit-row">路径<input id="bm-edit-path" type="text" spellcheck="false"
          placeholder="E:\\… 或 /home/… 或 ~/…" /></label>
        <div class="bm-edit-actions">
          <button type="button" class="bm-btn" id="bm-edit-cancel">取消</button>
          <button type="button" class="bm-btn primary" id="bm-edit-save">保存</button>
        </div>
      </div>
    </div>
  </main>
`;

// ============================ 元素与状态 ============================

const shell = query<HTMLElement>("#app-shell");
const rosterPane = query<HTMLElement>("#roster-pane");
const bookmarkList = query<HTMLElement>("#bookmark-list");
const popupMenu = query<HTMLElement>("#popup-menu");
const toast = query<HTMLElement>("#toast");
const navPathInput = query<HTMLInputElement>("#nav-path");
const editOverlay = query<HTMLElement>("#bm-edit-overlay");
const editName = query<HTMLInputElement>("#bm-edit-name");
const editPath = query<HTMLInputElement>("#bm-edit-path");

let toastTimer: number | null = null;
/** 正在编辑的书签（kind + 下标） */
let editing: { kind: "session" | "persistent"; index: number } | null = null;

function showToast(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

// ============================ 书签面板 ============================

function entryIconHtml(path: string): string {
  const norm = path.replace(/\//g, "\\");
  if (/^[a-zA-Z]:\\?$/.test(norm)) return xpIcon("drive", 15);   // 盘根 → 本地磁盘
  if (/^\\\\wsl/i.test(norm)) return xpIcon("drive", 15);         // WSL 发行版 → 本地磁盘
  if (/^\\\\[^\\]/.test(norm)) return xpIcon("net", 15);          // UNC 共享 → 网络位置
  return xpIcon("folder", 15);
}

function appendGroupHead(title: string, hint: string, onAdd: () => void): void {
  const head = document.createElement("div");
  head.className = "bookmark-group-head bm-head-flex";
  const label = document.createElement("span");
  label.className = "bm-head-label";
  label.textContent = title;
  label.title = hint;
  const add = document.createElement("button");
  add.type = "button";
  add.className = "bm-add";
  add.title = "收藏当前文件夹";
  add.innerHTML = icon("Plus", 12);
  add.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onAdd();
  });
  head.append(label, add);
  bookmarkList.append(head);
}

function appendEntry(kind: "session" | "persistent", index: number, entry: BmEntry): void {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "bookmark-item";
  item.dataset.path = entry.path;
  item.setAttribute("role", "option");
  item.innerHTML = `
    <span class="bookmark-icon">${entryIconHtml(entry.path)}</span>
    <span class="bookmark-copy">
      <span class="bookmark-name">${entry.name}</span>
      <span class="bookmark-path">${entry.path}</span>
    </span>
    <span class="bm-del" title="删除">${icon("X", 11)}</span>
  `;
  item.addEventListener("click", (ev) => {
    if ((ev.target as Element).closest(".bm-del")) {
      void removeEntry(kind, index);
      return;
    }
    void gotoPath(entry.path);
  });
  item.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openEntryMenu(ev.clientX, ev.clientY, kind, index);
  });
  bookmarkList.append(item);
}

function renderBookmarks(): void {
  bookmarkList.innerHTML = "";
  // ---- 临时组（本次会话） ----
  appendGroupHead("临时", "本次会话内有效，关闭应用后消失", () => void addEntry("session"));
  if (session.length === 0) {
    appendEmptyRow("（空：点 + 收藏当前文件夹）");
  } else {
    session.forEach((e, i) => appendEntry("session", i, e));
  }
  // ---- 常驻组（bookmarks.json） ----
  appendGroupHead("常驻", "持久化到 config/bookmarks.json", () => void addEntry("persistent"));
  if (persistent.length === 0) {
    appendEmptyRow("（空：点 + 收藏当前文件夹）");
  } else {
    persistent.forEach((e, i) => appendEntry("persistent", i, e));
  }
  refreshIcons();
}

function appendEmptyRow(text: string): void {
  const empty = document.createElement("div");
  empty.className = "bookmark-empty";
  empty.textContent = text;
  bookmarkList.append(empty);
}

async function reloadBookmarks(): Promise<void> {
  const raw = await backend.bookmarks().catch(() => null);
  if (raw === null) {
    showToast("读取 bookmarks.json 失败");
    return;
  }
  persistent = parseBookmarks(raw);
  renderBookmarks();
}

async function gotoPath(path: string): Promise<void> {
  await navigateTo(path);
}

/** + 收藏当前文件夹（临时组只进内存；常驻组立即写盘） */
async function addEntry(kind: "session" | "persistent"): Promise<void> {
  const cur = currentPath();
  if (!cur) {
    showToast("当前没有打开的文件夹");
    return;
  }
  const entry: BmEntry = { name: defaultName(cur), path: normalizePath(cur) };
  if (kind === "session") {
    session.push(entry);
    showToast(`已加入临时书签：${entry.name}`);
  } else {
    persistent.push(entry);
    await savePersistent();
    showToast(`已加入常驻书签：${entry.name}`);
  }
  renderBookmarks();
}

async function removeEntry(kind: "session" | "persistent", index: number): Promise<void> {
  if (kind === "session") {
    const [gone] = session.splice(index, 1);
    showToast(`已删除临时书签：${gone?.name ?? ""}`);
  } else {
    const [gone] = persistent.splice(index, 1);
    await savePersistent();
    showToast(`已删除常驻书签：${gone?.name ?? ""}`);
  }
  renderBookmarks();
}

// ---- 条目右键菜单（复用 #popup-menu） ----

function openEntryMenu(x: number, y: number, kind: "session" | "persistent", index: number): void {
  const items = [
    { label: "编辑…", action: () => openEditor(kind, index) },
    { label: "删除", action: () => void removeEntry(kind, index) },
  ];
  popupMenu.innerHTML = "";
  for (const it of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = it.label;
    btn.addEventListener("click", () => {
      closeMenu();
      it.action();
    });
    popupMenu.append(btn);
  }
  popupMenu.hidden = false;
  popupMenu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - 180))}px`;
  popupMenu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - 80))}px`;
}

// ---- 编辑弹窗 ----

function openEditor(kind: "session" | "persistent", index: number): void {
  const list = kind === "session" ? session : persistent;
  const entry = list[index];
  if (!entry) return;
  editing = { kind, index };
  query<HTMLElement>("#bm-edit-title").textContent = kind === "session" ? "编辑临时书签" : "编辑常驻书签";
  editName.value = entry.name;
  editPath.value = entry.path;
  editOverlay.hidden = false;
  editName.focus();
  editName.select();
}

function closeEditor(): void {
  editing = null;
  editOverlay.hidden = true;
}

async function commitEditor(): Promise<void> {
  if (!editing) return;
  const name = editName.value.trim();
  const path = normalizePath(editPath.value);
  if (!path) {
    showToast("路径不能为空");
    return;
  }
  const entry: BmEntry = { name: name || defaultName(path), path };
  const { kind, index } = editing;
  if (kind === "session") session[index] = entry;
  else {
    persistent[index] = entry;
    await savePersistent();
  }
  closeEditor();
  renderBookmarks();
  showToast("书签已保存");
}

// ============================ 菜单 ============================

interface MenuItem {
  label: string;
  action: () => void;
}

type Skin = "xp" | "glass";
const LS_SKIN = "skin";
const SKIN_LABELS: Record<Skin, string> = {
  xp: "XP 经典",
  glass: "黑色玻璃",
};

function currentSkin(): Skin {
  return localStorage.getItem(LS_SKIN) === "glass" ? "glass" : "xp";
}

/** 切皮肤：主题变量 + 窗口亚克力效果（黑色玻璃时开启）+ 菜单项勾选态 */
async function applySkin(skin: Skin): Promise<void> {
  localStorage.setItem(LS_SKIN, skin);
  document.documentElement.dataset.theme = skin;
  refreshViewMenu();
  if (isTauri()) {
    await backend.setGlass(skin === "glass").catch((error: unknown) => {
      // 亚克力失败必须可见：否则玻璃皮肤静默退化成“普通暗色”难排查
      showToast(`亚克力效果失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
  showToast(`已切换皮肤：${SKIN_LABELS[skin]}`);
}

function refreshViewMenu(): void {
  const skin = currentSkin();
  MENUS.view = [
    { label: "刷新书签", action: () => void reloadBookmarks() },
    { label: `皮肤：${SKIN_LABELS.xp}${skin === "xp" ? "  ●" : ""}`, action: () => void applySkin("xp") },
    { label: `皮肤：${SKIN_LABELS.glass}${skin === "glass" ? "  ●" : ""}`, action: () => void applySkin("glass") },
  ];
}

/** 拖动/缩放前摘除亚克力（已知卡顿源），停止后延迟恢复 */
function pauseGlassForDrag(): void {
  if (currentSkin() !== "glass" || !isTauri()) return;
  void backend.setGlass(false).catch(() => undefined);
}

let glassRestoreTimer: number | null = null;
function scheduleGlassRestore(): void {
  if (currentSkin() !== "glass" || !isTauri()) return;
  if (glassRestoreTimer !== null) window.clearTimeout(glassRestoreTimer);
  glassRestoreTimer = window.setTimeout(() => {
    glassRestoreTimer = null;
    void backend.setGlass(true).catch(() => undefined);
  }, 400);
}

let MENUS: Record<string, MenuItem[]> = {
  file: [{ label: "退出", action: () => void windowAction("close") }],
  view: [{ label: "刷新书签", action: () => void reloadBookmarks() }],
  help: [{ label: "关于", action: () => showToast("the_file：Tauri 壳 + 自绘文件列表（Tablacus Explorer 定制版演进而来）") }],
};
refreshViewMenu();

function openMenu(name: string, anchor: HTMLElement): void {
  const items = MENUS[name];
  if (!items) return;
  popupMenu.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      closeMenu();
      item.action();
    });
    popupMenu.append(btn);
  }
  popupMenu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  popupMenu.style.left = `${rect.left}px`;
  popupMenu.style.top = `${rect.bottom}px`;
}

function closeMenu(): void {
  popupMenu.hidden = true;
}

// ============================ 窗口控制 ============================

function startWindowDrag(event: MouseEvent): void {
  if (event.button !== 0 || event.detail !== 1) return;
  if ((event.target as Element).closest(".window-controls")) return;
  pauseGlassForDrag(); // 亚克力拖动卡顿规避：拖前摘除，onMoved 后恢复
  void getCurrentWindow().startDragging().catch(() => undefined);
}

async function startWindowResize(direction: ResizeDirection, event: PointerEvent): Promise<void> {
  if (event.button !== 0) return;
  event.preventDefault();
  pauseGlassForDrag();
  try {
    await getCurrentWindow().startResizeDragging(direction);
  } catch {
    // 忽略
  }
  scheduleGlassRestore();
}

async function windowAction(action: "minimize" | "maximize" | "close"): Promise<void> {
  try {
    const appWindow = getCurrentWindow();
    if (action === "minimize") await appWindow.minimize();
    if (action === "maximize") await appWindow.toggleMaximize();
    if (action === "close") await appWindow.close();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "窗口操作失败");
  }
}

// ============================ splitter（书签栏宽度拖拽） ============================

function bindSplitter(): void {
  const splitter = query<HTMLElement>("#workspace-splitter");
  let dragging = false;
  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    splitter.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  splitter.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const shellRect = shell.getBoundingClientRect();
    const width = event.clientX - shellRect.left;
    rosterPane.style.width = `${Math.min(Math.max(width, 160), shellRect.width - 320)}px`;
  });
  const stop = () => {
    dragging = false;
  };
  splitter.addEventListener("pointerup", stop);
  splitter.addEventListener("pointercancel", stop);
}

// ============================ 事件绑定与启动 ============================

function bindEvents(): void {
  query<HTMLElement>("#window-drag-region").addEventListener("mousedown", startWindowDrag);
  query<HTMLButtonElement>("#minimize-window").addEventListener("click", () => void windowAction("minimize"));
  query<HTMLButtonElement>("#maximize-window").addEventListener("click", () => void windowAction("maximize"));
  query<HTMLButtonElement>("#close-window").addEventListener("click", () => void windowAction("close"));

  for (const trigger of document.querySelectorAll<HTMLElement>(".menu-trigger")) {
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!popupMenu.hidden && popupMenu.dataset.menu === trigger.dataset.menu) {
        closeMenu();
        return;
      }
      popupMenu.dataset.menu = trigger.dataset.menu ?? "";
      openMenu(trigger.dataset.menu ?? "", trigger);
    });
  }
  window.addEventListener("click", (event) => {
    if (!popupMenu.hidden && !popupMenu.contains(event.target as Node)) closeMenu();
  });
  window.addEventListener("blur", closeMenu);

  query<HTMLButtonElement>("#bookmark-refresh").addEventListener("click", () => void reloadBookmarks());

  query<HTMLButtonElement>("#nav-back").addEventListener("click", () => void fvBack());
  query<HTMLButtonElement>("#nav-forward").addEventListener("click", () => void fvForward());
  query<HTMLButtonElement>("#nav-up").addEventListener("click", () => void fvUp());

  // 地址栏：回车跳转（WSL 写法归一化在 navigateTo 内做）；Esc/失焦回填当前路径
  navPathInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const value = navPathInput.value.trim();
      if (value) void navigateTo(value);
      navPathInput.blur();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      navPathInput.value = currentPath();
      navPathInput.blur();
    }
  });
  navPathInput.addEventListener("focus", () => navPathInput.select());
  navPathInput.addEventListener("blur", () => {
    navPathInput.value = currentPath();
  });

  // 编辑弹窗
  query<HTMLButtonElement>("#bm-edit-cancel").addEventListener("click", closeEditor);
  query<HTMLButtonElement>("#bm-edit-save").addEventListener("click", () => void commitEditor());
  editOverlay.addEventListener("mousedown", (ev) => {
    if (ev.target === editOverlay) closeEditor();
  });
  for (const input of [editName, editPath]) {
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void commitEditor();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closeEditor();
      }
    });
  }

  bindSplitter();

  for (const handle of document.querySelectorAll<HTMLElement>(".resize-handle")) {
    handle.addEventListener("pointerdown", (event) => {
      const direction = (handle.dataset.resizeDirection ?? "North") as ResizeDirection;
      void startWindowResize(direction, event);
    });
  }
}

function startClock(): void {
  const update = () => {
    const now = new Date();
    query<HTMLElement>("#status-clock").textContent =
      `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  };
  update();
  window.setInterval(update, 15_000);
}

function boot(): void {
  // 皮肤先于 UI 生效（免闪白）：localStorage 记忆，--skin= 参数优先
  document.documentElement.dataset.theme = currentSkin();
  initFileview(); // 文件列表（自绘）：初始目录 = 启动参数 > 上次目录 > 猜盘根
  bindEvents();
  startClock();
  refreshIcons();
  void reloadBookmarks();
  void setupExternalOpen(); // 单实例转发 + 外部打开目录自动累计临时书签
  void setupSkinEffects();
}

/** 启动时的皮肤副作用：--skin= 参数覆盖记忆 + 亚克力开启 + 拖动恢复钩子 */
async function setupSkinEffects(): Promise<void> {
  if (!isTauri()) return;
  const argSkin = await backend.startupSkin().catch(() => null);
  if (argSkin === "xp" || argSkin === "glass") {
    await applySkin(argSkin);
  } else if (currentSkin() === "glass") {
    await backend.setGlass(true).catch(() => undefined);
  }
  const appWindow = getCurrentWindow();
  // 拖动/缩放结束后（含标题栏拖动）恢复亚克力
  void appWindow.onMoved(() => scheduleGlassRestore());
  void appWindow.onResized(() => scheduleGlassRestore());
}

// ============================ 外部打开（单实例） ============================

/**
 * 单实例管线：第二实例（qq_codex 再次双击项目标签）启动即退出，
 * 目录/皮肤通过 external-open 事件转发到这里 → 同窗口导航 + 自动累计临时书签。
 * 本实例自己是带参启动的（第一次双击），initFileview 已导航，这里只补累计。
 */
interface ExternalOpenPayload {
  dir?: string | null;
  skin?: string | null;
}

async function setupExternalOpen(): Promise<void> {
  if (!isTauri()) return;
  await listen<ExternalOpenPayload>("external-open", (event) => {
    const payload = event.payload ?? {};
    if (payload.skin === "xp" || payload.skin === "glass") void applySkin(payload.skin);
    if (payload.dir) void openExternalDir(payload.dir);
  });
  const argDir = await backend.startupDir().catch(() => null);
  if (argDir) autoSessionBookmark(argDir);
}

/** 外部转发目录：同窗口打开（进后退历史）+ 累计临时书签 */
async function openExternalDir(raw: string): Promise<void> {
  const norm = normalizePath(raw);
  if (!norm) return;
  if (!(await backend.pathExists(norm).catch(() => false))) {
    showToast(`外部打开的目录不存在：${raw}`);
    return;
  }
  await gotoPath(norm);
  autoSessionBookmark(norm);
}

/** 外部打开的目录自动进临时书签（去重，最新置顶） */
function autoSessionBookmark(raw: string): void {
  const path = normalizePath(raw);
  if (!path) return;
  const lc = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  const i = session.findIndex((e) => lc(e.path) === lc(path));
  if (i >= 0) session.splice(i, 1);
  session.unshift({ name: defaultName(path), path });
  renderBookmarks();
}

boot();
