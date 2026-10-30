/**
 * fileview.ts —— 自绘文件列表视图，长在 WebView 里，零嵌入。
 *
 * 打法类比 xterm.js 之于终端：前端自己画文件列表，Rust（fileops.rs）只做
 * 目录数据与文件操作（原 TE 软嵌入双引擎已移除，2026-10-30）。
 *
 * - 目录状态机：当前 path / back·forward 栈 / 排序（名称·大小·修改时间）/
 *   内部剪贴板（copy|cut + paths）
 * - 渲染：详情列表 + ".." 上级行；cut 来源行半透明；图标按扩展名映射（lucide）
 * - 交互：单击选中（Ctrl/Shift 多选）、双击进入目录/打开文件、右键自绘菜单
 *   （复用 #popup-menu 元素与样式）、F2 行内重命名、Delete/Shift+Delete 删除、
 *   Ctrl+C/X/V、Enter、Backspace 上级、Ctrl+A、←/→ 历史
 * - 状态上报：syncChrome 直接操作 #nav-path / #status-path / #nav-live /
 *   #nav-back / #nav-forward 与书签高亮；导航条与书签面板的点击由 main.ts
 *   直接调 fvBack/fvForward/fvUp/navigateTo
 */
import { xpIcon, type XpIconName } from "./xpicons";

import { backend, type DirEntryX, type OpReport } from "./backend";

// ============================ 类型与常量 ============================

type SortKey = "name" | "size" | "mtime";
type SortDir = "asc" | "desc";

interface FvClipboard {
  mode: "copy" | "cut";
  paths: string[];
}

interface MenuSpec {
  label: string;
  action: () => void;
  disabled?: boolean;
}

const LS_LASTDIR = "fv-lastdir";
const LS_SORT = "fv-sort";

/** 扩展名 → 图标（XP 风）；目录固定 Folder，未命中落 File */
const EXT_ICONS: Record<string, XpIconName> = {
  png: "fileImage", jpg: "fileImage", jpeg: "fileImage", gif: "fileImage", bmp: "fileImage",
  webp: "fileImage", ico: "fileImage", svg: "fileImage",
  mp4: "fileVideo", mkv: "fileVideo", avi: "fileVideo", mov: "fileVideo", wmv: "fileVideo",
  flv: "fileVideo", webm: "fileVideo", ts: "fileVideo",
  mp3: "fileAudio", wav: "fileAudio", flac: "fileAudio", ogg: "fileAudio", m4a: "fileAudio",
  wma: "fileAudio", mid: "fileAudio",
  zip: "fileArchive", rar: "fileArchive", "7z": "fileArchive", tar: "fileArchive", gz: "fileArchive",
  bz2: "fileArchive", xz: "fileArchive", iso: "fileArchive", cab: "fileArchive",
  js: "fileCode", json: "fileCode", rs: "fileCode", py: "fileCode", c: "fileCode", cpp: "fileCode",
  h: "fileCode", cs: "fileCode", java: "fileCode", html: "fileCode", css: "fileCode",
  xml: "fileCode", yml: "fileCode", yaml: "fileCode", toml: "fileCode", sh: "fileCode",
  ps1: "fileCode", bat: "fileCode", cmd: "fileCode",
  xls: "fileSheet", xlsx: "fileSheet", csv: "fileSheet",
  doc: "fileText", docx: "fileText", pdf: "fileText", txt: "fileText", md: "fileText",
  rtf: "fileText", log: "fileText", ini: "fileText", cfg: "fileText",
  exe: "app", msi: "app", dll: "app", sys: "app", scr: "app",
};

// ============================ 模块状态 ============================

let root: HTMLElement | null = null;   // .file-list 容器
let body: HTMLElement | null = null;   // .file-body 行区
let toastTimer: number | null = null;

let curPath = "";
let entries: DirEntryX[] = [];
let backStack: string[] = [];
let forwardStack: string[] = [];
let sortKey: SortKey = "name";
let sortDir: SortDir = "asc";
const selected = new Set<string>();    // 选中项的 name（排序/重绘后仍稳定）
let anchor: string | null = null;      // Shift 范围选择锚点
let clipboard: FvClipboard | null = null;
let navSeq = 0;                        // 导航竞态防护（慢目录后到的结果丢弃）

// ============================ 导出 API（main.ts 消费） ============================

/** 导航到任意路径（书签点击用）；shell 命名空间位置（::{…}）不支持，toast 提示 */
/** 当前目录（书签面板“收藏当前位置”用） */
export function currentPath(): string {
  return curPath;
}

export async function navigateTo(rawPath: string): Promise<void> {
  const p = rawPath.trim();
  if (p.startsWith("::")) {
    toast("暂不支持系统位置（此电脑/下载/库），请用具体文件夹路径");
    return;
  }
  await navigate(normalizeAddress(p));
}

/** 地址/书签路径归一化（保存侧也用这份实现，单一真相） */
export function normalizeAddressExport(input: string): string {
  return normalizeAddress(input);
}

/**
 * 初始化：恢复上次的排序，构建 DOM、绑定事件，进入初始目录。
 * 优先级：命令行传入目录（qq_codex 双击项目标签启动）> 上次目录 > 猜盘根。
 */
export async function initFileview(): Promise<void> {
  const saved = localStorage.getItem(LS_SORT);
  if (saved) {
    const [k, d] = saved.split(":");
    if (isSortKey(k) && (d === "asc" || d === "desc")) {
      sortKey = k;
      sortDir = d;
    }
  }
  buildDom();
  bindBookmarkHighlight();
  const argDir = await backend.startupDir().catch(() => null);
  if (argDir) {
    const norm = normalizeAddress(argDir);
    if (norm && (await backend.pathExists(norm).catch(() => false))) {
      await navigate(norm);
      return;
    }
    toast(`启动参数目录无效，已回退上次目录：${argDir}`);
  }
  const last = localStorage.getItem(LS_LASTDIR);
  if (last && (await backend.pathExists(last).catch(() => false))) {
    await navigate(last);
    return;
  }
  await navigate(await guessStart());
}

/** 启动目录：上次目录失效时依次猜 C:/D:/E: 盘根 */
async function guessStart(): Promise<string> {
  for (const d of ["C:\\", "D:\\", "E:\\"]) {
    if (await backend.pathExists(d).catch(() => false)) return d;
  }
  return "C:\\";
}

// ============================ DOM 构建与事件 ============================

function buildDom(): void {
  const pane = document.querySelector<HTMLElement>(".file-pane");
  if (!pane) return;
  root = document.createElement("div");
  root.className = "file-list";
  root.tabIndex = 0;
  root.innerHTML = `
    <div class="file-head" role="row">
      <button type="button" class="fh-cell fh-name" data-key="name">名称<span class="fh-arrow"></span></button>
      <button type="button" class="fh-cell fh-size" data-key="size">大小<span class="fh-arrow"></span></button>
      <button type="button" class="fh-cell fh-mtime" data-key="mtime">修改时间<span class="fh-arrow"></span></button>
    </div>
    <div class="file-body" role="listbox"></div>
  `;
  pane.append(root);
  body = root.querySelector<HTMLElement>(".file-body");
  bindListEvents();
}

function bindListEvents(): void {
  if (!root || !body) return;

  // 表头排序
  for (const cell of root.querySelectorAll<HTMLElement>(".fh-cell")) {
    cell.addEventListener("click", () => {
      const k = cell.dataset.key ?? "name";
      if (isSortKey(k)) setSort(k);
    });
  }

  // 单击选中（Ctrl 加选/减选，Shift 范围，空白处清除）
  body.addEventListener("click", (ev) => {
    const row = (ev.target as Element).closest<HTMLElement>(".file-row");
    if (!row || !row.dataset.name) {
      if (!ev.ctrlKey && !ev.shiftKey) {
        selected.clear();
        applySelection();
      }
      return;
    }
    const name = row.dataset.name;
    if (ev.ctrlKey) {
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      anchor = name;
    } else if (ev.shiftKey && anchor) {
      selectRange(anchor, name);
    } else {
      selected.clear();
      selected.add(name);
      anchor = name;
    }
    applySelection();
    root?.focus({ preventScroll: true });
  });

  // 双击：目录→进入；文件→默认程序打开；".."→上一级
  body.addEventListener("dblclick", (ev) => {
    const row = (ev.target as Element).closest<HTMLElement>(".file-row");
    if (!row) return;
    if (row.dataset.up) {
      void fvUp();
      return;
    }
    const name = row.dataset.name;
    if (name) void openByName(name);
  });

  // 右键菜单：行上=完整菜单；空白=粘贴/新建/刷新（menu 内部处理 preventDefault）
  root.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const row = (ev.target as Element).closest<HTMLElement>(".file-row");
    if (row && row.dataset.name) {
      const name = row.dataset.name;
      if (!selected.has(name)) {
        selected.clear();
        selected.add(name);
        anchor = name;
        applySelection();
      }
      openRowMenu(ev.clientX, ev.clientY);
    } else {
      if (!ev.ctrlKey && !ev.shiftKey) {
        selected.clear();
        applySelection();
      }
      openBlankMenu(ev.clientX, ev.clientY);
    }
    root?.focus({ preventScroll: true });
  });

  // 键盘快捷键（重命名输入框有自己的 keydown 并 stopPropagation）
  root.addEventListener("keydown", (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    if (mod && key === "a") {
      ev.preventDefault();
      selectAll();
      return;
    }
    if (mod && key === "c") {
      ev.preventDefault();
      doCopy();
      return;
    }
    if (mod && key === "x") {
      ev.preventDefault();
      doCut();
      return;
    }
    if (mod && key === "v") {
      ev.preventDefault();
      void doPaste();
      return;
    }
    switch (ev.key) {
      case "F2": {
        ev.preventDefault();
        const one = selectedEntries()[0];
        if (one) beginRename(one.name);
        break;
      }
      case "Delete":
        ev.preventDefault();
        void doDelete(ev.shiftKey);
        break;
      case "Enter":
        ev.preventDefault();
        void openSelected();
        break;
      case "Backspace":
        ev.preventDefault();
        void fvUp();
        break;
      case "ArrowLeft":
        ev.preventDefault();
        void fvBack();
        break;
      case "ArrowRight":
        ev.preventDefault();
        void fvForward();
        break;
      case "Escape":
        selected.clear();
        applySelection();
        break;
    }
  });
}

/**
 * 书签面板重渲染（reloadBookmarks → renderBookmarks）后补一次高亮：
 * 书签 DOM 由 main.ts 重建，高亮状态在 fileview 这边维护。
 */
function bindBookmarkHighlight(): void {
  const list = document.querySelector<HTMLElement>("#bookmark-list");
  if (!list) return;
  new MutationObserver(() => {
    highlightBookmarks();
  }).observe(list, { childList: true });
}

// ============================ 导航（目录状态机） ============================

async function navigate(rawPath: string, pushHistory = true): Promise<void> {
  const path = normWin(rawPath);
  if (!path) {
    toast("路径无效");
    return;
  }
  const seq = ++navSeq;
  const listing = await backend.dirList(path).catch(() => null);
  if (seq !== navSeq) return; // 已被更新的导航覆盖，丢弃慢结果
  if (!listing) {
    toast(`无法读取：${path}`);
    return;
  }
  if (pushHistory && curPath && normPathLc(curPath) !== normPathLc(path)) {
    backStack.push(curPath);
    if (backStack.length > 64) backStack.shift();
    forwardStack = [];
  }
  curPath = listing.path || path;
  entries = listing.entries;
  selected.clear();
  anchor = null;
  sortEntries();
  render();
  syncChrome();
  localStorage.setItem(LS_LASTDIR, curPath);
}

export async function fvBack(): Promise<void> {
  const prev = backStack.pop();
  if (!prev) return;
  if (curPath) forwardStack.push(curPath);
  await navigate(prev, false);
}

export async function fvForward(): Promise<void> {
  const next = forwardStack.pop();
  if (!next) return;
  if (curPath) backStack.push(curPath);
  await navigate(next, false);
}

export async function fvUp(): Promise<void> {
  const parent = parentOf(curPath);
  if (parent) await navigate(parent);
}

/** "E:\a\b"→"E:\a"；"E:\a"→"E:\"；"E:\"→null（已在盘根） */
function parentOf(p: string): string | null {
  const s = normWin(p);
  if (/^[a-zA-Z]:\\?$/.test(s)) return null;
  const i = s.lastIndexOf("\\");
  if (i < 0) return null;
  if (i <= 2) return s.slice(0, 3);
  return s.slice(0, i);
}

// ============================ 排序 ============================

function isSortKey(v: string): v is SortKey {
  return v === "name" || v === "size" || v === "mtime";
}

function setSort(key: SortKey): void {
  if (key === sortKey) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  } else {
    sortKey = key;
    sortDir = "asc";
  }
  localStorage.setItem(LS_SORT, `${sortKey}:${sortDir}`);
  sortEntries();
  render();
}

function sortEntries(): void {
  entries.sort(cmpEntries);
}

/** 目录永远排在文件前；同键相等时回退按名称 */
function cmpEntries(a: DirEntryX, b: DirEntryX): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  let r: number;
  if (sortKey === "size") r = a.size === b.size ? cmpName(a, b) : a.size - b.size;
  else if (sortKey === "mtime") r = a.mtimeMs === b.mtimeMs ? cmpName(a, b) : a.mtimeMs - b.mtimeMs;
  else r = cmpName(a, b);
  return sortDir === "asc" ? r : -r;
}

/** 资源管理器式的自然排序（file2 < file10，大小写不敏感） */
function cmpName(a: DirEntryX, b: DirEntryX): number {
  return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

// ============================ 渲染 ============================

function iconFor(e: DirEntryX): XpIconName {
  if (e.isDir) return "folder";
  return EXT_ICONS[e.ext] ?? "fileGeneric";
}

function render(): void {
  if (!root || !body) return;
  const rows: string[] = [];
  rows.push(
    `<div class="file-row file-up" data-up="1" title="上一级"><span class="fr-cell fr-name"><span class="fr-icon">${xpIcon("folderUp", 18)}</span><span class="fr-text">..</span></span><span class="fr-cell fr-size"></span><span class="fr-cell fr-mtime"></span></div>`,
  );
  if (entries.length === 0) {
    rows.push(`<div class="fv-empty">（空文件夹）</div>`);
  }
  for (const e of entries) {
    const sel = selected.has(e.name) ? " sel" : "";
    const cut = clipboard?.mode === "cut" && clipboard.paths.includes(join(curPath, e.name)) ? " cut" : "";
    const name = escapeHtml(e.name);
    rows.push(
      `<div class="file-row${sel}${cut}" data-name="${name}"><span class="fr-cell fr-name"><span class="fr-icon">${xpIcon(iconFor(e), 18)}</span><span class="fr-text" title="${name}">${name}</span></span><span class="fr-cell fr-size">${fmtSize(e)}</span><span class="fr-cell fr-mtime">${fmtMtime(e.mtimeMs)}</span></div>`,
    );
  }
  body.innerHTML = rows.join("");
  syncHead();
  // 键盘焦点兜底：列表可直接吃快捷键（不抢重命名输入框的焦点）
  if (document.activeElement === document.body || document.activeElement === root) {
    root.focus({ preventScroll: true });
  }
}

function syncHead(): void {
  if (!root) return;
  for (const cell of root.querySelectorAll<HTMLElement>(".fh-cell")) {
    const key = cell.dataset.key;
    cell.classList.toggle("sorted-asc", key === sortKey && sortDir === "asc");
    cell.classList.toggle("sorted-desc", key === sortKey && sortDir === "desc");
  }
}

function rowEls(): HTMLElement[] {
  if (!body) return [];
  return Array.from(body.querySelectorAll<HTMLElement>(".file-row[data-name]"));
}

function applySelection(): void {
  for (const el of rowEls()) {
    el.classList.toggle("sel", selected.has(el.dataset.name ?? ""));
  }
}

function selectAll(): void {
  selected.clear();
  for (const e of entries) selected.add(e.name);
  applySelection();
}

function selectRange(from: string, to: string): void {
  const names = entries.map((e) => e.name);
  const i = names.indexOf(from);
  const j = names.indexOf(to);
  if (i < 0 || j < 0) {
    selected.add(to);
    return;
  }
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  selected.clear();
  for (let k = lo; k <= hi; k++) selected.add(names[k]);
}

// ============================ 右键菜单（复用 #popup-menu） ============================

function openRowMenu(x: number, y: number): void {
  const sel = selectedEntries();
  const one = sel.length === 1 ? sel[0] : null;
  const items: MenuSpec[] = [
    { label: "打开", disabled: sel.length === 0, action: () => void openSelected() },
    { label: "打开方式…", disabled: one === null || one.isDir, action: () => { if (one) void openWith(one); } },
    { label: "剪切", disabled: sel.length === 0, action: doCut },
    { label: "复制", disabled: sel.length === 0, action: doCopy },
    { label: "粘贴", disabled: clipboard === null, action: () => void doPaste() },
    { label: "重命名", disabled: one === null, action: () => { if (one) beginRename(one.name); } },
    { label: "删除", disabled: sel.length === 0, action: () => void doDelete(false) },
    { label: "新建文件夹", action: () => void doMkDir() },
  ];
  openFvMenu(x, y, items);
}

function openBlankMenu(x: number, y: number): void {
  const items: MenuSpec[] = [
    { label: "粘贴", disabled: clipboard === null, action: () => void doPaste() },
    { label: "新建文件夹", action: () => void doMkDir() },
    { label: "刷新", action: () => void navigate(curPath, false) },
  ];
  openFvMenu(x, y, items);
}

/** 弹出自绘菜单（与 main.ts 的 openMenu 同构：同一元素、同一样式；外点关闭由 main.ts 的 window click 监听兜底） */
function openFvMenu(x: number, y: number, items: MenuSpec[]): void {
  const popup = document.querySelector<HTMLElement>("#popup-menu");
  if (!popup) return;
  popup.innerHTML = "";
  for (const it of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = it.label;
    btn.disabled = it.disabled === true;
    btn.addEventListener("click", () => {
      closeFvMenu();
      it.action();
    });
    popup.append(btn);
  }
  popup.hidden = false;
  popup.style.left = `${Math.max(0, Math.min(x, window.innerWidth - 210))}px`;
  popup.style.top = `${Math.max(0, Math.min(y, window.innerHeight - items.length * 25 - 16))}px`;
}

function closeFvMenu(): void {
  const popup = document.querySelector<HTMLElement>("#popup-menu");
  if (popup) popup.hidden = true;
}

// ============================ 文件操作 ============================

function selectedEntries(): DirEntryX[] {
  return entries.filter((e) => selected.has(e.name));
}

function selectedPaths(): string[] {
  return selectedEntries().map((e) => join(curPath, e.name));
}

async function openByName(name: string): Promise<void> {
  const e = entries.find((x) => x.name === name);
  if (!e) return;
  if (e.isDir) {
    await navigate(join(curPath, name));
    return;
  }
  await backend.shellOpen(join(curPath, e.name)).catch((err) => toast(`${e.name}：${String(err)}`));
}

/** 打开选中项：有目录则进第一个目录（资源管理器同款取向），否则逐个文件用默认程序打开 */
async function openSelected(): Promise<void> {
  const sel = selectedEntries();
  if (sel.length === 0) return;
  const dir = sel.find((e) => e.isDir);
  if (dir) {
    await navigate(join(curPath, dir.name));
    return;
  }
  for (const e of sel) {
    await backend.shellOpen(join(curPath, e.name)).catch((err) => toast(`${e.name}：${String(err)}`));
  }
}

async function openWith(e: DirEntryX): Promise<void> {
  await backend.openWithDialog(join(curPath, e.name)).catch((err) => toast(String(err)));
  root?.focus({ preventScroll: true }); // 模态对话框关闭后把键盘焦点收回列表
}

function doCopy(): void {
  const paths = selectedPaths();
  if (paths.length === 0) return;
  clipboard = { mode: "copy", paths };
  render(); // 清掉可能的 cut 半透明
  toast(`已复制 ${paths.length} 项`);
}

function doCut(): void {
  const paths = selectedPaths();
  if (paths.length === 0) return;
  clipboard = { mode: "cut", paths };
  render(); // 来源行半透明
  toast(`已剪切 ${paths.length} 项（粘贴后生效）`);
}

async function doPaste(): Promise<void> {
  if (!clipboard) return;
  const { mode, paths } = clipboard;
  const report = await backend
    .filePaste(mode, paths, curPath)
    .catch((err) => {
      toast(`粘贴失败：${String(err)}`);
      return null;
    });
  if (!report) return;
  if (mode === "cut") clipboard = null; // 剪切是一次性的
  toastReport(report, mode);
  await navigate(curPath, false);
}

async function doDelete(permanent: boolean): Promise<void> {
  const paths = selectedPaths();
  if (paths.length === 0) return;
  const report = await backend
    .fileDelete(paths, permanent)
    .catch((err) => {
      toast(`删除失败：${String(err)}`);
      return null;
    });
  if (!report) return;
  const parts: string[] = [];
  if (report.deleted > 0) parts.push(`已删除 ${report.deleted} 项${permanent ? "（永久）" : "（回收站）"}`);
  if (report.skipped > 0) parts.push(`跳过 ${report.skipped} 项`);
  if (report.errors.length > 0) parts.push(`失败：${report.errors[0]}`);
  toast(parts.length > 0 ? parts.join("，") : "没有删除任何项");
  await navigate(curPath, false);
}

function toastReport(r: OpReport, mode: "copy" | "cut"): void {
  const done = mode === "copy" ? r.copied : r.moved;
  const parts: string[] = [];
  if (done > 0) parts.push(`${mode === "copy" ? "复制" : "移动"} ${done} 项`);
  if (r.skipped > 0) parts.push(`跳过 ${r.skipped} 项`);
  if (r.errors.length > 0) parts.push(`失败 ${r.errors.length} 项：${r.errors[0]}`);
  if (parts.length === 0) parts.push("没有可操作的项目");
  toast(parts.join("，"));
}

async function doMkDir(): Promise<void> {
  let name = "新建文件夹";
  const names = new Set(entries.map((e) => e.name));
  for (let i = 2; names.has(name); i++) name = `新建文件夹 (${i})`;
  const ok = await backend
    .dirCreate(curPath, name)
    .then(() => true)
    .catch((err) => {
      toast(String(err));
      return false;
    });
  if (!ok) return;
  toast(`已创建：${name}`);
  await navigate(curPath, false);
  selected.clear();
  selected.add(name);
  applySelection();
}

/** 行内重命名：名称位变输入框，选中 stem（Enter 提交 / Esc 取消 / 失焦提交） */
function beginRename(name: string): void {
  const row = rowEls().find((el) => el.dataset.name === name);
  const textEl = row?.querySelector<HTMLElement>(".fr-text");
  if (!row || !textEl) return;
  const input = document.createElement("input");
  input.className = "fv-rename";
  input.value = name;
  textEl.replaceWith(input);
  input.focus();
  const dot = name.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : name.length);
  let done = false;
  const commit = (): void => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    void finishRename(name, newName);
  };
  const cancel = (): void => {
    if (done) return;
    done = true;
    render();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // 不让列表快捷键吃掉输入
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", commit);
}

async function finishRename(oldName: string, newName: string): Promise<void> {
  if (!newName || newName === oldName) {
    render();
    return;
  }
  const ok = await backend
    .fileRename(join(curPath, oldName), newName)
    .then(() => true)
    .catch((err) => {
      toast(String(err));
      return false;
    });
  await navigate(curPath, false);
  if (ok) {
    selected.clear();
    selected.add(newName);
    applySelection();
  }
}

// ============================ 状态上报（导航条/状态栏/书签高亮） ============================

function syncChrome(): void {
  const navPath = document.querySelector<HTMLInputElement>("#nav-path");
  const statusPath = document.querySelector<HTMLElement>("#status-path");
  const navLive = document.querySelector<HTMLElement>("#nav-live");
  const navBack = document.querySelector<HTMLButtonElement>("#nav-back");
  const navForward = document.querySelector<HTMLButtonElement>("#nav-forward");
  if (navPath) {
    // 输入框聚焦（正在改地址）时不覆盖用户输入；失焦时 syncAddress 会回填
    if (document.activeElement !== navPath) navPath.value = curPath;
    navPath.title = curPath;
  }
  if (statusPath) statusPath.textContent = curPath;
  if (navBack) navBack.disabled = backStack.length === 0;
  if (navForward) navForward.disabled = forwardStack.length === 0;
  if (navLive) {
    navLive.textContent = `${entries.length} 项`;
    navLive.classList.add("ok");
  }
  setStatusChrome("就绪", true);
  highlightBookmarks();
}

function setStatusChrome(text: string, ok: boolean): void {
  const statusEl = document.querySelector<HTMLElement>("#connection-status");
  const lampEl = document.querySelector<HTMLElement>("#connection-lamp");
  if (statusEl) statusEl.textContent = text;
  if (lampEl) lampEl.classList.toggle("ok", ok);
}

/** 书签高亮：对齐 main.ts renderBookmarks 的 normPath 比对机制，直接切换 .active */
function highlightBookmarks(): void {
  const list = document.querySelector<HTMLElement>("#bookmark-list");
  if (!list) return;
  const cur = normPathLc(curPath);
  for (const item of list.querySelectorAll<HTMLElement>(".bookmark-item")) {
    const hit = cur !== "" && normPathLc(item.dataset.path ?? "") === cur;
    item.classList.toggle("active", hit);
  }
}

// ============================ 小工具 ============================

/** toast（与 main.ts showToast 同构，#toast 元素复用） */
function toast(text: string): void {
  const el = document.querySelector<HTMLElement>("#toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

/** Windows 路径规范化：'/'→'\'；"E:"→"E:\"；非盘根去尾部 '\' */
function normWin(p: string): string {
  let s = p.trim().replace(/\//g, "\\");
  if (/^[a-zA-Z]:$/.test(s)) s += "\\";
  if (s.length > 3) s = s.replace(/\\+$/, "");
  return s;
}

// ---- WSL 路径支持（对齐 qq_codex 的归一化规则）----

/** 默认发行版与家目录（本机约定：Ubuntu + /home/beluga） */
const WSL_DISTRO = "Ubuntu";
const WSL_HOME = "home\\beluga";

/**
 * 地址/书签路径归一化：
 *   ~ / ~/...          → \\wsl.localhost\Ubuntu\home\beluga\...
 *   /mnt/<盘>/…        → <盘>:\…（WSL 盘符挂载，如 /mnt/e/qq_codex → E:\qq_codex）
 *   /linux/abs         → \\wsl.localhost\Ubuntu\linux\abs
 *   \\wsl$\Distro\... / \\wsl.localhost\Distro\...（正反斜杠均可）
 *                      → \\wsl.localhost\Distro\...
 *   X:\ / X:/...       → X:\...（normWin）
 * 其他（\\server\share 等 UNC）原样交 normWin
 */
function normalizeAddress(input: string): string {
  let s = input.trim();
  if (!s) return s;
  if (s === "~") return `\\\\wsl.localhost\\${WSL_DISTRO}\\${WSL_HOME}`;
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return `\\\\wsl.localhost\\${WSL_DISTRO}\\${WSL_HOME}\\${s.slice(2).replace(/\//g, "\\")}`;
  }
  // \\wsl$ / \\wsl.localhost / //wsl... → 统一 \\wsl.localhost
  const wslUnc = /^[\\/]{2}(wsl(?:\$|\.localhost))[\\/]([^\\/]+)([\\/].*)?$/i.exec(s);
  if (wslUnc) {
    const distro = wslUnc[2] ?? WSL_DISTRO;
    const rest = (wslUnc[3] ?? "").replace(/\//g, "\\");
    return `\\\\wsl.localhost\\${distro}${rest}`;
  }
  // /mnt/<盘>/… → Windows 盘符路径（WSL 挂载表示法，如 /mnt/e/qq_codex → E:\qq_codex）
  const mnt = /^\/mnt\/([a-zA-Z])\b\/?(.*)$/.exec(s);
  if (mnt) {
    const rest = (mnt[2] ?? "").replace(/\//g, "\\");
    return normWin(`${mnt[1].toUpperCase()}:\\${rest}`);
  }
  // 纯 Linux 绝对路径 → 默认发行版
  if (s.startsWith("/")) {
    return `\\\\wsl.localhost\\${WSL_DISTRO}${s.replace(/\//g, "\\")}`;
  }
  return normWin(s);
}

function join(dir: string, name: string): string {
  return (dir.endsWith("\\") ? dir : `${dir}\\`) + name;
}

/** 比对用：小写、'/'→'\'、去尾 '\'（与 main.ts normPath 同规则） */
function normPathLc(p: string): string {
  return p.trim().toLowerCase().replace(/\//g, "\\").replace(/\\+$/, "");
}

function fmtSize(e: DirEntryX): string {
  if (e.isDir) return "";
  const n = e.size;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  for (const u of units) {
    v /= 1024;
    if (v < 1024) return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${u}`;
  }
  return `${Math.round(v)} PB`;
}

function fmtMtime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
