/**
 * 文件与目录。
 *
 * 存储模型：内容寻址 + 引用计数（见 db.ts 里 blobs 表的注释）。
 * 上传模型：分片追加 + 服务端记录已收字节数，支持断点续传。
 *
 * 为什么分片是自己实现而不是直接上 tusd：评价团推荐的 Uppy + tus + tusd 是
 * 正确方向，但 tusd 是独立进程/容器，而本项目在 NAS 上的内存预算只有 2-4GB，
 * 能少一个常驻进程就少一个。协议层自己做「offset 连续性校验 + 已收字节记账」，
 * 前端按同样的语义切片即可，将来要换 tusd 也不必改数据模型。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { MIN_FREE_BYTES, STORAGE_DIR, resolveStoragePath } from './config.ts'
import { getDb, newId, now, transaction } from './db.ts'
import { classifyUpload } from './mime.ts'

export type Space = 'shared' | 'private'
export type NodeKind = 'folder' | 'file'

export interface Node {
  id: string
  parent_id: string | null
  owner_id: string
  name: string
  kind: NodeKind
  space: Space
  size: number
  mime: string | null
  sha256: string | null
  storage_key: string | null
  deleted_at: number | null
  created_at: number
  updated_at: number
}

// ---------------------------------------------------------------- 名称与路径

/**
 * 校验并规范化用户输入的节点名。
 *
 * 这里挡掉的是路径穿越与不可见字符：文件名会被拼进存储路径、也会出现在
 * 下载响应头里，是注入的常见入口。
 */
export function normalizeName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new HttpError(400, '名称不能为空')
  if (name.length > 255) throw new HttpError(400, '名称过长（最多 255 字符）')
  if (name === '.' || name === '..') throw new HttpError(400, '非法名称')
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, '名称不能包含斜杠或控制字符')
  return name
}

/**
 * 带 HTTP 状态码的业务错误。
 *
 * 刻意不用 TypeScript 的「参数属性」语法（`constructor(readonly status: number)`）：
 * 本项目靠 Node 24 的原生类型剥离直接运行 .ts，而剥离模式不支持参数属性、
 * enum、namespace 这类需要生成代码的语法。
 */
export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** 内容寻址的落盘路径：blobs/<前两位>/<完整 sha256>。 */
function blobPath(sha256: string): string {
  const dir = join(STORAGE_DIR, 'blobs', sha256.slice(0, 2))
  return join(dir, sha256)
}

async function ensureBlobDir(sha256: string): Promise<void> {
  await mkdir(join(STORAGE_DIR, 'blobs', sha256.slice(0, 2)), { recursive: true })
}

// ---------------------------------------------------------------- blobs

function blobRefs(sha256: string): number {
  const row = getDb().prepare('SELECT refs FROM blobs WHERE sha256 = ?').get(sha256) as
    | { refs: number }
    | undefined
  return row?.refs ?? -1
}

/** 让 blob 的引用计数 +1，不存在则登记。 */
function retainBlob(sha256: string, size: number): void {
  getDb()
    .prepare(
      `INSERT INTO blobs (sha256, size, refs, created_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(sha256) DO UPDATE SET refs = refs + 1`,
    )
    .run(sha256, size, now())
}

/**
 * 引用计数 -1；归零时真正删盘。
 *
 * 归零才删是关键：同一份内容可能被多个节点引用（秒传产生），
 * 删掉一个节点不能把别人的文件一起删了。
 */
export async function releaseBlob(sha256: string): Promise<void> {
  const remaining = transaction(() => {
    const refs = blobRefs(sha256)
    if (refs <= 0) return 0
    const next = refs - 1
    if (next === 0) getDb().prepare('DELETE FROM blobs WHERE sha256 = ?').run(sha256)
    else getDb().prepare('UPDATE blobs SET refs = ? WHERE sha256 = ?').run(next, sha256)
    return next
  })
  if (remaining === 0) {
    try {
      await rm(blobPath(sha256), { force: true })
    } catch {
      // 文件可能本就不存在（比如秒传登记的 blob 但盘上是空），忽略。
    }
  }
}

// ---------------------------------------------------------------- 节点查询

export function getNode(id: string): Node | null {
  const row = getDb().prepare('SELECT * FROM nodes WHERE id = ? AND deleted_at IS NULL').get(id) as
    | Node
    | undefined
  return row ?? null
}

/**
 * 该用户能否读取这个节点。
 *
 * 共享空间人人可读，私有空间仅所有者 —— **外加管理员**。
 *
 * 这里必须让管理员也能读私有空间，否则会出现"能删不能看"的荒谬组合：
 * canWrite 早就给了管理员全权（见下），于是管理员对别人的私人文件
 * 保不住隐私、却又能删掉一个自己根本列不出来、下不来的东西。要么两头都不给，
 * 要么两头都给。社团平台的立场是"管理员对全站内容负责"，所以选择后者，
 * 并对管理员访问他人私有文件记审计（记录在下载/预览路由里）。
 *
 * 传入的 isAdmin 默认为 false：调用方不显式声明就不放行，避免某个新入口
 * 忘了判断就默认给管理员开后门。
 */
export function canRead(node: Node, userId: string, isAdmin = false): boolean {
  return node.space === 'shared' || node.owner_id === userId || isAdmin
}

/** 该用户能否修改/删除这个节点。 */
export function canWrite(node: Node, userId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true
  return node.owner_id === userId
}

export interface ListEntry {
  id: string
  parent_id: string | null
  owner_id: string
  owner_name: string
  name: string
  kind: NodeKind
  space: Space
  size: number
  mime: string | null
  sha256: string | null
  created_at: number
  updated_at: number
}

/**
 * 列出某个目录下的子节点。
 *
 * 隐私规则在 SQL 里就收敛掉，不在应用层过滤 —— 少一次"忘了加条件"的机会。
 */
export function listChildren(
  parentId: string | null,
  userId: string,
  opts: { space: Space; isAdmin?: boolean } = { space: 'shared' },
): ListEntry[] {
  const db = getDb()
  // 管理员能看全部；普通用户只能看共享空间的 + 自己的。条件在 SQL 里收敛。
  const visibility = opts.isAdmin ? '1 = 1' : "(n.space = 'shared' OR n.owner_id = ?)"
  const visibilityParams: string[] = opts.isAdmin ? [] : [userId]
  const rows = db
    .prepare(
      `SELECT n.id, n.parent_id, n.owner_id, u.display_name AS owner_name, n.name, n.kind,
              n.space, n.size, n.mime, n.sha256, n.created_at, n.updated_at
         FROM nodes n JOIN users u ON u.id = n.owner_id
        WHERE n.deleted_at IS NULL
          AND n.parent_id IS ${parentId === null ? 'NULL' : '?'}
          AND n.space = ?
          AND ${visibility}
        ORDER BY n.kind = 'folder' DESC, n.name COLLATE NOCASE ASC`,
    )
    .all(
      ...(parentId === null
        ? [opts.space, ...visibilityParams]
        : [parentId, opts.space, ...visibilityParams]),
    ) as unknown as ListEntry[]
  return rows
}

/** 面包屑：从根到该节点的路径。 */
export function breadcrumb(nodeId: string | null): Array<{ id: string; name: string }> {
  const trail: Array<{ id: string; name: string }> = []
  let cursor = nodeId
  let guard = 0
  while (cursor && guard++ < 64) {
    const node = getNode(cursor)
    if (!node) break
    trail.unshift({ id: node.id, name: node.name })
    cursor = node.parent_id
  }
  return trail
}

/** 在同一目录下找一个未删除的同名节点。 */
function findSibling(parentId: string | null, name: string, space: Space): Node | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM nodes
        WHERE deleted_at IS NULL AND name = ? AND space = ?
          AND parent_id IS ${parentId === null ? 'NULL' : '?'}`,
    )
    .get(...(parentId === null ? [name, space] : [parentId, name, space])) as Node | undefined
  return row ?? null
}

/**
 * 该用户在该空间里是否已经有一份同内容（sha256 相同）且可见的节点。
 *
 * 这是秒传的门槛条件，用来杜绝"用哈希探测他人文件是否存在"的信息泄漏。
 */
function findVisibleByHash(sha256: string, userId: string, space: Space): Node | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM nodes
        WHERE deleted_at IS NULL AND sha256 = ? AND space = ?
          AND (space = 'shared' OR owner_id = ?)
        LIMIT 1`,
    )
    .get(sha256, space, userId) as Node | undefined
  return row ?? null
}

// ---------------------------------------------------------------- 目录与节点操作

export function createFolder(input: {
  parentId: string | null
  name: string
  ownerId: string
  space: Space
}): Node {
  const name = normalizeName(input.name)
  if (input.parentId) {
    const parent = getNode(input.parentId)
    if (!parent) throw new HttpError(404, '父目录不存在')
    if (parent.kind !== 'folder') throw new HttpError(400, '父节点不是目录')
  }
  if (findSibling(input.parentId, name, input.space)) {
    throw new HttpError(409, `「${name}」已存在`)
  }

  const id = newId('n')
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO nodes (id, parent_id, owner_id, name, kind, space, size, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'folder', ?, 0, ?, ?)`,
    )
    .run(id, input.parentId, input.ownerId, name, input.space, ts, ts)
  return getNode(id)!
}

export function renameNode(id: string, rawName: string): Node {
  const node = getNode(id)
  if (!node) throw new HttpError(404, '节点不存在')
  const name = normalizeName(rawName)
  if (name === node.name) return node
  if (findSibling(node.parent_id, name, node.space)) {
    throw new HttpError(409, `「${name}」已存在`)
  }
  getDb().prepare('UPDATE nodes SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id)
  return getNode(id)!
}

export function moveNode(id: string, newParentId: string | null): Node {
  const node = getNode(id)
  if (!node) throw new HttpError(404, '节点不存在')
  if (newParentId === id) throw new HttpError(400, '不能移动到自身')

  if (newParentId) {
    const parent = getNode(newParentId)
    if (!parent) throw new HttpError(404, '目标目录不存在')
    if (parent.kind !== 'folder') throw new HttpError(400, '目标不是目录')
    if (parent.space !== node.space) throw new HttpError(400, '不能跨空间移动')
    // 防止把目录移进自己的子孙里，形成环
    let cursor: string | null = parent.id
    let guard = 0
    while (cursor && guard++ < 256) {
      if (cursor === id) throw new HttpError(400, '不能移动到自己的子目录里')
      cursor = getNode(cursor)?.parent_id ?? null
    }
  }

  if (findSibling(newParentId, node.name, node.space)) {
    throw new HttpError(409, '目标目录下已有同名项')
  }
  getDb()
    .prepare('UPDATE nodes SET parent_id = ?, updated_at = ? WHERE id = ?')
    .run(newParentId, now(), id)
  return getNode(id)!
}

/**
 * 删除节点（软删除），目录会递归。
 *
 * 递归释放 blob 引用，让去重空间能真正回收。
 */
export async function deleteNode(id: string): Promise<void> {
  const collect = (rootId: string): Node[] => {
    const out: Node[] = []
    const stack = [rootId]
    while (stack.length) {
      const current = stack.pop()!
      const node = getNode(current)
      if (!node) continue
      out.push(node)
      if (node.kind === 'folder') {
        const children = getDb()
          .prepare('SELECT id FROM nodes WHERE parent_id = ? AND deleted_at IS NULL')
          .all(current) as Array<{ id: string }>
        for (const c of children) stack.push(c.id)
      }
    }
    return out
  }

  const nodes = collect(id)
  if (nodes.length === 0) throw new HttpError(404, '节点不存在')

  const ts = now()
  transaction(() => {
    const stmt = getDb().prepare('UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE id = ?')
    for (const node of nodes) stmt.run(ts, ts, node.id)
  })

  for (const node of nodes) {
    if (node.kind === 'file' && node.sha256) await releaseBlob(node.sha256)
  }
}

// ---------------------------------------------------------------- 分片上传

export interface UploadSession {
  id: string
  user_id: string
  parent_id: string | null
  name: string
  declared_size: number
  declared_sha256: string | null
  tmp_path: string
  received: number
  status: string
  error: string | null
  /** v10 起：这次上传选定的空间。complete 以它为准，不再信调用方传进来的值。 */
  space: Space
  created_at: number
  updated_at: number
}

export function getUpload(id: string): UploadSession | null {
  const row = getDb().prepare('SELECT * FROM uploads WHERE id = ?').get(id) as
    | UploadSession
    | undefined
  return row ?? null
}

export interface InitUploadResult {
  uploadId: string
  /** 已收到的字节数。续传时客户端从这个偏移继续发。 */
  offset: number
  /** 命中秒传时为 true，此时不需要再传任何字节，nodeId 已经就绪。 */
  instant: boolean
  nodeId: string | null
}

/**
 * 开启（或复用）一次上传。
 *
 * 若调用方提供了 sha256 且该内容已在库里，直接建节点完成上传 —— 这就是秒传。
 * 社团里同一个安装包/影片被多人反复上传是常态，这一步省下的是真实带宽与等待。
 */
/** 把字节数说成人话（GB/MB）。只用于错误提示。 */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * 磁盘余量守卫：确认这次上传写完之后，盘上还能剩下足够空间。
 *
 * ============================================================================
 * 为什么是"检查余量"而不是"限制单文件大小"
 * ============================================================================
 *
 * 这里原来是一道写死的单文件上限（默认 4GiB）。它的问题是
 * **该拦的没拦住、不该拦的拦了**：
 *
 *   - 一个 5GB 的活动录像，在这台 878GB 可用空间的 NAS 上完全放得下，
 *     却被拒了。用户的原话是"上传文件为什么有限制，我不希望有限制"。
 *   - 而"循环发起上传把盘写满"这件事，4GiB 的上限**根本挡不住** ——
 *     传 4 个大文件就够了。
 *
 * 真正需要保护的只有一件事：**别把这台机器的盘写满**。
 * 写满的连带后果是整机级的（SQLite 写不进去、Docker 起不来、fnOS 自身出问题），
 * 远不止"这个平台传不了文件"。
 *
 * 所以改成按**实际剩余空间**判断：这次要写 size 字节，写完之后至少还要剩
 * MIN_FREE_BYTES。既没有"文件不能超过 X"这种拍脑袋的数字，机器也保住了。
 */
export async function assertDiskSpace(neededBytes: number): Promise<void> {
  // 显式设成 0 = 关掉这道闸门。不建议，但得给人留开关。
  if (MIN_FREE_BYTES <= 0) return

  let free: number
  try {
    const info = await statfs(STORAGE_DIR)
    // bavail 是"非特权用户还能用的块数"，容器进程就是非特权用户，
    // 用 bfree（含 root 保留块）会高估可用空间。
    const unit = Number(info.bsize) || Number(info.frsize) || 4096
    free = Number(info.bavail) * unit
  } catch {
    // 拿不到磁盘信息**就不拦**：宁可放行，也不要因为一个统计调用失败
    // 就把整个上传功能禁掉。真的写不下时，写盘那一步会自己报错。
    return
  }

  if (free - neededBytes < MIN_FREE_BYTES) {
    throw new HttpError(
      507,
      `磁盘空间不够：这次要写 ${humanBytes(neededBytes)}，而可用空间只剩 ${humanBytes(free)}。` +
        `为保证这台机器不被写满（数据库、日志、系统服务都在这块盘上），至少要留出 ${humanBytes(MIN_FREE_BYTES)}。` +
        `可以先清理一些旧文件，或者把文件传到别的空间。`,
    )
  }
}

export async function initUpload(input: {
  userId: string
  parentId: string | null
  name: string
  size: number
  sha256?: string | null
  space: Space
}): Promise<InitUploadResult> {
  const name = normalizeName(input.name)
  if (!Number.isFinite(input.size) || input.size < 0) throw new HttpError(400, '文件大小非法')

  if (input.parentId) {
    const parent = getNode(input.parentId)
    if (!parent) throw new HttpError(404, '目标目录不存在')
    if (parent.kind !== 'folder') throw new HttpError(400, '目标不是目录')
    // 空间是树：目录属于哪个空间，文件就传进哪个空间。
    // （这个不变量以前没人守着，正是"私人目录里冒出共享文件"的另一半原因。）
    if (parent.space !== input.space) throw new HttpError(400, '目标目录不在这个空间里')
  }

  const existing = findSibling(input.parentId, name, input.space)
  if (existing) throw new HttpError(409, `「${name}」已存在`)

  // 秒传：客户端给了 sha256，且**该用户在该空间里已经能看到**这份内容。
  //
  // 这里刻意不用"blobs 表里有这个哈希就秒传"。那样做会形成一个信息泄漏：
  // 攻击者拿到一份文件的哈希（比如某个大家都知道但只在某人个人空间里的文件），
  // 提交一次上传、观察是否返回 instant，就能探测出"这个文件存在".
  // 所以秒传必须限定在"用户本来就能看到同名内容"的范围内 —— 此时他本来就知道
  // 这份文件存在，告诉他"已秒传"不泄漏任何新信息。
  //
  // 别人的个人空间里的内容仍然会被去重（存储层照旧复用 blob），
  // 但走的是正常上传路径：用户必须真的把字节传上来，才能证明他确实拥有这份内容。
  if (input.sha256) {
    const known = getDb()
      .prepare('SELECT size FROM blobs WHERE sha256 = ?')
      .get(input.sha256) as { size: number } | undefined
    const visible = findVisibleByHash(input.sha256, input.userId, input.space)
    if (known && known.size === input.size && visible) {
      // ⚠️ 必须先 retainBlob 再建节点。
      //
      // 这段曾经漏掉了引用计数，后果是数据丢失：秒传产生的每个节点都指向同一个
      // blob，但不贡献引用计数，于是删掉其中任何一个节点时 refs 就归零，
      // blob 被真正删盘 —— 而另一个节点还在引用它。表现是"删掉一个副本，
      // 另一份文件也打不开了"。
      //
      // 规则很简单：**每个指向 blob 的节点都必须恰好贡献一次引用计数**。
      // 放在同一个事务里，避免中途失败留下不一致。
      return transaction(() => {
        retainBlob(input.sha256!, input.size)
        const node = createFileNode({
          parentId: input.parentId,
          ownerId: input.userId,
          space: input.space,
          name,
          size: input.size,
          sha256: input.sha256!,
          // 类型从"用户本来就能看到"的那份同内容节点上继承，而不是写 null：
          // 内容相同 → 按内容判定的类型必然相同（类型只由字节决定，见 mime.ts），
          // 写 null 只会让秒传出来的文件凭空丢掉图标/预览能力。
          mime: visible.mime,
        })
        return { uploadId: '', offset: input.size, instant: true, nodeId: node.id }
      })
    }
  }

  // 复用同一用户对同一目标的未完成上传（刷新页面后续传）。
  // 空间也必须一致 —— 同名同大小但换了空间，那是另一次上传。
  const pending = getDb()
    .prepare(
      `SELECT * FROM uploads
        WHERE user_id = ? AND status = 'open' AND name = ?
          AND parent_id IS ${input.parentId === null ? 'NULL' : '?'}
          AND declared_size = ?
          AND space = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(
      ...(input.parentId === null
        ? [input.userId, name, input.size, input.space]
        : [input.userId, name, input.parentId, input.size, input.space]),
    ) as UploadSession | undefined

  // ⚠️ 磁盘余量守卫放在这里，而不是在第 837 行的路由里。
  //
  // 放这里有两个理由：
  //   1. 秒传在上面已经返回了 —— 那种情况**根本不写盘**，不该被空间检查拦住。
  //   2. 续传（下面那个 pending 分支）也会继续写盘，所以检查必须在它之前。
  // 按整个 size 检查（而不是"剩余待传字节"）是保守的：续传时会多要一点余量，
  // 但那点误差无关紧要，而算错了会真的写满盘。
  await assertDiskSpace(input.size)

  if (pending) {
    const onDisk = await fileSize(pending.tmp_path)
    return { uploadId: pending.id, offset: Math.min(onDisk, pending.received), instant: false, nodeId: null }
  }

  const id = newId('up')
  const tmpPath = join(STORAGE_DIR, 'tmp', `${id}.part`)
  await mkdir(join(STORAGE_DIR, 'tmp'), { recursive: true })
  await createWriteStream(tmpPath, { flags: 'w' }).close()

  getDb()
    .prepare(
      `INSERT INTO uploads (id, user_id, parent_id, name, declared_size, declared_sha256, tmp_path,
                            received, status, space, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.parentId,
      name,
      input.size,
      input.sha256 ?? null,
      tmpPath,
      input.space,
      now(),
      now(),
    )

  return { uploadId: id, offset: 0, instant: false, nodeId: null }
}

async function fileSize(path: string): Promise<number> {
  try {
    const s = await stat(path)
    return s.size
  } catch {
    return 0
  }
}

/**
 * 追加一片。
 *
 * 强制 offset 必须等于服务端已记录的 received：分片乱序或重复提交都拒绝，
 * 让「已收字节数」始终等于盘上内容的真实长度，续传才是可信的。
 */
export async function appendChunk(
  uploadId: string,
  userId: string,
  offset: number,
  chunk: Buffer,
): Promise<{ received: number }> {
  const upload = getUpload(uploadId)
  if (!upload) throw new HttpError(404, '上传会话不存在')
  if (upload.user_id !== userId) throw new HttpError(403, '无权操作该上传')
  if (upload.status !== 'open') throw new HttpError(409, `上传已 ${upload.status}`)
  if (offset !== upload.received) {
    throw new HttpError(409, `分片偏移不匹配：期望 ${upload.received}，收到 ${offset}`)
  }
  if (upload.received + chunk.length > upload.declared_size) {
    throw new HttpError(400, '写入超出声明的文件大小')
  }

  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(upload.tmp_path, { flags: 'a' })
    stream.on('error', reject)
    stream.on('finish', () => resolve())
    stream.end(chunk)
  })

  const received = upload.received + chunk.length
  getDb()
    .prepare('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?')
    .run(received, now(), uploadId)

  return { received }
}

function createFileNode(input: {
  parentId: string | null
  ownerId: string
  space: Space
  name: string
  size: number
  sha256: string
  mime: string | null
}): Node {
  if (input.parentId) {
    const parent = getNode(input.parentId)
    if (!parent) throw new HttpError(404, '目标目录不存在')
  }
  if (findSibling(input.parentId, input.name, input.space)) {
    throw new HttpError(409, `「${input.name}」已存在`)
  }

  const id = newId('n')
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO nodes (id, parent_id, owner_id, name, kind, space, size, mime, sha256,
                          storage_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.parentId,
      input.ownerId,
      input.name,
      input.space,
      input.size,
      input.mime,
      input.sha256,
      input.sha256, // storage_key 就是 sha256，解析时拼到 blobs 下
      ts,
      ts,
    )
  return getNode(id)!
}

export interface CompleteUploadResult {
  nodeId: string
  mime: string
}

/**
 * 结束上传：校验大小与校验和、按内容识别类型、把临时文件搬进内容寻址存储、建节点。
 *
 * 类型识别在这里做（读文件头），而不是在分片过程中 —— 分片阶段文件还不完整，
 * 读不到可靠的文件头。
 *
 * ⚠️ 识别**不拒绝任何文件**（2026-10-18 起：用户要求"能上传任何格式的文件"，
 * 策略与理由见 mime.ts 的头注释）。它只决定节点上的 mime，而 mime 决定
 * 下载/预览响应里的 Content-Type —— 按内容判定，不采信文件名。
 * 大小与校验和**仍然**校验：那是完整性检查，不是格式限制。
 */
export async function completeUpload(
  uploadId: string,
  userId: string,
): Promise<CompleteUploadResult> {
  const upload = getUpload(uploadId)
  if (!upload) throw new HttpError(404, '上传会话不存在')
  if (upload.user_id !== userId) throw new HttpError(403, '无权操作该上传')
  if (upload.status !== 'open') throw new HttpError(409, `上传已 ${upload.status}`)

  // ⚠️ 空间以**上传会话**为准（v10 起会话自己记着 space），绝不从调用方/query 取。
  // 曾经这里信调用方传进来的 space，而前端完成上传时不带 ?space= —— 于是
  // 往个人空间传的文件被建成共享空间节点：传进私人子目录的，两个空间里都列不出来。
  const space: Space = upload.space

  const actualSize = await fileSize(upload.tmp_path)
  if (actualSize !== upload.declared_size) {
    // 大小不符时要把临时文件清掉。之前这里只是抛错，
    // 留下的 .part 文件再也没人管 —— 而"声明 4GB 然后乱传分片"正是一条
    // 不需要任何漏洞就能写满 NAS 磁盘的路径。
    await discardUpload(uploadId)
    throw new HttpError(
      400,
      `文件大小不符：声明 ${upload.declared_size} 字节，实际收到 ${actualSize} 字节`,
    )
  }

  // 读前 4KB 判类型。认不出来也会给 octet-stream —— 任何格式都能传。
  const head = await readHead(upload.tmp_path, 4096)
  const mime = classifyUpload(head)

  const sha256 = await hashFile(upload.tmp_path)
  if (upload.declared_sha256 && upload.declared_sha256 !== sha256) {
    await discardUpload(uploadId)
    throw new HttpError(400, '文件校验和不符，传输过程中可能被损坏，请重传')
  }

  await ensureBlobDir(sha256)
  const target = blobPath(sha256)
  const alreadyThere = (await fileSize(target)) === actualSize

  if (alreadyThere) {
    // 并发或重复上传了同一份内容，直接丢掉临时文件复用已有 blob
    await rm(upload.tmp_path, { force: true })
  } else {
    await rename(upload.tmp_path, target)
  }

  // ⚠️ retainBlob 与 createFileNode 必须在同一个事务里。
  //
  // 否则会出现这种泄漏：init 时通过了同名检查，但 complete 之前别处
  // （另一个上传完成 / 新建目录 / 工具产物）创建了同名节点，于是
  // retainBlob 先把 refs +1，紧接着 createFileNode 抛 409 ——
  // 结果是 refs=1 而没有任何节点引用它，这份内容**永远不会被释放**，
  // blob 文件永久滞留在磁盘上。
  const node = transaction(() => {
    retainBlob(sha256, actualSize)
    return createFileNode({
      parentId: upload.parent_id,
      ownerId: userId,
      space,
      name: upload.name,
      size: actualSize,
      sha256,
      mime,
    })
  })

  getDb()
    .prepare("UPDATE uploads SET status = 'completed', updated_at = ? WHERE id = ?")
    .run(now(), uploadId)

  return { nodeId: node.id, mime }
}

/** 放弃一次上传，删掉临时文件。 */
export async function discardUpload(uploadId: string): Promise<void> {
  const upload = getUpload(uploadId)
  if (!upload) return
  await rm(upload.tmp_path, { force: true })
  getDb()
    .prepare("UPDATE uploads SET status = 'aborted', updated_at = ? WHERE id = ?")
    .run(now(), uploadId)
}

async function readHead(path: string, length: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let total = 0
  const stream = createReadStream(path, { start: 0, end: length - 1 })
  await pipeline(
    stream,
    async function* (source) {
      for await (const piece of source) {
        chunks.push(piece as Buffer)
        total += (piece as Buffer).length
      }
    },
  )
  return new Uint8Array(Buffer.concat(chunks, total))
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  await pipeline(stream, async function* (source) {
    for await (const piece of source) hash.update(piece as Buffer)
  })
  return hash.digest('hex')
}

/** 打开节点的文件流供下载。 */
export function openNodeStream(node: Node) {
  if (node.kind !== 'file' || !node.storage_key) throw new HttpError(400, '该节点不是文件')
  return createReadStream(resolveStoragePath(join('blobs', node.storage_key.slice(0, 2), node.storage_key)))
}

/**
 * 把一段内存里的字节落成 blob 并建节点。
 *
 * 供工具（PDF 合并、图片转换、二维码…）产出结果使用。与上传走同一套内容寻址
 * 存储，所以工具产物同样能享受去重，也能被下载/分享/再次作为工具输入。
 */
export async function saveBufferAsNode(input: {
  buffer: Uint8Array
  name: string
  parentId: string | null
  ownerId: string
  space: Space
  mime: string
}): Promise<Node> {
  const name = normalizeName(input.name)
  // 同名时自动加序号，避免"转换结果和源文件同名"这种最常见的冲突
  let finalName = name
  let counter = 1
  while (findSibling(input.parentId, finalName, input.space)) {
    const dot = name.lastIndexOf('.')
    finalName =
      dot > 0
        ? `${name.slice(0, dot)} (${counter})${name.slice(dot)}`
        : `${name} (${counter})`
    counter++
    if (counter > 999) throw new HttpError(409, '同名文件过多')
  }

  const sha256 = createHash('sha256').update(input.buffer).digest('hex')
  const size = input.buffer.byteLength

  await ensureBlobDir(sha256)
  const target = blobPath(sha256)
  if ((await fileSize(target)) !== size) {
    await writeFileAtomic(target, input.buffer)
  }

  // 同样：引用计数与建节点放一个事务（见 completeUpload 的说明）。
  // 这里靠自动改名把重名概率降得很低，但"概率低"和"不会发生"是两回事。
  return transaction(() => {
    retainBlob(sha256, size)
    return createFileNode({
      parentId: input.parentId,
      ownerId: input.ownerId,
      space: input.space,
      name: finalName,
      size,
      sha256,
      mime: input.mime,
    })
  })
}

/** 先写临时文件再 rename，保证不会留下写了一半的 blob。 */
async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

/**
 * 在线编辑器能产出、也允许回写的类型。
 *
 * ⚠️ 这份名单必须与 `web/src/lib/file-kinds.ts` 里的 `editableKind()` 对齐：
 * 前端那一侧决定"哪些文件给「编辑」入口"，这一侧决定"哪些文件允许被改写"。
 * 两边不一致的表现是：界面上点了编辑、改完保存，服务端回 415。
 *
 * 为什么要有白名单而不是"任何文件都能被覆盖写"：
 * 在线编辑的产物只有这三类（表格 / 文档 / 纯文本）。把它收窄到这三类，
 * "编辑"这个动作就不会变成一条绕过上传流程的任意写通道 —— 例如把一份
 * 已归档的 PDF 或视频悄悄换成别的内容，而审计里只留下一句"编辑了文件"。
 */
export function isEditableMime(mime: string | null | undefined): boolean {
  const m = mime ?? ''
  return (
    m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    m.startsWith('text/')
  )
}

export interface ReplaceContentResult {
  node: Node
  /** 新内容与旧内容完全一样时为 true：此时没有写新 blob，节点也没动。 */
  unchanged: boolean
}

/**
 * 用一段新内容**替换**节点的内容（在线编辑保存走这里）。
 *
 * 与"上传"的区别：上传是新建节点，这里是**原地改写**同一个节点 ——
 * 文件还是那个文件（id、名字、位置、权限都不变），只是内容换了。
 * 这对使用者是对的：编辑完一个共享表格，不应该在目录里多出一个同名副本。
 *
 * 存储层仍然走内容寻址：新内容按 sha256 落成新 blob、引用计数 +1，
 * 旧内容的引用计数 -1（归零才真删盘）。所以：
 *   - 改回原来的内容时不会留下垃圾（sha256 命中已有 blob）；
 *   - 别处引用着同一份内容的节点**不会**因为这次编辑而失效。
 *
 * ⚠️ 释放旧 blob 必须在事务**之外**做。releaseBlob 归零时会真的删盘，
 * 而删盘不在事务里 —— 事务回滚也撤不回一个已经删掉的文件。
 */
export async function replaceNodeContent(
  node: Node,
  buffer: Uint8Array,
): Promise<ReplaceContentResult> {
  if (node.kind !== 'file') throw new HttpError(400, '只能改写文件的内容')

  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const size = buffer.byteLength
  if (node.sha256 === sha256) return { node, unchanged: true }

  // 类型仍然**按内容**判定（见 mime.ts 的策略说明）。
  //
  // 但这里有一个刻意的例外：认不出来时**保留节点原来的类型**，而不是改成
  // octet-stream。原因是 OOXML 靠"前 4KB 里有没有 xl/ / word/ 这些条目名"来认，
  // 打包器的条目顺序一变就可能认成 application/zip —— 那会让一个好端端的
  // .xlsx 在界面上突然"变成压缩包"，从此点不出编辑入口。
  // 内容确实是别的东西（例如文本）时，采用新判定的类型才是安全的那一侧。
  const sniffed = classifyUpload(buffer.subarray(0, 4096))
  const mime = isEditableMime(sniffed) ? sniffed : (node.mime ?? sniffed)

  const oldSha = node.sha256
  await ensureBlobDir(sha256)
  const target = blobPath(sha256)
  if ((await fileSize(target)) !== size) {
    await writeFileAtomic(target, buffer)
  }

  const updated = transaction(() => {
    retainBlob(sha256, size)
    getDb()
      .prepare(
        `UPDATE nodes SET sha256 = ?, storage_key = ?, size = ?, mime = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(sha256, sha256, size, mime, now(), node.id)
    return getNode(node.id)!
  })

  if (oldSha) await releaseBlob(oldSha)
  return { node: updated, unchanged: false }
}

/** 读取节点的完整内容到内存。仅用于中小文件。 */
export async function readNodeBuffer(node: Node): Promise<Buffer> {
  if (node.kind !== 'file' || !node.storage_key) throw new HttpError(400, '该节点不是文件')
  const path = resolveStoragePath(join('blobs', node.storage_key.slice(0, 2), node.storage_key))
  return readFile(path)
}

/** 磁盘使用统计（管理员面板用）。 */
export function storageStats(): { blobs: number; bytes: number; nodes: number } {
  const blob = getDb()
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM blobs')
    .get() as { n: number; b: number }
  const node = getDb()
    .prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'file' AND deleted_at IS NULL")
    .get() as { n: number }
  return { blobs: blob.n, bytes: blob.b, nodes: node.n }
}

/**
 * 一致性自检：引用计数与实际引用是否对得上。
 *
 * 两种不一致都要能查出来，缺一不可：
 *
 *   ① **blobs 行还在，但 refs 与实际引用它的未删节点数不符** ——
 *      这是"少记引用计数"的早期状态，再往前走一步就会变成下面那种。
 *   ② **未删节点引用的 sha256 在 blobs 里根本没有对应行** ——
 *      这是数据已经丢了的终态（blob 被误删、磁盘文件也没了），节点还在但打不开。
 *
 * 最初的实现只查了 ①（而且是从 blobs 出发的 SQL），于是恰恰漏掉了
 * 这个自检最该抓的那件事 —— ②。等于装了个烟雾报警器但没接电源。
 */
export function auditBlobRefCounts(): { discrepancies: number; samples: string[] } {
  const byDrift = getDb()
    .prepare(
      `SELECT b.sha256, b.refs,
              (SELECT COUNT(*) FROM nodes n
                WHERE n.sha256 = b.sha256 AND n.deleted_at IS NULL) AS live_nodes
         FROM blobs b
        WHERE b.refs != (SELECT COUNT(*) FROM nodes n
                          WHERE n.sha256 = b.sha256 AND n.deleted_at IS NULL)
        LIMIT 20`,
    )
    .all() as unknown as Array<{ sha256: string; refs: number; live_nodes: number }>

  const byDangling = getDb()
    .prepare(
      `SELECT DISTINCT n.sha256
         FROM nodes n
        WHERE n.kind = 'file' AND n.deleted_at IS NULL AND n.sha256 IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = n.sha256)
        LIMIT 20`,
    )
    .all() as unknown as Array<{ sha256: string }>

  return {
    discrepancies: byDrift.length + byDangling.length,
    samples: [
      ...byDrift.map((r) => `引用计数不符 ${r.sha256.slice(0, 12)}… 记 ${r.refs} 实际 ${r.live_nodes}`),
      ...byDangling.map((r) => `节点悬空 ${r.sha256.slice(0, 12)}… 内容已丢失`),
    ],
  }
}

/**
 * 回收超时未完成的上传会话，删掉它们的临时文件。
 *
 * 为什么必须有：每次发起上传都会建一个 .part 文件，而客户端可能再也不回来
 * （关掉页面、断网、或者故意恶心你 —— "声明 4GB、只传 1MB、然后换一个名字重来"）。
 * 没有回收的话，tmp 目录只增不减，最后把 NAS 上跟存储共用的盘写满，
 * 连带数据库写入失败、整个平台瘫痪。
 *
 * 默认 6 小时：够慢网络下的续传用，又能保证垃圾不会累积。
 */
export async function cleanupStaleUploads(maxAgeMs = 6 * 60 * 60 * 1000): Promise<number> {
  const cutoff = now() - maxAgeMs
  const stale = getDb()
    .prepare("SELECT id, tmp_path FROM uploads WHERE status = 'open' AND updated_at < ?")
    .all(cutoff) as unknown as Array<{ id: string; tmp_path: string }>

  for (const row of stale) {
    await discardUpload(row.id)
  }

  // 兜底：磁盘上可能有会话记录已经没了的孤儿 .part（例如数据库被回滚过）
  try {
    const { readdir, stat } = await import('node:fs/promises')
    const known = new Set(
      (getDb().prepare("SELECT tmp_path FROM uploads WHERE status = 'open'").all() as unknown as Array<{
        tmp_path: string
      }>).map((r) => r.tmp_path),
    )
    const tmpDir = join(STORAGE_DIR, 'tmp')
    for (const name of await readdir(tmpDir)) {
      const full = join(tmpDir, name)
      if (known.has(full)) continue
      const info = await stat(full).catch(() => null)
      if (info && info.isFile() && now() - info.mtimeMs > maxAgeMs) {
        await rm(full, { force: true })
      }
    }
  } catch {
    // 目录不存在或读不动都无所谓，这不是关键路径
  }

  return stale.length
}
