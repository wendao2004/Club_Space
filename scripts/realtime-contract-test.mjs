/**
 * 实时推送事件名的双侧契约体检。
 *
 * 为什么需要它（真实事故，2026-10-27）：狼人杀上线后「根本无法正常游玩」，
 * 而 274 条服务端规则断言全绿。根因是 `pushWerewolfRoom()` 的事件名参数
 * 带了个默认值 `= 'game'`，六个调用点里五个没传，推送于是全发到了 `game` ——
 * 那是象棋和斗地主在用的名字，前端狼人杀只监听 `game-werewolf`。
 * 服务端状态机每一步都算对了，但没有一个玩家能看到：线上两局里有人在夜里问
 * 「死人了吗」、预言家自己说「昨晚查空气」。
 *
 * ⚠️ 关键教训：**光做「名字集合对账」抓不到这个 bug**。`game` 既是合法事件名、
 * 前端也确实有人在听，两侧名单完全对得上。所以判据必须是「默认值」本身：
 * 推送函数的事件名一旦有默认值，调用点就会显得「不需要想」，而漏传是静默的。
 *
 * 四条判据：
 *   ① 服务端 RealtimeEvent 声明的事件，前端必须有 rt.on 订阅（hello/ping 例外，
 *      它们在 realtime.ts 的分发器里内建处理，不走 rt.on）。
 *   ② 前端 rt.on 监听的名字，必须真在 RealtimeEvent 里声明过（防拼错）。
 *   ③ 任何 push* 函数的事件名参数**不许有默认值** —— 这条直接锁住本次事故。
 *   ④ 提示：同一个事件名被多个业务共用（本次 `game` 就是三家共用）。
 *
 * 用法：node scripts/realtime-contract-test.mjs   （退出码 0 = 干净）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_SRC = join(ROOT, 'server', 'src')
const WEB_SRC = join(ROOT, 'web', 'src')
const REALTIME_TS = join(SERVER_SRC, 'realtime.ts')

/** 在 realtime.ts 的分发器里内建处理，不需要 rt.on 订阅。 */
const INTERNAL_EVENTS = new Set(['hello', 'ping'])

/** 已知的多业务共用事件名 —— 只提示不判失败。 */
const SHARED_OWNERS = {
  game: '象棋(game-move 之外的房间状态) / 斗地主 / 狼人杀房间状态',
}

let passed = 0
let failed = 0

function ok(msg) {
  passed++
  console.log(`  ✓ ${msg}`)
}

function bad(msg, detail) {
  failed++
  console.log(`  ✗ ${msg}`)
  if (detail) console.log(`      ${detail}`)
}

function walk(dir, ext) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p, ext)
    return ext.test(e.name) ? [p] : []
  })
}

/** 从服务端 RealtimeEvent 联合类型里抠出权威事件名。 */
function declaredEvents() {
  const text = readFileSync(REALTIME_TS, 'utf8')
  const start = text.indexOf('export type RealtimeEvent =')
  const end = text.indexOf('\nexport ', start + 10)
  const block = text.slice(start, end === -1 ? undefined : end)
  return new Set([...block.matchAll(/type:\s*'([a-z-]+)'/g)].map((m) => m[1]))
}

/** 收集前端所有 rt.on(...)：字面量，或同文件内声明的事件名常量。 */
function collectListeners() {
  const out = new Map()
  for (const file of walk(WEB_SRC, /\.(ts|vue)$/)) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(ROOT, file)
    const consts = new Map()
    for (const m of src.matchAll(/(?:const|let)\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([a-z-]+)'/g)) consts.set(m[1], m[2])
    for (const m of src.matchAll(/rt\.on\(\s*(?:'([a-z-]+)'|([A-Z_][A-Z0-9_]*))/g)) {
      const name = m[1] ?? consts.get(m[2])
      if (!name) continue
      if (!out.has(name)) out.set(name, [])
      out.get(name).push(rel)
    }
  }
  return out
}

function main() {
  const declared = declaredEvents()
  const listeners = collectListeners()

  if (declared.size === 0) {
    bad('没能从 RealtimeEvent 里解析出任何事件名', '判据本身失效了，先修解析再信结论')
    console.log('\n通过 0 失败 ' + failed)
    process.exit(1)
  }
  console.log(`服务端声明 ${declared.size} 个事件，前端订阅 ${listeners.size} 个`)

  console.log('[1] 服务端发出的每个事件，前端都得有人在听')
  for (const name of [...declared].sort()) {
    if (INTERNAL_EVENTS.has(name)) continue
    if (listeners.has(name)) ok(`${name} → ${listeners.get(name).length} 处订阅`)
    else bad(`${name} 服务端在发，前端没有任何 rt.on 订阅`, '发出去没人收 = 该功能对用户完全静默（狼人杀事故正是这个形态）')
  }

  console.log('\n[2] 前端监听的每个名字，服务端都得真声明过')
  for (const name of [...listeners.keys()].sort()) {
    if (declared.has(name)) ok(`${name}`)
    else bad(`${name} 前端在听，但 RealtimeEvent 里没有它`, `订阅方：${listeners.get(name).join(', ')} —— 拼错的名字永远收不到东西`)
  }

  checkNoDefaults()

  console.log('\n[4] 多业务共用的事件名（只提示）')
  for (const [name, owner] of Object.entries(SHARED_OWNERS)) {
    if (listeners.has(name)) console.log(`  · ${name} 由多家共用：${owner}`)
  }

  console.log(`\n通过 ${passed} 失败 ${failed}`)
  if (failed > 0) {
    console.log('\n提示：判据 ③ 是本次事故的直接防线 —— 事件名默认值会让调用点显得可省略。')
    process.exit(1)
  }
}

/** 判据 ③：push* 函数的事件名参数不许有默认值。 */
function checkNoDefaults() {
  console.log('\n[3] 推送函数的事件名不许有默认值')
  let checked = 0
  for (const file of walk(SERVER_SRC, /\.ts$/)) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(ROOT, file)
    const re = /(?:export\s+)?function\s+(push\w+)\s*\(([\s\S]{0,700}?)\)\s*(?::\s*[^{]+)?\{/g
    for (const m of src.matchAll(re)) {
      const fnName = m[1]
      const params = m[2]
      const em = params.match(/\bevent\s*\??\s*:\s*([^,=\n]+?)(\s*=\s*([^,\n]+?))?\s*(?:,|$)/m)
      if (!em) continue
      checked++
      if (em[2]) {
        bad(`${fnName}() 的事件名参数带默认值 ${em[2].trim()}`, `${rel} —— 调用点漏传时推送会静默发到别人的事件名上，正是狼人杀那次事故的成因`)
      } else {
        ok(`${fnName}() 的事件名必须显式传`)
      }
    }
  }
  if (checked === 0) bad('一个带 event 参数的推送函数都没找到', '判据本身失效了，检查解析正则')
}

main()
