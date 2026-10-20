/**
 * .xlsx 的读改写 —— 在线表格编辑器的底层。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么用 ExcelJS 而不是自己拼 OOXML
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 一份真实社团表格（WPS / Excel 导出的 .xlsx）里装着的东西远不止"格子里的字"：
 * 单元格样式、列宽、合并单元格、数字格式、公式、多张工作表、条件格式……
 *
 * 自己拼一个"最小 xlsx 写入器"只要两三百行就能跑通，但它每次保存都会把上面
 * 这些**全部抹掉**：改一个数字，整张表的表头配色、边框、列宽一起没了。
 * 对"在线编辑"来说这不是瑕疵，是**不可用** —— 用户改一格再下载，
 * 发现格式全乱，下次就再也不在这里改了。
 *
 * 所以这里保留 ExcelJS 的 workbook 对象作为真相：
 *   - 读取时只在它上面读值渲染界面；
 *   - 编辑时只改被编辑的那一个单元格（或做一次 splice）；
 *   - 保存时把整个 workbook 原样序列化回去。
 * 没被碰过的单元格、样式、公式，字节层面就还是原来那些字节。
 *
 * 代价是这颗依赖有约 950KB（min）。它被**按需加载**（编辑器窗口是异步组件，
 * 只有真的打开表格时才下载这个 chunk），不进桌面首屏。
 */

import ExcelJS from 'exceljs'
import type { CellValue, Workbook, Worksheet } from 'exceljs'

/**
 * 渲染列数上限。
 *
 * 超过就不再画（界面会提示）。这不是内容上限 —— 表里那么多列仍然会原样保存，
 * 只是在浏览器里一屏画几百列既看不清也会把标签页拖死。
 */
export const SHEET_MAX_RENDER_COLS = 64

/**
 * 表格至少画多少行 / 多少列。
 *
 * 一份新建的空白表在文件里是 0 行 0 列，照实画出来就是**一个 1×1 的格子** ——
 * 用户看着一个孤零零的方块，不知道该往哪写。表格软件在这里的约定都是
 * "先给你一大片空格子"：这里给 50 行 × 12 列，够写日常表格，也不会一次
 * 生成几千个 DOM 节点。
 *
 * 注意这只是**显示范围**：超出实际尺寸的格子读出来是空串、不会凭空创建单元格
 * （ExcelJS 的 getCell 是"取不到就建一个"），写进去时才真的建。
 */
const MIN_DISPLAY_ROWS = 50
const MIN_DISPLAY_COLS = 12

/** 单元格里的值类型。 */
export type CellVal = CellValue

/**
 * 打开一份表格。
 *
 * @param bytes 文件字节（.xlsx）
 * @throws 内容不是合法 xlsx 时抛错，由调用方决定怎么呈现
 */
export async function loadSpreadsheet(bytes: ArrayBuffer | Uint8Array): Promise<Spreadsheet> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as ArrayBuffer)
  const first = workbook.worksheets[0]
  if (!first) throw new Error('这个文件里没有工作表')
  return new Spreadsheet(workbook, first)
}

/** 新建一份空白表格（供「新建表格」用）。 */
export function createSpreadsheet(sheetName = 'Sheet1'): Spreadsheet {
  const workbook = new ExcelJS.Workbook()
  workbook.created = new Date()
  const sheet = workbook.addWorksheet(sheetName)
  return new Spreadsheet(workbook, sheet)
}

/**
 * 一份打开着的表格。
 *
 * ⚠️ 这个对象**不要放进 Vue 的响应式系统**（ref/reactive）：workbook 是一张
 * 有几千个对象的深图，被 Proxy 包一层之后每次编辑都会触发海量依赖追踪，
 * 界面会肉眼可见地卡。调用方只把它当"一个句柄"，界面状态另行维护。
 */
export class Spreadsheet {
  readonly workbook: Workbook
  private sheet: Worksheet

  constructor(workbook: Workbook, sheet: Worksheet) {
    this.workbook = workbook
    this.sheet = sheet
  }

  /** 所有工作表的名字，顺序与文件里一致。 */
  get sheetNames(): string[] {
    return this.workbook.worksheets.map((ws) => ws.name)
  }

  get activeName(): string {
    return this.sheet.name
  }

  /** 切换当前工作表。名字不存在时不切换（返回 false）。 */
  select(name: string): boolean {
    const target = this.workbook.worksheets.find((ws) => ws.name === name)
    if (!target) return false
    this.sheet = target
    return true
  }

  /** 界面上的行数（含为了"能写字"而留出的空白行，见 MIN_DISPLAY_ROWS）。 */
  get rowCount(): number {
    return Math.max(MIN_DISPLAY_ROWS, this.sheet.rowCount, 1)
  }

  get columnCount(): number {
    return Math.max(MIN_DISPLAY_COLS, this.sheet.columnCount, 1)
  }

  /**
   * 读取一块区域的显示文本。
   *
   * 行号是 **1 起**（与 Excel 一致），`start` 是要读的第一行，`count` 是要读几行。
   * 编辑器靠它做"只渲染看得见的那几十行"，上万行的表也不会卡。
   */
  readRows(start: number, count: number): string[][] {
    const cols = Math.min(this.columnCount, SHEET_MAX_RENDER_COLS)
    const out: string[][] = []
    const end = Math.min(this.rowCount, start + count - 1)
    // 实际有内容的范围。超出这个范围直接给空串而**不去调 getCell** ——
    // ExcelJS 的 getCell 是"没有就建一个"，滚动几千次就等于往 workbook 里
    // 塞进几万个空单元格，既慢又会让保存出来的文件莫名其妙地变大。
    const realRows = this.sheet.rowCount
    const realCols = this.sheet.columnCount
    for (let r = start; r <= end; r++) {
      const row: string[] = []
      for (let c = 1; c <= cols; c++) {
        row.push(r <= realRows && c <= realCols ? displayValue(this.sheet.getCell(r, c).value) : '')
      }
      out.push(row)
    }
    return out
  }

  /** 单个单元格的显示文本（1 起）。 */
  cellText(row: number, col: number): string {
    return displayValue(this.sheet.getCell(row, col).value)
  }

  /** 单元格在文件里的原始值，界面上"公式栏"用得到。 */
  cellValue(row: number, col: number): CellVal {
    return this.sheet.getCell(row, col).value
  }

  /** 整列的表头提示（第 1 行的文本），鼠标悬停列标时用。 */
  headerText(col: number): string {
    return this.cellText(1, col)
  }

  /**
   * 写入一个单元格。
   *
   * 输入永远是字符串（来自输入框），这里负责"它到底该是什么类型"：
   *   - 空 → null（清空单元格，而不是留下一个空字符串）
   *   - `=` 开头 → 公式（原样写进文件，值由 Excel/WPS 打开时计算）
   *   - 长得像数字 → 数字（否则 SUM 之类的公式会把它当文本跳过）
   *   - 其余 → 文本
   */
  setCellText(row: number, col: number, text: string): void {
    this.sheet.getCell(row, col).value = parseInput(text)
  }

  /** 直接写原始值（撤销/恢复时用，不经过字符串解析）。 */
  setCellValue(row: number, col: number, value: CellVal): void {
    this.sheet.getCell(row, col).value = value
  }

  /** 在 `at` 这一行**之前**插入一行。 */
  insertRow(at: number): void {
    this.sheet.spliceRows(at, 0, [])
  }

  /** 删除 `at` 这一行。 */
  deleteRow(at: number): void {
    if (this.rowCount <= 1) return
    this.sheet.spliceRows(at, 1)
  }

  /** 在 `at` 这一列**之前**插入一列。 */
  insertColumn(at: number): void {
    const blank: unknown[] = new Array(Math.max(1, this.rowCount)).fill(null)
    this.sheet.spliceColumns(at, 0, [blank])
  }

  /** 删除 `at` 这一列。 */
  deleteColumn(at: number): void {
    if (this.columnCount <= 1) return
    this.sheet.spliceColumns(at, 1)
  }

  /** 序列化成 .xlsx 字节。 */
  async toBytes(): Promise<Uint8Array> {
    const buffer = await this.workbook.xlsx.writeBuffer()
    return new Uint8Array(buffer)
  }
}

/**
 * 把单元格值变成界面上显示的文本。
 *
 * 只影响**显示**：文件里存的还是原始类型，保存时不经过这里。
 */
export function displayValue(value: CellVal): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return numberText(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Date) return dateText(value)

  // 这里 value 是 exceljs 的 CellErrorValue / CellRichTextValue / CellFormulaValue 等
  // 联合类型里剩下的那几支，它们没有共同的索引签名，直接转 Record 会被 TS 拦下。
  // 只看 formula / sharedFormula / result 三个可选字段，用 unknown 中转是安全的。
  const obj = value as unknown as Record<string, unknown>
  // 公式：文件里可能同时存着上次算出的结果，有就显示结果，
  // 没有（我们刚写进去的公式）就显示公式本身 —— 显示成空会让人以为格子坏了
  if (typeof obj.formula === 'string') {
    return obj.result === undefined || obj.result === null
      ? `=${obj.formula}`
      : displayValue(obj.result as CellVal)
  }
  if (typeof obj.sharedFormula === 'string') {
    return obj.result === undefined || obj.result === null
      ? `=${obj.sharedFormula}`
      : displayValue(obj.result as CellVal)
  }
  // 富文本：一个格子里几种不同格式的字
  if (Array.isArray(obj.richText)) {
    return (obj.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('')
  }
  // 超链接：{ text, hyperlink }
  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.error === 'string') return `#${obj.error}`
  return ''
}

/**
 * 数字显示。
 *
 * 刻意不做"按 Excel 的数字格式渲染"（百分比、货币、千分位）：那需要实现一整套
 * numFmt 解析，而**格式本身仍然原样保存在文件里**，只是本界面显示原始值 ——
 * 界面上写的是 0.15 而 Excel 里显示 15%，是"显示不同"，不是"数据不同"。
 * 把这层差异藏在"看起来一样"的假象里反而更危险。
 */
function numberText(value: number): string {
  if (!Number.isFinite(value)) return '#NUM!'
  // 整数不用科学计数法：1e21 这样的数 Excel 里就是那么存的，
  // 但界面上显示 1e+21 比显示原值更让人困惑，交给 String() 的默认规则即可
  return String(value)
}

function dateText(value: Date): string {
  if (Number.isNaN(value.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const h = value.getHours()
  const m = value.getMinutes()
  return h || m ? `${day} ${pad(h)}:${pad(m)}` : day
}

/**
 * 把输入框里的字符串解释成一个单元格值。
 *
 * 判数字的正则刻意**窄**：只有"整数或小数、没有前导零、不超过 15 位"才当数字。
 * 因为把 "007"（工号）、"0012"（房间号）、一长串订单号自动转成数字，
 * 会**真的改掉数据** —— 前导零一去不回。宁可让它们保持文本（求和时被跳过，
 * 用户能立刻看出来），也不要悄悄改数据。
 */
export function parseInput(text: string): CellVal {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('=')) return { formula: trimmed.slice(1) }
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const lower = trimmed.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  return text
}

/**
 * 列号 → 列名（1 → A，27 → AA）。
 *
 * 表格编辑器要用它画列标，而 Excel 的列标就是这个 26 进制 —— 注意它不是普通的
 * 进制转换：没有表示 0 的符号，所以每次都要先减 1。
 */
export function columnName(index: number): string {
  let n = index
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out || 'A'
}
