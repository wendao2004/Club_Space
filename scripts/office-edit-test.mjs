/**
 * 在线编辑保存接口（`PUT /api/files/:id/content`）的测试。
 *
 * 这个接口做的是"**原地改写一个已存在的文件**"，比上传敏感得多 ——
 * 上传是"多一个文件"，改写是"换掉别人正在用的那份"。所以这里逐条钉住四件事：
 *
 *   1. **权限**：只有能改这个节点的人才能改写（不是"能读就能写"）；
 *   2. **类型**：只有表格/文档/文本能被改写，别的东西一律 415
 *      —— 否则"编辑"就成了绕过上传流程的任意写通道；
 *   3. **并发**：带 `?base=<updatedAt>` 时，期间被别人改过必须 409，
 *      而不是静默覆盖（这条是"会丢数据"与"会告诉你可能丢数据"的分界）；
 *   4. **内容正确性**：保存后下载回来，改的那个格子是新的，**没改的还在**。
 *      第 4 条用真实的 ExcelJS 解析产出来验证，而不是看 HTTP 200 ——
 *      "写进去了但整张表被写坏"是完全可能的，200 说明不了任何事。
 *
 * 还有一条容易漏的：**同一份内容的引用计数**。两个节点引用同一份 blob 时，
 * 改写其中一个必须把旧 blob 的引用数减到 1 而不是删掉它，
 * 否则另一个节点会突然变成"文件不见了"。
 */

import ExcelJS from 'exceljs'
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
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

function makeClient() {
  let cookie = ''
  return {
    get cookie() {
      return cookie
    },
    async api(path, options = {}) {
      const headers = { ...(options.headers ?? {}) }
      if (cookie) headers.cookie = cookie
      let body = options.body
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(options.json)
      }
      const res = await fetch(`${BASE}${path}`, {
        method: options.method ?? (body !== undefined ? 'POST' : 'GET'),
        headers,
        body,
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const type = res.headers.get('content-type') ?? ''
      const parsed = type.includes('application/json')
        ? await res.json()
        : Buffer.from(await res.arrayBuffer())
      return { status: res.status, body: parsed }
    },
  }
}

/** 走真实的分片上传接口，返回节点 id（和界面用的是同一条路径）。 */
async function upload(client, name, bytes) {
  const init = await client.api('/api/uploads', {
    method: 'POST',
    json: { parentId: null, name, size: bytes.length, space: 'shared' },
  })
  if (init.status !== 200) throw new Error(`init 失败：${init.status} ${JSON.stringify(init.body)}`)
  if (init.body.instant) return init.body.nodeId

  const put = await client.api(`/api/uploads/${init.body.uploadId}/chunk?offset=0`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  if (put.status !== 200) throw new Error(`chunk 失败：${put.status}`)
  const done = await client.api(`/api/uploads/${init.body.uploadId}/complete`, {
    method: 'POST',
    json: {},
  })
  if (done.status !== 200) throw new Error(`complete 失败：${done.status}`)
  return done.body.nodeId
}

/** 生成一份"像真的"的表格：粗体表头、数字、公式。 */
async function buildXlsx({ firstCell, withFormula = true }) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('账目')
  ws.getCell('A1').value = firstCell
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.getCell('B1').value = '金额'
  ws.getCell('B1').font = { bold: true }
  ws.getCell('A2').value = '场地费'
  ws.getCell('B2').value = 300
  ws.getCell('A3').value = '物料'
  ws.getCell('B3').value = 120
  if (withFormula) ws.getCell('B4').value = { formula: 'SUM(B2:B3)', result: 420 }
  ws.getColumn(1).width = 22
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** 手搓一份最小的 docx（有段落样式、有图片占位），够服务端嗅探成 Word 文档。 */
function buildDocx(text) {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>
</w:body></w:document>`
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
      'word/document.xml': strToU8(documentXml),
    }),
  )
}

async function main() {
  console.log(`\n\x1b[1m在线编辑保存（内容改写 / 权限 / 并发）\x1b[0m  目标 ${BASE}\n`)

  const owner = makeClient()
  const other = makeClient()

  // ---------------------------------------------------------------- 账号

  const regOwner = await owner.api('/api/auth/register', {
    method: 'POST',
    json: { username: `edt${SUFFIX}`, displayName: '编辑测试甲', password: 'office-edit-2026' },
  })
  assert(regOwner.status === 200 || regOwner.status === 201, '注册写入者', `状态 ${regOwner.status}`)

  // 第二个账号要邀请码 —— 首启只自动创建第一个（owner）账号。
  // 用邀请码而不是直接写库，是因为"乙看得见但改不了"必须是一个真实的普通成员。
  const invite = await owner.api('/api/admin/invites', { json: { role: 'member', maxUses: 1 } })
  const regOther = await other.api('/api/auth/register', {
    method: 'POST',
    json: {
      username: `edx${SUFFIX}`,
      displayName: '编辑测试乙',
      password: 'office-edit-2026',
      inviteCode: invite.body?.code,
    },
  })
  assert(regOther.status === 200 || regOther.status === 201, '注册旁观者', `状态 ${regOther.status}`)

  // ---------------------------------------------------------------- 表格

  const xlsxName = `在线编辑-${SUFFIX}.xlsx`
  const original = await buildXlsx({ firstCell: '九月账目' })
  const nodeId = await upload(owner, xlsxName, original)
  assert(typeof nodeId === 'string' && nodeId.length > 0, '上传一份 .xlsx', xlsxName)

  const listing = await owner.api('/api/files?space=shared')
  const node = listing.body.entries.find((e) => e.id === nodeId)
  assert(
    node?.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '服务端按内容认出了 xlsx',
    node?.mime ?? '(缺失)',
  )
  const baseUpdatedAt = node?.updatedAt ?? 0

  // 乙能看见这份文件（共享空间），但不能改写 —— 写权限与读权限是两件事
  const stranger = await other.api(`/api/files/${nodeId}/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: await buildXlsx({ firstCell: '被别人改了' }),
  })
  assert(stranger.status === 403, '别人改不了这份表格（403）', `实际 ${stranger.status}`)

  // ---------------------------------------------------------------- 正常保存

  const edited = await buildXlsx({ firstCell: '十月账目' })
  const saved = await owner.api(`/api/files/${nodeId}/content?base=${baseUpdatedAt}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: edited,
  })
  assert(saved.status === 200, '保存成功（200）', `实际 ${saved.status} ${JSON.stringify(saved.body)}`)
  assert(saved.body?.node?.size === edited.length, '返回的大小是新内容的大小', `${saved.body?.node?.size}`)
  assert(saved.body?.node?.updatedAt > baseUpdatedAt, 'updatedAt 前进了（并发校验的基准）')

  // 下载回来，用真的 ExcelJS 解析 —— 只看 200 说明不了任何事
  const back = await owner.api(`/api/files/${nodeId}/download`)
  assert(back.status === 200, '改写后的内容能下载')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(back.body)
  const ws = wb.getWorksheet('账目')
  assert(ws?.getCell('A1').value === '十月账目', '改的那个格子是新的', String(ws?.getCell('A1').value))
  assert(ws?.getCell('B2').value === 300, '没改的格子还在', String(ws?.getCell('B2').value))
  assert(ws?.getCell('A1').font?.bold === true, '单元格样式被保留（不是被重建成纯文本）')
  const formulaCell = ws?.getCell('B4').value
  assert(
    typeof formulaCell === 'object' && formulaCell?.formula === 'SUM(B2:B3)',
    '公式还在（原文没有被"算成值"覆盖）',
    JSON.stringify(formulaCell),
  )

  // ---------------------------------------------------------------- 并发

  const stale = await owner.api(`/api/files/${nodeId}/content?base=${baseUpdatedAt}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: await buildXlsx({ firstCell: '基于旧版本的修改' }),
  })
  assert(stale.status === 409, '基于旧版本的保存被拒（409，不静默覆盖）', `实际 ${stale.status}`)

  const force = await owner.api(`/api/files/${nodeId}/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: await buildXlsx({ firstCell: '明确覆盖' }),
  })
  assert(force.status === 200, '不带 base = 明确覆盖（200）', `实际 ${force.status}`)

  // ---------------------------------------------------------------- 输入校验

  const empty = await owner.api(`/api/files/${nodeId}/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(0),
  })
  assert(empty.status === 400, '空内容被拒（400）', `实际 ${empty.status}`)

  // 一份 PNG：不在可编辑白名单里
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const pngId = await upload(owner, `图片-${SUFFIX}.png`, pngBytes)
  const pngEdit = await owner.api(`/api/files/${pngId}/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: pngBytes,
  })
  assert(pngEdit.status === 415, '图片不能被"编辑"改写（415，白名单外）', `实际 ${pngEdit.status}`)

  // ---------------------------------------------------------------- 文本

  const txtName = `笔记-${SUFFIX}.txt`
  const txtId = await upload(owner, txtName, Buffer.from('第一版笔记\n', 'utf8'))
  const txtSave = await owner.api(`/api/files/${txtId}/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('第二版笔记\n多了这一行\n', 'utf8'),
  })
  assert(txtSave.status === 200, '文本文件可以被改写（200）', `实际 ${txtSave.status}`)
  const txtBack = await owner.api(`/api/files/${txtId}/download`)
  assert(
    strFromU8(new Uint8Array(txtBack.body)) === '第二版笔记\n多了这一行\n',
    '文本内容逐字节正确',
  )

  // ---------------------------------------------------------------- 引用计数

  // 同一份内容传两次 → 两个节点共用一份 blob。改其中一个之后，
  // 另一个必须还能正常下载（旧 blob 的引用数从 2 减到 1，而不是被删掉）
  const sharedName = `共用内容-${SUFFIX}.xlsx`
  const sharedBytes = await buildXlsx({ firstCell: '共用原件' })
  const sharedA = await upload(owner, sharedName, sharedBytes)
  const sharedB = await upload(owner, `共用内容2-${SUFFIX}.xlsx`, sharedBytes)
  const sharedListing = await owner.api('/api/files?space=shared')
  const nodeA = sharedListing.body.entries.find((e) => e.id === sharedA)
  const rewrite = await owner.api(`/api/files/${sharedA}/content?base=${nodeA?.updatedAt ?? 0}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: await buildXlsx({ firstCell: '只改这一份' }),
  })
  assert(rewrite.status === 200, '改写共用内容的其中一份（200）', `实际 ${rewrite.status}`)
  const otherCopy = await owner.api(`/api/files/${sharedB}/download`)
  assert(otherCopy.status === 200, '另一份共用同一内容的文件仍然可下载（引用计数没误删）')
  const otherWb = new ExcelJS.Workbook()
  await otherWb.xlsx.load(otherCopy.body)
  assert(
    otherWb.getWorksheet(1)?.getCell('A1').value === '共用原件',
    '另一份的内容没有被一起改掉',
    String(otherWb.getWorksheet(1)?.getCell('A1').value),
  )

  // ---------------------------------------------------------------- 文档

  const docxName = `在线编辑-${SUFFIX}.docx`
  const docxId = await upload(owner, docxName, buildDocx('原始标题'))
  const docxListing = await owner.api('/api/files?space=shared')
  const docxNode = docxListing.body.entries.find((e) => e.id === docxId)
  assert(
    docxNode?.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '服务端按内容认出了 docx',
    docxNode?.mime ?? '(缺失)',
  )

  const docxSave = await owner.api(`/api/files/${docxId}/content?base=${docxNode?.updatedAt ?? 0}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: buildDocx('改过的标题'),
  })
  assert(docxSave.status === 200, '文档保存成功（200）', `实际 ${docxSave.status}`)
  const docxBack = await owner.api(`/api/files/${docxId}/download`)
  const files = unzipSync(new Uint8Array(docxBack.body))
  const xml = strFromU8(files['word/document.xml'] ?? new Uint8Array())
  assert(xml.includes('改过的标题'), '保存后的 document.xml 里是新文字')
  assert(!xml.includes('原始标题'), '旧文字没有留在文件里')

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
