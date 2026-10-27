/**
 * 设计 token 体检：`var(--x)` 里用到的 token，必须在 tokens.css 里真的定义过。
 *
 * 为什么需要它（真实事故）：2026-10 的一次扫描发现 **11 个 token 从未定义、56 处在用**，
 * 其中 `var(--text-3)` / `var(--text-2)` 一共 38 处**没有 fallback** —— 浏览器遇到
 * 未定义的自定义属性会整条声明失效，`color` 于是退化成 `inherit`。表现是那些文字
 * 悄悄跟着父元素走，看起来「灰得不对」却查不出原因，而 CSS 检查器里只显示一行
 * 划掉的声明。它不报错、不变红、不影响任何功能断言，所以能活很久。
 *
 * 判据有两条，缺一不可：
 *   ① **无 fallback** 的 `var(--x)`：找不到定义就算失败（整条声明会失效）。
 *   ② **有 fallback** 的 `var(--x, ...)`：允许（浏览器会退到 fallback），但会列出来，
 *      因为它们往往是想写某个真实 token 却拼错了名字。
 *
 * 例外（不算失败，白名单）：由**内联 style 在运行时注入**的自定义属性 ——
 * `--tint`（图标主色，DesktopIcons/StartMenu 用 :style 设）与 `--xq-fly-dx/dy`
 * （象棋走子动画的位移）。它们本来就不该出现在样式表里。
 *
 * 用法：node scripts/design-tokens-test.mjs   （退出码 0 = 干净）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'web', 'src')
const TOKENS_FILE = join(SRC, 'styles', 'tokens.css')

/** 只允许在这两个文件里定义 token —— 别处出现定义会让「唯一来源」失效。 */
const RUNTIME_INJECTED = new Set(['--tint', '--xq-fly-dx', '--xq-fly-dy'])

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(vue|css|scss)$/.test(e.name) ? [p] : []
  })
}

function main() {
  const tokensText = readFileSync(TOKENS_FILE, 'utf8')
  const defined = new Set()
  for (const m of tokensText.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1])

  let passed = 0
  let failed = 0
  const failures = []
  const suspicious = []

  const ok = (name, extra = '') => {
    passed += 1
    console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`)
  }
  const bad = (name, detail) => {
    failed += 1
    failures.push(name + ' :: ' + detail)
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${detail}\x1b[0m`)
  }

  console.log('\n\x1b[1m设计 token 体检\x1b[0m\n')

  ok('tokens.css 里定义了 token', `${defined.size} 个`)

  const files = walk(SRC)
  ok('扫描了样式来源', `${files.length} 个文件`)

  // ---- ① 无 fallback 的 var(--x) 必须存在（全局 token，或**本文件内**定义的局部变量）
  //
  // ⚠️ 这一条一开始写错过：只看 tokens.css 会把 --poker-*/--xq-* 判成缺失，
  // 而它们其实是组件 <style> 里自己定义的局部变量（同一选择器作用域内有效）。
  // 判据必须是「从使用点往上找得到定义」，不是「全局表里有」。
  // 反过来也有价值：一个**跨文件**使用的局部变量名，说明有人在不该用的地方用了它，
  // 那种情况要么提升成全局 token，要么改回本地 —— 单独列出来。
  const localDefs = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const set = new Set()
    for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) set.add(m[1])
    localDefs.set(file, set)
  }

  const missingNoFallback = new Map()
  const missingWithFallback = new Map()
  const crossFileLocals = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    const own = localDefs.get(file) ?? new Set()
    // var(--x) 后紧跟 ')' —— 没有逗号就是没有 fallback
    for (const m of text.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)) {
      const name = m[1]
      if (defined.has(name) || RUNTIME_INJECTED.has(name)) continue
      if (own.has(name)) {
        // 本地定义、本地使用：正常。但若别处也在用，记为「跨文件局部变量」
        const users = [...localDefs.entries()].filter(([f2, s2]) => f2 !== file && s2.has(name))
        if (users.length > 0 && !crossFileLocals.has(name)) {
          crossFileLocals.set(name, [rel, ...users.map(([f2]) => relative(ROOT, f2).replace(/\\/g, '/'))])
        }
        continue
      }
      if (!missingNoFallback.has(name)) missingNoFallback.set(name, [])
      missingNoFallback.get(name).push(rel)
    }
    // var(--x, fallback) —— 允许，但要列出来
    for (const m of text.matchAll(/var\((--[a-z0-9-]+)\s*,/g)) {
      const name = m[1]
      if (defined.has(name) || RUNTIME_INJECTED.has(name)) continue
      if (!missingWithFallback.has(name)) missingWithFallback.set(name, 0)
      missingWithFallback.set(name, missingWithFallback.get(name) + 1)
    }
  }

  if (missingNoFallback.size === 0) {
    ok('没有用到未定义且无 fallback 的 token')
  } else {
    for (const [name, where] of [...missingNoFallback.entries()].sort()) {
      bad(
        `未定义且无 fallback：${name}`,
        `${where.length} 处 → ${[...new Set(where)].slice(0, 4).join(', ')}` +
          '（整条 CSS 声明会失效，color 会退化成 inherit）',
      )
    }
  }

  // ---- ①b 跨文件使用组件局部变量：不算失败，但要说出来（命名该收敛）
  if (crossFileLocals.size === 0) {
    ok('没有跨文件使用组件局部变量')
  } else {
    for (const [name, where] of [...crossFileLocals.entries()].sort()) {
      ok('跨文件使用的局部变量（提示）', `${name}：${[...new Set(where)].join(' + ')}`)
    }
  }

  // ---- ② 有 fallback 的：不判失败，列出来供人工判断是不是拼错了
  if (missingWithFallback.size > 0) {
    const list = [...missingWithFallback.entries()].map(([k, n]) => `${k}(${n})`).join(', ')
    suspicious.push(list)
  }

  // ---- ③ 每个 token 至少被用一次（防止定义了却没人用，属于「僵尸 token」）
  const usedAnywhere = new Set()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) usedAnywhere.add(m[1])
  }
  const unused = [...defined].filter((t) => !usedAnywhere.has(t))
  if (unused.length === 0) ok('每个已定义的 token 都至少被用了一次')
  else ok('有未使用的 token（仅提示，不判失败）', `${unused.length} 个：${unused.slice(0, 8).join(', ')}`)

  // ---- ④ 运行时注入的例外必须真的在别处被设置（否则白名单会腐烂）
  const allText = files.map((f) => readFileSync(f, 'utf8')).join('\n')
  const injectionProven = [...RUNTIME_INJECTED].filter((t) =>
    new RegExp("'" + t + "':").test(allText),
  )
  if (injectionProven.length === RUNTIME_INJECTED.size) {
    ok('运行时注入的 token 确实在 :style 里被设置', injectionProven.join(', '))
  } else {
    const notProven = [...RUNTIME_INJECTED].filter((t) => !injectionProven.includes(t))
    bad('白名单里的 token 没找到注入点', `${notProven.join(', ')} —— 白名单该收紧了`)
  }

  if (suspicious.length > 0) {
    console.log(
      `\n\x1b[33m提示：以下 token 未定义但有 fallback（可用，多半是想写某个真实 token）：\x1b[0m\n  ${suspicious[0]}`,
    )
  }

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  if (failed > 0) {
    console.log('\x1b[31m修法：把 var(--旧名) 换成 tokens.css 里真实存在的名字。\x1b[0m')
    console.log('\x1b[90m真实 token 见 web/src/styles/tokens.css。\x1b[0m\n')
    process.exit(1)
  }
  process.exit(0)
}

main()