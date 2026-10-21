/**
 * 打字练习的个人数据（进度 + 错题本）。
 *
 * 词库在前端（web/src/lib/dicts/），服务端只认 dict/chapter 这两个字符串
 * 标识 —— 不校验"词库存不存在"：词库随前端版本演进，后端卡死了反而会
 * 出现"新词库存不了进度"的怪事。只校验形状（长度、范围）。
 *
 * 全部只读写自己的行：进度和错题是纯个人数据，没有共享语义。
 */
import { getDb, now } from './db.ts'
import { HttpError } from './files.ts'

const MAX_DICT_LEN = 40
const MAX_WORD_LEN = 60
/** 单人错题本上限：满了说明该复习了，继续塞只会变成垃圾抽屉。 */
const MAX_WRONG_ENTRIES = 500

export interface TypingProgress {
  dict: string
  chapter: number
  position: number
  updatedAt: number
}

export interface TypingWrong {
  dict: string
  word: string
  wrongCount: number
  lastAt: number
}

export function listProgress(userId: string): TypingProgress[] {
  return getDb()
    .prepare('SELECT dict, chapter, position, updated_at AS updatedAt FROM typing_progress WHERE user_id = ?')
    .all(userId) as unknown as TypingProgress[]
}

/** 记录/更新某章进度。position 允许回退（重练一章），也允许清零。 */
export function saveProgress(userId: string, dict: string, chapter: number, position: number): TypingProgress {
  validateDictKey(dict, chapter)
  if (!Number.isInteger(position) || position < 0 || position > 10_000) {
    throw new HttpError(400, 'position 不合法')
  }
  getDb()
    .prepare(
      `INSERT INTO typing_progress (user_id, dict, chapter, position, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, dict, chapter) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
    )
    .run(userId, dict, chapter, position, now())
  return { dict, chapter, position, updatedAt: now() }
}

export function listWrong(userId: string): TypingWrong[] {
  return getDb()
    .prepare(
      `SELECT dict, word, wrong_count AS wrongCount, last_at AS lastAt
         FROM typing_wrong WHERE user_id = ? ORDER BY last_at DESC`,
    )
    .all(userId) as unknown as TypingWrong[]
}

/** 在某个词上出过错：记一笔 / 累加。同一章里连错同一个词按多次记。 */
export function recordWrong(userId: string, dict: string, word: string): void {
  validateDictKey(dict)
  const w = word.trim()
  if (!w || w.length > MAX_WORD_LEN) throw new HttpError(400, 'word 不合法')

  const count = (getDb().prepare('SELECT COUNT(*) AS c FROM typing_wrong WHERE user_id = ?').get() as { c: number }).c
  if (count >= MAX_WRONG_ENTRIES) {
    throw new HttpError(400, `错题本最多 ${MAX_WRONG_ENTRIES} 条，先去复习清一清`)
  }

  getDb()
    .prepare(
      `INSERT INTO typing_wrong (user_id, dict, word, wrong_count, last_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(user_id, dict, word) DO UPDATE SET wrong_count = wrong_count + 1, last_at = excluded.last_at`,
    )
    .run(userId, dict, w, now())
}

/**
 * 清错题：传 word 删单个，不传全清（复习完的成就感需要一个"清空"动作）。
 * 返回删掉的条数。
 */
export function clearWrong(userId: string, dict: string | null, word: string | null): number {
  if (word !== null) {
    if (!word.trim() || word.length > MAX_WORD_LEN) throw new HttpError(400, 'word 不合法')
    const r = getDb()
      .prepare('DELETE FROM typing_wrong WHERE user_id = ? AND word = ?')
      .run(userId, word.trim())
    return Number(r.changes)
  }
  if (dict !== null) {
    validateDictKey(dict)
    const r = getDb().prepare('DELETE FROM typing_wrong WHERE user_id = ? AND dict = ?').run(userId, dict)
    return Number(r.changes)
  }
  const r = getDb().prepare('DELETE FROM typing_wrong WHERE user_id = ?').run(userId)
  return Number(r.changes)
}

function validateDictKey(dict: string, chapter?: number): void {
  if (typeof dict !== 'string' || !dict || dict.length > MAX_DICT_LEN) {
    throw new HttpError(400, 'dict 标识不合法')
  }
  if (chapter !== undefined && (!Number.isInteger(chapter) || chapter < 0 || chapter > 1000)) {
    throw new HttpError(400, 'chapter 不合法')
  }
}
