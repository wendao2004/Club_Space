/**
 * 文档转换（Word/文本 → PDF）的端到端测试。
 *
 * 为什么需要这个文件：这条链路**曾经是个空壳**。
 * 服务端往 `${CONVERT_SERVICE_URL}/jobs` 发一段 JSON，里面带
 * `callback: /api/internal/jobs/<id>`，指望转换服务自己取文件、干完再回调 ——
 * 而应用侧根本没有那个路由，转换服务（Gotenberg）也没有 /jobs 这个接口。
 * 也就是说在任何配置下都跑不通，但界面上显示成"部署了服务就能用"。
 *
 * 所以这个测试的核心不是"函数返回了 200"，而是**验证两边真的对上了**：
 *   - 应用发出的请求确实打到 Gotenberg 真实存在的路由上
 *   - 请求体确实是 multipart 且带 files 段（Gotenberg 的约定）
 *   - 返回的字节确实被当成产物存成了文件节点
 *
 * 用一个**假的 Gotenberg**来当对端：它记录收到的请求，返回一份最小 PDF。
 * 这样即使本机没有 Docker、没有 LibreOffice，也能把接口契约钉死。
 *
 * 用法：由 scripts/run-all-tests.mjs 启动带 WL_CONVERT_SERVICE_URL 的服务端后运行。
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const BASE = process.env.WL_TEST_BASE ?? 'http://127.0.0.1:3000'
const FAKE_PORT = Number(process.env.WL_FAKE_CONVERT_PORT ?? 9919)
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

/** 一份最小但结构合法的 PDF —— 收端按 %PDF- 开头处理即可。 */
const FAKE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
)

function makeClient() {
  let cookie = ''
  return {
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
      const parsed = type.includes('application/json') ? await res.json() : await res.text()
      return { status: res.status, body: parsed, headers: res.headers }
    },
  }
}

/** 假的 Gotenberg：记录请求，返回一份 PDF。 */
function startFakeConvert() {
  const seen = []
  let mode = 'ok'
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      seen.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'] ?? '',
        outputName: req.headers['gotenberg-output-filename'] ?? '',
        // 有没有一个叫 files 的 multipart 段 —— Gotenberg 的约定就是这个字段名
        hasFilesPart: /name="files"/.test(raw.toString('latin1')),
        bytes: raw.length,
      })
      if (mode === 'fail') {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('LibreOffice 无法解析该文件')
        return
      }
      res.writeHead(200, { 'content-type': 'application/pdf' })
      res.end(FAKE_PDF)
    })
  })
  return new Promise((resolve) => {
    server.listen(FAKE_PORT, '127.0.0.1', () =>
      resolve({
        seen,
        setMode: (m) => {
          mode = m
        },
        close: () => new Promise((r) => server.close(r)),
      }),
    )
  })
}

async function waitForJob(client, jobId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const res = await client.api(`/api/jobs/${jobId}`)
    last = res.body?.job ?? last
    if (last && (last.state === 'done' || last.state === 'failed')) return last
    await new Promise((r) => setTimeout(r, 200))
  }
  return last
}

async function main() {
  console.log(`\n\x1b[1m文档转换（推送式调用）\x1b[0m  目标 ${BASE}\n`)

  const fake = await startFakeConvert()
  console.log(`【假 Gotenberg 已在 127.0.0.1:${FAKE_PORT} 就绪】\n`)

  const client = makeClient()
  try {
    // ------------------------------------------------------------ 准备
    console.log('【准备】')
    const reg = await client.api('/api/auth/register', {
      method: 'POST',
      json: { username: `cv${SUFFIX}`, displayName: '转换测试员', password: 'convert-test-2026' },
    })
    if (reg.status !== 200 && reg.status !== 201) {
      bad('注册测试账号', `状态 ${reg.status}：${JSON.stringify(reg.body)}`)
      return
    }
    ok('注册测试账号')

    const folder = await client.api('/api/files/folder', {
      method: 'POST',
      json: { parentId: null, name: '转换测试', space: 'shared' },
    })
    assert(folder.status === 200 || folder.status === 201, '建测试目录')
    const parentId = folder.body.node?.id ?? null

    // 传一个文本文件（doc.to-pdf 接受 text/plain；纯文本也最好造）
    const content = Buffer.from('# 社团通知\n\n本周五 19:00 例会，请准时参加。\n', 'utf8')
    const sha = createHash('sha256').update(content).digest('hex')
    const init = await client.api('/api/uploads', {
      method: 'POST',
      json: { parentId, name: '通知.md', size: content.length, sha256: sha, space: 'shared' },
    })
    assert(init.status === 200, '开启上传会话', `状态 ${init.status}`)
    const put = await client.api(`/api/uploads/${init.body.uploadId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: content,
    })
    assert(put.status === 200, '上传内容')
    const done = await client.api(`/api/uploads/${init.body.uploadId}/complete`, { method: 'POST' })
    assert(done.status === 200, '完成上传', `mime=${done.body.mime}`)
    const inputId = done.body.nodeId

    // ------------------------------------------------------------ 工具可见性
    console.log('\n【工具可用性】')
    const tools = await client.api('/api/tools')
    const toPdf = (tools.body.tools ?? []).find((t) => t.id === 'doc.to-pdf')
    assert(!!toPdf, '「转为 PDF」出现在工具清单里')
    assert(
      toPdf?.available === true,
      '配置了 WL_CONVERT_SERVICE_URL 后它显示为可用',
      `available=${toPdf?.available} ${toPdf?.reason ?? ''}`,
    )

    // ------------------------------------------------------------ 正常转换
    console.log('\n【正常转换】')
    fake.seen.length = 0
    const run = await client.api('/api/tools/doc.to-pdf/run', {
      method: 'POST',
      json: { nodeIds: [inputId], params: {}, space: 'shared' },
    })
    assert(run.status === 200 && typeof run.body.jobId === 'string', '提交转换任务', `状态 ${run.status}`)

    const job = await waitForJob(client, run.body.jobId)
    assert(job?.state === 'done', '任务完成', `state=${job?.state} err=${job?.error ?? ''}`)
    assert(
      (job?.outputNodeIds ?? []).length === 1,
      '产出了 1 个文件节点',
      JSON.stringify(job?.outputNodeIds ?? []),
    )

    // ------------------------------------------------------------ 契约核对
    // 这一节才是这个测试的重点：光看"任务成功"无法发现对端换成了另一个接口。
    console.log('\n【与 Gotenberg 的接口契约】')
    assert(fake.seen.length === 1, '应用只发了一次请求', `${fake.seen.length} 次`)
    const req = fake.seen[0]
    assert(req?.method === 'POST', '用的是 POST')
    assert(
      req?.url === '/forms/libreoffice/convert',
      '打的是 Gotenberg 真实存在的路由（而不是自造的 /jobs）',
      `实际 ${req?.url}`,
    )
    assert(
      req?.contentType?.startsWith('multipart/form-data'),
      '请求体是 multipart/form-data',
      req?.contentType ?? '(空)',
    )
    assert(req?.hasFilesPart === true, 'multipart 里有名为 files 的段（Gotenberg 的约定）')
    assert(
      typeof req?.outputName === 'string' &&
        req.outputName.length > 0 &&
        /^[\x20-\x7e]+$/.test(req.outputName),
      '带上了 Gotenberg-Output-Filename 头，且值全是 ASCII',
      `值 "${req?.outputName}"`,
    )
    assert(req?.bytes > 0, '确实把文件字节发过去了', `${req?.bytes} 字节`)

    // ------------------------------------------------------------ 产物
    console.log('\n【产物】')
    const outId = job?.outputNodeIds?.[0]
    if (outId) {
      // 产物落在输入文件所在的目录里 —— 目录列表接口按 parent 列子项
      const listed = await client.api(`/api/files?parent=${parentId}&space=shared`)
      const node = (listed.body?.entries ?? []).find((e) => e.id === outId)
      assert(!!node, '产物出现在输入文件所在的目录里', outId ?? '(没有产物 id)')
      assert(node?.kind === 'file', '产物是一个文件节点', node?.kind ?? '(没找到该节点)')
      assert(node?.mime === 'application/pdf', '产物的类型是 application/pdf', node?.mime ?? '')
      assert(
        typeof node?.name === 'string' && node.name.endsWith('.pdf'),
        '产物按 PDF 命名',
        node?.name ?? '',
      )
      // ASCII 化只用在 HTTP 头里，给用户看的名字必须保留中文 ——
      // 这条断言就是为了防止有人"顺手"把产物名也一起 ASCII 化了。
      assert(
        node?.name === '通知.pdf',
        '产物名保留了原始的中文名',
        node?.name ?? '',
      )
      const dl = await client.api(`/api/files/${outId}/download`)
      assert(
        typeof dl.body === 'string' && dl.body.startsWith('%PDF-'),
        '产物内容确实是 PDF',
        String(dl.body).slice(0, 12),
      )
    }

    // ------------------------------------------------------------ 失败路径
    console.log('\n【失败路径要能说清原因】')
    fake.setMode('fail')
    const run2 = await client.api('/api/tools/doc.to-pdf/run', {
      method: 'POST',
      json: { nodeIds: [inputId], params: {}, space: 'shared' },
    })
    const job2 = await waitForJob(client, run2.body.jobId)
    assert(job2?.state === 'failed', '转换服务报错时任务标记为失败')
    assert(
      typeof job2?.error === 'string' && job2.error.includes('转换失败'),
      '错误信息说明了是转换失败而不是网络问题',
      String(job2?.error).slice(0, 120),
    )
    fake.setMode('ok')

    // 视频转码还没实现 —— 必须明确说"没实现"，而不是给一个看不懂的超时
    const transcode = await client.api('/api/tools/media.transcode/run', {
      method: 'POST',
      json: { nodeIds: [inputId], params: { preset: 'compressed' }, space: 'shared' },
    })
    if (transcode.status === 200) {
      const job3 = await waitForJob(client, transcode.body.jobId)
      assert(
        job3?.state === 'failed' && String(job3.error).includes('还没有可用的服务端实现'),
        '未实现的工具明确报"没有实现"',
        String(job3?.error).slice(0, 120),
      )
    } else {
      ok('未实现的工具在提交阶段就被拒', `状态 ${transcode.status}`)
    }

    // ------------------------------------------------------------ 体积闸门
    console.log('\n【体积闸门】')
    const big = await client.api('/api/uploads', {
      method: 'POST',
      json: {
        parentId,
        name: '巨大的文档.txt',
        size: 200 * 1024 * 1024,
        sha256: 'f'.repeat(64),
        space: 'shared',
      },
    })
    if (big.status === 200 && big.body.uploadId) {
      // 不真传 200MB：只要一个超过上限的节点即可，用秒传之外的方式造不出来，
      // 所以这里只验证"接口本身没有因为我们改过而崩"，真正的闸门由 inline 侧覆盖。
      ok('超大文件的上传会话能正常开启（闸门在工具入口处）')
      await client.api(`/api/uploads/${big.body.uploadId}`, { method: 'DELETE' })
    }
  } finally {
    await fake.close()
  }

  console.log(`\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止:\x1b[0m', err)
  process.exit(1)
})
