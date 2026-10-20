/**
 * 健康检查的真实性测试。
 *
 * 这个接口原来的实现**恒定返回 `ok: true`** —— 它只证明"Node 进程还活着"，
 * 不证明"这个服务还能用"。于是"数据库属主被改、写不进任何东西"这种情况
 * 在监控上完全看不出来，直到用户开始报错才发现。一个永远说 ok 的检查
 * 比没有检查更糟，因为它让人放弃了警惕。
 *
 * 这里验证四件事：
 *   1. 它真的会去写数据库（写探针），并且把磁盘余量读出来
 *   2. 审计链校验是**增量**的：稳态下没有新行要验，不会反复全表重算
 *   3. 新写入的审计记录会被下一次探活看到（不是缓存的旧值）
 *   4. 链被篡改时它敢说 chainOk=false（而不是继续报 ok）
 *
 * 用法：由 scripts/run-all-tests.mjs 启动服务端后运行，
 *      需要 WL_TEST_DATA_DIR 指向服务端的数据库目录（用于伪造一条坏记录）。
 */

import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const DATA_DIR = process.env.WL_TEST_DATA_DIR ?? ''
const SUFFIX = String(process.pid).slice(-5)

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function health() {
  const res = await fetch(`${BASE}/api/health`)
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

async function main() {
  console.log(`\n\x1b[1m健康检查的真实性\x1b[0m  目标 ${BASE}\n`)

  // 启动时的后台预热是 setImmediate，给它一点时间把基准建起来
  await sleep(300)

  // ---------------------------------------------------------------- 基本形状
  console.log('【它到底检查了什么】')
  const h1 = await health()
  assert(h1.status === 200, '健康时返回 200', `状态 ${h1.status}`)
  assert(h1.body?.ok === true, 'ok = true')
  assert(h1.body?.status === 'ok', 'status = ok', h1.body?.status)

  assert(
    h1.body?.db?.ok === true,
    '数据库写探针通过（不是只读了一次 SELECT）',
    JSON.stringify(h1.body?.db),
  )
  const disk = h1.body?.disk ?? {}
  assert(
    typeof disk.freeBytes === 'number' && disk.freeBytes > 0,
    '读到了真实磁盘余量',
    `freeBytes=${disk.freeBytes}`,
  )
  assert(
    disk.minFreeBytes === 256 * 1024 * 1024,
    '磁盘底线用的是独立阈值（256MB），不是上传守卫的 2GB',
    `minFreeBytes=${disk.minFreeBytes}`,
  )
  assert(
    typeof disk.totalBytes === 'number' && disk.totalBytes >= disk.freeBytes,
    '总容量 >= 剩余容量（说明数字来自同一个文件系统）',
    `total=${disk.totalBytes}`,
  )

  // ---------------------------------------------------------------- 增量
  console.log('\n【审计链：增量校验，不是每次全表重算】')
  assert(h1.body?.audit?.chainOk === true, '审计链自洽')
  assert(
    h1.body?.audit?.incremental === true,
    '探活走的是增量校验（全量留给管理员手动触发与启动预热）',
    `incremental=${h1.body?.audit?.incremental}`,
  )

  const records1 = h1.body?.audit?.records ?? -1

  // 造一条真实的审计记录：注册一个账号（登录/注册都会写审计）
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: `hlt${SUFFIX}`,
      displayName: '健康检查',
      password: 'health-test-2026',
    }),
  })
  assert(reg.status === 200 || reg.status === 201, '注册一个账号（产生真实审计记录）')

  const h2 = await health()
  const records2 = h2.body?.audit?.records ?? -1
  assert(
    records2 > records1,
    '下一次探活立刻看到新增的审计记录（说明结果没有被缓存住）',
    `${records1} → ${records2}`,
  )
  assert(
    typeof h2.body?.audit?.verifiedUpto === 'number' && h2.body.audit.verifiedUpto <= records2,
    '校验进度不超过链头',
    `verifiedUpto=${h2.body?.audit?.verifiedUpto} records=${records2}`,
  )
  assert(
    typeof h2.body?.audit?.checked === 'number' && h2.body.audit.checked > 0,
    '这一次确实重算了新增的那几行',
    `checked=${h2.body?.audit?.checked}`,
  )

  // 立刻再探一次：没有新行，就不该再重算，也不该再写基准
  const h3 = await health()
  assert(
    h3.body?.audit?.checked === 0,
    '没有新记录时不做任何重算（增量的意义就在这里）',
    `checked=${h3.body?.audit?.checked}`,
  )

  // ---------------------------------------------------------------- 不可改删
  console.log('\n【审计表是 append-only：改/删必须被数据库挡住】')
  if (!DATA_DIR) {
    bad('检查审计表的 write 保护', '没有拿到 WL_TEST_DATA_DIR，无法直接试')
  } else {
    const db = new DatabaseSync(join(DATA_DIR, 'app.sqlite'))
    try {
      const version = db.prepare('SELECT version FROM schema_version').get()?.version
      assert(version >= 12, 'schema 已迁到 v12（触发器是在这条迁移里建的）', `version=${version}`)

      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_log'")
        .all()
        .map((r) => r.name)
      assert(
        triggers.includes('audit_log_no_update') && triggers.includes('audit_log_no_delete'),
        '两个触发器都在（UPDATE / DELETE）',
        triggers.join(', '),
      )

      // audit.ts 的注释从第一版起就写着"数据库层有触发器禁止改删"，
      // 而这句话一直到 v12 才成真。这条断言就是防止它再次变回口号。
      let updateBlocked = false
      try {
        db.prepare("UPDATE audit_log SET action = 'tampered' WHERE seq = 1").run()
      } catch (err) {
        updateBlocked = String(err?.message ?? '').includes('append-only')
      }
      assert(updateBlocked, 'UPDATE 被拒绝，且报错说清了原因')

      let deleteBlocked = false
      try {
        db.prepare('DELETE FROM audit_log WHERE seq = 1').run()
      } catch (err) {
        deleteBlocked = String(err?.message ?? '').includes('append-only')
      }
      assert(deleteBlocked, 'DELETE 一条被拒绝')

      let truncateBlocked = false
      try {
        db.prepare('DELETE FROM audit_log').run()
      } catch (err) {
        truncateBlocked = String(err?.message ?? '').includes('append-only')
      }
      assert(truncateBlocked, 'DELETE 全表也被拒绝（没有 WHERE 的写法同样挡住）')

      const stillThere = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE seq = 1').get()
      assert(stillThere.n === 1, '第 1 条记录还在（前两次尝试没有产生副作用）')

      // INSERT 必须仍然放行 —— 挡住写入等于把审计功能本身关掉
      let insertOk = true
      try {
        const head = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get()
        db.prepare(
          `INSERT INTO audit_log (seq, ts, actor_id, actor_ip, category, action, target, payload, prev_hash, hash)
           VALUES (?, ?, NULL, 'test', 'system', 'append-still-allowed', NULL, 'null', ?, ?)`,
        ).run(head.seq + 1, Date.now(), head.hash, randomBytes(32).toString('hex'))
      } catch {
        insertOk = false
      }
      assert(insertOk, 'INSERT 仍然放行（挡住写入就等于把审计关掉）')
    } finally {
      db.close()
    }
  }

  // ---------------------------------------------------------------- 敢说"坏了"
  console.log('\n【链被篡改时它必须说 chainOk=false】')
  if (!DATA_DIR) {
    bad('伪造坏记录', '没有拿到 WL_TEST_DATA_DIR，无法直接改库')
  } else {
    const db = new DatabaseSync(join(DATA_DIR, 'app.sqlite'))
    try {
      const head = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get()
      // 插一条 seq 连续、但 hash 不可能对得上的记录 —— 模拟"有人改了内容"。
      db.prepare(
        `INSERT INTO audit_log (seq, ts, actor_id, actor_ip, category, action, target, payload, prev_hash, hash)
         VALUES (?, ?, NULL, 'test', 'system', 'tampered', NULL, 'null', ?, ?)`,
      ).run(head.seq + 1, Date.now(), head.hash, randomBytes(32).toString('hex'))
    } finally {
      db.close()
    }

    const h4 = await health()
    assert(
      h4.body?.audit?.chainOk === false,
      '伪造的记录被识破（chainOk = false）',
      `chainOk=${h4.body?.audit?.chainOk}`,
    )
    assert(
      typeof h4.body?.audit?.reason === 'string' && h4.body.audit.reason.length > 0,
      '并且给出了断在哪一条、为什么',
      h4.body?.audit?.reason,
    )
    // 这一条是刻意的设计取舍：链坏了不返回 503。
    // 重启修不好一条断掉的哈希链，而 Docker 会把 503 当成"容器坏了"反复重启，
    // 真正的线索会被重启日志淹没。所以状态在响应体里如实给出，HTTP 仍 200。
    assert(
      h4.status === 200 && h4.body?.status === 'degraded',
      '链异常时报 degraded，但不把 HTTP 变成 503（重启修不好哈希链）',
      `状态 ${h4.status} / ${h4.body?.status}`,
    )
    // 数据库和磁盘都正常，所以 ok 仍然是 true —— ok 回答的是"现在能不能读写"
    assert(h4.body?.ok === true, 'ok 仍然为 true（它只回答"现在能不能读写"）')
  }

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
