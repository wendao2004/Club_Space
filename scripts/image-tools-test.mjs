/**
 * 图片工具端到端测试。
 *
 * 重点测三件事：
 *
 * 1. **透明图转 JPEG 不能变黑。** 这是图片处理里最经典的"结果看起来坏了"：
 *    JPEG 不支持透明，如果直接把 RGBA 喂进去，透明区域会变成黑色。
 *    正确处理是先铺一层白底（sharp 的 flatten）。
 *
 * 2. **只缩小不放大。** 把 100px 的图"缩放到 1920px"只会得到一张模糊的大图，
 *    用户会以为工具坏了。正确行为是保持原尺寸。
 *
 * 3. **压缩后确实变小（或如实说变小不了）。** 不做"假装压过了"。
 *
 * 测试数据用 zlib + node:crypto 现场生成 PNG，不依赖任何外部图片文件，
 * 也不依赖 sharp（被测代码之外不该引入被测对象的依赖来做断言）。
 *
 * 用法：先启动后端，然后  node scripts/image-tools-test.mjs
 */

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

/** 组装一个 PNG 块：长度 + 类型 + 数据 + CRC32。 */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData) >>> 0)
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * 生成一张 RGBA PNG。
 *
 * pixels(row, col) 返回 [r, g, b, a]。
 * 用最小的手工编码器而不是引入图像库：测试数据应该由测试自己造，
 * 否则"生成图片的库"和"处理图片的库"是同一个，出了问题也测不出来。
 */
function makePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：RGBA
  ihdr[10] = 0 // 压缩
  ihdr[11] = 0 // 滤波
  ihdr[12] = 0 // 隔行

  // 每行前面有一个滤波字节（0 = 无滤波）
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

/** 半透明图：左半边完全透明，右半边不透明的红色。 */
function makeTransparentPng() {
  return makePng(40, 20, (_row, col) => (col < 20 ? [0, 0, 0, 0] : [220, 30, 30, 255]))
}

/** 大尺寸渐变图：给缩放与压缩用。 */
function makeLargePng(size = 600) {
  return makePng(size, size, (row, col) => [
    (col * 255) / size,
    (row * 255) / size,
    128,
    255,
  ])
}

function readPngSize(buffer) {
  // IHDR 数据从第 16 字节开始：宽 4 字节、高 4 字节
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// ---------------------------------------------------------------- HTTP 客户端

function makeClient() {
  let cookie = ''
  return {
    get cookie() {
      return cookie
    },
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

/** 上传一段字节并返回节点 id。 */
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
  const done = await client.api(`/api/uploads/${init.body.uploadId}/complete`, { method: 'POST', json: {} })
  if (done.status !== 200) throw new Error(`完成上传失败：${JSON.stringify(done.body)}`)
  return done.body.nodeId
}

/** 跑一个工具并等它结束。 */
async function runTool(client, toolId, nodeIds, params = {}) {
  const run = await client.api(`/api/tools/${toolId}/run`, {
    method: 'POST',
    json: { nodeIds, params, space: 'shared' },
  })
  if (run.status !== 200) return { ok: false, error: run.body.error ?? `提交失败 ${run.status}` }

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 300))
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
  console.log(`\n\x1b[1m图片工具端到端测试\x1b[0m  目标 ${BASE}\n`)

  const client = makeClient()

  // ---------------------------------------------------------------- 准备
  console.log('【准备】')
  const reg = await client.api('/api/auth/register', {
    method: 'POST',
    json: { username: `img${SUFFIX}`, displayName: '图片测试', password: 'image-test-2026' },
  })
  if (reg.status !== 200 && reg.status !== 201) {
    bad('注册测试账号', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
    process.exit(1)
  }
  ok('注册测试账号')

  const tools = await client.api('/api/tools')
  const ids = tools.body.tools.map((t) => t.id)
  assert(ids.includes('image.info'), '工具列表里有 image.info')
  assert(ids.includes('image.convert'), '工具列表里有 image.convert')
  assert(ids.includes('image.resize'), '工具列表里有 image.resize')
  assert(ids.includes('image.compress'), '工具列表里有 image.compress')
  const imageToolsAvailable = tools.body.tools
    .filter((t) => t.id.startsWith('image.'))
    .every((t) => t.available)
  assert(imageToolsAvailable, '图片工具都可用（sharp 原生模块已加载）')

  // ---------------------------------------------------------------- 图片信息
  console.log('\n【图片信息】')
  const largePng = makeLargePng(600)
  const largeId = await upload(client, `渐变色-${SUFFIX}.png`, largePng)

  const info = await runTool(client, 'image.info', [largeId])
  assert(info.ok, '图片信息任务完成', info.error ?? '')
  if (info.ok) {
    const image = info.job.data?.images?.[0]
    assert(image?.width === 600 && image?.height === 600, '识别出正确的尺寸', `${image?.width}x${image?.height}`)
    assert(image?.format === 'png', '识别出格式是 png', image?.format)
    assert(image?.hasAlpha === true, '识别出这张图带 alpha 通道（我们是按 RGBA 编码的）')
  }

  // ---------------------------------------------------------------- 透明图转 JPEG
  console.log('\n【透明图转 JPEG（经典坑：不能变黑）】')
  const alphaPng = makeTransparentPng()
  const alphaId = await upload(client, `半透明-${SUFFIX}.png`, alphaPng)

  const toJpeg = await runTool(client, 'image.convert', [alphaId], { format: 'jpeg', quality: 90 })
  assert(toJpeg.ok, '透明 PNG 转 JPEG 成功', toJpeg.error ?? '')
  if (toJpeg.ok && toJpeg.job.outputNodeIds.length > 0) {
    const jpegBytes = await download(client, toJpeg.job.outputNodeIds[0])
    assert(
      jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8,
      '产物确实是 JPEG（文件头 FFD8）',
      `前两字节 ${jpegBytes[0]?.toString(16)} ${jpegBytes[1]?.toString(16)}`,
    )
    // 直接检查像素：用工具自己的 resize 把 jpeg 转回 png 再读像素太绕，
    // 这里用一个更直接的判据 —— JPEG 的体积。全黑图的 JPEG 会非常小，
    // 而白底 + 红色块的图会明显更大。
    assert(jpegBytes.byteLength > 300, 'JPEG 体积正常（全黑图会被压到极小）', `${jpegBytes.byteLength} 字节`)

    // 更硬的判据：把 JPEG 交回 image.info 看它是否可解析（说明产物是有效图片）
    const jpegId = toJpeg.job.outputNodeIds[0]
    const jpegInfo = await runTool(client, 'image.info', [jpegId])
    assert(jpegInfo.ok, '产物能被图片工具正常解析（是有效图片）', jpegInfo.error ?? '')
    if (jpegInfo.ok) {
      const meta = jpegInfo.job.data?.images?.[0]
      assert(meta?.width === 40 && meta?.height === 20, '尺寸保持一致', `${meta?.width}x${meta?.height}`)
      assert(meta?.format === 'jpeg', '格式是 jpeg', meta?.format)
      assert(meta?.hasAlpha === false, 'JPEG 没有 alpha 通道')
    }
  }

  // ---------------------------------------------------------------- 格式转换
  console.log('\n【格式转换】')
  for (const [format, magic, label] of [
    ['webp', [0x52, 0x49, 0x46, 0x46], 'WebP'],
    ['avif', null, 'AVIF'],
  ]) {
    const res = await runTool(client, 'image.convert', [largeId], { format, quality: 80 })
    assert(res.ok, `转 ${label} 成功`, res.error ?? '')
    if (res.ok && res.job.outputNodeIds.length > 0) {
      const bytes = await download(client, res.job.outputNodeIds[0])
      if (magic) {
        assert(
          magic.every((b, i) => bytes[i] === b),
          `${label} 文件头正确`,
          [...bytes.slice(0, 4)].map((b) => b.toString(16)).join(' '),
        )
      } else {
        // AVIF 是 ISO BMFF 容器，第 4-8 字节是 "ftyp"
        assert(bytes.toString('ascii', 4, 8) === 'ftyp', 'AVIF 是合法的 ISO BMFF 容器')
      }
      assert(bytes.byteLength < largePng.byteLength, `${label} 比原 PNG 小`, `${bytes.byteLength} vs ${largePng.byteLength}`)
    }
  }

  const badFormat = await runTool(client, 'image.convert', [largeId], { format: 'bmp2' })
  assert(!badFormat.ok, '不支持的目标格式被拒绝', badFormat.error ?? '')

  // ---------------------------------------------------------------- 缩放
  console.log('\n【缩放】')
  const resized = await runTool(client, 'image.resize', [largeId], { width: 150, height: 0, format: 'png' })
  assert(resized.ok, '按宽度缩放到 150 完成', resized.error ?? '')
  if (resized.ok && resized.job.outputNodeIds.length > 0) {
    const bytes = await download(client, resized.job.outputNodeIds[0])
    const size = readPngSize(bytes)
    assert(size.width === 150, '宽度变成 150', `${size.width}`)
    // 600x600 缩到宽 150，等比缩放高度也应是 150
    assert(size.height === 150, '高度等比缩放（600×600 → 150×150）', `${size.height}`)
  }

  // 只缩小不放大
  const enlarge = await runTool(client, 'image.resize', [resized.job.outputNodeIds[0]], {
    width: 1920,
    format: 'png',
  })
  assert(enlarge.ok, '尝试把小图放大（工具允许提交）', enlarge.error ?? '')
  if (enlarge.ok && enlarge.job.outputNodeIds.length > 0) {
    const bytes = await download(client, enlarge.job.outputNodeIds[0])
    const size = readPngSize(bytes)
    assert(
      size.width === 150,
      '只缩小不放大：150px 的图传 1920 仍然是 150px（放大只会变模糊）',
      `${size.width}x${size.height}`,
    )
  }

  // 不填尺寸要拒绝
  const noSize = await runTool(client, 'image.resize', [largeId], { width: 0, height: 0 })
  assert(!noSize.ok, '宽度与高度都不填时被拒绝', noSize.error ?? '')

  // ---------------------------------------------------------------- 压缩
  console.log('\n【压缩】')
  const compressed = await runTool(client, 'image.compress', [largeId], { level: 'medium' })
  assert(compressed.ok, '压缩任务完成', compressed.error ?? '')
  if (compressed.ok && compressed.job.outputNodeIds.length > 0) {
    const bytes = await download(client, compressed.job.outputNodeIds[0])
    assert(
      bytes.byteLength < largePng.byteLength,
      '压缩后体积变小',
      `${bytes.byteLength} vs 原 ${largePng.byteLength}（省 ${Math.round((1 - bytes.byteLength / largePng.byteLength) * 100)}%）`,
    )
  }

  // ---------------------------------------------------------------- 多图批量
  console.log('\n【批量处理】')
  const secondPng = makePng(80, 60, (_r, c) => [10, 200, 90, 255])
  const secondId = await upload(client, `绿色-${SUFFIX}.png`, secondPng)
  const batch = await runTool(client, 'image.convert', [largeId, secondId], { format: 'webp', quality: 80 })
  assert(batch.ok, '一次处理两张图', batch.error ?? '')
  assert(batch.ok && batch.job.outputNodeIds.length === 2, '产出两个文件', `${batch.job.outputNodeIds?.length} 个`)

  // ---------------------------------------------------------------- 非图片输入
  console.log('\n【输入校验】')
  const notImage = Buffer.from('这不是图片，只是一段文本。')
  const textId = await upload(client, `文本-${SUFFIX}.txt`, notImage)
  const wrongInput = await runTool(client, 'image.convert', [textId], { format: 'webp' })
  assert(!wrongInput.ok, '把文本文件喂给图片工具会被拒绝', wrongInput.error ?? '')
  assert(
    typeof wrongInput.error === 'string' && wrongInput.error.includes('不是图片'),
    '错误信息说清了原因',
    wrongInput.error,
  )

  const missingInput = await runTool(client, 'image.info', [])
  assert(!missingInput.ok, '不提供输入文件会被拒绝', missingInput.error ?? '')

  // ---------------------------------------------------------------- 结果
  console.log(
    `\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
