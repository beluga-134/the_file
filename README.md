# the_file

[Tablacus Explorer](https://github.com/tablacus/TablacusExplorer) 的个人定制版。
原作由 **Gaku** 开发（MIT License），向原作者致敬 🙏——这个 11KB exe + 明文脚本、
跑了十几年依然轻量的文件管理器，是"本地壳 + Web UI + 插件化"架构的最佳实践之一。

上游项目：https://github.com/tablacus/TablacusExplorer （te26.9.20 基线）

## 本仓库的定制

- **标签栏放左侧竖排**（`config/addons.xml`：tabplus `Align="2" Width="180"`，带关闭按钮/盘符图标/工具提示）
- 精简 32 位二进制（TE32/te32.dll/tewv32.dll）与多余语言文件，只保留 简中/繁中/英文
- 清除运行时浏览历史状态（remember/closedtabs/window1，启动自动重建）

## 怎么改 UI

所有 UI 都是明文，无编译环节，记事本保存即"发布"：

| 想改 | 文件 |
|---|---|
| 标签条 | `addons/tabplus/script.js` |
| 菜单/工具栏/地址栏 | `addons/<对应插件>/script.js` |
| 布局骨架/样式 | `script/index.html` `script/index.css` |
| 右键菜单/快捷键/手势 | `config/menus.xml` `key.xml` `mouse.xml`（工具菜单"重新加载自定义"即时生效） |
| 布局预设（官方自带左/右/底标签等） | `layout/*.xml`，工具菜单 → 载入布局 |

文件列表本体是原生 shell 控件（性能担当），标题栏/右键弹出菜单是系统渲染，不在可改范围。

## License

MIT，见 [LICENSE](LICENSE)。包含 Tablacus Explorer 原项目（Gaku）的代码与资源。
