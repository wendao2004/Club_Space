/**
 * 新增工具集端到端测试。
 *
 * 覆盖这一批新增工具的真实 run 路径，重点验证几件容易翻车的事：
 *
 * 1. **产物是真能被解析的文件。** PDF 产物要有 `%PDF` 文件头、图片产物尺寸要对，
 *    而不是"任务成功但文件是坏的"。很多工具第一次写出来的 bug 就藏在这里。
 * 2. **边界要挡得住。** 删光所有页、给 PDF 写中文水印、空名单、非法 JSON / Base64 / URL，
 *    都必须在入口给出明确错误，而不是产出坏结果或静默成功。
 * 3. **非文件型结果必须能被前端显示。** 本仓库前端只认 data 里的标量和 data.pages 表格，
 *    所以像文件哈希、抽签分组、主色调这些结果，这里断言它们落在 data.pages 上。
 *
 * 图片数据用 zlib + node:crypto 现场生成 PNG，PDF 用工具自己生成（图片转 PDF），
 * 全程不依赖任何外部素材，也不依赖被测代码之外的库。
 *
 * 用法：先启动后端（或 node scripts/run-all-tests.mjs --only tools-extra-test），
 * 然后 node scripts/tools-extra-test.mjs
 */

import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'

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

// ---------------------------------------------------------------- 极简 PNG 编码器

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData) >>> 0)
  return Buffer.concat([length, typeAndData, crc])
}

/** 生成一张 RGBA PNG（与 image-tools-test 同款，测试数据由测试自己造）。 */
function makePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  let offset = 0
  for (let row = 0; row < height; row++) {
    raw[offset++] = 0
    for (let col = 0; col < width; col++) {
      const [r, g, b, a] = pixels(row, col)
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
      raw[offset++] = a
    }
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 从 PNG 的 IHDR 里读宽高（IHDR 数据从第 16 字节开始）。 */
function readPngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** 产品是不是 PDF：认文件头，而不是看扩展名。 */
function isPdf(buffer) {
  return buffer.length > 4 && buffer.subarray(0, 4).toString('ascii') === '%PDF'
}

// ---------------------------------------------------------------- HTTP 客户端

function makeClient() {
  let cookie = ''
  return {
    async api(path, options = {}) {
      const headers = { ...(options.headers ?? {}) }
      if (cookie) headers.cookie = cookie
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json'
        options.body = JSON.stringify(options.json)
      }
      const res = await fetch(`${BASE}${path}`, {
        method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: options.body,
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const type = res.headers.get('content-type') ?? ''
      if (type.includes('application/json')) return { status: res.status, body: await res.json() }
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()) }
    },
  }
}

async function upload(client, name, bytes) {
  const init = await client.api('/api/uploads', {
    method: 'POST',
    json: { parentId: null, name, size: bytes.byteLength, space: 'shared' },
  })
  if (init.status !== 200 || !init.body.uploadId) {
    throw new Error(`开启上传失败：${JSON.stringify(init.body)}`)
  }
  await client.api(`/api/uploads/${init.body.uploadId}/chunk?offset=0`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  const done = await client.api(`/api/uploads/${init.body.uploadId}/complete`, {
    method: 'POST',
    json: {},
  })
  if (done.status !== 200) throw new Error(`完成上传失败：${JSON.stringify(done.body)}`)
  return done.body.nodeId
}

/** 提交工具并等它结束。返回 { ok, job } 或 { ok:false, error }。 */
async function runTool(client, toolId, nodeIds, params = {}) {
  const run = await client.api(`/api/tools/${toolId}/run`, {
    method: 'POST',
    json: { nodeIds, params, space: 'shared' },
  })
  if (run.status !== 200) return { ok: false, error: run.body.error ?? `提交失败 ${run.status}` }
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250))
    const job = await client.api(`/api/jobs/${run.body.jobId}`)
    const state = job.body.job?.state
    if (state === 'done') return { ok: true, job: job.body.job }
    if (state === 'failed') return { ok: false, error: job.body.job.error }
  }
  return { ok: false, error: '任务超时' }
}

async function download(client, nodeId) {
  const res = await client.api(`/api/files/${nodeId}/download`)
  return res.body
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`\n\x1b[1m新增工具集端到端测试\x1b[0m  目标 ${BASE}\n`)

  const client = makeClient()

  console.log('【准备】')
  const reg = await client.api('/api/auth/register', {
    method: 'POST',
    json: { username: `tool${SUFFIX}`, displayName: '工具测试', password: 'tools-extra-2026' },
  })
  if (reg.status !== 200 && reg.status !== 201) {
    bad('注册测试账号', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
    process.exit(1)
  }
  ok('注册测试账号')

  const tools = await client.api('/api/tools')
  const ids = tools.body.tools.map((t) => t.id)
  const expected = [
    'pdf.images-to-pdf',
    'pdf.remove-pages',
    'pdf.split-each',
    'pdf.page-numbers',
    'pdf.watermark',
    'image.watermark',
    'image.collage',
    'image.grid-slice',
    'image.palette',
    'file.hash',
    'text.transform',
    'list.shuffle',
  ]
  const missing = expected.filter((id) => !ids.includes(id))
  assert(missing.length === 0, '新工具都出现在工具清单里', missing.length ? `缺失：${missing.join(', ')}` : '')

  // 测试素材：红/绿/蓝三张纯色图，再加一张左右两色的图给取色用。
  const redId = await upload(client, `红-${SUFFIX}.png`, makePng(40, 20, () => [220, 30, 30, 255]))
  const greenId = await upload(client, `绿-${SUFFIX}.png`, makePng(80, 60, () => [10, 200, 90, 255]))
  const blueId = await upload(client, `蓝-${SUFFIX}.png`, makePng(60, 60, () => [30, 60, 220, 255]))
  const twoColorId = await upload(
    client,
    `两色-${SUFFIX}.png`,
    makePng(40, 20, (_r, c) => (c < 20 ? [220, 30, 30, 255] : [10, 200, 90, 255])),
  )

  // ================================================================ 图片转 PDF
  console.log('\n【图片转 PDF】')
  const toPdf = await runTool(client, 'pdf.images-to-pdf', [redId, greenId, blueId], {
    pageSize: 'fit',
    quality: 85,
  })
  assert(toPdf.ok, '三张图合成 PDF 成功', toPdf.error ?? '')

  let pdfId = null
  if (toPdf.ok && toPdf.job.outputNodeIds.length > 0) {
    pdfId = toPdf.job.outputNodeIds[0]
    const bytes = await download(client, pdfId)
    assert(isPdf(bytes), '产物是真的 PDF（文件头 %PDF）')
    const info = await runTool(client, 'pdf.info', [pdfId])
    assert(info.ok, '合成后的 PDF 能被 PDF 工具解析', info.error ?? '')
    assert(info.ok && info.job.data?.pageCount === 3, '合成后正好 3 页', String(info.job.data?.pageCount))
  } else {
    bad('三张图合成 PDF 的产物', '没有拿到产物节点')
  }

  const toPdfA4 = await runTool(client, 'pdf.images-to-pdf', [greenId], { pageSize: 'a4' })
  assert(toPdfA4.ok, 'A4 页面模式也能生成', toPdfA4.error ?? '')
  if (toPdfA4.ok && toPdfA4.job.outputNodeIds.length > 0) {
    assert(isPdf(await download(client, toPdfA4.job.outputNodeIds[0])), 'A4 产物是有效 PDF')
  }

  const toPdfBad = await runTool(client, 'pdf.images-to-pdf', [greenId], { pageSize: 'b5' })
  assert(!toPdfBad.ok, '不支持的页面尺寸被拒绝', toPdfBad.error ?? '')

  // ================================================================ PDF 系列（依赖上面生成的 3 页 PDF）
  console.log('\n【PDF 删除 / 拆分 / 页码 / 水印】')
  if (!pdfId) {
    bad('PDF 系列测试', '前置的图片转 PDF 失败，无法继续')
  } else {
    // ---- 删除页面 ----
    const removed = await runTool(client, 'pdf.remove-pages', [pdfId], { pages: '2' })
    assert(removed.ok, '删除第 2 页成功', removed.error ?? '')
    if (removed.ok && removed.job.outputNodeIds.length > 0) {
      const info = await runTool(client, 'pdf.info', [removed.job.outputNodeIds[0]])
      assert(info.ok && info.job.data?.pageCount === 2, '删除后剩 2 页', String(info.job.data?.pageCount))
    }
    const removeAll = await runTool(client, 'pdf.remove-pages', [pdfId], { pages: '1-3' })
    assert(!removeAll.ok, '试图删光所有页会被拒绝', removeAll.error ?? '')

    // ---- 逐页拆分（多产物）----
    const splitEach = await runTool(client, 'pdf.split-each', [pdfId])
    assert(splitEach.ok, '逐页拆分成功', splitEach.error ?? '')
    assert(
      splitEach.ok && splitEach.job.outputNodeIds.length === 3,
      '拆出 3 个文件',
      String(splitEach.job.outputNodeIds?.length),
    )
    if (splitEach.ok && splitEach.job.outputNodeIds[0]) {
      assert(isPdf(await download(client, splitEach.job.outputNodeIds[0])), '拆分产物是有效 PDF')
    }

    // ---- 添加页码 ----
    const paged = await runTool(client, 'pdf.page-numbers', [pdfId], { format: 'of-total', startAt: 1 })
    assert(paged.ok, '添加页码成功', paged.error ?? '')
    if (paged.ok && paged.job.outputNodeIds.length > 0) {
      const bytes = await download(client, paged.job.outputNodeIds[0])
      assert(isPdf(bytes), '加页码产物是有效 PDF')
      const info = await runTool(client, 'pdf.info', [paged.job.outputNodeIds[0]])
      assert(info.ok && info.job.data?.pageCount === 3, '加页码后页数不变')
    }

    // ---- 文字水印 ----
    const wm = await runTool(client, 'pdf.watermark', [pdfId], {
      text: 'DRAFT',
      opacity: 0.2,
      angle: '45',
    })
    assert(wm.ok, '英文文字水印成功', wm.error ?? '')
    if (wm.ok && wm.job.outputNodeIds.length > 0) {
      assert(isPdf(await download(client, wm.job.outputNodeIds[0])), '文字水印产物是有效 PDF')
    }

    // 中文水印必须被挡下（标准字体没有中文字形）
    const wmCn = await runTool(client, 'pdf.watermark', [pdfId], { text: '内部资料' })
    assert(!wmCn.ok, '中文水印被拒绝（PDF 标准字体无中文字形）', wmCn.error ?? '')
    assert(
      typeof wmCn.error === 'string' && wmCn.error.includes('中文'),
      '错误信息说明了中文限制的原因',
      wmCn.error,
    )

    // ---- 图片水印 ----
    const wmImg = await runTool(client, 'pdf.watermark', [pdfId, redId], { opacity: 0.3, angle: '0' })
    assert(wmImg.ok, '图片水印成功', wmImg.error ?? '')
    if (wmImg.ok && wmImg.job.outputNodeIds.length > 0) {
      assert(isPdf(await download(client, wmImg.job.outputNodeIds[0])), '图片水印产物是有效 PDF')
    }

    // 第一个输入不是 PDF 要拒绝
    const wmWrong = await runTool(client, 'pdf.watermark', [redId], { text: 'X' })
    assert(!wmWrong.ok, '第一个输入不是 PDF 时被拒绝', wmWrong.error ?? '')
  }

  // ================================================================ 图片加水印
  console.log('\n【图片加水印】')
  const iw = await runTool(client, 'image.watermark', [redId, greenId], {
    position: 'bottom-right',
    scale: 20,
    opacity: 0.8,
  })
  assert(iw.ok, '给图片加水印成功', iw.error ?? '')
  if (iw.ok && iw.job.outputNodeIds.length > 0) {
    const bytes = await download(client, iw.job.outputNodeIds[0])
    const size = readPngSize(bytes)
    assert(size.width === 80 && size.height === 60, '产物尺寸与目标图一致', `${size.width}x${size.height}`)
  }
  const iwSingle = await runTool(client, 'image.watermark', [greenId])
  assert(!iwSingle.ok, '只给一张图时被拒绝（第一张是水印、需要目标图）', iwSingle.error ?? '')

  // ================================================================ 图片拼接
  console.log('\n【图片拼接】')
  const collage = await runTool(client, 'image.collage', [greenId, blueId], { layout: 'horizontal' })
  assert(collage.ok, '横向拼接成功', collage.error ?? '')
  if (collage.ok && collage.job.outputNodeIds.length > 0) {
    // 产物是 JPEG，直接用图片信息工具读它的真实尺寸：
    // 80x60 与 60x60 对齐高度后并排 → 宽 80+60=140、高 60。
    const info = await runTool(client, 'image.info', [collage.job.outputNodeIds[0]])
    assert(info.ok, '拼接产物是有效图片', info.error ?? '')
    const meta = info.ok ? info.job.data?.images?.[0] : null
    assert(meta?.width === 140 && meta?.height === 60, '横向拼接尺寸正确（140×60）', `${meta?.width}x${meta?.height}`)
  }

  // ================================================================ 九宫格切图
  console.log('\n【九宫格切图】')
  const sliced = await runTool(client, 'image.grid-slice', [blueId], { rows: 3, cols: 3, format: 'png' })
  assert(sliced.ok, '3×3 切图成功', sliced.error ?? '')
  assert(
    sliced.ok && sliced.job.outputNodeIds.length === 9,
    '切出 9 块',
    String(sliced.job.outputNodeIds?.length),
  )
  if (sliced.ok && sliced.job.outputNodeIds[0]) {
    const size = readPngSize(await download(client, sliced.job.outputNodeIds[0]))
    assert(size.width === 20 && size.height === 20, '单块尺寸为 60/3=20', `${size.width}x${size.height}`)
  }

  // ================================================================ 主色调提取
  console.log('\n【主色调提取】')
  const palette = await runTool(client, 'image.palette', [twoColorId], { count: 8 })
  assert(palette.ok, '提取主色调成功', palette.error ?? '')
  if (palette.ok) {
    const pages = palette.job.data?.pages
    assert(Array.isArray(pages) && pages.length === 2, '两色图提取出 2 种主色', String(pages?.length))
    assert(
      Array.isArray(pages) && typeof pages[0]?.hex === 'string' && pages[0].hex.startsWith('#'),
      '结果带 #RRGGBB 色值（表格可显示）',
      pages?.[0]?.hex,
    )
    assert(palette.job.outputNodeIds.length === 1, '另外产出一张色板图')
    if (palette.job.outputNodeIds[0]) {
      assert(readPngSize(await download(client, palette.job.outputNodeIds[0])).height === 80, '色板图尺寸正常')
    }
  }

  // ================================================================ 文件校验
  console.log('\n【文件校验】')
  const hashContent = Buffer.from(`哈希测试内容 ${SUFFIX}\n第二行\n`, 'utf8')
  const hashId = await upload(client, `待校验-${SUFFIX}.txt`, hashContent)
  const expectedSha = createHash('sha256').update(hashContent).digest('hex')
  const hash = await runTool(client, 'file.hash', [hashId], { algorithm: 'sha256' })
  assert(hash.ok, '文件哈希计算成功', hash.error ?? '')
  if (hash.ok) {
    const row = hash.job.data?.pages?.[0]
    assert(row?.hash === expectedSha, 'SHA-256 与本地计算一致', row?.hash)
    assert(row?.verify === '一致', '自校验显示「一致」', row?.verify)
  }
  const hashMd5 = await runTool(client, 'file.hash', [hashId], { algorithm: 'md5' })
  const expectedMd5 = createHash('md5').update(hashContent).digest('hex')
  assert(
    hashMd5.ok && hashMd5.job.data?.pages?.[0]?.hash === expectedMd5,
    'MD5 与本地计算一致',
    hashMd5.job.data?.pages?.[0]?.hash,
  )
  const hashBad = await runTool(client, 'file.hash', [hashId], { algorithm: 'crc' })
  assert(!hashBad.ok, '不支持的算法被拒绝', hashBad.error ?? '')

  // ================================================================ 文本工具
  console.log('\n【文本工具】')
  const jsonFmt = await runTool(client, 'text.transform', [], {
    mode: 'json-format',
    text: '{"a":1,"b":[2,3]}',
  })
  assert(jsonFmt.ok, 'JSON 格式化成功', jsonFmt.error ?? '')
  if (jsonFmt.ok && jsonFmt.job.outputNodeIds[0]) {
    const text = (await download(client, jsonFmt.job.outputNodeIds[0])).toString('utf8')
    assert(text.includes('"a": 1') && text.includes('\n'), '格式化结果带缩进换行', JSON.stringify(text))
  }

  const b64 = await runTool(client, 'text.transform', [], { mode: 'base64-encode', text: 'hello 世界' })
  assert(b64.ok, 'Base64 编码成功', b64.error ?? '')
  let encoded = ''
  if (b64.ok && b64.job.outputNodeIds[0]) {
    encoded = (await download(client, b64.job.outputNodeIds[0])).toString('utf8')
    assert(encoded === Buffer.from('hello 世界', 'utf8').toString('base64'), 'Base64 编码结果正确', encoded)
  }
  const b64dec = await runTool(client, 'text.transform', [], { mode: 'base64-decode', text: encoded })
  assert(b64dec.ok, 'Base64 解码成功', b64dec.error ?? '')
  if (b64dec.ok && b64dec.job.outputNodeIds[0]) {
    const text = (await download(client, b64dec.job.outputNodeIds[0])).toString('utf8')
    assert(text === 'hello 世界', 'Base64 解码还原原文', text)
  }
  const b64bad = await runTool(client, 'text.transform', [], { mode: 'base64-decode', text: '!!!not base64!!!' })
  assert(!b64bad.ok, '非法 Base64 被拒绝', b64bad.error ?? '')

  const urlBad = await runTool(client, 'text.transform', [], { mode: 'url-decode', text: '%ZZ' })
  assert(!urlBad.ok, '非法 URL 编码被拒绝', urlBad.error ?? '')

  const jsonBad = await runTool(client, 'text.transform', [], { mode: 'json-format', text: '{不是 JSON' })
  assert(!jsonBad.ok, '非法 JSON 被拒绝', jsonBad.error ?? '')

  const dedupeContent = Buffer.from('b\na\nb\nc\na\n', 'utf8')
  const dedupeId = await upload(client, `去重-${SUFFIX}.txt`, dedupeContent)
  const dedupe = await runTool(client, 'text.transform', [dedupeId], { mode: 'dedupe-sort' })
  assert(dedupe.ok, '去重排序成功', dedupe.error ?? '')
  if (dedupe.ok && dedupe.job.outputNodeIds[0]) {
    const text = (await download(client, dedupe.job.outputNodeIds[0])).toString('utf8')
    assert(text === 'a\nb\nc', '去重并排序为 a/b/c', JSON.stringify(text))
  }

  const count = await runTool(client, 'text.transform', [], { mode: 'count', text: 'ab cd\n中文' })
  assert(count.ok, '字数统计成功', count.error ?? '')
  assert(count.ok && count.job.data?.chars === 8, '统计字符数正确（8）', String(count.job.data?.chars))
  assert(count.ok && count.job.data?.lines === 2, '统计行数正确（2）', String(count.job.data?.lines))
  assert(count.ok && count.job.data?.cjkChars === 2, '统计中文字符数正确（2）', String(count.job.data?.cjkChars))

  const noText = await runTool(client, 'text.transform', [], { mode: 'json-format' })
  assert(!noText.ok, '既没选文件也没填文本时被拒绝', noText.error ?? '')

  // ================================================================ 抽签 / 分组
  console.log('\n【随机抽签 / 分组】')
  const draw = await runTool(client, 'list.shuffle', [], { mode: 'draw', count: 2, items: '张三,李四,王五,赵六' })
  assert(draw.ok, '随机抽取成功', draw.error ?? '')
  if (draw.ok) {
    const pages = draw.job.data?.pages
    const names = new Set(['张三', '李四', '王五', '赵六'])
    assert(Array.isArray(pages) && pages.length === 2, '抽出 2 项', String(pages?.length))
    assert(
      Array.isArray(pages) && pages.every((p) => names.has(p.winner)),
      '抽出的都是名单里的人',
      JSON.stringify(pages),
    )
  }
  const group = await runTool(client, 'list.shuffle', [], {
    mode: 'group',
    count: 2,
    items: 'a b c d e',
  })
  assert(group.ok, '随机分组成功', group.error ?? '')
  if (group.ok) {
    const pages = group.job.data?.pages
    const total = Array.isArray(pages) ? pages.reduce((s, p) => s + p.count, 0) : 0
    assert(Array.isArray(pages) && pages.length === 2, '分成 2 组', String(pages?.length))
    assert(total === 5, '所有成员都被分到组里（5 人）', String(total))
  }
  const emptyList = await runTool(client, 'list.shuffle', [], { mode: 'draw', count: 1 })
  assert(!emptyList.ok, '空名单被拒绝', emptyList.error ?? '')

  // ---------------------------------------------------------------- 结果
  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
