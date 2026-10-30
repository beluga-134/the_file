import { invoke } from "@tauri-apps/api/core";

/** 是否运行在 Tauri 桌面壳内（浏览器 dev 预览时为 false） */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const backend = {
  /** 书签 JSON 原文（config/bookmarks.json） */
  async bookmarks(): Promise<string | null> {
    return invoke<string | null>("read_bookmarks");
  },

  /** 书签写回（tmp+rename 原子替换；内容需为合法 JSON） */
  async writeBookmarks(content: string): Promise<void> {
    return invoke<void>("write_bookmarks", { content });
  },

  /** 启动参数传入的初始目录（命令行第一个非空参数；无则 null，浏览器预览返回 null） */
  async startupDir(): Promise<string | null> {
    return invoke<string | null>("startup_dir");
  },

  /** 启动参数 --skin=xp|glass（无则 null） */
  async startupSkin(): Promise<string | null> {
    return invoke<string | null>("startup_skin");
  },

  /** 黑色玻璃皮肤的系统级亚克力模糊（开启/摘除；拖动前摘除防卡） */
  async setGlass(enabled: boolean): Promise<void> {
    return invoke<void>("set_glass", { enabled });
  },

  // ---- 文件视图（fileops.rs）----

  /** 目录列表；path 无效/不可读返回 null（前端 toast） */
  async dirList(path: string): Promise<DirListing | null> {
    return invoke<DirListing | null>("dir_list", { path });
  },

  /** ShellExecuteW 默认打开（目录=资源管理器，文件=默认程序） */
  async shellOpen(path: string): Promise<void> {
    return invoke<void>("shell_open", { path });
  },

  /** SHOpenWithDialog 系统“打开方式”对话框（模态，owner=宿主窗口） */
  async openWithDialog(path: string): Promise<void> {
    return invoke<void>("open_with_dialog", { path });
  },

  /** 粘贴：opMode=copy 逐个复制；cut 先 rename、跨盘回退 copy+delete；同名自动改名 */
  async filePaste(opMode: "copy" | "cut", paths: string[], destDir: string): Promise<OpReport> {
    return invoke<OpReport>("file_paste", { opMode, paths, destDir });
  },

  /** 删除：permanent=false 回收站（仅 Windows）；true 直接删（目录递归） */
  async fileDelete(paths: string[], permanent: boolean): Promise<OpReport> {
    return invoke<OpReport>("file_delete", { paths, permanent });
  },

  /** 同目录重命名 */
  async fileRename(path: string, newName: string): Promise<void> {
    return invoke<void>("file_rename", { path, newName });
  },

  /** 新建文件夹（重名报错，前端先找空位名） */
  async dirCreate(parent: string, name: string): Promise<void> {
    return invoke<void>("dir_create", { parent, name });
  },

  /** 路径是否存在（校验 localStorage 记住的上次目录用） */
  async pathExists(path: string): Promise<boolean> {
    return invoke<boolean>("path_exists", { path });
  },
};

// ---- 文件视图（fileops.rs）的类型 ----

/** 目录项（Rust DirEntryX，serde camelCase；size 对目录为 0，mtimeMs 取不到为 0） */
export interface DirEntryX {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  ext: string;
}

/** dir_list 返回的目录清单（path 为规范化后的 Windows 路径） */
export interface DirListing {
  path: string;
  entries: DirEntryX[];
}

/** file_paste / file_delete 的结果报告 */
export interface OpReport {
  copied: number;
  moved: number;
  deleted: number;
  skipped: number;
  errors: string[];
}
