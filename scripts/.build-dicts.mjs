/**
 * 从 ECDICT（MIT，github.com/skywind3000/ECDICT）生成打字练习词库。
 *
 * 一次性脚本：读 ecdict.csv，按 tag 筛 cet4 / cet6 / ky（考研），按 BNC
 * 词频取高频词，输出 web/src/lib/dicts/gen-*.ts。跑法：
 *
 *   node scripts/.build-dicts.mjs /tmp/ecdict.csv
 *
 * 选择标准（写在生成的文件头里）：
 *  - 只收纯字母词（词组打起来没有"背单词"的意义）
 *  - 词长 3-14：太短的（a/an/is）没有练习价值，太长的多是术语
 *  - 按 BNC 语料词频升序取（越常用越先练）
 *  - 每章 20 词
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

/** 按 tag 筛词：{ tag → Map<word, row> } */
const pools = { cet4: new Map(), cet6: new Map(), ky: new Map() }

for (let i = 1; i < lines.length; i++) {
  const line = lines[i]
  if (!line) continue
  const f = parseCsvLine(line)
  const word = f[col.word]
  if (!word || !/^[A-Za-z]{3,14}$/.test(word)) continue
  const tags = f[col.tag]
  if (!tags) continue
  const bnc = Number.parseInt(f[col.bnc] || '0', 10) || 999999999
  const phonetic = (f[col.phonetic] || '').trim()
  // ECDICT 的 translation 用 \n 分隔多个词性，打字练习只要第一行（最常用义）
  const translation = (f[col.translation] || '').split('\\n')[0].trim().slice(0, 60)
  if (!translation) continue

  for (const tag of Object.keys(pools)) {
    if (new RegExp(`(^| )${tag}( |$)`).test(tags) && !pools[tag].has(word)) {
      pools[tag].set(word, { word, bnc, phonetic, translation })
    }
  }
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

for (const [tag, map] of Object.entries(pools)) {
  const sorted = [...map.values()].sort((a, b) => a.bnc - b.bnc).slice(0, TARGETS[tag])
  const chapters = []
  for (let i = 0; i < sorted.length; i += CHAPTER) {
    chapters.push(sorted.slice(i, i + CHAPTER))
  }
  const name = tag === 'ky' ? '考研英语' : tag === 'cet4' ? 'CET-4 核心词' : 'CET-6 核心词'
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
 * 选词：tag 含 ${tag}、纯字母、词长 3-14，按 BNC 语料词频取前 ${sorted.length} 词。
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
  console.log(`写出 ${filename}：${sorted.length} 词 / ${chapters.length} 章`)
}
