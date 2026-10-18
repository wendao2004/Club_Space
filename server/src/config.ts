/**
 * 运行时配置。
 *
 * 设计约束（来自 AI 评审团的结论）：
 *  - NAS 上业务容器只有 2-4GB 预算，所以后端进程要小而可控。
 *  - NAS 无外网，所有依赖必须能离线/内网获取。
 *  - 本机（开发机）没有 Docker，所以默认值必须让后端能直接 `node src/index.ts` 跑起来。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 项目根目录（server/ 的上一级）。 */
const SERVER_DIR = resolve(import.meta.dirname, '..')
export const PROJECT_ROOT = resolve(SERVER_DIR, '..')

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

/** 数据目录：数据库、上传文件、工具产物都放这里，整体不进 git。 */
export const DATA_DIR = process.env.WL_DATA_DIR
  ? resolve(process.env.WL_DATA_DIR)
  : join(PROJECT_ROOT, 'data')

export const DB_PATH = process.env.WL_DB_PATH ?? join(DATA_DIR, 'app.sqlite')
export const STORAGE_DIR = process.env.WL_STORAGE_DIR ?? join(DATA_DIR, 'files')
export const TMP_DIR = process.env.WL_TMP_DIR ?? join(DATA_DIR, 'tmp')

export const PORT = envInt('WL_PORT', 3000)
export const HOST = process.env.WL_HOST ?? '127.0.0.1'

/** 生产环境下前端静态资源目录（web/dist）。 */
export const WEB_DIST = join(PROJECT_ROOT, 'web', 'dist')

export const IS_PROD = process.env.NODE_ENV === 'production'

/**
 * 单文件**硬**上限（字节）。**默认 0 = 不限。**
 *
 * 这个值原来默认 4GiB，用户直接问"上传文件为什么有限制，我不希望有限制"。
 * 它的问题是**该拦的没拦住、不该拦的拦了**：一个 5GB 的活动录像在 878GB 的
 * NAS 上完全放得下却被拒；而"循环上传把盘写满"这件事它根本挡不住 ——
 * 传 4 个大文件就够了。
 *
 * 所以默认关掉它，改由**磁盘余量守卫**（MIN_FREE_BYTES）来保护机器 ——
 * 那个才真的对应"别把盘写满"这个唯一需要保护的东西。
 *
 * 留这个开关是给"我就是想设个上限"的运维用的；设成大于 0 的值才会生效。
 */
export const MAX_UPLOAD_BYTES = envInt('WL_MAX_UPLOAD_BYTES', 0)

/**
 * 上传后必须保留的磁盘余量（字节）。**默认 2GiB。**
 *
 * 这是取代"单文件上限"的那道闸门：上传前算一次
 * 「当前可用空间 − 这次要写的字节 ≥ 本值」，不满足就拒绝。
 *
 * 为什么必须留一截而不是"写满为止"：这台 NAS 上还跑着 SQLite、
 * Docker 日志、以及 fnOS 自己。把盘写满的连带后果是**整机级故障**
 * （数据库写不进去、系统服务起不来），不只是这个平台传不了文件。
 *
 * 设成 0 就完全关掉这道闸门 —— 不建议，除非你确知后果。
 */
export const MIN_FREE_BYTES = envInt('WL_MIN_FREE_BYTES', 2 * 1024 * 1024 * 1024)

/** 会话有效期（天）。 */
export const SESSION_DAYS = envInt('WL_SESSION_DAYS', 30)

/** 站点名称，显示在桌面外壳与引导页上。 */
export const SITE_NAME = process.env.WL_SITE_NAME ?? '社团空间'

/** 工具模块总开关。默认开启，但具体工具是否可用取决于外部服务是否配置。 */
export const TOOLS_ENABLED = envFlag('WL_TOOLS_ENABLED', true)

/**
 * 外部重任务服务地址（可选）。
 *
 * 这些服务（LibreOffice 转换、PDF 处理）体积大、内存重，**不在本机跑**，
 * 部署时由 NAS 侧的容器按需拉起。未配置时对应工具在界面上显示为「未启用」，
 * 而不是静默失败 —— 这是评审团反复强调的一条：宁可显式告知，不能假装可用。
 */
export const CONVERT_SERVICE_URL = process.env.WL_CONVERT_SERVICE_URL ?? ''

/**
 * 会话签名密钥。
 *
 * 生产环境必须由 .env 提供（评审把「密钥进 git」列为 blocker，所以这里
 * 绝不硬编码默认值到生产路径）；开发环境若没提供就在数据目录里生成一个
 * 并持久化，保证重启后已登录的会话不会全部失效。
 */
export function loadSessionSecret(): Buffer {
  const fromEnv = process.env.WL_SESSION_SECRET
  if (fromEnv && fromEnv.length >= 32) return Buffer.from(fromEnv, 'utf8')

  if (IS_PROD) {
    // 生产环境拒绝降级：宁可启动失败，也不要用一个随机生成的临时密钥，
    // 否则每次重启都会把所有人踢下线，而且无人会注意到配置缺失。
    throw new Error(
      '生产环境必须设置 WL_SESSION_SECRET（至少 32 字符）。请通过 .env 提供，不要提交进 git。'
    )
  }

  const keyFile = join(DATA_DIR, '.dev-session-secret')
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'utf8')
  const generated = randomBytes(48).toString('base64url')
  mkdirSync(dirname(keyFile), { recursive: true })
  writeFileSync(keyFile, generated, { mode: 0o600 })
  return Buffer.from(generated, 'utf8')
}

/** 确保所有运行期目录存在。 */
export function ensureDirs(): void {
  for (const dir of [DATA_DIR, STORAGE_DIR, TMP_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

/** 把相对存储键解析成绝对路径，并拒绝逃逸出存储根的路径。 */
export function resolveStoragePath(storageKey: string): string {
  const abs = isAbsolute(storageKey) ? storageKey : join(STORAGE_DIR, storageKey)
  const normalized = resolve(abs)
  if (!normalized.startsWith(resolve(STORAGE_DIR))) {
    throw new Error(`存储路径越界: ${storageKey}`)
  }
  return normalized
}
