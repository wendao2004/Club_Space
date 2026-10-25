/**
 * 应用注册表。
 *
 * 桌面上的图标、开始菜单里的列表、任务栏里点图标要打开什么，全部来自这里。
 * 新增一个应用 = 在这里加一条 + 写好对应组件，桌面外壳本身不需要改。
 */
import { defineAsyncComponent, type Component } from 'vue'

export interface AppDef {
  id: string
  name: string
  /** 图标名（见 components/Icon.vue） */
  icon: string
  /** 桌面图标与开始菜单里显示的一句话说明 */
  description: string
  /**
   * 图标主色（纯色 hex）。
   *
   * 组件负责把它调成"浅底彩线"的形态：浅色主题 = 主色 14% 淡底 + 主色字形，
   * 深色主题 = 主色 55% 提亮字形。所以这里给的是**主色**，不是背景色，
   * 不要给渐变、不要给高饱和的整块底色。
   */
  tint?: string
  /** 是否显示在桌面上 */
  onDesktop?: boolean
  /** 是否显示在开始菜单里 */
  inStartMenu?: boolean
  /** 开始菜单里的分组 */
  group?: '常用' | '工具' | '管理'
  /** 打开时的默认尺寸 */
  defaultSize?: { w: number; h: number }
  minSize?: { w: number; h: number }
  resizable?: boolean
  /** 需要管理员权限 */
  adminOnly?: boolean
  /**
   * 移动端打开时在返回栏下方给出的一句提醒。
   *
   * 刻意做成"标注"而不是"隐藏/禁用"：手机上没有上传入口的文件管理和
   * 固定两栏的狼人杀，进来至少还能看，直接下架等于把已有的只读能力也砍掉；
   * 但什么都不说，用户只会觉得应用坏了。只给结构上真的排不开的应用配这个字段。
   */
  mobileHint?: string
  component: () => Promise<{ default: Component }>
}

export const APPS: AppDef[] = [
  {
    id: 'chat',
    name: '聊天',
    icon: 'users',
    description: '社团成员之间的即时交流，群聊与单聊',
    tint: '#16a06b',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 1000, h: 640 },
    minSize: { w: 560, h: 380 },
    component: () => import('@/apps/ChatApp.vue'),
  },
  {
    id: 'files',
    name: '文件',
    icon: 'folder',
    description: '社团共享空间与个人空间，支持大文件断点续传',
    tint: '#e08a1e',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 980, h: 620 },
    minSize: { w: 520, h: 360 },
    mobileHint: '请在电脑上使用：侧栏固定 180px，手机屏幕放不下，而且手机端没有上传入口',
    component: () => import('@/apps/FileManagerApp.vue'),
  },
  {
    id: 'tools',
    name: '工具集',
    icon: 'tools',
    description: '格式转换、PDF 处理、二维码等常用小工具',
    tint: '#2b6cd4',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 940, h: 620 },
    minSize: { w: 520, h: 380 },
    component: () => import('@/apps/ToolsApp.vue'),
  },
  {
    id: 'ledger',
    name: '记账',
    icon: 'chart',
    description: '社团报账：收支流水、分摊、审批与月度统计',
    tint: '#2f9e44',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 1120, h: 680 },
    minSize: { w: 600, h: 400 },
    component: () => import('@/apps/LedgerApp.vue'),
  },
  {
    id: 'assets',
    name: '财物',
    icon: 'archive',
    description: '社团物品台账与借还记录，谁借走了什么一目了然',
    tint: '#2a7f9e',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 1080, h: 680 },
    minSize: { w: 620, h: 420 },
    component: () => import('@/apps/AssetsApp.vue'),
  },
  {
    id: 'games',
    name: '象棋',
    icon: 'grid',
    description: '中国象棋对局与观战，规则由服务端裁定',
    tint: '#b06a2c',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 1060, h: 700 },
    minSize: { w: 560, h: 440 },
    component: () => import('@/apps/GamesApp.vue'),
  },
  {
    id: 'doudizhu',
    name: '斗地主',
    icon: 'layout',
    description: '三人牌局，手牌由服务端按视角裁剪',
    tint: '#c0392b',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 1080, h: 720 },
    minSize: { w: 620, h: 480 },
    component: () => import('@/apps/DoudizhuApp.vue'),
  },
  {
    id: 'werewolf',
    name: '狼人杀',
    icon: 'eye',
    description: '9 人局，身份由服务端按视角裁剪，别人看不到你的牌',
    tint: '#6a5acd',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 1080, h: 720 },
    minSize: { w: 640, h: 500 },
    mobileHint: '请在电脑上使用：牌桌是"1fr + 290px"两栏，手机上主体只剩一条缝',
    component: () => import('@/apps/WerewolfApp.vue'),
  },
  {
    id: 'draw',
    name: '你画我猜',
    icon: 'brush',
    description: '一人画大家猜，词只在画家与已猜对的人手里',
    tint: '#2e8b74',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 1120, h: 740 },
    minSize: { w: 700, h: 520 },
    component: () => import('@/apps/DrawApp.vue'),
  },
  {
    id: 'board',
    name: '留言板',
    icon: 'chat',
    description: '遇到的问题、想说的建议都写在这儿，管理员会标记处理',
    tint: '#b5651d',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 820, h: 700 },
    minSize: { w: 520, h: 460 },
    component: () => import('@/apps/BoardApp.vue'),
  },
  {
    id: 'poll',
    name: '投票',
    icon: 'vote',
    description: '约时间、定地点、集体决策，点选项即投票，结果实时可见',
    tint: '#0f8f8f',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 820, h: 680 },
    minSize: { w: 520, h: 440 },
    component: () => import('@/apps/PollApp.vue'),
  },
  {
    id: 'music',
    name: '听歌房',
    icon: 'audio',
    description: '全站一个厅：共享播放队列，谁都能排歌、切歌，挂着当背景音',
    tint: '#c2452d',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 760, h: 620 },
    minSize: { w: 480, h: 400 },
    component: () => import('@/apps/MusicRoomApp.vue'),
  },
  {
    id: 'typing',
    name: '打字背单词',
    icon: 'text',
    description: '边打字边背单词：CET-4/6、考研、程序员词库，进度与错题本存服务端',
    tint: '#3f7d20',
    onDesktop: true,
    inStartMenu: true,
    group: '工具',
    defaultSize: { w: 900, h: 640 },
    minSize: { w: 560, h: 440 },
    component: () => import('@/apps/TypingApp.vue'),
  },
  {
    id: 'whiteboard',
    name: '白板',
    icon: 'brush',
    description: 'Excalidraw 协作画板：讨论方案、画草图，所有人可见、作者保存定稿',
    tint: '#8a4fbf',
    onDesktop: true,
    inStartMenu: true,
    group: '工具',
    defaultSize: { w: 1180, h: 760 },
    minSize: { w: 720, h: 520 },
    component: () => import('@/apps/WhiteboardApp.vue'),
  },
  {
    id: 'jobs',
    name: '任务',
    icon: 'clock',
    description: '查看转换与处理的进度和历史',
    tint: '#7c6cd9',
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 780, h: 520 },
    component: () => import('@/apps/JobsApp.vue'),
  },
  {
    id: 'settings',
    name: '设置',
    icon: 'settings',
    description: '主题、壁纸、账号与安全状态',
    tint: '#6b7686',
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 820, h: 580 },
    component: () => import('@/apps/SettingsApp.vue'),
  },
  {
    id: 'admin',
    name: '管理',
    icon: 'shield',
    description: '成员、邀请码、存储用量与审计日志',
    tint: '#d0454f',
    inStartMenu: true,
    group: '管理',
    adminOnly: true,
    defaultSize: { w: 1000, h: 640 },
    component: () => import('@/apps/AdminApp.vue'),
  },
  {
    id: 'ops',
    name: '运维',
    icon: 'terminal',
    description: '两步验证与受控的服务器操作（管理员）',
    tint: '#4a5a6a',
    inStartMenu: true,
    group: '管理',
    adminOnly: true,
    defaultSize: { w: 1000, h: 680 },
    minSize: { w: 600, h: 440 },
    component: () => import('@/apps/OpsApp.vue'),
  },
  {
    id: 'about',
    name: '关于本平台',
    icon: 'info',
    description: '部署说明、HTTPS 证书与已知限制',
    tint: '#2c9c8a',
    inStartMenu: true,
    group: '管理',
    defaultSize: { w: 760, h: 560 },
    component: () => import('@/apps/AboutApp.vue'),
  },
  {
    // 在线表格编辑器：由文件管理器按需拉起（双击 .xlsx / 右键「编辑」）。
    //
    // 和预览窗口一样不进桌面、不进开始菜单 —— 它不是"一个应用"，
    // 是某个文件的一个打开方式，没有"打开一个空的表格编辑器"这种操作
    // （新建表格是文件管理器的事，它先生成文件再开这个窗口）。
    id: 'sheet-editor',
    name: '表格编辑',
    icon: 'sheet',
    description: '在线编辑 .xlsx 表格',
    tint: '#1f8a51',
    defaultSize: { w: 1100, h: 660 },
    minSize: { w: 560, h: 380 },
    component: () => import('@/apps/SheetEditorApp.vue'),
  },
  {
    // 在线文档编辑器：由文件管理器按需拉起（双击 .docx / 右键「编辑」）。
    id: 'doc-editor',
    name: '文档编辑',
    icon: 'doc',
    description: '在线编辑 .docx 文档',
    tint: '#2b6cd4',
    defaultSize: { w: 1000, h: 700 },
    minSize: { w: 520, h: 380 },
    component: () => import('@/apps/DocEditorApp.vue'),
  },
  {
    // 文件预览窗口：由文件管理器按需拉起（双击文件 / 右键「预览」）。
    // 刻意不进桌面、不进开始菜单 —— 它不是"应用"，是文件的一个视图，
    // 所以也不该出现在桌面图标和开始菜单的自动化断言里。
    id: 'preview',
    name: '预览',
    icon: 'eye',
    description: '文件预览窗口',
    tint: '#5b6b7d',
    defaultSize: { w: 940, h: 660 },
    minSize: { w: 420, h: 320 },
    component: () => import('@/apps/PreviewApp.vue'),
  },
]

export function findApp(id: string): AppDef | undefined {
  return APPS.find((app) => app.id === id)
}

/** 预解析组件，供外壳按 appId 渲染。 */
export const appComponents: Record<string, Component> = Object.fromEntries(
  APPS.map((app) => [app.id, defineAsyncComponent(app.component)]),
)
