//! the_file 文件管理器（原 TE Host PoC，2026-10-30 去嵌入定稿）。
//!
//! 架构：Tauri 壳 + WebView 自绘文件列表（src/fileview.ts，类比 xterm.js 打法）
//! + Rust fileops（fileops.rs，目录数据与文件操作）。
//! Tablacus Explorer 软嵌入通道已整体移除；原 TE64 运行时归档于仓库根
//! te64-runtime.tar.zst（恢复即解包，main 分支历史里亦有完整源文件）。
//!
//! 宿主侧仅剩一个非 fileops 命令：read_bookmarks——读取 config/bookmarks.json
//! （书签面板数据源）。路径定位规则：从 exe（打包形态，位于仓库根）或
//! crate manifest（dev 形态，src-tauri/target/…）逐级上溯找 config/bookmarks.json。

mod fileops;

use std::path::PathBuf;

use tauri::{Emitter, Manager};

/// 单实例转发事件：第二实例携带的目录路径（前端 listen 后同窗口打开 + 累计临时书签）
const EXTERNAL_OPEN_EVENT: &str = "external-open";

// ============================ 书签文件定位 ============================

/// 逐级上溯（最多 8 跳）找 config/bookmarks.json；exe 与 manifest 两个起点取先命中。
/// 部署形态：the_file.exe 与 config/ 同级，一跳即中；
/// dev 形态：src-tauri/target/{release,debug} → src-tauri → 仓库根。
fn bookmarks_path() -> Option<PathBuf> {
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            starts.push(dir.to_path_buf());
        }
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    for start in starts {
        let mut cur = Some(start.as_path());
        let mut hops = 0;
        while let Some(dir) = cur {
            let p = dir.join("config").join("bookmarks.json");
            if p.is_file() {
                return Some(p);
            }
            hops += 1;
            if hops > 8 {
                break;
            }
            cur = dir.parent();
        }
    }
    None
}

// ============================ Tauri commands ============================

/// 启动参数传入的初始目录：第一个非空参数（跳过 exe 自身路径）。
/// qq_codex 双击项目标签即以 `the_file.exe <路径>` 启动；无参数返回 None。
#[tauri::command]
fn startup_dir() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().trim().to_string())
        .find(|arg| !arg.is_empty())
}

/// 书签 JSON 原文（config/bookmarks.json；找不到/读不了返回 None，前端 toast）
#[tauri::command]
fn read_bookmarks() -> Option<String> {
    bookmarks_path().and_then(|p| std::fs::read_to_string(p).ok())
}

/// 书签写回（tmp + rename 原子替换，避免读到半截 JSON）
#[tauri::command]
fn write_bookmarks(content: String) -> Result<(), String> {
    let path = bookmarks_path().ok_or_else(|| "无法定位 config/bookmarks.json".to_string())?;
    // 先验一下是合法 JSON，防止前端 bug 把书签文件写坏
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("书签内容不是合法 JSON：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &content).map_err(|e| format!("写入 {} 失败：{e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename 失败：{e}"))?;
    Ok(())
}

// ============================ 应用入口 ============================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 必须第一个注册：二次启动直接退出，把 argv 里的目录转发给已运行实例
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let dir = argv
                .into_iter()
                .skip(1)
                .map(|arg| arg.trim().to_string())
                .find(|arg| !arg.is_empty());
            if let Some(dir) = dir {
                let _ = app.emit(EXTERNAL_OPEN_EVENT, dir);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            startup_dir,
            read_bookmarks,
            write_bookmarks,
            fileops::dir_list,
            fileops::shell_open,
            fileops::open_with_dialog,
            fileops::file_paste,
            fileops::file_delete,
            fileops::file_rename,
            fileops::dir_create,
            fileops::path_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the_file");
}
