/**
 * .docx 的读改写 —— 在线文档编辑器的底层。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么自己解析而不是引入 mammoth / docx 这类库
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 现成的库各管一半：mammoth 只做 docx → HTML（**不能**写回），docx 只做
 * JS 对象 → docx（**不能**读）。把两者接起来就是"读成 HTML、改完重新生成"，
 * 中间那一转会把原文档里所有没被建模的东西丢掉：页边距、页眉页脚、编号样式、
 * 图片、文本框、批注……
 *
 * 而社团文档里最常见的恰恰是"改几个字，其余一律不许动"。
 *
 * 所以这里走**块模型 + 原样回写**：
 *
 *   - 读：把 document.xml 拆成一段一段的块（段落 / 列表项 / 表格 / 只读块）；
 *   - 每个块记住它**原始的 pPr 片段**（样式、缩进、编号、对齐全在里面）；
 *   - 改：只替换块里的文字与行内格式，不动 pPr；
 *   - 遇到没建模的内容（图片、图表、文本框）→ 整段原样保留，界面标成只读；
 *   - 写：只替换 zip 里的 `word/document.xml`，其余部件（styles / numbering /
 *     media / header / footer / 关系表）**一个字节都不碰**。
 *
 * 这样"改一句话"保存之后，页眉、图片、页码、样式全都还在原处。
 *
 * 代价是**它不是所见即所得的排版器**：界面呈现的是内容结构，不是精确的版面。
 * 这是刻意的取舍，界面上也会如实说明，而不是假装这是一份 Word。
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

// ---------------------------------------------------------------- 块模型

/** 一段文字里的一个"格式片段"（对应 OOXML 的 run）。 */
export interface DocRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /**
   * 超链接的关系 id（r:id）。
   *
   * 存的是**关系 id 而不是 URL**：URL 在 `word/_rels/document.xml.rels` 里，
   * 而那个文件我们不去动 —— 只有用户新加链接时才往里追加一条（见 addHyperlink）。
   */
  linkId?: string
  /** 链接的目标地址。只为界面显示与"改链接"用，写回时用的是 linkId。 */
  href?: string
}

/** 0 = 正文，1-6 = 对应的标题级别。 */
export type ParaLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6
export type ParaAlign = 'left' | 'center' | 'right' | 'justify' | null

/** 普通段落 / 标题。level 为 0 表示正文。 */
export interface ParaBlock {
  kind: 'p'
  level: ParaLevel
  /** 打开时的级别。与 level 不同才说明用户改过，此时才需要重写 pStyle。 */
  origLevel: ParaLevel
  align: ParaAlign
  runs: DocRun[]
  /** 原始 `<w:pPr>` 片段，写回时原样用（样式/缩进/行距全在里面）。 */
  pPrXml: string
  /** 原始 pStyle 的 w:val；改标题级别时用它对比"到底变了没"。 */
  styleVal: string | null
}

/**
 * 列表项。
 *
 * ⚠️ 编号的**形式**（圆点 / 1. 2. 3. / 甲乙丙）由 numbering.xml 定义，
 * 我们不去重写它 —— 所以这里只记"它是列表项"，pPr（含 numPr）原样回写，
 * 输出文件里的编号还是原来的样子。`ordered` 只影响本界面的显示。
 */
export interface ListBlock {
  kind: 'list'
  level: number
  ordered: boolean
  runs: DocRun[]
  pPrXml: string
}

/** 表格。单元格是纯文本（多段用换行分隔）。 */
export interface TableBlock {
  kind: 'table'
  rows: string[][]
  prXml: string
  gridXml: string
}

/**
 * 只读块：图片、图表、文本框、复杂对象等没被建模的内容。
 *
 * 它在界面上标注为只读，保存时**原样写回** —— 于是图片不会丢。
 * 这是"宁可不让你改，也不能给你改没了"。
 */
export interface RawBlock {
  kind: 'raw'
  /** 为什么不能编辑（给用户看的一句话）。 */
  note: string
  /** 从原始 XML 里抽出的文字，供界面显示一个预览。 */
  text: string
  xml: string
}

export type DocBlock = ParaBlock | ListBlock | TableBlock | RawBlock

// ---------------------------------------------------------------- 文档对象

/** 新文档用的命名空间声明（多余的声明无害，缺了反而会让图片等元素认不出来）。 */
const ROOT_ATTRS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
].join(' ')

const REL_HYPERLINK =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'

/** 打开一份 Word 文档。 */
export function loadDocument(bytes: ArrayBuffer | Uint8Array): WordDocument {
  const entries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  const main = entries['word/document.xml']
  if (!main) throw new Error('这不是 Word 文档（缺少 word/document.xml）')
  return WordDocument.parse(strFromU8(main), entries)
}

/** 新建一份空白文档。 */
export function createDocument(): WordDocument {
  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`),
    'word/numbering.xml': strToU8(NUMBERING),
    // 显式定义标题样式：内置的 "Heading1" 各家编辑器都能认，
    // 但写死一份字号/颜色更可控，免得不同软件打开长得不一样
    'word/styles.xml': strToU8(STYLES),
  }
  return new WordDocument(
    [{ kind: 'p', level: 0, origLevel: 0, align: null, runs: [], pPrXml: '', styleVal: null }],
    '',
    entries,
  )
}

export class WordDocument {
  blocks: DocBlock[]
  /** 原始 `<w:sectPr>`（页面大小、页边距、分栏…），写回时放在 body 末尾。 */
  private sectPrXml: string
  /** zip 里的其余部件（styles / media / header / rels…），原样保留。 */
  private entries: Record<string, Uint8Array>
  /** styleId → 标题级别（来自 styles.xml）。 */
  private headingStyles: Map<string, number>
  /** numId → 是否有序（来自 numbering.xml）。 */
  private numbering: Map<string, boolean>
  private relsXml: string | null
  private relsSeq: number

  constructor(
    blocks: DocBlock[],
    sectPrXml: string,
    entries: Record<string, Uint8Array>,
    headingStyles: Map<string, number> = new Map(),
    numbering: Map<string, boolean> = new Map(),
  ) {
    this.blocks = blocks
    this.sectPrXml = sectPrXml
    this.entries = entries
    this.headingStyles = headingStyles
    this.numbering = numbering
    this.relsXml = null
    this.relsSeq = 0
  }

  // ------------------------------------------------------------ 解析

  static parse(xml: string, entries: Record<string, Uint8Array>): WordDocument {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('文档内容解析失败，文件可能已损坏')
    }
    const body = children(doc.documentElement).find((el) => el.localName === 'body')
    if (!body) throw new Error('文档里没有正文（缺少 w:body）')

    const headingStyles = parseHeadingStyles(entries['word/styles.xml'])
    const numbering = parseNumbering(entries['word/numbering.xml'])
    const rels = parseRels(entries['word/_rels/document.xml.rels'])

    const blocks: DocBlock[] = []
    let sectPrXml = ''
    walkBlocks(body, blocks, headingStyles, numbering, rels)
    const sect = children(body).find((el) => el.localName === 'sectPr')
    if (sect) sectPrXml = new XMLSerializer().serializeToString(sect)

    return new WordDocument(blocks, sectPrXml, entries, headingStyles, numbering)
  }

  // ------------------------------------------------------------ 编辑

  /** 在 `index` 这个块之后插入一个空段落。 */
  insertParagraphAfter(index: number): number {
    const block: ParaBlock = {
      kind: 'p',
      level: 0,
      origLevel: 0,
      align: null,
      runs: [{ text: '' }],
      pPrXml: '',
      styleVal: null,
    }
    this.blocks.splice(index + 1, 0, block)
    return index + 1
  }

  /** 删除一个块（至少保留一个，否则会得到一个没有段落的空文档）。 */
  removeBlock(index: number): void {
    if (this.blocks.length <= 1) return
    this.blocks.splice(index, 1)
  }

  /**
   * 找一个"无序列表"的编号定义，供新增的列表项复用。
   *
   * 编号的外形（圆点、缩进）由 `numbering.xml` 决定，我们不会凭空造一份：
   * 造出来的 numId 在 Word 里很可能只是"一个没有定义的编号"，看起来就是
   * 段落前面空一块。所以没有现成的就如实返回 null，由界面告诉用户为什么。
   */
  bulletNumId(): string | null {
    for (const [id, ordered] of this.numbering) {
      if (!ordered) return id
    }
    return null
  }

  /**
   * 新增一个超链接关系，返回它的 r:id。
   *
   * ⚠️ 只接受 http/https/mailto。
   * 文档里的链接是"打开文档的人会去点"的东西，放行 `javascript:` 之类的
   * 协议等于把一段脚本塞进别人信任的文档里。
   */
  addHyperlink(url: string): string | null {
    const trimmed = url.trim()
    if (!/^(https?:\/\/|mailto:)/i.test(trimmed)) return null
    if (/["<>\n\r]/.test(trimmed)) return null

    const raw = this.relsXml ?? strFromU8(this.entries['word/_rels/document.xml.rels'] ?? new Uint8Array())
    const base = raw.trim() ? raw : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
    this.relsSeq += 1
    const id = `rIdEdit${Date.now().toString(36)}${this.relsSeq}`
    const entry = `<Relationship Id="${id}" Type="${REL_HYPERLINK}" Target="${escapeXml(trimmed)}" TargetMode="External"/>`
    this.relsXml = base.includes('</Relationships>')
      ? base.replace('</Relationships>', `${entry}</Relationships>`)
      : base.replace(/(<Relationships\b[^>]*>)/, `$1${entry}`)
    return id
  }

  // ------------------------------------------------------------ 序列化

  /** 生成 .docx 字节。 */
  toBytes(): Uint8Array {
    const xml = this.toDocumentXml()
    const files: Record<string, Uint8Array> = {}

    // 顺序有讲究：`word/` 这个名字要出现在文件开头几 KB 内 ——
    // 服务端的类型嗅探（server/src/mime.ts）靠前 4KB 里的条目名区分 docx 与 zip。
    // 顺序弄反了，保存完的文件会被认成 application/zip，从此点不出编辑入口。
    for (const key of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
      const value = key === 'word/document.xml' ? strToU8(xml) : this.entries[key]
      if (value) files[key] = value
    }
    for (const [key, value] of Object.entries(this.entries)) {
      if (key in files) continue
      files[key] = value
    }
    if (this.relsXml) files['word/_rels/document.xml.rels'] = strToU8(this.relsXml)

    return zipSync(files, { level: 6 })
  }

  private toDocumentXml(): string {
    const body = this.blocks
      .map((block) => {
        switch (block.kind) {
          case 'p':
            return paragraphXml(block, this.styleForLevel(block.level))
          case 'list':
            return `<w:p>${block.pPrXml}${runsXml(block.runs)}</w:p>`
          case 'table':
            return tableXml(block)
          case 'raw':
            return block.xml
        }
      })
      .join('')
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${ROOT_ATTRS}><w:body>${body}${this.sectPrXml}</w:body></w:document>`
  }

  /**
   * 标题级别 → 这份文档里真正存在的 styleId。
   *
   * 优先用文档自己的（中文模板里叫「标题 1」，英文模板里叫 "Heading 1"，
   * 直接写死 Heading1 会让中文文档的标题丢掉原有样式），
   * 认不出来才退回内置名 —— 各家编辑器都认内置名。
   */
  private styleForLevel(level: ParaLevel): string | null {
    if (level === 0) return null
    for (const [id, lv] of this.headingStyles) if (lv === level) return id
    return `Heading${level}`
  }
}

// ---------------------------------------------------------------- 解析辅助

function walkBlocks(
  parent: Element,
  out: DocBlock[],
  headingStyles: Map<string, number>,
  numbering: Map<string, boolean>,
  rels: Map<string, string>,
): void {
  for (const el of children(parent)) {
    switch (el.localName) {
      case 'p':
        out.push(parseParagraph(el, headingStyles, numbering, rels))
        break
      case 'tbl':
        out.push(parseTable(el))
        break
      case 'sdt': {
        // 结构化文档标签（封面、目录、引用块…）：里面的内容还是段落与表格
        const content = children(el).find((c) => c.localName === 'sdtContent')
        if (content) walkBlocks(content, out, headingStyles, numbering, rels)
        break
      }
      default:
        // sectPr / bookmarkStart / proofErr 等不构成可见内容，跳过
        break
    }
  }
}

function parseParagraph(
  el: Element,
  headingStyles: Map<string, number>,
  numbering: Map<string, boolean>,
  rels: Map<string, string>,
): DocBlock {
  const pPr = children(el).find((c) => c.localName === 'pPr')
  const pPrXml = pPr ? new XMLSerializer().serializeToString(pPr) : ''
  const runs: DocRun[] = []
  collectRuns(el, null, runs, rels)

  // 含图片/图表/公式/文本框的段落不建模：原样保留，避免"改了字、图没了"
  if (hasEmbeddedObject(el)) {
    return {
      kind: 'raw',
      note: '这一段里有图片或图表等无法在线编辑的内容，已原样保留',
      text: plainTextOf(el),
      xml: new XMLSerializer().serializeToString(el),
    }
  }

  if (pPr) {
    const numPr = children(pPr).find((c) => c.localName === 'numPr')
    if (numPr) {
      const ilvl = attrOf(children(numPr).find((c) => c.localName === 'ilvl'), 'w:val')
      const numId = attrOf(children(numPr).find((c) => c.localName === 'numId'), 'w:val')
      return {
        kind: 'list',
        level: ilvl ? Number.parseInt(ilvl, 10) + 1 : 1,
        ordered: numId ? (numbering.get(numId) ?? false) : false,
        runs,
        pPrXml,
      }
    }
  }

  const styleVal = pPr ? attrOf(children(pPr).find((c) => c.localName === 'pStyle'), 'w:val') : null
  const rawLevel = styleVal ? (headingStyles.get(styleVal) ?? 0) : 0
  const level = (rawLevel >= 1 && rawLevel <= 6 ? rawLevel : 0) as ParaLevel
  const jc = pPr ? attrOf(children(pPr).find((c) => c.localName === 'jc'), 'w:val') : null
  return {
    kind: 'p',
    level,
    origLevel: level,
    align: jc === 'center' || jc === 'right' || jc === 'both' ? (jc === 'both' ? 'justify' : jc) : null,
    runs,
    pPrXml,
    styleVal,
  }
}

function parseTable(el: Element): DocBlock {
  // 三种表格不建模，整段原样保留：
  //   ① 单元格里有图片 / 图表 / OLE；
  //   ② 嵌套表格（内层表格的单元格不在我们重建的范围里，重建会把它压成纯文本）；
  //   ③ 有合并单元格（gridSpan / vMerge）—— 重建会把合并拆掉，列宽跟着错位。
  // 这三件事的共同点是"重建之后看起来像坏了"，而用户只会觉得是我们弄坏的。
  const merged = descendants(el, 'gridSpan').length > 0 || descendants(el, 'vMerge').length > 0
  const nested = descendants(el, 'tbl').length > 1
  if (hasEmbeddedObject(el) || merged || nested) {
    const why = nested
      ? '这个表格里嵌了另一个表格'
      : merged
        ? '这个表格有合并单元格'
        : '这个表格里有图片或图表'
    return {
      kind: 'raw',
      note: `${why}，已原样保留（这类表格暂不支持在线编辑单元格）`,
      text: plainTextOf(el),
      xml: new XMLSerializer().serializeToString(el),
    }
  }
  const rows: string[][] = []
  for (const tr of children(el).filter((c) => c.localName === 'tr')) {
    const cells: string[] = []
    for (const tc of children(tr).filter((c) => c.localName === 'tc')) {
      const paras = children(tc).filter((c) => c.localName === 'p')
      cells.push(paras.map(plainTextOf).join('\n'))
    }
    rows.push(cells)
  }
  const prXml = children(el).find((c) => c.localName === 'tblPr')
    ? new XMLSerializer().serializeToString(children(el).find((c) => c.localName === 'tblPr')!)
    : ''
  const grid = children(el).find((c) => c.localName === 'tblGrid')
  return {
    kind: 'table',
    rows,
    prXml,
    gridXml: grid ? new XMLSerializer().serializeToString(grid) : '',
  }
}

/** 递归收集 run，遇到 hyperlink 时把它的 r:id 带给里面的 run。 */
function collectRuns(
  parent: Element,
  linkId: string | null,
  out: DocRun[],
  rels: Map<string, string>,
): void {
  for (const el of children(parent)) {
    switch (el.localName) {
      case 'r': {
        const run = parseRun(el, linkId, rels)
        // 连续同格式的 run 合并，块模型小一点，界面上也少一些无意义的碎片
        const last = out[out.length - 1]
        if (last && sameFormat(last, run) && !last.text.endsWith('\n')) {
          last.text += run.text
        } else if (run.text !== '' || out.length === 0) {
          out.push(run)
        }
        break
      }
      case 'hyperlink':
        collectRuns(el, attrOf(el, 'r:id'), out, rels)
        break
      case 'ins':
      case 'smartTag':
      case 'sdtContent':
      case 'customXml':
      case 'dir':
      case 'bdo':
        collectRuns(el, linkId, out, rels)
        break
      default:
        break
    }
  }
}

function parseRun(el: Element, linkId: string | null, rels: Map<string, string>): DocRun {
  let text = ''
  for (const child of children(el)) {
    switch (child.localName) {
      case 't':
      case 'delText':
        text += child.textContent ?? ''
        break
      case 'br':
      case 'cr':
        text += '\n'
        break
      case 'tab':
        text += '\t'
        break
      default:
        break
    }
  }
  const rPr = children(el).find((c) => c.localName === 'rPr')
  const run: DocRun = { text: stripInvalidXmlChars(text) }
  if (rPr) {
    if (hasMark(rPr, 'b')) run.bold = true
    if (hasMark(rPr, 'i')) run.italic = true
    if (hasMark(rPr, 'strike') || hasMark(rPr, 'dstrike')) run.strike = true
    const u = children(rPr).find((c) => c.localName === 'u')
    if (u && attrOf(u, 'w:val') !== 'none') run.underline = true
  }
  if (linkId) {
    run.linkId = linkId
    const href = rels.get(linkId)
    if (href) run.href = href
  }
  return run
}

/** `<w:b/>` 这样的开关：没写 val 就是开，写了 0/false/off 才是关。 */
function hasMark(rPr: Element, name: string): boolean {
  const el = children(rPr).find((c) => c.localName === name)
  if (!el) return false
  const val = attrOf(el, 'w:val')
  return !(val === '0' || val === 'false' || val === 'off')
}

/** 段落/表格里有没有我们没建模的东西（图片、图表、OLE、公式…）。 */
function hasEmbeddedObject(el: Element): boolean {
  // ⚠️ 刻意**不**把 bookmarkStart 算进来。书签在 Word 里到处都是
  // （自动目录的 _Toc 锚点、交叉引用），把带书签的段落整段变成只读，
  // 结果是"一份普通文档里有大半不能编辑" —— 比丢掉一个书签糟得多。
  // 代价是重写这一段时会丢书签（目录需要重新更新，文档本身照样能打开）。
  const names = new Set(['drawing', 'pict', 'object', 'OLEObject', 'chart', 'textbox', 'txbxContent'])
  if (names.has(el.localName)) return true
  for (const child of children(el)) {
    if (hasEmbeddedObject(child)) return true
  }
  return false
}

function parseHeadingStyles(bytes: Uint8Array | undefined): Map<string, number> {
  const map = new Map<string, number>()
  if (!bytes) return map
  const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return map
  for (const style of descendants(doc.documentElement, 'style')) {
    const id = attrOf(style, 'w:styleId')
    if (!id) continue
    const nameEl = children(style).find((c) => c.localName === 'name')
    const name = attrOf(nameEl, 'w:val') ?? ''
    const basedOn = children(style).find((c) => c.localName === 'basedOn')
    const match = /(?:heading|标题|h)\s*([1-9])/i.exec(name) ?? /(?:heading|标题|h)\s*([1-9])/i.exec(attrOf(basedOn, 'w:val') ?? '')
    if (match?.[1]) map.set(id, Number.parseInt(match[1], 10))
  }
  return map
}

/**
 * 解析关系表：rId → 目标地址。
 *
 * 只为了把超链接的地址还原出来给界面显示 —— 写回时用的仍然是 rId，
 * 所以这里读不懂也不影响保存（链接会被保留，只是界面上不带下划线）。
 */
function parseRels(bytes: Uint8Array | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!bytes) return map
  const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return map
  for (const rel of descendants(doc.documentElement, 'Relationship')) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (id && target) map.set(id, target)
  }
  return map
}

function parseNumbering(bytes: Uint8Array | undefined): Map<string, boolean> {
  const map = new Map<string, boolean>()
  if (!bytes) return map
  const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return map
  const abstracts = new Map<string, boolean>()
  for (const abs of descendants(doc.documentElement, 'abstractNum')) {
    const id = attrOf(abs, 'w:abstractNumId')
    if (!id) continue
    // 只看第 0 级的编号格式，够判断"是有序还是无序"了
    let ordered = false
    for (const lvl of children(abs).filter((c) => c.localName === 'lvl')) {
      if ((attrOf(lvl, 'w:ilvl') ?? '0') !== '0') continue
      const fmt = children(lvl).find((c) => c.localName === 'numFmt')
      const val = attrOf(fmt, 'w:val') ?? ''
      ordered = val !== 'bullet' && val !== 'none' && val !== ''
      break
    }
    abstracts.set(id, ordered)
  }
  for (const num of descendants(doc.documentElement, 'num')) {
    const numId = attrOf(num, 'w:numId')
    const abs = children(num).find((c) => c.localName === 'abstractNumId')
    if (numId) map.set(numId, abstracts.get(attrOf(abs, 'w:val') ?? '') ?? false)
  }
  return map
}

// ---------------------------------------------------------------- 序列化辅助

function paragraphXml(block: ParaBlock, styleVal: string | null): string {
  // 标题级别没变 → 原样用原始 pPr（保住缩进、行距、对齐等一切）；
  // 只有用户真的改了级别，才去动 pStyle —— 动一次就意味着丢掉原始样式引用
  let pPr = block.pPrXml
  if (block.level !== block.origLevel) pPr = withPStyle(pPr, styleVal)
  if (block.align && !/<w:jc\b/.test(pPr)) pPr = withJc(pPr, block.align)
  return `<w:p>${pPr}${runsXml(block.runs)}</w:p>`
}

function withPStyle(pPrXml: string, val: string | null): string {
  const tag = `<w:pStyle w:val="${escapeXml(val ?? '')}"/>`
  const pattern = /<w:pStyle\b[^>]*\/?>(?:<\/w:pStyle>)?/
  if (val === null) {
    return pPrXml ? pPrXml.replace(pattern, '') : ''
  }
  if (pattern.test(pPrXml)) return pPrXml.replace(pattern, tag)
  // 正则里确实有捕获组，但 `open[1]` 在 noUncheckedIndexedAccess 下是
  // `string | undefined`，所以走一个显式的局部判断而不是直接把下标喂给 replace。
  const head = /^(<w:pPr\b[^>]*>)/.exec(pPrXml)?.[1]
  if (head) return pPrXml.replace(head, `${head}${tag}`)
  return `<w:pPr>${tag}</w:pPr>`
}

function withJc(pPrXml: string, align: Exclude<ParaAlign, null>): string {
  const val = align === 'justify' ? 'both' : align
  const tag = `<w:jc w:val="${val}"/>`
  const pattern = /<w:jc\b[^>]*\/?>(?:<\/w:jc>)?/
  if (pattern.test(pPrXml)) return pPrXml.replace(pattern, tag)
  const head = /^(<w:pPr\b[^>]*>)/.exec(pPrXml)?.[1]
  if (head) return pPrXml.replace(head, `${head}${tag}`)
  return `<w:pPr>${tag}</w:pPr>`
}

function runsXml(runs: DocRun[]): string {
  let out = ''
  let i = 0
  while (i < runs.length) {
    const linkId = runs[i]?.linkId ?? null
    let j = i
    while (j < runs.length && (runs[j]?.linkId ?? null) === linkId) j++
    const inner = runs.slice(i, j).map(runXml).join('')
    out += linkId ? `<w:hyperlink r:id="${escapeXml(linkId)}">${inner}</w:hyperlink>` : inner
    i = j
  }
  return out
}

function runXml(run: DocRun): string {
  const marks: string[] = []
  if (run.bold) marks.push('<w:b/>')
  if (run.italic) marks.push('<w:i/>')
  if (run.underline) marks.push('<w:u w:val="single"/>')
  if (run.strike) marks.push('<w:strike/>')
  const rPr = marks.length > 0 ? `<w:rPr>${marks.join('')}</w:rPr>` : ''
  const lines = run.text.split('\n')
  return lines
    .map((line, index) => {
      const br = index > 0 ? '<w:br/>' : ''
      const text = `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`
      return `<w:r>${rPr}${br}${text}</w:r>`
    })
    .join('')
}

function tableXml(block: TableBlock): string {
  const cols = block.rows.reduce((max, row) => Math.max(max, row.length), 1)
  const gridCols = (block.gridXml.match(/<w:gridCol\b/g) ?? []).length
  const pr = block.prXml || DEFAULT_TBL_PR
  // 列数对不上就重建 tblGrid：Word 会因为 grid 与行里的单元格数不一致而报错
  const grid =
    block.gridXml && gridCols === cols
      ? block.gridXml
      : `<w:tblGrid>${'<w:gridCol w:w="2880"/>'.repeat(cols)}</w:tblGrid>`
  const rows = block.rows
    .map((cells) => {
      const tcs: string[] = []
      for (let c = 0; c < cols; c++) {
        const paras = (cells[c] ?? '')
          .split('\n')
          .map((line) => `<w:p>${runXml({ text: line })}</w:p>`)
          .join('')
        tcs.push(
          `<w:tc><w:tcPr><w:tcW w:w="2880" w:type="dxa"/></w:tcPr>${paras}</w:tc>`,
        )
      }
      return `<w:tr>${tcs.join('')}</w:tr>`
    })
    .join('')
  return `<w:tbl>${pr}${grid}${rows}</w:tbl>`
}

// ---------------------------------------------------------------- 通用小工具

function children(el: Element | undefined | null): Element[] {
  if (!el) return []
  return Array.from(el.children)
}

function descendants(el: Element | undefined | null, local: string): Element[] {
  if (!el) return []
  const out: Element[] = []
  const stack: Element[] = [el]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.localName === local) out.push(node)
    for (const child of children(node)) stack.push(child)
  }
  return out
}

/** 取带命名空间前缀的属性（DOM 的 getAttribute 对 `w:val` 需要带前缀）。 */
function attrOf(el: Element | undefined | null, name: string): string | null {
  if (!el) return null
  return el.getAttribute(name) ?? el.getAttribute(name.replace('w:', '')) ?? null
}

function plainTextOf(el: Element): string {
  let out = ''
  for (const t of descendants(el, 't')) out += t.textContent ?? ''
  return out
}

/**
 * XML 转义 + 去掉非法字符。
 *
 * ⚠️ 去非法字符这一步不能省：用户从别处粘进来一个控制字符（\u0007 之类），
 * 拼进 XML 之后整份文档就**打不开了**（Word 会报"内容有问题"）。
 * 而那看起来像是"编辑器把我的文档弄坏了"，很难想到是一个看不见的字符。
 */
function escapeXml(text: string): string {
  return stripInvalidXmlChars(text).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&apos;'
    }
  })
}

function stripInvalidXmlChars(text: string): string {
  // 只保留制表符与换行：其余 C0 控制字符在 XML 1.0 里都是非法的
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function sameFormat(a: DocRun, b: DocRun): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    (a.linkId ?? null) === (b.linkId ?? null)
  )
}

// ---------------------------------------------------------------- 新文档骨架

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`

/**
 * 新建表格的默认属性。
 *
 * 刻意**不依赖** `TableGrid` 样式：那是 Word 内置样式，但目标机器上如果没有
 * （某些精简版 WPS、或者文档自身 styles.xml 覆盖过），表格就成了没有边框的
 * 一片空白 —— 用户会以为表格没插进去。这里把边框写死，任何软件打开都有线。
 */
const DEFAULT_TBL_PR = `<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>
<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>
</w:tblBorders></w:tblPr>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${ROOT_ATTRS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
</w:styles>`

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${ROOT_ATTRS}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`
