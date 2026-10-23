/**
 * 从 ECDICT（MIT，github.com/skywind3000/ECDICT）生成打字练习词库。
 *
 * 一次性脚本：读 ecdict.csv，按 tag 筛 cet4 / cet6 / ky（考研），输出
 * web/src/lib/dicts/gen-*.ts。跑法：
 *
 *   node scripts/.build-dicts.mjs /tmp/ecdict.csv
 *
 * 选择标准（写在生成的文件头里）：
 *  - 只收纯字母词（词组打起来没有"背单词"的意义）
 *  - 词长 3-14：太短的（a/an/is）没有练习价值，太长的多是术语
 *  - 每章 20 词，章内按 BNC 语料词频升序（越常用越先练）
 *
 * ⚠️ **三个板块必须互不重复**。
 *
 * 这是用户报过的真实问题：以前三个词库各自按 BNC 取前 N，而 ECDICT 的
 * 考试 tag 高度重叠（cet4 3834 / cet6 5387 / ky 4796，高频词同时带好几个
 * tag），于是 CET-4 / CET-6 / 考研 三份词库的正文几乎一模一样。
 *
 * 现在按"层级互斥"分配：
 *   CET-4  = tag 含 cet4（高频在前）
 *   CET-6  = tag 含 cet6，且**不含 cet4**
 *   考研   = tag 含 ky，且**不含 cet4**，再剔除已经选进 CET-6 的词
 *
 * 任何一个词只会出现在一个板块里，难度也自然分层（CET-4 最常用，
 * CET-6/考研 的 BNC 排名整体更靠后）。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const CSV = process.argv[2] ?? '/tmp/ecdict.csv'
const OUT_DIR = new URL('../web/src/lib/dicts/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 目标词量（ECDICT 的 tag 圈定的词集远大于这个数，按词频截断）。 */
const TARGETS = { cet4: 480, cet6: 400, ky: 400 }
const CHAPTER = 20

console.log('读取', CSV)
const text = readFileSync(CSV, 'utf8')

const lines = text.split('\n')
const header = lines[0].split(',')
const col = {}
header.forEach((h, i) => (col[h.trim()] = i))
console.log('字段：', header.join(','))

// 手写解析 CSV（translation 字段里有逗号，不能天真 split —— ECDICT 用
// 双引号包转义，逐字符状态机最稳，一次性脚本不引依赖）
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuote = false
      } else cur += c
    } else if (c === '"') inQuote = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

/** 所有候选词（去重：同一个 word 只收第一次出现的行）。 */
const all = []
const seen = new Set()

for (let i = 1; i < lines.length; i++) {
  const line = lines[i]
  if (!line) continue
  const f = parseCsvLine(line)
  const word = f[col.word]
  // 全小写：排除专有名词（Jesus / Africa / English 这类首字母大写词）。
  // 背单词练的是通用词汇，专有名词出现在 CET-6 / 考研 里只会显得列表很怪。
  if (!word || !/^[a-z]{3,14}$/.test(word)) continue
  if (seen.has(word)) continue
  const tags = f[col.tag]
  if (!tags) continue
  const bnc = Number.parseInt(f[col.bnc] || '0', 10) || 999999999
  const phonetic = (f[col.phonetic] || '').trim()
  // ECDICT 的 translation 用 \n 分隔多个词性，打字练习只要第一行（最常用义）
  const translation = (f[col.translation] || '').split('\\n')[0].trim().slice(0, 60)
  if (!translation) continue
  const tagSet = new Set(tags.trim().split(/\s+/))
  seen.add(word)
  all.push({ word, bnc, phonetic, translation, tags: tagSet })
}

const has = (row, tag) => row.tags.has(tag)
const byBnc = (a, b) => a.bnc - b.bnc

// CET-4：全部 cet4 词，按词频取前 N
const cet4 = all.filter((r) => has(r, 'cet4')).sort(byBnc).slice(0, TARGETS.cet4)

// CET-6：**排除 cet4**，否则又是同一批高频词
const cet6 = all
  .filter((r) => has(r, 'cet6') && !has(r, 'cet4'))
  .sort(byBnc)
  .slice(0, TARGETS.cet6)

// 考研：排除 cet4，再剔除已经进了 CET-6 的词 —— 保证三份互不重复
const cet6Words = new Set(cet6.map((r) => r.word))
const ky = all
  .filter((r) => has(r, 'ky') && !has(r, 'cet4') && !cet6Words.has(r.word))
  .sort(byBnc)
  .slice(0, TARGETS.ky)

const selections = {
  cet4: { name: 'CET-4 核心词', words: cet4, rule: 'tag 含 cet4，按 BNC 词频取前 N' },
  cet6: {
    name: 'CET-6 核心词',
    words: cet6,
    rule: 'tag 含 cet6 且**不含 cet4**（不与 CET-4 重复），按 BNC 词频取前 N',
  },
  ky: {
    name: '考研英语',
    words: ky,
    rule: 'tag 含 ky 且不含 cet4、也不在 CET-6 里（三个板块互不重复），按 BNC 词频取前 N',
  },
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

for (const [tag, { name, words, rule }] of Object.entries(selections)) {
  const chapters = []
  for (let i = 0; i < words.length; i += CHAPTER) {
    chapters.push(words.slice(i, i + CHAPTER))
  }
  const body = chapters
    .map(
      (ch, i) => `  {
    title: '第 ${i + 1} 章',
    words: [
${ch.map((w) => `      { w: '${esc(w.word)}', ipa: '${esc(w.phonetic)}', t: '${esc(w.translation)}' },`).join('\n')}
    ],
  },`,
    )
    .join('\n')

  const file = `/**
 * ${name} 词库 —— 由 ECDICT（MIT，github.com/skywind3000/ECDICT）生成，
 * 生成脚本 scripts/.build-dicts.mjs，不要手改本文件（会被下次生成覆盖）。
 * 选词：纯字母、词长 3-14、${rule}。
 * 三个考试词库互不重复：一个词只会出现在 CET-4 / CET-6 / 考研 中的一个。
 */
import type { TypingDict } from './types.ts'

export const gen${tag === 'ky' ? 'Kaoyan' : tag === 'cet4' ? 'Cet4' : 'Cet6'}: TypingDict = {
  id: '${tag}',
  name: '${name}',
  chapters: [
${body}
  ],
}
`
  const filename = `gen-${tag}.ts`
  writeFileSync(OUT_DIR + filename, file)
  console.log(`写出 ${filename}：${words.length} 词 / ${chapters.length} 章`)
}

// 生成时就自查一遍互斥，避免以后改规则又悄悄重叠
const sets = {
  cet4: new Set(cet4.map((r) => r.word)),
  cet6: new Set(cet6.map((r) => r.word)),
  ky: new Set(ky.map((r) => r.word)),
}
for (const [a, b] of [
  ['cet4', 'cet6'],
  ['cet4', 'ky'],
  ['cet6', 'ky'],
]) {
  const overlap = [...sets[a]].filter((w) => sets[b].has(w))
  if (overlap.length > 0) {
    console.error(`✗ ${a} 与 ${b} 仍有 ${overlap.length} 个重复：${overlap.slice(0, 10).join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${a} 与 ${b} 无重复`)
  }
}