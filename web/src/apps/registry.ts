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
  /** 图标底色，用 CSS 渐变；不写则用中性色 */
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
  component: () => Promise<{ default: Component }>
}

export const APPS: AppDef[] = [
  {
    id: 'chat',
    name: '聊天',
    icon: 'users',
    description: '社团成员之间的即时交流，群聊与单聊',
    tint: 'linear-gradient(140deg,#5ed3a8,#22a06b)',
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
    tint: 'linear-gradient(140deg,#f7b955,#e08a1e)',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 980, h: 620 },
    minSize: { w: 520, h: 360 },
    component: () => import('@/apps/FileManagerApp.vue'),
  },
  {
    id: 'tools',
    name: '工具集',
    icon: 'tools',
    description: '格式转换、PDF 处理、二维码等常用小工具',
    tint: 'linear-gradient(140deg,#5aa9f0,#2b6cd4)',
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
    tint: 'linear-gradient(140deg,#7ed957,#3a9e2e)',
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
    tint: 'linear-gradient(140deg,#59c1c9,#2b7f92)',
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
    tint: 'linear-gradient(140deg,#d98a4a,#a4551f)',
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
    tint: 'linear-gradient(140deg,#e05555,#a32b2b)',
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
    tint: 'linear-gradient(140deg,#6a5acd,#3b2f8f)',
    onDesktop: true,
    inStartMenu: true,
    group: '常用',
    defaultSize: { w: 1080, h: 720 },
    minSize: { w: 640, h: 500 },
    component: () => import('@/apps/WerewolfApp.vue'),
  },
  {
    id: 'jobs',
    name: '任务',
    icon: 'clock',
    description: '查看转换与处理的进度和历史',
    tint: 'linear-gradient(140deg,#9b8cf0,#6a55d4)',
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
    tint: 'linear-gradient(140deg,#8f9aa8,#5b6672)',
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
    tint: 'linear-gradient(140deg,#f07178,#c13b45)',
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
    tint: 'linear-gradient(140deg,#5b6b7d,#2f3a47)',
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
    tint: 'linear-gradient(140deg,#6fd3c0,#2c9c8a)',
    inStartMenu: true,
    group: '管理',
    defaultSize: { w: 760, h: 560 },
    component: () => import('@/apps/AboutApp.vue'),
  },
]

export function findApp(id: string): AppDef | undefined {
  return APPS.find((app) => app.id === id)
}

/** 预解析组件，供外壳按 appId 渲染。 */
export const appComponents: Record<string, Component> = Object.fromEntries(
  APPS.map((app) => [app.id, defineAsyncComponent(app.component)]),
)
