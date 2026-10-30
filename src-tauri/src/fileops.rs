//! fileops.rs —— 内置文件视图（src/fileview.ts）的后端命令集。
//!
//! 与 TE 完全无关：前端在 WebView 里自绘文件列表（"终端模式"打法，类比 xterm.js），
//! Rust 只负责目录数据与文件操作：
//!   dir_list        目录列表（目录优先 + 名称排序在 Rust 做）
//!   shell_open      ShellExecuteW 默认打开（目录=资源管理器，文件=默认程序）
//!   open_with_dialog SHOpenWithDialog 系统"打开方式"对话框（owner=宿主 hwnd）
//!   file_paste      copy 模式逐个复制；cut 模式先 rename、跨盘失败回退 copy+delete；
//!                   同名冲突自动改名 "xxx (2).ext" 循环找空位
//!   file_delete     permanent=false 先试回收站（SHFileOperationW FOF_ALLOWUNDO），
//!                   permanent=true 直接删；目录递归
//!   file_rename     同目录重命名；dir_create / path_exists 给"新建文件夹"等用
//!
//! Windows 专属 API 用 cfg 隔离，非 Windows 返回 Err（对齐 lib.rs 里 te_* stub 的风格）。
//! 依赖 Cargo.toml 的 windows features 增加 "Win32_UI_Shell"（ShellExecuteW /
//! SHOpenWithDialog / SHFileOperationW 都在 Win32::UI::Shell 下）。

use std::path::{Path, PathBuf};

use serde::Serialize;

// ============================ 数据结构（serde camelCase，对齐前端 backend.ts 接口） ============================

/// 目录项。size 对目录恒为 0（前端显示空白，同资源管理器）；mtimeMs 为 Unix 毫秒，取不到为 0。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryX {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
    pub ext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<DirEntryX>,
}

/// file_paste / file_delete 共用的结果报告（前端据此拼 toast 文案）
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpReport {
    pub copied: u32,
    pub moved: u32,
    pub deleted: u32,
    pub skipped: u32,
    pub errors: Vec<String>,
}

// ============================ 通用小工具（跨平台） ============================

/// 路径规范化：'/'→'\'，去尾部斜杠（盘根 "E:\" 保留；裸盘符 "E:" 补成 "E:\"）。
/// 前端传入的可能是书签里的 "E:/" 写法，先统一再交给 fs。
fn norm_win(p: &str) -> String {
    let mut s = p.trim().replace('/', "\\");
    if s.len() == 2 && s.ends_with(':') {
        s.push('\\');
    }
    if s.len() > 3 {
        while s.ends_with('\\') {
            s.pop();
        }
    }
    s
}

/// 文件名合法性校验（Windows 规则 + 常识项），返回 trim 后的名字
fn check_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名称不能为空".into());
    }
    if n == "." || n == ".." {
        return Err("名称不能是 . 或 ..".into());
    }
    for c in n.chars() {
        // Windows 非法字符集 + 控制字符
        if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 {
            return Err(format!("名称含非法字符：{c:?}"));
        }
    }
    if n.ends_with('.') || n.ends_with(' ') {
        return Err("名称不能以点或空格结尾".into());
    }
    Ok(n.to_string())
}

/// UTF-16 结尾补 \0（Win32 宽字符 API 用；非 Windows 构建下无消费者，免 dead_code 警告）
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// child 是否等于 ancestor 或位于其内部（大小写不敏感、分隔符对齐）。
/// 用途：阻止把目录粘贴/移动进它自身的子目录（递归复制会失控）。
fn is_within(child: &Path, ancestor: &Path) -> bool {
    let c = child.to_string_lossy().to_lowercase().replace('/', "\\");
    let a = ancestor.to_string_lossy().to_lowercase().replace('/', "\\");
    let a = a.trim_end_matches('\\');
    if a.is_empty() {
        return true; // 祖先是盘根 → 必然在内部
    }
    c == a || c.starts_with(&format!("{a}\\"))
}

/// 同名冲突自动改名：dest/name 已存在时尝试 "stem (2).ext"、"stem (3).ext" ……
/// 目录名整体当 stem（不按点拆）；文件按最后一个点拆扩展名（".gitignore" 这类
/// 开头即点的隐藏文件整体当名字，对齐资源管理器行为）。
fn unique_target(dest: &Path, name: &str, is_dir: bool) -> PathBuf {
    let first = dest.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = if is_dir {
        (name.to_string(), String::new())
    } else {
        match name.rfind('.') {
            None | Some(0) => (name.to_string(), String::new()),
            Some(pos) => (name[..pos].to_string(), name[pos..].to_string()),
        }
    };
    for n in 2..1000u32 {
        let cand = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}){ext}")
        };
        let p = dest.join(&cand);
        if !p.exists() {
            return p;
        }
    }
    dest.join(format!("{stem} (重名过多)"))
}

/// 递归复制（目录：先建目标再逐项递归；文件：fs::copy）
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for item in std::fs::read_dir(src)? {
            let item = item?;
            let name = item.file_name();
            copy_recursive(&item.path(), &dst.join(name))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}

/// 递归删除（目录 remove_dir_all，文件 remove_file）
fn remove_recursive(p: &Path) -> std::io::Result<()> {
    if p.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
}

/// 永久删除一批路径，结果记账进 report
fn delete_permanent(paths: &[String], report: &mut OpReport) {
    for p in paths {
        let path = PathBuf::from(norm_win(p));
        match remove_recursive(&path) {
            Ok(()) => report.deleted += 1,
            Err(e) => report.errors.push(format!("{}：{e}", path.display())),
        }
    }
}

// ============================ 命令实现（跨平台部分） ============================

fn dir_list_impl(raw: &str) -> Result<DirListing, String> {
    let path = norm_win(raw);
    if path.is_empty() {
        return Err("路径为空".into());
    }
    let rd = std::fs::read_dir(&path).map_err(|_| format!("无法读取：{path}"))?;
    let mut entries: Vec<DirEntryX> = Vec::new();
    for item in rd {
        let item = match item {
            Ok(it) => it,
            Err(_) => continue, // 单项读不了就跳过（不拖垮整个列表）
        };
        let name = item.file_name().to_string_lossy().into_owned();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let md = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue, // 断链 symlink 等拿不到元数据 → 跳过
        };
        let size = if is_dir { 0 } else { md.len() };
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let ext = Path::new(&name)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        entries.push(DirEntryX {
            name,
            is_dir,
            size,
            mtime_ms,
            ext,
        });
    }
    // 目录优先 + 名称排序（不区分大小写）；前端再按用户选的列重排
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(DirListing { path, entries })
}

/// 粘贴实现：copy=逐项复制；cut=先 rename（同盘瞬时），失败（跨盘）回退复制+删除。
fn paste_impl(op_mode: &str, paths: &[String], dest_dir: &str) -> Result<OpReport, String> {
    let dest = PathBuf::from(norm_win(dest_dir));
    if !dest.is_dir() {
        return Err(format!("目标目录不存在：{dest_dir}"));
    }
    let is_copy = op_mode.eq_ignore_ascii_case("copy");
    let mut report = OpReport::default();
    for raw in paths {
        let src = PathBuf::from(norm_win(raw));
        if !src.exists() {
            report.skipped += 1;
            continue;
        }
        let name = match src.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => {
                report.skipped += 1; // 盘根之类没有文件名成分
                continue;
            }
        };
        let src_is_dir = src.is_dir();
        // 剪切且源就在目标目录里 → 同目录粘贴没意义（Explorer 同样跳过）
        let src_parent = src.parent().map(|p| p.to_string_lossy().to_lowercase());
        if !is_copy && src_parent.as_deref() == Some(dest.to_string_lossy().to_lowercase().as_str()) {
            report.skipped += 1;
            continue;
        }
        let target = unique_target(&dest, &name, src_is_dir);
        // 目录不能粘进它自身内部（递归复制会无限膨胀）
        if src_is_dir && is_within(&target, &src) {
            report.errors.push(format!("{name}：不能粘贴到它自身的内部"));
            continue;
        }
        if is_copy {
            match copy_recursive(&src, &target) {
                Ok(()) => report.copied += 1,
                Err(e) => report.errors.push(format!("{name}：{e}")),
            }
        } else {
            let moved: Result<(), String> = match std::fs::rename(&src, &target) {
                Ok(()) => Ok(()),
                Err(rename_err) => copy_recursive(&src, &target)
                    .and_then(|()| remove_recursive(&src))
                    .map_err(|e| format!("{e}（rename：{rename_err}）")),
            };
            match moved {
                Ok(()) => report.moved += 1,
                Err(msg) => report.errors.push(format!("{name}：{msg}")),
            }
        }
    }
    Ok(report)
}

// ============================ Tauri commands ============================

/// 目录列表。path 无效/不可读返回 None（前端 toast）。异步 + spawn_blocking：
/// 大目录或慢速网络盘读取不该占着主线程。
#[tauri::command]
pub async fn dir_list(path: String) -> Option<DirListing> {
    tokio::task::spawn_blocking(move || dir_list_impl(&path).ok())
        .await
        .ok()
        .flatten()
}

/// 粘贴（copy/cut）。可能耗时（大文件/跨盘），异步 + spawn_blocking。
#[tauri::command]
pub async fn file_paste(
    op_mode: String,
    paths: Vec<String>,
    dest_dir: String,
) -> Result<OpReport, String> {
    tokio::task::spawn_blocking(move || paste_impl(&op_mode, &paths, &dest_dir))
        .await
        .map_err(|e| format!("粘贴任务失败：{e}"))?
}

/// 删除。permanent=true 直接删（目录递归）；false 走回收站（仅 Windows）。
/// 可能耗时，异步 + spawn_blocking。
#[tauri::command]
pub async fn file_delete(paths: Vec<String>, permanent: bool) -> Result<OpReport, String> {
    tokio::task::spawn_blocking(move || delete_impl(&paths, permanent))
        .await
        .map_err(|e| format!("删除任务失败：{e}"))?
}

/// 同目录重命名（前端 F2 行内输入框触发）
#[tauri::command]
pub fn file_rename(path: String, new_name: String) -> Result<(), String> {
    let name = check_name(&new_name)?;
    let old = PathBuf::from(norm_win(&path));
    if !old.exists() {
        return Err(format!("源不存在：{path}"));
    }
    let parent = old.parent().ok_or_else(|| "无法取得所在目录".to_string())?;
    let target = parent.join(&name);
    if target.exists() {
        return Err(format!("已存在同名项：{name}"));
    }
    std::fs::rename(&old, &target).map_err(|e| format!("重命名失败：{e}"))
}

/// 新建文件夹（父目录必须已存在；重名直接报错，由前端先找空位名字）
#[tauri::command]
pub fn dir_create(parent: String, name: String) -> Result<(), String> {
    let name = check_name(&name)?;
    let dir = PathBuf::from(norm_win(&parent)).join(&name);
    if dir.exists() {
        return Err(format!("已存在：{name}"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建文件夹失败：{e}"))
}

/// 路径是否存在（前端启动时校验 localStorage 里记住的上次目录）
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&norm_win(&path)).exists()
}

// ---- Windows 专属：shell 打开 / 打开方式 / 回收站删除 ----

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn shell_open(path: String) -> Result<(), String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;

    let p = norm_win(&path);
    let wide = to_wide(&p);
    // "open"：目录 → 资源管理器；文件 → 默认关联程序；返回值 > 32 才算成功
    let h = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOW,
        )
    };
    if h.0 as isize <= 32 {
        return Err(format!("无法打开 {p}（ShellExecute 返回 {}）", h.0 as isize));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn open_with_dialog(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{OAIF_EXEC, OPENASINFO, SHOpenWithDialog};

    // owner 尽量传宿主窗口（模态对话框居宿主之前）；拿不到就 NULL（桌面为 owner）
    let owner = match window.hwnd() {
        Ok(h) => Some(HWND(h.0)),
        Err(_) => None,
    };
    let wide = to_wide(&norm_win(&path));
    let info = OPENASINFO {
        pcszFile: PCWSTR(wide.as_ptr()),
        pcszClass: PCWSTR::null(),
        oaifInFlags: OAIF_EXEC, // 选完程序立即执行
    };
    // 同步命令跑在主线程：模态对话框与 owner 同线程，行为与原生一致
    unsafe { SHOpenWithDialog(owner, &info) }.map_err(|e| format!("打开方式对话框失败：{e}"))
}

#[cfg(target_os = "windows")]
fn delete_impl(paths: &[String], permanent: bool) -> Result<OpReport, String> {
    if permanent {
        let mut report = OpReport::default();
        delete_permanent(paths, &mut report);
        return Ok(report);
    }
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{
        FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, SHFILEOPSTRUCTW,
        SHFileOperationW,
    };

    // 回收站删除：SHFileOperationW 一次批量。pFrom 要求双 \0 结尾的多字符串
    let mut buf: Vec<u16> = Vec::new();
    for p in paths {
        buf.extend(norm_win(p).encode_utf16());
        buf.push(0);
    }
    buf.push(0); // 列表整体结尾的第二个 \0
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.hwnd = HWND(std::ptr::null_mut());
    op.wFunc = FO_DELETE;
    op.pFrom = PCWSTR(buf.as_ptr());
    // ALLOWUNDO=进回收站；NOCONFIRMATION/NOERRORUI=确认与报错都由前端自己的 toast 承担
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI).0 as u16;
    let rc = unsafe { SHFileOperationW(&mut op) };
    let mut report = OpReport::default();
    if rc != 0 {
        report.errors.push(format!("移入回收站失败（错误码 {rc}）"));
    } else if op.fAnyOperationsAborted.as_bool() {
        report.errors.push("操作被取消".into());
    } else {
        report.deleted = paths.len() as u32;
    }
    Ok(report)
}

// ---- 非 Windows stub（对齐 lib.rs 的 te_* 风格） ----

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn shell_open(path: String) -> Result<(), String> {
    let _ = path;
    Err("shell 打开仅支持 Windows".into())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn open_with_dialog(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let _ = (window, path);
    Err("打开方式对话框仅支持 Windows".into())
}

#[cfg(not(target_os = "windows"))]
fn delete_impl(paths: &[String], permanent: bool) -> Result<OpReport, String> {
    if !permanent {
        return Err("回收站删除仅支持 Windows".into());
    }
    let mut report = OpReport::default();
    delete_permanent(paths, &mut report);
    Ok(report)
}
