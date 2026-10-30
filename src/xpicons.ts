/**
 * XP Luna 风自绘 SVG 图标库（32 viewBox，渐变 + 高光）。
 *
 * 手绘原创，避免捆绑微软版权图标资源（真 XP 图标不可再分发入仓库）；
 * 观感对齐 Windows XP：金黄光滑文件夹、蓝标题应用窗口、绿色导航箭头等。
 * 每次调用生成唯一渐变 id，防同页多实例 SVG defs 冲突。
 */

export type XpIconName =
  | "folder"
  | "folderUp"
  | "fileGeneric"
  | "fileText"
  | "fileImage"
  | "fileVideo"
  | "fileAudio"
  | "fileArchive"
  | "fileCode"
  | "fileSheet"
  | "app"
  | "drive"
  | "cdrom"
  | "floppy"
  | "net"
  | "back"
  | "forward"
  | "refresh";

/** 图标 → 用途说明（可读性，不做映射逻辑） */
export const XP_ICON_USAGE: Record<XpIconName, string> = {
  folder: "目录（XP 金黄文件夹）",
  folderUp: "上一级（文件夹 + 绿箭头）",
  fileGeneric: "未知类型文件（白纸折角）",
  fileText: "文本文档",
  fileImage: "图片",
  fileVideo: "视频",
  fileAudio: "音频",
  fileArchive: "压缩包（拉链纸页）",
  fileCode: "代码",
  fileSheet: "表格",
  app: "可执行（XP 蓝窗）",
  drive: "本地磁盘（3D 灰盒 + 绿灯）",
  cdrom: "光驱",
  floppy: "软盘",
  net: "网络位置（双显示器）",
  back: "后退（绿色圆箭头）",
  forward: "前进",
  refresh: "刷新（绿色回环箭头）",
};

let seq = 0;

/** 竖向双色渐变 */
function lin(id: string, top: string, bottom: string): string {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>` +
    `</linearGradient>`;
}

/** XP 金黄文件夹主体（供 folder / folderUp 复用）；gid 为渐变 id 前缀 */
function folderBody(gid: string): string {
  return `<defs>
${lin(`${gid}b`, "#EFC464", "#C88F1F")}
${lin(`${gid}f`, "#FFE9A8", "#F0B429")}
</defs>
<path d="M3 10 q0-2.4 2.4-2.4 h8.2 l3 3 h11 q2.4 0 2.4 2.4 v3.4 H3 Z" fill="url(#${gid}b)" stroke="#A5761C" stroke-width="1.4"/>
<path d="M3 14.4 h26 v10.4 q0 2.4-2.4 2.4 H5.4 q-2.4 0-2.4-2.4 Z" fill="url(#${gid}f)" stroke="#A5761C" stroke-width="1.4"/>
<path d="M3.8 15.2 h24.4 v2.6 q-12.2 2.8-24.4 0 Z" fill="#ffffff" opacity="0.35"/>`;
}

/** 白纸页（供各 file* 复用）：返回 [defs+纸身, 内容起点提示] */
function pageBody(gid: string): string {
  return `<defs>
${lin(gid, "#ffffff", "#e9eef4")}
</defs>
<path d="M7 3 h12 l6 6 v20 H7 Z" fill="url(#${gid})" stroke="#8a95a3" stroke-width="1.4"/>
<path d="M19 3 l6 6 h-6 Z" fill="#cfe0f0" stroke="#8a95a3" stroke-width="1.4" stroke-linejoin="round"/>`;
}

/** 绿色圆箭头（back/forward 复用）；dir=-1 左 / +1 右 */
function circleArrow(gid: string, dir: -1 | 1): string {
  const mirror = dir < 0 ? ' transform="translate(32,0) scale(-1,1)"' : "";
  return `<defs>
<radialGradient id="${gid}" cx="0.38" cy="0.32" r="0.95">
<stop offset="0" stop-color="#9fe89f"/><stop offset="0.55" stop-color="#4cc24c"/><stop offset="1" stop-color="#23802f"/>
</radialGradient>
</defs>
<circle cx="16" cy="16" r="12.4" fill="url(#${gid})" stroke="#1b6b2a" stroke-width="1.5"/>
<circle cx="16" cy="16" r="9.6" fill="none" stroke="#dff3df" stroke-width="1" opacity="0.8"/>
<path d="M16.6 9.2 L24 16 L16.6 22.8" fill="none" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"${mirror}/>
<path d="M10.6 16 H21" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round"${mirror}/>`;
}

const BUILDERS: Record<XpIconName, (gid: string) => string> = {
  folder: (g) => folderBody(g),

  folderUp: (g) => folderBody(g) +
    `<path d="M25 25 v-9.4 M21.4 19 L25 15.2 28.6 19" fill="none" stroke="#1b6b2a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,

  fileGeneric: (g) => pageBody(g),

  fileText: (g) => pageBody(g) +
    `<path d="M10.5 14 h11 M10.5 18 h11 M10.5 22 h7.5" stroke="#7a87a0" stroke-width="1.6" stroke-linecap="round"/>`,

  fileImage: (g) => pageBody(g) +
    `<rect x="10" y="13" width="12" height="9.6" fill="#bfe0fa" stroke="#6e93b8" stroke-width="1.2"/>
<circle cx="13.4" cy="16" r="1.5" fill="#ffd84d" stroke="#d9a400" stroke-width="0.8"/>
<path d="M10.6 21.4 l3.4-4 2.6 2.8 3-3.4 2.4 4.6 Z" fill="#3e8e41" stroke="#2c6e2f" stroke-width="0.8" stroke-linejoin="round"/>`,

  fileVideo: (g) => pageBody(g) +
    `<rect x="9.4" y="13.4" width="13.2" height="10" rx="1" fill="#2e2e34" stroke="#14141a" stroke-width="1.2"/>
<path d="M11.4 15.4 h1.6 v1.6 h-1.6 Z M15.2 15.4 h1.6 v1.6 h-1.6 Z M19 15.4 h1.6 v1.6 H19 Z M11.4 20 h1.6 v1.6 h-1.6 Z M15.2 20 h1.6 v1.6 h-1.6 Z M19 20 h1.6 v1.6 H19 Z" fill="#e8e8e8"/>`,

  fileAudio: (g) => pageBody(g) +
    `<circle cx="13.6" cy="21.4" r="2.8" fill="#4b69c6" stroke="#33488f" stroke-width="1"/>
<path d="M16.2 21.4 V13.2 l5.4 1.6 v-2 l-5.4-1.7 Z" fill="#4b69c6" stroke="#33488f" stroke-width="1" stroke-linejoin="round"/>`,

  fileArchive: (g) => pageBody(g) +
    `<path d="M16 10 v17" stroke="#8a95a3" stroke-width="1.6" stroke-dasharray="2.4 2.2"/>
<rect x="13.9" y="19.4" width="4.2" height="5" rx="1" fill="#c9d4e0" stroke="#7d8996" stroke-width="1"/>
<circle cx="16" cy="21.8" r="1" fill="#5a6673"/>`,

  fileCode: (g) => pageBody(g) +
    `<path d="M12.6 14.6 L9 18.4 l3.6 3.6 M19.4 14.6 l3.6 3.8-3.6 3.6 M17.8 12.6 l-3.6 11" fill="none" stroke="#3f62b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,

  fileSheet: (g) => pageBody(g) +
    `<rect x="9.4" y="12.6" width="13.2" height="11.4" fill="#ffffff" stroke="#6aa84f" stroke-width="1.3"/>
<path d="M9.4 16.4 h13.2 M9.4 20.2 h13.2 M14 12.6 v11.4 M18.4 12.6 v11.4" stroke="#6aa84f" stroke-width="1.1"/>
<rect x="9.4" y="12.6" width="13.2" height="3.8" fill="#c6e0b4" opacity="0.85"/>`,

  app: (g) => `<defs>
${lin(`${g}t`, "#5aa7ff", "#0055ea")}
${lin(g, "#f6f4ec", "#d8d2bd")}
</defs>
<rect x="4.6" y="6.4" width="22.8" height="19.2" rx="1.2" fill="url(#${g})" stroke="#3f546e" stroke-width="1.5"/>
<rect x="4.6" y="6.4" width="22.8" height="5.4" rx="1.2" fill="url(#${g}t)" stroke="#3f546e" stroke-width="1.5"/>
<circle cx="24.2" cy="9.1" r="1.6" fill="#e05a5a" stroke="#a03030" stroke-width="0.7"/>
<path d="M8 14.4 h10 M8 17.6 h14 M8 20.8 h12" stroke="#8a8672" stroke-width="1.5" stroke-linecap="round"/>`,

  drive: (g) => `<defs>
${lin(g, "#d5dce4", "#8c99a8")}
</defs>
<path d="M8.6 11.6 l2.6-3.4 h13.6 l2.6 3.4 Z" fill="#e8edf2" stroke="#4a5561" stroke-width="1.3" stroke-linejoin="round"/>
<rect x="4.6" y="11.6" width="22.8" height="11.4" rx="1.4" fill="url(#${g})" stroke="#4a5561" stroke-width="1.5"/>
<path d="M6.6 20.8 h13" stroke="#6b7887" stroke-width="1.4" stroke-linecap="round"/>
<circle cx="23.6" cy="19.6" r="1.8" fill="#37c837" stroke="#1f8f27" stroke-width="0.9"/>`,

  cdrom: (g) => `<defs>
<linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#f4f8fb"/><stop offset="0.5" stop-color="#c3cedb"/><stop offset="1" stop-color="#8d9aa9"/>
</linearGradient>
</defs>
<circle cx="16" cy="16" r="11.6" fill="url(#${g})" stroke="#6d7987" stroke-width="1.5"/>
<circle cx="16" cy="16" r="3.6" fill="#ece9d8" stroke="#8a95a3" stroke-width="1.2"/>
<path d="M9 9.4 a9.8 9.8 0 0 1 7-2.8" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.7" stroke-linecap="round"/>`,

  floppy: (g) => `<defs>
${lin(g, "#5b74ad", "#35497c")}
</defs>
<rect x="4.6" y="4.6" width="22.8" height="22.8" rx="1.6" fill="url(#${g})" stroke="#26365e" stroke-width="1.5"/>
<rect x="10.4" y="4.6" width="11" height="8.4" fill="#cdd4dc" stroke="#8a95a3" stroke-width="1"/>
<rect x="16.6" y="6" width="2.8" height="5.4" fill="#7d8996"/>
<rect x="8.6" y="17" width="14.8" height="9" fill="#ececec" stroke="#a8a8a8" stroke-width="1"/>
<path d="M10.6 20.6 h10.8 M10.6 23.4 h10.8" stroke="#9aa2ac" stroke-width="1.1"/>`,

  net: (g) => `<defs>
${lin(g, "#7db4e8", "#2e5fa3")}
</defs>
<rect x="3.6" y="5.6" width="14" height="10" rx="1" fill="url(#${g})" stroke="#253c66" stroke-width="1.4"/>
<rect x="8" y="15.6" width="5.2" height="2.6" fill="#8a95a3" stroke="#5a6673" stroke-width="0.9"/>
<rect x="5.6" y="18.2" width="10" height="1.8" fill="#c3cedb" stroke="#5a6673" stroke-width="0.9"/>
<rect x="15.6" y="15.6" width="13" height="9.4" rx="1" fill="url(#${g})" stroke="#253c66" stroke-width="1.4"/>
<rect x="19.4" y="25" width="5.4" height="2.2" fill="#8a95a3" stroke="#5a6673" stroke-width="0.9"/>
<rect x="17" y="27.2" width="10.2" height="1.7" fill="#c3cedb" stroke="#5a6673" stroke-width="0.9"/>`,

  back: (g) => circleArrow(g, -1),

  forward: (g) => circleArrow(g, 1),

  refresh: (g) => `<defs>
<radialGradient id="${g}" cx="0.4" cy="0.3" r="1">
<stop offset="0" stop-color="#9fe89f"/><stop offset="1" stop-color="#2e9e3e"/>
</radialGradient>
</defs>
<circle cx="16" cy="16" r="12.6" fill="url(#${g})" stroke="#1b6b2a" stroke-width="1.5"/>
<path d="M16 8.2 a7.8 7.8 0 1 0 7.8 7.8" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round"/>
<path d="M16 4.2 L22 8.4 16 12.6 Z" fill="#ffffff"/>`,
};

/** 生成内联 XP 风图标 SVG 字符串 */
export function xpIcon(name: XpIconName, size = 16): string {
  const gid = `xg${++seq}`;
  return `<svg class="xpicon xpicon-${name}" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">${BUILDERS[name](gid)}</svg>`;
}
