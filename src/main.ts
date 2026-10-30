/**
 * the_file —— Tauri 壳 + WebView 自绘文件列表（原 TE Host PoC，2026-10-30 去嵌入定稿）。
 *
 * 形态：
 * - 左栏：书签面板（config/bookmarks.json），点击 → fileview 导航到该文件夹
 * - 右栏：迷你工具条（← → ↑ + 当前路径）+ 自绘文件列表（fileview.ts）
 * - Tablacus Explorer 软嵌入已移除；文件操作走 Rust fileops
 *
 * 旧 PoC 的聊天视图、xterm/PTY、TE 双引擎均已移除。
 */
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Folder,
  HardDrive,
  Maximize2,
  Minus,
  RefreshCw,
  X,
  createIcons,
} from "lucide";
import { getCurrentWindow } from "@tauri-apps/api/window";

import "./styles.css";
import { backend } from "./backend";
import { fvBack, fvForward, fvUp, initFileview, navigateTo } from "./fileview";

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
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Folder,
  HardDrive,
  Maximize2,
  Minus,
  RefreshCw,
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

interface BookmarkEntry {
  group: string;
  name: string;
  path: string;
  drive: boolean;
}

function bookmarkName(path: string): string {
  const norm = path.trim().toLowerCase();
  if (/^[a-z]:\/?$/.test(norm)) return `${path.substring(0, 1)}: 盘`;
  const tail = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  return tail || path;
}

function parseBookmarks(raw: string): BookmarkEntry[] {
  const entries: BookmarkEntry[] = [];
  try {
    const obj = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    for (const [group, value] of Object.entries(obj)) {
      const paths = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
      for (const p of paths) {
        if (typeof p !== "string" || !p.trim()) continue;
        const path = p.trim();
        entries.push({
          group,
          name: bookmarkName(path),
          path,
          drive: /^[a-zA-Z]:\/?$/.test(path),
        });
      }
    }
  } catch {
    // 书签文件坏了 → 空面板 + 状态栏提示
  }
  return entries;
}

// ============================ DOM 骨架 ============================

const appRoot = query<HTMLElement>("#app");

appRoot.innerHTML = `
  <main class="app-shell" id="app-shell">
    <header class="xp-titlebar" id="window-drag-region">
      <div class="window-title">
        <span class="title-icon" id="title-icon">${icon("Folder", 13)}</span>
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
          <span class="bookmark-head-title">${icon("Folder", 14)}<span>资源书签</span></span>
          <button class="bookmark-refresh" id="bookmark-refresh" title="重新载入 bookmarks.json">${icon("RefreshCw", 12)}</button>
        </div>
        <div class="bookmark-list" id="bookmark-list" role="listbox" aria-label="书签列表"></div>
      </aside>

      <div class="workspace-splitter" id="workspace-splitter" aria-hidden="true"></div>

      <section class="file-pane" aria-label="文件列表">
        <nav class="file-navbar" aria-label="导航">
          <button class="nav-btn" id="nav-back" title="后退" disabled>${icon("ArrowLeft", 14)}</button>
          <button class="nav-btn" id="nav-forward" title="前进" disabled>${icon("ArrowRight", 14)}</button>
          <button class="nav-btn" id="nav-up" title="上一级">${icon("ArrowUp", 14)}</button>
          <span class="nav-path" id="nav-path" title="">（载入中…）</span>
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
  </main>
`;

// ============================ 元素与状态 ============================

const shell = query<HTMLElement>("#app-shell");
const rosterPane = query<HTMLElement>("#roster-pane");
const bookmarkList = query<HTMLElement>("#bookmark-list");
const popupMenu = query<HTMLElement>("#popup-menu");
const toast = query<HTMLElement>("#toast");

let bookmarks: BookmarkEntry[] = [];
let toastTimer: number | null = null;

function showToast(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

// ============================ 书签面板 ============================

function renderBookmarks(): void {
  bookmarkList.innerHTML = "";
  if (bookmarks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "bookmark-empty";
    empty.textContent = "没有书签：请编辑 config/bookmarks.json 后点刷新";
    bookmarkList.append(empty);
    return;
  }
  let currentGroup = "";
  for (const entry of bookmarks) {
    if (entry.group !== currentGroup) {
      currentGroup = entry.group;
      const head = document.createElement("div");
      head.className = "bookmark-group-head";
      head.textContent = entry.group;
      bookmarkList.append(head);
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "bookmark-item";
    item.dataset.path = entry.path;
    item.setAttribute("role", "option");
    item.innerHTML = `
      <span class="bookmark-icon">${icon(entry.drive ? "HardDrive" : "Folder", 15)}</span>
      <span class="bookmark-copy">
        <span class="bookmark-name">${entry.name}</span>
        <span class="bookmark-path">${entry.path}</span>
      </span>
    `;
    item.addEventListener("click", () => {
      void gotoBookmark(entry);
    });
    bookmarkList.append(item);
  }
  refreshIcons();
}

async function reloadBookmarks(): Promise<void> {
  const raw = await backend.bookmarks().catch(() => null);
  if (raw === null) {
    showToast("读取 bookmarks.json 失败");
    return;
  }
  bookmarks = parseBookmarks(raw);
  renderBookmarks();
}

async function gotoBookmark(entry: BookmarkEntry): Promise<void> {
  await navigateTo(entry.path);
}

// ============================ 菜单 ============================

interface MenuItem {
  label: string;
  action: () => void;
}

const MENUS: Record<string, MenuItem[]> = {
  file: [{ label: "退出", action: () => void windowAction("close") }],
  view: [{ label: "刷新书签", action: () => void reloadBookmarks() }],
  help: [{ label: "关于", action: () => showToast("the_file：Tauri 壳 + 自绘文件列表（Tablacus Explorer 定制版演进而来）") }],
};

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
  void getCurrentWindow().startDragging().catch(() => undefined);
}

async function startWindowResize(direction: ResizeDirection, event: PointerEvent): Promise<void> {
  if (event.button !== 0) return;
  event.preventDefault();
  try {
    await getCurrentWindow().startResizeDragging(direction);
  } catch {
    // 忽略
  }
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
  initFileview(); // 文件列表（自绘）：初始目录 = 上次目录，失效则猜盘根
  bindEvents();
  startClock();
  refreshIcons();
  void reloadBookmarks();
}

boot();
