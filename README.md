# the_file

轻量 Windows 文件管理器：**Tauri 壳 + WebView 自绘文件列表**（XP 观感）。
由 [Tablacus Explorer](https://github.com/tablacus/TablacusExplorer)（Gaku，MIT）个人定制版演进而来——
原“Tauri 壳软嵌入 TE64 文件列表”的架构已于 2026-10-30 完成"去嵌入"切换：
文件列表完全自绘（前端 TypeScript），Rust 只做目录数据与文件操作，
不再依赖 TE64.exe 进程。原 TE 运行时已归档（见文末）。

## 运行

```
the_file.exe          # 双击即用（需 WebView2 Runtime，Win10/11 自带）
the_file.exe <路径>    # 指定启动目录（qq_codex 双击项目标签即此方式）；支持 Windows/UNC/Linux 写法
config\bookmarks.json # 常驻书签数据源，应用内增删改即时写回；改文件后"查看→刷新书签"重载
```

启动目录优先级：命令行传入目录 > 上次目录记忆（localStorage）> 猜盘根；传入目录不存在时 toast 提示并回退。

## 功能

- **书签面板两组**：
  - 「临时」：本次会话有效（内存），组头 `+` 收藏当前文件夹，条目 hover `×` 删除
  - 「常驻」：`config\bookmarks.json` 持久化（`[{name, path}]`），增删改即时写回（原子替换），
    右键条目 →「编辑…」改名称/路径
- **地址栏输入跳转**：回车直达、Esc 回填；支持三种写法（归一化对齐 qq_codex）：
  - Windows：`E:\foo\bar`；UNC：`\\server\share`、`\\wsl.localhost\Ubuntu\…`、`\\wsl$\…`
  - Linux 风格：`/home/beluga/…` → `\\wsl.localhost\Ubuntu\home\beluga\…`
  - `~` / `~/…` → WSL 家目录
- 自绘文件列表：单击/Ctrl/Shift 多选、双击打开、**F2 行内重命名**、
  Delete/Shift+Delete 删除（回收站/永久）、Ctrl+C/X/V 剪贴板、Ctrl+A、
  右键菜单（打开方式…/粘贴/新建文件夹）、表头三列排序、自然排序（file2 < file10）
- 上次目录记忆（localStorage）；自绘 XP 风标题栏 + 八向窗口拉伸

## 架构

| 层 | 选型 |
|---|---|
| 壳 | Tauri 2.11.5 + WebView2，`decorations:false` 自绘标题栏 |
| 文件列表 | `src/fileview.ts` 自绘（类比 xterm.js 之于终端），零原生控件、零嵌入 |
| 文件操作 | `src-tauri/src/fileops.rs`：ShellExecuteW / SHOpenWithDialog / SHFileOperationW（回收站）等 |
| 书签 | `src-tauri/src/lib.rs` read_bookmarks：从 exe 逐级上溯定位 `config/bookmarks.json` |

## 开发与构建（Windows 侧）

```bat
scripts\dev.ps1     :: tauri dev（热更新）
scripts\build.ps1   :: npm build + cargo release → the_file.exe
scripts\check.ps1   :: 仅 cargo check
scripts\verify.ps1  :: 启动 exe + 自动截图验证
```

依赖：WebView2 Runtime、Node、Rust + MSVC Build Tools（`qq_codex/scripts/env.ps1` 自动探测）。

## TE64 运行时归档（te64-runtime.tar.zst）

原 Tablacus Explorer 定制版（含左侧竖排标签栏、roster 花名册、无边框 te64.dll、
hostbridge 嵌入插件及整套调试记录）打包在本目录 `te64-runtime.tar.zst`（本地文件，不入库；
完整源文件亦见本仓库 `main` 分支）。恢复方法：

```
tar --zstd -xf te64-runtime.tar.zst -C the_wenjian
TE64.exe
```

## License

MIT，见 [LICENSE](LICENSE)。含 Tablacus Explorer 原项目（Gaku）代码与资源的派生历史。
