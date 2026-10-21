/**
 * 数据库迁移的并发安全。
 *
 * 复现的是一个"单实例永远遇不到"的故障：迁移的版本号原来在**锁外**读一次，
 * 然后 BEGIN IMMEDIATE 再迁。于是 N 个进程同时启动时，它们都读到同一个旧版本，
 * 先拿到写锁的那位迁完提交，后到的拿着已经过期的版本号再跑一遍
 * `ALTER TABLE ... ADD COLUMN`，直接撞 `duplicate column name` 然后启动失败。
 *
 * 表现会很难看：报错信息看起来像 schema 写错了，而实际上是"你起得比一个快"。
 * 之所以值得测：`docker compose up --scale app=2`、容器滚动重启、
 * 以及以后真要做零停机部署，都会走到这条路上。
 *
 * 做法是**起真的子进程**并发打开同一个库，而不是在一个进程里调两次 getDb()
 * —— 后者串行执行，永远不会撞上。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 从 db.ts 的迁移数组里数出最新版本号。
 *
 * 这个数字以前是硬编码的（v12、v13…），每加一次迁移就要记得改这里，
 * 忘了就是"测试挂了但代码没问题"—— 加迁移的人还得先去修测试才能看到
 * 真正的结果。迁移注释已经写成 `// ---- vNN: 说明` 的固定格式，
 * 直接按这个格式抓最大值即可，从此不用手工同步。
 */
const DB_SOURCE = readFileSync(join(ROOT, 'server/src/db.ts'), 'utf8')
const MIGRATION_VERSIONS = [...DB_SOURCE.matchAll(/\/\/ ---- v(\d+):/g)].map((m) => Number(m[1]))
const LATEST_VERSION = Math.max(...MIGRATION_VERSIONS)
const DB_MODULE = pathToFileURL(join(ROOT, 'server', 'src', 'db.ts')).href

let passed = 0
let failed = 0

function ok(name, extra = '') {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`)
}
function bad(name, detail) {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${detail}\x1b[0m`)
}
function assert(cond, name, detail = '') {
  if (cond) ok(name, detail)
  else bad(name, detail || '断言失败')
}

const dataDir = mkdtempSync(join(tmpdir(), 'wl-migrate-'))

/** 起一个只做"打开数据库"的子进程；迁移就在打开时发生。 */
function openInChild(index) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', `import { getDb } from ${JSON.stringify(DB_MODULE)}; getDb();`],
      {
        cwd: ROOT,
        // 让每个子进程都真的去抢第一次迁移：不设 WL_SKIP，正常路径就是迁移路径
        env: { ...process.env, WL_DATA_DIR: dataDir, WL_DB_PATH: join(dataDir, 'app.sqlite') },
      },
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code, signal) => resolve({ index, code, signal, out }))
  })
}

async function main() {
  console.log(`\n\x1b[1m数据库迁移（并发启动）\x1b[0m  数据目录 ${dataDir}\n`)

  const N = 4
  console.log(`【${N} 个进程同时打开一个空库】`)
  // 逐个 spawn 而不用 await：要的就是"同时"。
  const results = await Promise.all(Array.from({ length: N }, (_, i) => openInChild(i)))

  for (const r of results) {
    assert(
      r.code === 0,
      `进程 #${r.index + 1} 正常退出`,
      r.code === 0 ? '' : `退出码 ${r.code}${r.signal ? ` 信号 ${r.signal}` : ''}：${r.out.trim().split('\n').slice(-4).join(' | ') || '(没有任何输出)'}`,
    )
  }
  // 把最典型的失败形态单独点名，否则以后有人只看到"退出码 1"会去猜
  const dupColumn = results.find((r) => /duplicate column/i.test(r.out))
  assert(
    dupColumn === undefined,
    '没有任何进程撞上 duplicate column（版本号在锁内重读，不是锁外的旧值）',
    dupColumn ? dupColumn.out.trim().split('\n').slice(-3).join(' | ') : '',
  )

  console.log('\n【迁移结果】')
  assert(existsSync(join(dataDir, 'app.sqlite')), '库文件已创建')

  const db = new DatabaseSync(join(dataDir, 'app.sqlite'))
  try {
    const rows = db.prepare('SELECT version FROM schema_version').all()
    assert(rows.length === 1, 'schema_version 只有一行（并发写没有写出重复行）', `${rows.length} 行`)

    // 版本号从 db.ts 的迁移注释里数出来（见文件头的 MIGRATION_VERSIONS）。
    // 断言的作用不是"钉死版本号"，而是防止"迁移跑了一半就提交"。
    const version = rows[0]?.version
    assert(version === LATEST_VERSION, `版本号是当前最新（v${LATEST_VERSION}）`, `version=${version}`)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name)
    assert(
      tables.includes('messages') && tables.includes('audit_log') && tables.includes('game_rooms'),
      '关键表都在（不是只跑完了第一条迁移）',
      `${tables.length} 张表`,
    )

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((r) => r.name)
    assert(
      ['audit_log_no_update', 'audit_log_no_delete'].every((t) => triggers.includes(t)),
      '审计表的两条触发器已建（v12 的内容真的执行了）',
      triggers.join(', '),
    )

    // 内容层面的验证不能省：只比版本号的话，"迁移写漏了"会静默通过。
    // 新增迁移时在这里补一条表/列存在性断言。
    assert(
      tables.includes('draw_rounds'),
      '你画我猜的存档表已建（v13 的内容真的执行了）',
      tables.join(', '),
    )
    assert(
      tables.includes('board_posts'),
      '留言板表已建（v14 的内容真的执行了）',
      tables.join(', '),
    )
  } finally {
    db.close()
  }

  // 并发跑完之后再开一次，确认"已经是新版"的启动路径不报错也不改动
  console.log('\n【已经是新版之后再启动】')
  const again = await openInChild(99)
  assert(again.code === 0, '再次打开不再执行任何迁移，正常退出')
  const db2 = new DatabaseSync(join(dataDir, 'app.sqlite'))
  try {
    const v = db2.prepare('SELECT version FROM schema_version').get()?.version
    assert(v === LATEST_VERSION, '版本号没有被重复执行改坏', `version=${v}（期望 ${LATEST_VERSION}）`)
  } finally {
    db2.close()
  }

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  rmSync(dataDir, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  rmSync(dataDir, { recursive: true, force: true })
  process.exit(1)
})
