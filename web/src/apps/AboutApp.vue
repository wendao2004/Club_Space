<!--
  关于本平台。

  定位是“说明书”，不是宣传页：这一节里的每一句话都要能被用户拿去指导实际操作，
  或者解释一个他刚刚遇到的、界面上没给出答案的现象。所以刻意保留“已知限制”
  一节并把话说全 —— 把做不到的事情说清楚，比让用户自己撞几次墙更省事。

  后端状态走 api.health()，出错时原样显示后端返回的 message，不吞。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { APPS } from '@/apps/registry'
import { api, ApiError, formatTime } from '@/api'
import { useAuth } from '@/stores/auth'
import type { WindowInstance } from '@/stores/windows'

const props = defineProps<{ win: WindowInstance }>()

const auth = useAuth()

// ---------------------------------------------------------------- 运行环境

/** 访问地址。 */
const origin = window.location.origin
/** 是否安全上下文（HTTPS 或 localhost）。 */
const isSecure = window.isSecureContext
/** 是否支持 Service Worker。 */
const hasServiceWorker = 'serviceWorker' in navigator

interface BrowserInfo {
  name: string
  version: string
  platform: string
}

/**
 * 把 navigator.userAgent 提炼成人能读的形式。
 *
 * 直接吐一整串 UA 对用户没有意义，这里只留下“哪个浏览器、几版、什么系统”，
 * 排查兼容性问题时这三点就够了。
 */
function parseBrowser(ua: string): BrowserInfo {
  let name = '未知浏览器'
  let version = ''

  // 顺序有讲究：Edge、Opera 的 UA 里也带 Chrome，必须先匹配它们。
  const candidates: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /Edg\/(\d+)/, label: 'Microsoft Edge' },
    { pattern: /OPR\/(\d+)/, label: 'Opera' },
    { pattern: /Firefox\/(\d+)/, label: 'Firefox' },
    { pattern: /Chrome\/(\d+)/, label: 'Chrome' },
    { pattern: /Version\/(\d+)[\d.]* Safari/, label: 'Safari' },
  ]
  for (const candidate of candidates) {
    const major = candidate.pattern.exec(ua)?.[1]
    if (major) {
      name = candidate.label
      version = major
      break
    }
  }

  let platform = '未知平台'
  if (/Windows NT 10/.test(ua)) platform = 'Windows 10 / 11'
  else if (/Windows NT 6\.[23]/.test(ua)) platform = 'Windows 8 / 8.1'
  else if (/Windows NT 6\.1/.test(ua)) platform = 'Windows 7'
  else if (/Mac OS X/.test(ua)) platform = 'macOS'
  else if (/Android/.test(ua)) platform = 'Android'
  else if (/(iPhone|iPad|iPod)/.test(ua)) platform = 'iOS / iPadOS'
  else if (/Linux/.test(ua)) platform = 'Linux'

  return { name, version, platform }
}

const browser = parseBrowser(navigator.userAgent)
const browserText = `${browser.name}${browser.version ? ` ${browser.version}` : ''} · ${browser.platform}`

const secureReason = isSecure
  ? '当前连接已加密（HTTPS 或本机回环地址），加密接口、Service Worker、剪贴板与通知等功能可用。'
  : '当前是明文 HTTP 访问，浏览器的加密接口、Service Worker、剪贴板、摄像头与通知等能力会被禁用。'

// ---------------------------------------------------------------- 后端状态

interface Health {
  ok: boolean
  audit: { healthy: boolean; chainOk: boolean; records: number }
}

const health = ref<Health | null>(null)
const healthError = ref('')
const healthLoading = ref(false)
const checkedAt = ref<number | null>(null)

async function loadHealth(): Promise<void> {
  healthLoading.value = true
  healthError.value = ''
  try {
    health.value = await api.health()
    checkedAt.value = Date.now()
  } catch (err) {
    health.value = null
    healthError.value = err instanceof ApiError ? err.message : '获取后端状态失败，请稍后重试'
  } finally {
    healthLoading.value = false
  }
}

// ---------------------------------------------------------------- 静态说明

const usageSteps: string[] = [
  '在桌面上双击图标即可打开应用；再次点击任务栏上的同一图标，可以切换或最小化这个窗口。',
  '窗口可拖动标题栏移动、拖四边缩放；拖到屏幕左右边缘会自动分屏。',
  '刷新页面会恢复上一次打开的窗口布局，不用每次重新摆一遍。',
  '文件默认上传到“共享空间”，全社团可见；“个人空间”只有自己能看到。',
  '上传大文件支持断点续传：关掉页面再打开、重新选择同一个文件，会从中断处继续。',
  '上传**没有单文件大小上限**。唯一的限制是磁盘余量：如果这次上传会让 NAS 剩下的空间低于 2GB，会被拒绝并告诉你还差多少——那是在保命，不是限额。',
]

const shortcuts: Array<{ keys: string[]; label: string }> = [
  { keys: ['Ctrl', 'Alt', 'E'], label: '打开文件' },
  { keys: ['Ctrl', 'Alt', 'T'], label: '打开工具集' },
  { keys: ['Ctrl', 'Alt', 'M'], label: '最小化全部窗口' },
  { keys: ['Ctrl', 'Alt', 'S'], label: '最大化 / 还原当前窗口' },
  { keys: ['Ctrl', 'W'], label: '关闭当前窗口' },
  { keys: ['Esc'], label: '关闭菜单' },
  { keys: ['↑', '↓', '←', '→'], label: '在桌面图标间移动' },
  { keys: ['Enter'], label: '打开选中的图标' },
]

/**
 * 这个平台"能做什么"。
 *
 * 名字不写死在这里：应用清单以 apps/registry.ts 为准（那边加一个应用，
 * 这一节自动跟上），这里只负责给每个应用配一句人话。
 * 术语一律不进这一节 —— 用户来这儿是为了知道"点了会发生什么"，不是读架构。
 * 唯一需要点名的是听歌房的在线曲库：它是第 42 轮的起因，也是最容易被
 * "文件区里没有歌" 挡在门外的一个入口。
 */
const capabilityTips: Record<string, string> = {
  chat: '和朋友私聊，或者在群里一起说话；历史消息都留在服务器上，换台电脑也能翻。',
  files: '社团共享的文件都放在这儿，谁都能看；自己还有一个只有自己看得到的空间。大文件传一半断了，重新选同一个文件会接着传。',
  tools: '一串随手能用的小工具：格式转换、PDF 拆分合并、生成二维码之类，不用另外装软件。',
  ledger: '记社团的每一笔收支，月底自动汇总；谁该分摊多少也算得清，报账不用再翻聊天记录。',
  assets: '社团的实物也能登记：相机、音响、帐篷借给谁了、什么时候该还，一查就知道。',
  games: '中国象棋，两个人在线下一盘，旁边的人可以围观。',
  doudizhu: '斗地主，三个人一桌；你看不到别人的牌，别人也看不到你的。',
  werewolf: '狼人杀，九个人一局；身份只有自己知道，天黑请闭眼那种。',
  draw: '一人画、大家猜。词只发给画的人和已经猜对的人，别人偷看不到。',
  board: '遇到问题、想提建议就写在留言板上，管理员会标记"处理中 / 已处理"。',
  poll: '约时间、定地点、选方案：点一下就算投票，结果当场刷新，不用挨个问。',
  music:
    '全站只有一个听歌房，所有人听同一首歌、进度也一样，挂着当背景音就行。' +
    '曲库有两种来源：社团自己的文件，以及「在线曲库」里搜哔哩哔哩 —— ' +
    '文件区里没有歌（比如歌都在别人的私人空间）也不影响，直接用在线曲库搜就行。',
  typing: '边打字边背单词，CET-4/6、考研、程序员词库都有；进度和错题会记住。',
  whiteboard: '一块大家共用的画板，可以画草图、贴想法，谁都能看，画的人最后点保存定稿。',
  jobs: '所有"要跑一会儿"的任务都在这儿排队，能看到进度，也能翻历史。',
  settings: '换主题、换壁纸，改自己的名字和密码，也能看到账号的安全状态。',
  admin: '管理员专用：加人、发邀请码、看硬盘用了多少、翻操作记录。',
  ops: '管理员专用：给服务器做几件"事先写死"的维护操作，每次都要再验一次身份。',
  about: '就是你现在看的这一页：部署情况、证书、已知限制，都在这里说清楚。',
  'sheet-editor': '在线改 Excel 表格，不用下载下来。',
  'doc-editor': '在线改 Word 文档，不用下载下来。',
  preview: '文件点开先看一眼，不用真的下载。',
}

/** 这三个没有独立的桌面图标：它们是文件的打开方式，入口在文件管理器里。 */
const OPENED_FROM_FILES = new Set(['sheet-editor', 'doc-editor', 'preview'])

interface Capability {
  id: string
  name: string
  tip: string
  fromFiles: boolean
  adminOnly: boolean
}

/**
 * 逐条列出所有应用。
 *
 * 顺序与 registry 一致，名字也从那儿取 —— 手抄一遍迟早会和真实清单对不上
 * （改名、加应用之后这一节就悄悄变成谎话）。registry 里没配人话的，
 * 退回它自己那句 description，宁可朴素也不要漏掉一个应用。
 */
const capabilities = computed<Capability[]>(() =>
  APPS.map((app) => ({
    id: app.id,
    name: app.name,
    tip: capabilityTips[app.id] ?? app.description,
    fromFiles: OPENED_FROM_FILES.has(app.id),
    adminOnly: Boolean(app.adminOnly),
  })),
)

const limitations: string[] = [
  '浏览器无法拦截 Win 键、Alt+Tab 等系统级快捷键，所以“和 Windows 完全一致”在键位层面做不到。',
  '局域网内没有公网出口，因此浏览器推送通知（Web Push）不可用；通知只在页面打开时显示。',
  '视频“在线剪辑”是服务端处理（裁剪、压缩、转封装），不是浏览器里的多轨实时预览 —— NAS 的 CPU 与内存撑不住后者。',
  '格式转换（Word / Excel / PPT 转 PDF）依赖单独的转换服务，未部署时该工具会显示为“未启用”并给出原因。',
  '若设备未安装内网根证书，摄像头、通知、剪贴板、PWA 等功能不可用。',
  '操作记录只能做到“被改过一定查得出来”，做不到“根本改不了”：整台 NAS 都在同一台机器上，拿到最高权限的人想改总有办法。我们能保证的是事后对得上账。',
  '备份的另一份要靠人搬：外接硬盘得有人换、有人带到别的地方去。这个动作没有任何软件能替代。',
  '象棋、斗地主、狼人杀的房间画面是“一人一份”单独算的，不能共用同一份 —— 共用的话，对手收到的是你的视角，牌和回合都会看错。',
  '三国杀还没做。象棋、斗地主、狼人杀都能玩了，三国杀的工作量差不多等于这三个加起来。',
  '管理员那套服务器操作需要在部署时手动开启，默认是关的。社团这台机器上没装 Docker，所以这条只有换到 NAS 上才谈得上真的验证过。',
  '在线曲库能不能用，不由这里的代码决定：它要求这台机器能上外网，还得看哔哩哔哩那边接口脸色。已经真遇到过“首页正常、其实一条数据都不给”的静默故障。所以它的定位是“能连上就多一个来源”，不是承诺。',
]

const stack: Array<{ name: string; detail: string }> = [
  { name: '前端', detail: 'Vue 3 + TypeScript + Vite' },
  { name: '后端', detail: 'Node.js 24 + Fastify' },
  { name: '数据', detail: 'SQLite（WAL 模式）' },
  { name: '文件存储', detail: '内容寻址存储与引用计数，相同内容自动去重' },
  { name: '上传', detail: '分片上传与断点续传' },
  { name: '认证', detail: 'scrypt 口令哈希，httpOnly cookie 会话' },
  { name: '审计', detail: '哈希链审计日志' },
]

// ---------------------------------------------------------------- 生命周期

const bodyRef = ref<HTMLElement | null>(null)

onMounted(() => {
  void loadHealth()

  // 允许从别处带着 { section } 参数打开并直接定位到某一节。
  const section = props.win.args.section
  if (typeof section === 'string' && section) {
    window.requestAnimationFrame(() => {
      try {
        const target = bodyRef.value?.querySelector(`#sec-${section}`)
        if (target instanceof HTMLElement) target.scrollIntoView({ block: 'start', behavior: 'smooth' })
      } catch {
        // 参数不合法时忽略定位，不影响页面本身
      }
    })
  }
})
</script>

<template>
  <div class="about">
    <div class="about__bar">
      <div class="about__bar-title">
        <Icon name="info" :size="16" />
        <span>关于本平台</span>
      </div>
      <div class="about__bar-actions">
        <span v-if="checkedAt" class="about__bar-time selectable">检查于 {{ formatTime(checkedAt) }}</span>
        <button class="wl-btn wl-btn--ghost" type="button" :disabled="healthLoading" @click="loadHealth">
          <Icon name="refresh" :size="15" />
          刷新状态
        </button>
      </div>
    </div>

    <div ref="bodyRef" class="about__body wl-scroll">
      <!-- 这是什么 -->
      <section id="sec-intro" class="wl-card card">
        <header class="card__head">
          <Icon name="info" :size="16" />
          <h2 class="card__title">这是什么</h2>
        </header>
        <p class="card__text">
          {{ auth.siteName }} 是部署在社团自己的飞牛 NAS 上、只对局域网开放的协作平台。
          文件与数据保存在社团自有的硬盘上，不经过任何公网服务，也不出内网。
        </p>
        <dl class="facts">
          <div class="facts__row">
            <dt>站点名称</dt>
            <dd class="selectable">{{ auth.siteName }}</dd>
          </div>
          <div class="facts__row">
            <dt>部署位置</dt>
            <dd>社团飞牛 NAS（局域网内）</dd>
          </div>
          <div class="facts__row">
            <dt>访问范围</dt>
            <dd>仅局域网，数据不出内网</dd>
          </div>
        </dl>
      </section>

      <!-- 当前连接状态 -->
      <section id="sec-status" class="wl-card card">
        <header class="card__head">
          <Icon name="wifi" :size="16" />
          <h2 class="card__title">当前连接状态</h2>
        </header>

        <div class="rows">
          <div class="row">
            <span class="row__label">访问地址</span>
            <span class="row__value mono selectable">{{ origin }}</span>
          </div>

          <div class="row">
            <span class="row__label">安全上下文</span>
            <span class="row__value">
              <span class="wl-badge" :class="isSecure ? 'wl-badge--success' : 'wl-badge--danger'">
                {{ isSecure ? '是' : '否' }}
              </span>
            </span>
          </div>
          <p class="row__note">{{ secureReason }}</p>

          <div class="row">
            <span class="row__label">Service Worker</span>
            <span class="row__value">
              <span class="wl-badge" :class="hasServiceWorker ? 'wl-badge--success' : 'wl-badge--warning'">
                {{ hasServiceWorker ? '支持' : '不支持' }}
              </span>
            </span>
          </div>
          <p v-if="!hasServiceWorker" class="row__note">
            当前浏览器不支持 Service Worker，离线缓存与安装为 PWA 不可用；其余功能不受影响。
          </p>

          <div class="row">
            <span class="row__label">浏览器</span>
            <span class="row__value selectable">{{ browserText }}</span>
          </div>
        </div>

        <div class="status">
          <div v-if="healthLoading && !health" class="status__loading">
            <span class="wl-spinner" />
            <span>正在获取后端状态…</span>
          </div>

          <div v-else-if="healthError" class="status__error">
            <Icon name="alert" :size="15" />
            <div class="status__error-body">
              <p class="status__error-msg selectable">{{ healthError }}</p>
              <button class="wl-btn" type="button" @click="loadHealth">
                <Icon name="refresh" :size="14" />
                重试
              </button>
            </div>
          </div>

          <div v-else-if="health" class="rows">
            <div class="row">
              <span class="row__label">后端服务</span>
              <span class="row__value">
                <span class="wl-badge" :class="health.ok ? 'wl-badge--success' : 'wl-badge--danger'">
                  {{ health.ok ? '运行中' : '异常' }}
                </span>
              </span>
            </div>
            <div class="row">
              <span class="row__label">审计链</span>
              <span class="row__value">
                <span class="wl-badge" :class="health.audit.chainOk ? 'wl-badge--success' : 'wl-badge--danger'">
                  {{ health.audit.chainOk ? '自洽' : '校验未通过' }}
                </span>
              </span>
            </div>
            <div class="row">
              <span class="row__label">审计记录</span>
              <span class="row__value selectable">{{ health.audit.records }} 条</span>
            </div>
          </div>

          <div v-else class="wl-empty">
            <Icon name="cloud" :size="22" />
            <span>暂无状态信息</span>
          </div>
        </div>
      </section>

      <!-- 怎么用 -->
      <section id="sec-usage" class="wl-card card">
        <header class="card__head">
          <Icon name="list" :size="16" />
          <h2 class="card__title">怎么用</h2>
        </header>
        <ol class="steps">
          <li v-for="(step, index) in usageSteps" :key="index" class="steps__item">
            <span class="steps__index">{{ index + 1 }}</span>
            <span class="steps__text selectable">{{ step }}</span>
          </li>
        </ol>
      </section>

      <!-- 这个平台能做什么 -->
      <section id="sec-capabilities" class="wl-card card">
        <header class="card__head">
          <Icon name="grid" :size="16" />
          <h2 class="card__title">这个平台能做什么</h2>
        </header>
        <p class="card__text">
          桌面上和开始菜单里的每个应用都在下面，一句话说清它是干什么的。
          不知道从哪儿下手的时候，先在这儿扫一眼。
        </p>
        <ul class="caps">
          <li v-for="item in capabilities" :key="item.id" class="caps__item">
            <span class="caps__name">{{ item.name }}</span>
            <span class="caps__tip selectable">{{ item.tip }}</span>
            <span v-if="item.fromFiles" class="caps__tag">从文件管理器打开</span>
            <span v-else-if="item.adminOnly" class="caps__tag">仅管理员</span>
          </li>
        </ul>
      </section>

      <!-- 键盘快捷键 -->
      <section id="sec-shortcuts" class="wl-card card">
        <header class="card__head">
          <Icon name="terminal" :size="16" />
          <h2 class="card__title">键盘快捷键</h2>
        </header>
        <ul class="keys">
          <li v-for="item in shortcuts" :key="item.label" class="keys__row">
            <span class="keys__combo">
              <template v-for="(key, index) in item.keys" :key="key">
                <span v-if="index > 0" class="keys__plus">+</span>
                <kbd class="kbd">{{ key }}</kbd>
              </template>
            </span>
            <span class="keys__label selectable">{{ item.label }}</span>
          </li>
        </ul>
      </section>

      <!-- 已知限制 -->
      <section id="sec-limits" class="wl-card card">
        <header class="card__head">
          <Icon name="alert" :size="16" />
          <h2 class="card__title">已知限制</h2>
        </header>
        <p class="card__text">
          下面这些事情本平台目前做不到，写在这里是为了让你少走弯路，而不是回避。
        </p>
        <ul class="limits">
          <li v-for="(limit, index) in limitations" :key="index" class="limits__item">
            <Icon name="alert" :size="14" />
            <span class="selectable">{{ limit }}</span>
          </li>
        </ul>
      </section>

      <!-- 技术栈 -->
      <section id="sec-stack" class="wl-card card">
        <header class="card__head">
          <Icon name="db" :size="16" />
          <h2 class="card__title">技术栈</h2>
        </header>
        <dl class="stack">
          <div v-for="item in stack" :key="item.name" class="stack__row">
            <dt class="stack__name">{{ item.name }}</dt>
            <dd class="stack__detail selectable">{{ item.detail }}</dd>
          </div>
        </dl>
      </section>
    </div>
  </div>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-1);
  color: var(--text);
}

/* ---------------------------------------------------------------- 工具栏 */

.about__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex: 0 0 auto;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.about__bar-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.about__bar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.about__bar-time {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ---------------------------------------------------------------- 内容区 */

.about__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  scroll-behavior: smooth;
}

.card {
  flex: 0 0 auto;
  padding: var(--space-4);
}

.card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  color: var(--text-secondary);
}

.card__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.card__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-secondary);
}

/* ---------------------------------------------------------------- 键值列表 */

.facts,
.stack {
  margin: var(--space-3) 0 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.facts__row {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-2);
}

.facts__row dt {
  flex: 0 0 84px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.facts__row dd {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.rows {
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-subtle);
}

.row:last-child {
  border-bottom: none;
}

.row__label {
  flex: 0 0 auto;
  font-size: 13px;
  color: var(--text-secondary);
}

.row__value {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  color: var(--text);
  text-align: right;
  word-break: break-all;
}

.row__note {
  margin: 0 0 var(--space-2);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-tertiary);
}

.mono {
  font-family: var(--font-mono);
  font-size: 12.5px;
}

/* ---------------------------------------------------------------- 后端状态 */

.status {
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
}

.status__loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.status__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
}

.status__error-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
}

.status__error-msg {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
}

/* ---------------------------------------------------------------- 步骤 */

.steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.steps__item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.steps__index {
  flex: 0 0 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

.steps__text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
  padding-top: 1px;
}

/* ---------------------------------------------------------------- 能力清单 */

.caps {
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.caps__item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-2);
}

.caps__name {
  flex: 0 0 auto;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.caps__tip {
  /* 长句子必须能换行：窄屏下留给它的宽度只有一百多像素 */
  flex: 1 1 200px;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.caps__tag {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  color: var(--text-tertiary);
  background: var(--surface-1);
}

/* ---------------------------------------------------------------- 快捷键 */

.keys {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}

.keys__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-subtle);
}

.keys__row:last-child {
  border-bottom: none;
}

.keys__combo {
  display: flex;
  align-items: center;
  gap: 3px;
}

.keys__plus {
  font-size: 11px;
  color: var(--text-tertiary);
}

.kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  background: var(--surface-solid);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1;
}

.keys__label {
  font-size: 13px;
  color: var(--text-secondary);
  text-align: right;
}

/* ---------------------------------------------------------------- 限制 */

.limits {
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.limits__item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.limits__item :deep(svg) {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--warning);
}

/* ---------------------------------------------------------------- 技术栈 */

.stack {
  margin: 0;
}

.stack__row {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-2);
}

.stack__name {
  flex: 0 0 72px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
}

.stack__detail {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
}
</style>
