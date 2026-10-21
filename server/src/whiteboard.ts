/**
 * Excalidraw 白板（轻量协作）。
 *
 * 官方 @excalidraw/excalidraw（MIT）画在客户端，这里只管场景 JSON 的
 * 存取与协作通知。轻量协作 = **最后写入胜**：A 保存后 B 的本地改动在
 * 下次保存时覆盖 A。不做 OT/CRDT —— 白板场景是"讨论时的草图"，两人
 * 同时改一块区域本来就是罕见路径，为它引入 CRDT 的复杂度不值。
 */
import { getDb, newId, now } from './db.ts'
import { HttpError } from './files.ts'

const MAX_NAME = 60
/** 场景 JSON 上限。2MB 的场景 ≈ 上万个元素，真画到那个量级该拆白板了。 */
const MAX_DATA = 2 * 1024 * 1024

export interface WhiteboardMeta {
  id: string
  name: string
  ownerId: string
  ownerName: string
  updatedAt: number
  canEdit: boolean
}

export interface WhiteboardDetail extends WhiteboardMeta {
  data: string
  createdAt: number
}

const META_SELECT = `
  SELECT b.id, b.name, b.owner_id, b.updated_at, u.display_name AS owner_name
    FROM whiteboards b JOIN users u ON u.id = b.owner_id
`

function metaOf(row: { id: string; name: string; owner_id: string; updated_at: number; owner_name: string }, viewerId: string, isAdmin: boolean): WhiteboardMeta {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    updatedAt: row.updated_at,
    canEdit: row.owner_id === viewerId || isAdmin,
  }
}

export function listWhiteboards(viewerId: string, isAdmin: boolean): WhiteboardMeta[] {
  const rows = getDb()
    .prepare(`${META_SELECT} ORDER BY b.updated_at DESC LIMIT 100`)
    .all() as unknown as Array<{ id: string; name: string; owner_id: string; updated_at: number; owner_name: string }>
  return rows.map((r) => metaOf(r, viewerId, isAdmin))
}

export function getWhiteboard(id: string, viewerId: string, isAdmin: boolean): WhiteboardDetail {
  const row = getDb()
    .prepare(
      `SELECT b.*, u.display_name AS owner_name FROM whiteboards b JOIN users u ON u.id = b.owner_id WHERE b.id = ?`,
    )
    .get(id) as
    | ({ id: string; name: string; owner_id: string; created_at: number; updated_at: number; data: string; owner_name: string })
    | undefined
  if (!row) throw new HttpError(404, '这块白板不存在')
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    data: row.data,
    canEdit: row.owner_id === viewerId || isAdmin,
  }
}

/** 校验场景 JSON：能解析、有 elements 数组、尺寸受限。 */
function validateData(data: string): void {
  if (typeof data !== 'string' || data.length === 0) throw new HttpError(400, '场景内容不能为空')
  if (data.length > MAX_DATA) throw new HttpError(400, '场景太大（超过 2MB），拆一块新白板吧')
  try {
    const parsed = JSON.parse(data) as { elements?: unknown }
    if (!Array.isArray(parsed.elements)) throw new Error('bad shape')
  } catch {
    throw new HttpError(400, '场景内容不是合法的 Excalidraw 格式')
  }
}

export function createWhiteboard(name: string, ownerId: string, data = '{"elements":[]}'): WhiteboardDetail {
  const n = name.trim()
  if (!n) throw new HttpError(400, '先给白板起个名字')
  if (n.length > MAX_NAME) throw new HttpError(400, `名字最多 ${MAX_NAME} 字`)
  validateData(data)
  const id = newId('wb')
  const ts = now()
  getDb()
    .prepare('INSERT INTO whiteboards (id, name, owner_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, n, ownerId, data, ts, ts)
  return getWhiteboard(id, ownerId, false)
}

/** 保存场景（作者/管理员）。全量覆盖 —— Excalidraw 的场景本来就是整份的。 */
export function saveWhiteboard(id: string, userId: string, isAdmin: boolean, data: string): WhiteboardDetail {
  const board = getWhiteboard(id, userId, isAdmin)
  if (!board.canEdit) throw new HttpError(403, '只有作者或管理员能保存这块白板')
  validateData(data)
  getDb().prepare('UPDATE whiteboards SET data = ?, updated_at = ? WHERE id = ?').run(data, now(), id)
  return getWhiteboard(id, userId, isAdmin)
}

export function deleteWhiteboard(id: string, userId: string, isAdmin: boolean): WhiteboardDetail {
  const board = getWhiteboard(id, userId, isAdmin)
  if (!board.canEdit) throw new HttpError(403, '只有作者或管理员能删除')
  getDb().prepare('DELETE FROM whiteboards WHERE id = ?').run(id)
  return board
}
