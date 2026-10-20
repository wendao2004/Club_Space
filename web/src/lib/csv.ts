/**
 * 分隔符文本（CSV / TSV / 分号分隔）的解析。
 *
 * 只做预览需要的那一件事：把一段文本变成「表头 + 行」，不多做类型转换、
 * 不做公式、不做编码侦测（浏览器 fetch 已经按 UTF-8 解出来了）。
 *
 * 为什么不引 PapaParse 之类的库：
 *   ① 预览只是看一眼，要的是"不会看错"，不是"支持全部 RFC 4180 边角"；
 *   ② 这份文件要能被 `scripts/csv-parser-test.mjs` 直接 import 跑断言，
 *      而 Node 只能直跑 .ts、跑不了依赖解析（'@/' 别名）与打包产物。
 */

/** 参与自动识别的分隔符。竖线也列进来是因为导出的对账单常用它。 */
const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const

export interface ParsedTable {
  /** 实际使用的分隔符（自动识别的结果） */
  delimiter: string
  /**
   * 表头。**可能为 null**：判定不出表头时（例如全是数字、或有空单元格）
   * 所有行都算数据行，界面就不画表头 —— 比"硬把第一行当表头"更不容易看错。
   */
  header: string[] | null
  rows: string[][]
  /** 因超过 maxRows 而被截断 */
  truncated: boolean
  /** 截断前的总行数（不含被判定为表头的那一行） */
  totalRows: number
}

export interface ParseOptions {
  /** 最多解析多少**数据行**。超出即停止，避免 10 万行的表把界面卡死。 */
  maxRows?: number
  /** 强制指定分隔符，跳过自动识别 */
  delimiter?: string
}

/** 剥掉 UTF-8 BOM。Excel 导出的 CSV 几乎都带，不剥的话第一列表头会带个乱码前缀。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 数一行里**引号外**出现了几次分隔符。 */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      // CSV 里转义的引号是两个连着的 ""，它**不**切换引号状态
      if (inQuotes && line[i + 1] === '"') i++
      else inQuotes = !inQuotes
    } else if (!inQuotes && ch === delimiter) {
      count++
    }
  }
  return count
}

/**
 * 自动识别分隔符。
 *
 * 打分而不是"谁出现次数多谁赢"：一份中文说明里逗号可能比制表符多得多，
 * 但它在**每一行**里出现的次数是稳定的 —— 所以「列数一致」给 10 倍权重，
 * 宁可选一个出现少但列数稳定的分隔符。
 */
export function detectDelimiter(text: string): string {
  const sample = stripBom(text).split(/\r\n|\r|\n/).filter((l) => l.trim() !== '').slice(0, 5)
  if (sample.length === 0) return ','

  let best: string = ','
  let bestScore = -1
  for (const delimiter of DELIMITER_CANDIDATES) {
    const counts = sample.map((line) => countOutsideQuotes(line, delimiter))
    const nonZero = counts.filter((c) => c > 0)
    if (nonZero.length === 0) continue
    const consistent = nonZero.every((c) => c === nonZero[0])
    const score = nonZero[0] * (consistent ? 10 : 1)
    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }
  return best
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/

/**
 * 第一行是不是表头。
 *
 * 判据刻意保守：只有「每格都非空、且没有一格像数字、且至少两列」才认作表头。
 * 认错成表头的代价是**第一行数据被当成列名**，用户会以为少了一行；
 * 而漏认表头只是少了一条加粗，看不出问题。所以宁可漏认。
 */
function looksLikeHeader(first: string[]): boolean {
  if (first.length < 2) return false
  return first.every((cell) => cell.trim() !== '' && !NUMBER_RE.test(cell.trim()))
}

/**
 * 解析分隔符文本。
 *
 * 用**状态机**而不是 `split(delimiter)`：后者遇到 `a,"b,c",d` 会切出 4 段，
 * 遇到字段里换行的多行地址会直接错位 —— 这两种在真实导出里都很常见。
 */
export function parseDelimited(text: string, options: ParseOptions = {}): ParsedTable {
  const maxRows = options.maxRows ?? 1000
  const body = stripBom(text)
  const delimiter = options.delimiter ?? detectDelimiter(body)

  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let totalRows = 0

  // 多收一行：maxRows 说的是**数据行**，而表头要等解析完才知道有没有，
  // 先按"可能有表头"留一个位置，最后再决定怎么切。
  const keep = maxRows + 1

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    // 全是空串的一行（文件末尾的换行、或空行）不算一行数据
    if (row.some((cell) => cell !== '')) {
      if (rows.length < keep) rows.push(row)
      // ⚠️ 计数**不**受上限影响：totalRows 要能回答"一共多少行"，
      // 界面靠它显示"共 5000 行，只显示前 1000 行"。
      totalRows++
    }
    row = []
  }

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
    } else if (ch === delimiter) {
      endField()
    } else if (ch === '\n') {
      // \r\n 的 \r 在上一轮就被下面的分支吞掉了，这里只处理 LF 与裸 CR
      endRow()
    } else if (ch === '\r') {
      if (body[i + 1] === '\n') i++
      endRow()
    } else {
      field += ch
    }
  }
  // 收尾：文件末尾没有换行时，最后一行还没结束
  if (field !== '' || row.length > 0) endRow()

  const first = rows[0]
  const hasHeader = first ? looksLikeHeader(first) : false
  const dataTotal = hasHeader ? totalRows - 1 : totalRows
  let dataRows = hasHeader ? rows.slice(1) : rows
  if (dataRows.length > maxRows) dataRows = dataRows.slice(0, maxRows)

  return {
    delimiter,
    header: hasHeader ? first! : null,
    rows: dataRows,
    // 唯一判据：真实数据行数比交出去的多就是被截断了。
    // 不要在"解析到第 N 行"的那一刻记账 —— 那时还不知道第一行算不算表头。
    truncated: dataTotal > dataRows.length,
    totalRows: dataTotal,
  }
}
