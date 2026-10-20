/**
 * CSV / 分隔符文本解析器的断言测试。
 *
 * 直接 `import('../web/src/lib/csv.ts')` —— Node 从 22.18 起默认剥离类型，
 * 不需要 --experimental-strip-types，也不需要打包。它跑的是**界面真正会用的
 * 那一份代码**，而不是测试里另写一份副本。
 *
 * 只测解析：预览窗口的其他部分靠 ui-smoke-test（真实 Chrome）。
 */
import { parseDelimited, detectDelimiter, stripBom } from '../web/src/lib/csv.ts'

let passed = 0
let failed = 0

function assert(cond, label, detail = '') {
  if (cond) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${label}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

console.log('\n\x1b[1mCSV / 分隔符解析\x1b[0m')

// ---------------------------------------------------------------- 基本解析
console.log('\n【基本解析】')
{
  const r = parseDelimited('name,age\n张三,20\n李四,21')
  assert(r.delimiter === ',', '自动识别逗号', r.delimiter)
  assert(r.header !== null && r.header.join('|') === 'name|age', '表头正确', JSON.stringify(r.header))
  assert(r.rows.length === 2, '两行数据', String(r.rows.length))
  assert(r.rows[0].join('|') === '张三|20', '中文与数字分开', JSON.stringify(r.rows[0]))
  assert(r.totalRows === 2, 'totalRows 不含表头', String(r.totalRows))
  assert(!r.truncated, '未截断')
}

// ---------------------------------------------------------------- 引号
console.log('\n【引号与转义 —— split(",") 会在这里翻车】')
{
  const r = parseDelimited('名称,备注\n电脑,"联想, 16G, 512G"\n显示器,"说明里有个""引号"""')
  assert(r.rows[0].length === 2, '引号内的逗号不切分（仍是 2 列）', String(r.rows[0].length))
  assert(r.rows[0][1] === '联想, 16G, 512G', '引号内的逗号原样保留', r.rows[0][1])
  assert(r.rows[1][1] === '说明里有个"引号"', '两个连续引号还原成一个', r.rows[1][1])
}

// ---------------------------------------------------------------- 字段内换行
console.log('\n【字段内换行】')
{
  const r = parseDelimited('a,b\n"第一行\n第二行",x')
  assert(r.rows.length === 1, '引号内的换行不产生新行', String(r.rows.length))
  assert(r.rows[0][0] === '第一行\n第二行', '多行字段内容完整', JSON.stringify(r.rows[0][0]))
}

// ---------------------------------------------------------------- 分隔符识别
console.log('\n【分隔符自动识别】')
{
  assert(detectDelimiter('a\tb\tc\n1\t2\t3') === '\t', 'TSV 识别制表符')
  assert(detectDelimiter('a;b;c\n1;2;3') === ';', '识别分号（欧洲 CSV 常见）')

  // 中文说明里逗号比制表符多，但列数不稳定 —— 一致性要给更高权重
  const tricky = '姓名\t部门\t备注\n张三\t技术部\t会用逗号,也会用分号;还写了很多字'
  assert(detectDelimiter(tricky) === '\t', '列数稳定优先于出现次数', detectDelimiter(tricky))

  const r = parseDelimited(tricky)
  assert(r.rows[0].length === 3, '按识别到的制表符切出 3 列', String(r.rows[0].length))
  assert(r.rows[0][2].includes('逗号'), '中文里的逗号没有被当成分隔符', r.rows[0][2])
}

// ---------------------------------------------------------------- 换行符
console.log('\n【换行符与结尾】')
{
  const crlf = parseDelimited('a,b\r\n1,2\r\n3,4\r\n')
  assert(crlf.rows.length === 2, 'CRLF 正常，末尾换行不产生空行', String(crlf.rows.length))
  assert(crlf.rows[1].join('|') === '3|4', '最后一行不以换行结尾也能读到')

  const cr = parseDelimited('a,b\r1,2\r')
  assert(cr.rows.length === 1 && cr.rows[0].join('|') === '1|2', '老式 CR 换行', JSON.stringify(cr.rows))

  const noEol = parseDelimited('a,b\n1,2')
  assert(noEol.rows.length === 1 && noEol.rows[0].join('|') === '1|2', '文件末尾没有换行')
}

// ---------------------------------------------------------------- BOM
console.log('\n【BOM】')
{
  assert(stripBom('\ufeffa') === 'a', 'stripBom 剥离 BOM')
  const r = parseDelimited('\ufeff姓名,金额\n张三,100')
  assert(r.header !== null && r.header[0] === '姓名', '带 BOM 的表头不带乱码前缀', JSON.stringify(r.header))
}

// ---------------------------------------------------------------- 表头判定
console.log('\n【表头判定（宁可漏认）】')
{
  const noHeader = parseDelimited('1,2\n3,4')
  assert(noHeader.header === null, '全是数字的第一行不是表头')
  assert(noHeader.rows.length === 2, '这种情况下第一行算数据', String(noHeader.rows.length))
  assert(noHeader.totalRows === 2, 'totalRows 计入第一行')

  const blank = parseDelimited('a,,c\n1,2,3')
  assert(blank.header === null, '有空格子的第一行不是表头')

  const single = parseDelimited('只有一列\n第二行')
  assert(single.header === null, '单列不认作表头')
}

// ---------------------------------------------------------------- 截断
console.log('\n【行数上限】')
{
  const lines = ['a,b']
  for (let i = 0; i < 5000; i++) lines.push(`r${i},${i}`)
  const r = parseDelimited(lines.join('\n'), { maxRows: 100 })
  assert(r.rows.length === 100, '只保留 100 行', String(r.rows.length))
  assert(r.truncated, '标记 truncated')
  assert(r.totalRows === 5000, 'totalRows 仍是真实总行数（用于提示"共 5000 行"）', String(r.totalRows))
}

// ---------------------------------------------------------------- 边界
console.log('\n【边界】')
{
  assert(parseDelimited('').rows.length === 0, '空文本不炸')
  assert(parseDelimited(',,,\n,,').rows.every((row) => row.every((c) => c === '')), '全是分隔符也不炸')
  const ragged = parseDelimited('a,b,c\n1,2')
  assert(ragged.rows[0].length === 2, '列数不齐时按实际列数，不补空', String(ragged.rows[0].length))
}

console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
process.exitCode = failed === 0 ? 0 : 1
