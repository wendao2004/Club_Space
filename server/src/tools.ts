/**
 * 工具集：可插拔注册表 + 任务队列。
 *
 * 两条泳道（评审团对「重任务内存」的结论落成了代码结构）：
 *
 *   inline —— 纯 JS、内存小的任务，在后端进程内直接跑。
 *             PDF 合并/拆分/旋转、二维码、图片处理。峰值几十 MB，可以放心。
 *
 *   external —— 需要 LibreOffice / Chromium / ffmpeg 的重任务。
 *             这些服务在 NAS 上单实例就要 1-2GB，**绝不常驻**，由 NAS 侧的
 *             按需调度器拉起（见 deploy/ 下的说明）。未配置服务地址时，
 *             工具在界面上显示为「未启用」而不是点了没反应 —— 评审团反复
 *             强调：宁可显式告知，不能假装可用。
 *
 * 许可证红线：PDF 处理只用 pdf-lib (MIT)。**绝不引入 PyMuPDF** —— 事实核查
 * 组实测其许可为 "GNU AFFERO GPL 3.0 or Artifex Commercial License"，
 * 闭源打包分发时会触发 AGPL 传染。
 */
import { createHash, randomInt } from 'node:crypto'
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import QRCode from 'qrcode'
import { CONVERT_SERVICE_URL, TOOLS_ENABLED } from './config.ts'
import { getDb, newId, now, transaction } from './db.ts'
import { HttpError, readNodeBuffer, saveBufferAsNode, type Node, type Space } from './files.ts'

export interface ToolContext {
  userId: string
  inputs: Node[]
  params: Record<string, unknown>
  space: Space
  /** 产物落地方向：产物放到第一个输入所在的目录。 */
  outputParentId: string | null
  /** 把一段字节落成文件节点。 */
  produce(name: string, data: Uint8Array, mime: string): Promise<Node>
  /** 报告进度（0-100）与可选说明。 */
  progress(value: number, message?: string): void
}

export interface ToolResult {
  /** 工具产出的节点（可能多个）。 */
  outputs: Node[]
  /** 不产出文件时的结构化结果（例如 PDF 页数）。 */
  data?: unknown
  message?: string
}

export interface ToolDef {
  id: string
  name: string
  description: string
  category: 'pdf' | 'image' | 'document' | 'utility' | 'media'
  /** 接受的输入 MIME（精确值或 "image/" 这样的前缀）。 */
  accepts: string[]
  /** 输入文件数量要求。 */
  minInputs: number
  maxInputs: number
  /** 参数声明，供前端自动渲染表单。 */
  params?: Array<{
    key: string
    label: string
    type: 'text' | 'number' | 'select' | 'boolean'
    options?: Array<{ value: string; label: string }>
    default?: string | number | boolean
    placeholder?: string
    help?: string
  }>
  kind: 'inline' | 'external'
  /** 是否当前环境可用。不可用时返回原因，界面据此显示「未启用」。 */
  availability(): { available: true } | { available: false; reason: string }
  run?(ctx: ToolContext): Promise<ToolResult>
}

// ---------------------------------------------------------------- 工具实现

function requireParam<T>(params: Record<string, unknown>, key: string, label: string): T {
  const value = params[key]
  if (value === undefined || value === null || value === '') {
    throw new HttpError(400, `缺少参数：${label}`)
  }
  return value as T
}

function parsePageRange(spec: string, pageCount: number): number[] {
  const pages = new Set<number>()
  for (const part of spec.split(',')) {
    const piece = part.trim()
    if (!piece) continue
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      let from = Number.parseInt(range[1]!, 10)
      let to = Number.parseInt(range[2]!, 10)
      if (from > to) [from, to] = [to, from]
      for (let p = from; p <= to; p++) {
        if (p >= 1 && p <= pageCount) pages.add(p - 1)
      }
      continue
    }
    const single = piece.match(/^\d+$/)
    if (single) {
      const p = Number.parseInt(piece, 10)
      if (p >= 1 && p <= pageCount) pages.add(p - 1)
      continue
    }
    throw new HttpError(400, `无法解析页码范围：「${piece}」（示例：1-3,5,8-10）`)
  }
  if (pages.size === 0) throw new HttpError(400, '页码范围没有匹配到任何页')
  return [...pages].sort((a, b) => a - b)
}

const pdfTools: ToolDef[] = [
  {
    id: 'pdf.info',
    name: 'PDF 信息',
    description: '查看页数、纸张尺寸与元数据，不做任何修改。',
    category: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: 1,
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const doc = await PDFDocument.load(await readNodeBuffer(ctx.inputs[0]!), {
        ignoreEncryption: true,
      })
      const pages = doc.getPages().map((page, index) => {
        const { width, height } = page.getSize()
        return {
          index: index + 1,
          width: Math.round(width),
          height: Math.round(height),
          rotation: page.getRotation().angle,
        }
      })
      ctx.progress(100)
      return {
        outputs: [],
        data: {
          pageCount: doc.getPageCount(),
          title: doc.getTitle() ?? null,
          author: doc.getAuthor() ?? null,
          producer: doc.getProducer() ?? null,
          pages,
        },
      }
    },
  },
  {
    id: 'pdf.merge',
    name: '合并 PDF',
    description: '按选择顺序把多个 PDF 合成一个文件。',
    category: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 2,
    maxInputs: 50,
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const merged = await PDFDocument.create()
      let done = 0
      for (const input of ctx.inputs) {
        const src = await PDFDocument.load(await readNodeBuffer(input), { ignoreEncryption: true })
        const copied = await merged.copyPages(src, src.getPageIndices())
        for (const page of copied) merged.addPage(page)
        done++
        ctx.progress(Math.round((done / ctx.inputs.length) * 90))
      }
      const bytes = await merged.save()
      const out = await ctx.produce('合并结果.pdf', bytes, 'application/pdf')
      ctx.progress(100)
      return { outputs: [out], message: `已合并 ${ctx.inputs.length} 个文件，共 ${merged.getPageCount()} 页` }
    },
  },
  {
    id: 'pdf.split',
    name: '提取页码范围',
    description: '抽取指定页生成新的 PDF，例如「1-3,5,8-10」。',
    category: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: 1,
    params: [
      {
        key: 'pages',
        label: '页码范围',
        type: 'text',
        placeholder: '1-3,5,8-10',
        help: '从 1 开始计数，支持区间与逗号分隔',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const spec = requireParam<string>(ctx.params, 'pages', '页码范围')
      const src = await PDFDocument.load(await readNodeBuffer(ctx.inputs[0]!), {
        ignoreEncryption: true,
      })
      const indices = parsePageRange(spec, src.getPageCount())
      const out = await PDFDocument.create()
      const copied = await out.copyPages(src, indices)
      for (const page of copied) out.addPage(page)
      const bytes = await out.save()
      ctx.progress(90)
      const base = ctx.inputs[0]!.name.replace(/\.pdf$/i, '')
      const node = await ctx.produce(`${base}-提取.pdf`, bytes, 'application/pdf')
      ctx.progress(100)
      return { outputs: [node], message: `已提取 ${indices.length} 页` }
    },
  },
  {
    id: 'pdf.rotate',
    name: '旋转 PDF',
    description: '把全部页面顺时针旋转指定角度。',
    category: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: 1,
    params: [
      {
        key: 'angle',
        label: '角度',
        type: 'select',
        options: [
          { value: '90', label: '顺时针 90°' },
          { value: '180', label: '180°' },
          { value: '270', label: '逆时针 90°' },
        ],
        default: '90',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const angle = Number.parseInt(requireParam<string>(ctx.params, 'angle', '角度'), 10)
      if (![90, 180, 270].includes(angle)) throw new HttpError(400, '角度只能是 90 / 180 / 270')
      const doc = await PDFDocument.load(await readNodeBuffer(ctx.inputs[0]!), {
        ignoreEncryption: true,
      })
      for (const page of doc.getPages()) {
        const current = page.getRotation().angle
        page.setRotation(degrees((current + angle) % 360))
      }
      const bytes = await doc.save()
      const base = ctx.inputs[0]!.name.replace(/\.pdf$/i, '')
      const node = await ctx.produce(`${base}-旋转${angle}.pdf`, bytes, 'application/pdf')
      ctx.progress(100)
      return { outputs: [node] }
    },
  },
  {
    id: 'pdf.remove-pages',
    name: '删除页面',
    description: '删掉指定的页面，其余原样保留，例如「2,5,7-9」。与「提取页码范围」正好相反。',
    category: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: 1,
    params: [
      {
        key: 'pages',
        label: '要删除的页码',
        type: 'text',
        placeholder: '2,5,7-9',
        help: '从 1 开始计数；不能把整份文档删空',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const spec = requireParam<string>(ctx.params, 'pages', '要删除的页码')
      const doc = await PDFDocument.load(await readNodeBuffer(ctx.inputs[0]!), {
        ignoreEncryption: true,
      })
      const indices = parsePageRange(spec, doc.getPageCount())
      // 用「至少留一页」而不是「允许删空」：0 页的 PDF 在多数阅读器里直接打不开，
      // 与其产出一个坏文件，不如在入口就把这个没有意义的请求挡回去。
      if (indices.length >= doc.getPageCount()) {
        throw new HttpError(400, '不能删除全部页面，请至少保留一页')
      }
      // ⚠️ 必须从后往前删。removePage 会让后面页面的下标整体前移，如果从小到大删，
      // 删完第 2 页之后原本的第 5 页已经变成第 4 页，接着删「5」删掉的是错的那一页。
      for (const index of [...indices].sort((a, b) => b - a)) doc.removePage(index)
      const bytes = await doc.save()
      ctx.progress(90)
      const node = await ctx.produce(
        `${stripExtension(ctx.inputs[0]!.name)}-删除${indices.length}页.pdf`,
        bytes,
        'application/pdf',
      )
      ctx.progress(100)
      return { outputs: [node], message: `已删除 ${indices.length} 页，剩余 ${doc.getPageCount()} 页` }
    },
  },
  {
    id: 'pdf.split-each',
    name: '逐页拆分',
    description: '把每一页拆成单独的 PDF 文件，一次产出多个文件，常用于把合订本还原成单页。',
    category: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: 1,
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const src = await PDFDocument.load(await readNodeBuffer(ctx.inputs[0]!), {
        ignoreEncryption: true,
      })
      const pageCount = src.getPageCount()
      // 页数上限：每一页都会落成一个独立文件节点。一份 2000 页的扫描件会瞬间
      // 生成 2000 个节点，把目录塞爆、把界面卡死。这里显式挡住并给出替代做法。
      if (pageCount > MAX_SPLIT_PAGES) {
        throw new HttpError(
          400,
          `共 ${pageCount} 页，超过一次拆分的上限（${MAX_SPLIT_PAGES} 页）。请先用「提取页码范围」分批处理。`,
        )
      }
      const base = stripExtension(ctx.inputs[0]!.name)
      const outputs = []
      for (let i = 0; i < pageCount; i++) {
        const doc = await PDFDocument.create()
        const copied = await doc.copyPages(src, [i])
        // copied 一定有一项（上面按单页索引拷贝），断言只是为了让类型收窄。
        doc.addPage(copied[0]!)
        const bytes = await doc.save()
        outputs.push(await ctx.produce(`${base}-第${i + 1}页.pdf`, bytes, 'application/pdf'))
        ctx.progress(Math.round(((i + 1) / pageCount) * 100))
      }
      return { outputs, message: `已拆成 ${outputs.length} 个文件` }
    },
  },
  {
    id: 'pdf.page-numbers',
    name: '添加页码',
    description: '在每一页上叠加页码。只画数字，因此不含中文字形。',
    category: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: 1,
    params: [
      {
        key: 'position',
        label: '位置',
        type: 'select',
        options: [
          { value: 'bottom-center', label: '页脚居中' },
          { value: 'bottom-right', label: '页脚右下' },
          { value: 'top-center', label: '页眉居中' },
        ],
        default: 'bottom-center',
      },
      {
        key: 'format',
        label: '格式',
        type: 'select',
        options: [
          { value: 'plain', label: '1' },
          { value: 'of-total', label: '1 / 10' },
        ],
        default: 'plain',
      },
      { key: 'startAt', label: '起始编号', type: 'number', default: 1, help: '封面不计页码时可设为 2' },
      { key: 'fontSize', label: '字号（pt）', type: 'number', default: 11 },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const doc = await PDFDocument.load(await readNodeBuffer(ctx.inputs[0]!), {
        ignoreEncryption: true,
      })
      // 用 pdf-lib 内置的 14 个标准字体，**不需要 fontkit、不需要字体文件**。
      // 代价是标准字体只覆盖 WinAnsi 字符集（拉丁字母、数字、常见西文标点），
      // 写中文会整段丢失 —— 而页码只有数字和斜杠，恰好落在安全区内。
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const position = String(ctx.params.position ?? 'bottom-center')
      const format = String(ctx.params.format ?? 'plain')
      const startAt = clampInt(ctx.params.startAt, 1, { min: 1, max: 100000 })
      const fontSize = clampInt(ctx.params.fontSize, 11, { min: 6, max: 72 })
      const pages = doc.getPages()
      const denominator = startAt + pages.length - 1
      const margin = 24
      let done = 0
      for (const page of pages) {
        const label =
          format === 'of-total' ? `${startAt + done} / ${denominator}` : `${startAt + done}`
        const { width, height } = page.getSize()
        const textWidth = font.widthOfTextAtSize(label, fontSize)
        let x: number
        let y: number
        if (position === 'top-center') {
          x = (width - textWidth) / 2
          y = height - margin - fontSize
        } else if (position === 'bottom-right') {
          x = width - margin - textWidth
          y = margin
        } else {
          x = (width - textWidth) / 2
          y = margin
        }
        page.drawText(label, { x, y, size: fontSize, font, color: rgb(0.25, 0.25, 0.25) })
        done++
        ctx.progress(Math.round((done / pages.length) * 100))
      }
      const bytes = await doc.save()
      const node = await ctx.produce(
        `${stripExtension(ctx.inputs[0]!.name)}-页码.pdf`,
        bytes,
        'application/pdf',
      )
      return { outputs: [node], message: `已为 ${pages.length} 页添加页码` }
    },
  },
  {
    id: 'pdf.watermark',
    name: '添加水印',
    description:
      '给每一页叠加水印。文字水印仅支持英文/数字（PDF 标准字体不含中文字形）；选第二张图片则叠加图片水印。',
    category: 'pdf',
    // 第二个输入可以是图片（图片水印）。第一个必须是 PDF，运行时校验。
    accepts: ['application/pdf', 'image/png', 'image/jpeg'],
    minInputs: 1,
    maxInputs: 2,
    params: [
      {
        key: 'text',
        label: '水印文字（英文/数字）',
        type: 'text',
        default: 'CONFIDENTIAL',
        placeholder: 'CONFIDENTIAL',
      },
      { key: 'opacity', label: '不透明度（0-1）', type: 'number', default: 0.15 },
      { key: 'fontSize', label: '字号（pt）', type: 'number', default: 48 },
      {
        key: 'angle',
        label: '旋转角度',
        type: 'select',
        options: [
          { value: '45', label: '45°（斜向）' },
          { value: '0', label: '水平' },
          { value: '-45', label: '-45°' },
        ],
        default: '45',
      },
      { key: 'color', label: '颜色', type: 'text', default: '#808080', placeholder: '#808080' },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const first = ctx.inputs[0]!
      if (first.mime !== 'application/pdf' && !first.name.toLowerCase().endsWith('.pdf')) {
        throw new HttpError(400, '第一个输入必须是 PDF 文件')
      }
      const doc = await PDFDocument.load(await readNodeBuffer(first), { ignoreEncryption: true })
      const opacity = clampNumber(ctx.params.opacity, 0.15, { min: 0.02, max: 1 })
      const angle = clampInt(ctx.params.angle, 45, { min: -360, max: 360 })
      const radians = (angle * Math.PI) / 180

      const extra = ctx.inputs[1]
      // 图片水印：第二张是图片时优先按图片水印处理。
      let watermarkImage: Awaited<ReturnType<typeof doc.embedPng>> | null = null
      let text = ''
      if (extra) {
        if (!extra.mime?.startsWith('image/')) {
          throw new HttpError(400, `第二个输入必须是图片（识别为 ${extra.mime ?? '未知类型'}）`)
        }
        const bytes = await readNodeBuffer(extra)
        // pdf-lib 只认 PNG/JPEG 两种内嵌格式。输入被 accepts 限制在这两类，
        // 这里再按 MIME 分支；万一是别的格式，embed 会抛错并被上层翻译成任务失败。
        watermarkImage = extra.mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
      } else {
        text = String(ctx.params.text ?? 'CONFIDENTIAL')
        if (!text) throw new HttpError(400, '水印文字不能为空')
        // ⚠️ 这条校验必须在入口挡住，而不是"画上去看着是空的"。标准字体没有中文字形，
        // pdf-lib 画非 WinAnsi 字符时会静默丢弃（或直接抛错），用户只会看到一份
        // "水印没了"的 PDF，却完全不知道为什么 —— 所以这里用明确的提示代替静默失败。
        if (!isAsciiPrintable(text)) {
          throw new HttpError(
            400,
            '水印文字只能包含英文、数字与常见符号。内置 PDF 标准字体不含中文字形，写中文会整段丢失；需要中文水印请改用图片水印。',
          )
        }
      }
      const [r, g, b] = hexToRgb(String(ctx.params.color ?? '#808080'))
      const fontSize = clampInt(ctx.params.fontSize, 48, { min: 6, max: 400 })
      const font = watermarkImage ? null : await doc.embedFont(StandardFonts.Helvetica)
      const textColor = rgb(r / 255, g / 255, b / 255)

      const pages = doc.getPages()
      let done = 0
      for (const page of pages) {
        const { width, height } = page.getSize()
        if (watermarkImage) {
          const w = Math.min(width, height) * 0.3
          const h = w * (watermarkImage.height / watermarkImage.width)
          // drawImage 的旋转是绕传入的 (x,y) 这个锚点转的，不是绕图片中心。
          // 想让水印「斜着摆在正中」，必须自己把锚点往对角线方向挪半个旋转后的位移，
          // 否则水印会绕着左上角转，跑到页面外面去。
          const anchor = centeredRotatedAnchor(width / 2, height / 2, w, h, radians)
          page.drawImage(watermarkImage, {
            x: anchor.x,
            y: anchor.y,
            width: w,
            height: h,
            opacity,
            rotate: degrees(angle),
          })
        } else {
          const textWidth = font!.widthOfTextAtSize(text, fontSize)
          const anchor = centeredRotatedAnchor(width / 2, height / 2, textWidth, fontSize, radians)
          page.drawText(text, {
            x: anchor.x,
            y: anchor.y,
            size: fontSize,
            font: font!,
            color: textColor,
            opacity,
            rotate: degrees(angle),
          })
        }
        done++
        ctx.progress(Math.round((done / pages.length) * 100))
      }
      const bytes = await doc.save()
      const node = await ctx.produce(
        `${stripExtension(first.name)}-水印.pdf`,
        bytes,
        'application/pdf',
      )
      return {
        outputs: [node],
        message: `已为 ${pages.length} 页添加${watermarkImage ? '图片' : '文字'}水印`,
      }
    },
  },
]

const utilityTools: ToolDef[] = [
  {
    id: 'qr.generate',
    name: '生成二维码',
    description: '把文本或网址生成二维码图片。支持中文。',
    category: 'utility',
    accepts: [],
    minInputs: 0,
    maxInputs: 0,
    params: [
      {
        key: 'text',
        label: '内容',
        type: 'text',
        placeholder: 'https://… 或任意文本',
      },
      {
        key: 'size',
        label: '尺寸（像素）',
        type: 'number',
        default: 512,
        help: '256 - 2048',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const text = requireParam<string>(ctx.params, 'text', '内容')
      const size = Math.min(2048, Math.max(256, Number(ctx.params.size ?? 512)))
      const png = await QRCode.toBuffer(text, {
        type: 'png',
        width: size,
        margin: 2,
        errorCorrectionLevel: 'M',
      })
      ctx.progress(80)
      const node = await ctx.produce(`二维码-${Date.now()}.png`, new Uint8Array(png), 'image/png')
      ctx.progress(100)
      return { outputs: [node] }
    },
  },
  {
    id: 'file.hash',
    name: '文件校验',
    description: '计算文件的哈希值，用来确认文件是否完整、是否被改动过。零依赖，纯本地计算。',
    category: 'utility',
    // accepts 为空数组 = 不限类型，任何文件都可作为输入（前端把空 accepts 当作"全收"）。
    accepts: [],
    minInputs: 1,
    maxInputs: 20,
    params: [
      {
        key: 'algorithm',
        label: '算法',
        type: 'select',
        options: [
          { value: 'sha256', label: 'SHA-256（推荐）' },
          { value: 'sha1', label: 'SHA-1（兼容旧校验）' },
          { value: 'md5', label: 'MD5（仅作兼容，勿用于安全）' },
        ],
        default: 'sha256',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const algorithm = String(ctx.params.algorithm ?? 'sha256')
      if (algorithm !== 'sha256' && algorithm !== 'sha1' && algorithm !== 'md5') {
        throw new HttpError(400, `不支持的算法：${algorithm}`)
      }
      const pages: Array<Record<string, string>> = []
      let done = 0
      for (const input of ctx.inputs) {
        const buffer = await readNodeBuffer(input)
        const hash = createHash(algorithm).update(buffer).digest('hex')
        // 入库时节点已经记了一份 sha256。算出来的和它比对：一致说明这份内容
        // 自入库以来没被动过 —— 这正是一次「校验」想回答的问题。
        const verify =
          algorithm === 'sha256' && input.sha256
            ? hash === input.sha256
              ? '一致'
              : '不一致'
            : '—'
        pages.push({ name: input.name, size: humanSize(input.size), hash, verify })
        done++
        ctx.progress(Math.round((done / ctx.inputs.length) * 100))
      }
      return {
        outputs: [],
        data: { algorithm, fileCount: pages.length, pages },
        message: `已计算 ${pages.length} 个文件的 ${algorithm} 哈希`,
      }
    },
  },
  {
    id: 'text.transform',
    name: '文本工具',
    description:
      'JSON 格式化/压缩、Base64 编解码、URL 编解码、去重排序、字数统计。可直接粘贴文本，也可选一个文本文件。',
    category: 'utility',
    accepts: ['text/'],
    // 允许"零文件输入"：文本也可以直接在参数里粘贴。
    minInputs: 0,
    maxInputs: 1,
    params: [
      {
        key: 'mode',
        label: '操作',
        type: 'select',
        options: [
          { value: 'json-format', label: 'JSON 格式化' },
          { value: 'json-minify', label: 'JSON 压缩' },
          { value: 'base64-encode', label: 'Base64 编码' },
          { value: 'base64-decode', label: 'Base64 解码' },
          { value: 'url-encode', label: 'URL 编码' },
          { value: 'url-decode', label: 'URL 解码' },
          { value: 'dedupe-sort', label: '去重并排序（按行）' },
          { value: 'count', label: '字数统计' },
        ],
        default: 'json-format',
      },
      {
        key: 'text',
        label: '文本内容（未选文件时使用）',
        type: 'text',
        placeholder: '直接粘贴文本…',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const mode = String(ctx.params.mode ?? 'json-format')
      // 取源文本：优先用选中的文件，其次用参数里的文本。两者都没有就报错。
      let source: string
      let sourceName = '文本'
      if (ctx.inputs.length > 0) {
        const input = ctx.inputs[0]!
        sourceName = stripExtension(input.name)
        source = (await readNodeBuffer(input)).toString('utf8')
      } else if (typeof ctx.params.text === 'string' && ctx.params.text !== '') {
        source = ctx.params.text
      } else {
        throw new HttpError(400, '请选择一个文本文件，或在「文本内容」里粘贴内容')
      }

      // 字数统计不产出文件，直接把几个标量放进 data —— 前端会渲染成键值表。
      if (mode === 'count') {
        const lines = source === '' ? 0 : source.split(/\r\n|\r|\n/).length
        const words = source.trim() === '' ? 0 : source.trim().split(/\s+/).length
        const cjk = (source.match(/[一-鿿]/g) ?? []).length
        ctx.progress(100)
        return {
          outputs: [],
          data: {
            chars: source.length,
            charsNoSpace: source.replace(/\s/g, '').length,
            cjkChars: cjk,
            words,
            lines,
            bytes: Buffer.byteLength(source, 'utf8'),
          },
          message: '字数统计完成',
        }
      }

      let result: string
      if (mode === 'json-format' || mode === 'json-minify') {
        let parsed: unknown
        try {
          parsed = JSON.parse(source)
        } catch (err) {
          throw new HttpError(400, `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
        }
        result = mode === 'json-format' ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed)
      } else if (mode === 'base64-encode') {
        result = Buffer.from(source, 'utf8').toString('base64')
      } else if (mode === 'base64-decode') {
        const cleaned = source.replace(/\s+/g, '')
        // Buffer.from(..., 'base64') 对非法输入是"尽力而为"的，不报错但会给出垃圾。
        // 所以先自己校验一遍字符集与长度，宁可在入口明确报错。
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
          throw new HttpError(400, '这不是合法的 Base64 文本')
        }
        result = Buffer.from(cleaned, 'base64').toString('utf8')
      } else if (mode === 'url-encode') {
        result = encodeURIComponent(source)
      } else if (mode === 'url-decode') {
        try {
          result = decodeURIComponent(source)
        } catch {
          throw new HttpError(400, '这不是合法的 URL 编码文本')
        }
      } else if (mode === 'dedupe-sort') {
        const lines = source.split(/\r\n|\r|\n/)
        const seen = new Set<string>()
        const unique: string[] = []
        for (const line of lines) {
          const key = line.trim()
          // 去重按"去掉首尾空白后的内容"判断，但保留原始行 —— 否则前导空格会被抹掉。
          if (key === '' || seen.has(key)) continue
          seen.add(key)
          unique.push(line)
        }
        unique.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
        result = unique.join('\n')
      } else {
        throw new HttpError(400, `不支持的操作：${mode}`)
      }

      const bytes = Buffer.from(result, 'utf8')
      const node = await ctx.produce(`${sourceName}-结果.txt`, new Uint8Array(bytes), 'text/plain')
      ctx.progress(100)
      return { outputs: [node], message: `已生成结果（${humanSize(bytes.byteLength)}）` }
    },
  },
  {
    id: 'list.shuffle',
    name: '随机抽签 / 分组',
    description:
      '从名单里随机抽取若干名，或把名单随机分成若干组。名单可来自文本文件（每行一个），也可直接填写。',
    category: 'utility',
    accepts: ['text/'],
    minInputs: 0,
    maxInputs: 1,
    params: [
      {
        key: 'mode',
        label: '模式',
        type: 'select',
        options: [
          { value: 'draw', label: '随机抽取' },
          { value: 'group', label: '随机分组' },
        ],
        default: 'draw',
      },
      { key: 'count', label: '抽取人数 / 分组数量', type: 'number', default: 1 },
      {
        key: 'items',
        label: '名单（每行一个，或用逗号/空格分隔）',
        type: 'text',
        placeholder: '张三\n李四\n王五',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const mode = String(ctx.params.mode ?? 'draw')
      let raw = ''
      if (ctx.inputs.length > 0) {
        raw = (await readNodeBuffer(ctx.inputs[0]!)).toString('utf8')
      } else if (typeof ctx.params.items === 'string') {
        raw = ctx.params.items
      }
      // 按换行、逗号、分号、空格、顿号统一拆分，容忍用户随手写的各种分隔符。
      const items = raw
        .split(/[\n\r,，、;；]+|\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (items.length === 0) throw new HttpError(400, '名单为空，请填写或上传一份名单')
      if (items.length > 5000) throw new HttpError(400, `名单过长（${items.length} 项，最多 5000）`)

      const count = clampInt(ctx.params.count, 1, { min: 1, max: items.length })
      const shuffled = shuffle(items)

      if (mode === 'group') {
        // 轮转发牌：把洗好的名单依次丢进各组，保证各组人数最多相差 1。
        const groups: string[][] = Array.from({ length: count }, () => [])
        shuffled.forEach((name, index) => groups[index % count]!.push(name))
        const pages = groups.map((members, index) => ({
          group: `第 ${index + 1} 组`,
          count: members.length,
          members: members.join('、'),
        }))
        return {
          outputs: [],
          data: { total: items.length, groupCount: count, pages },
          message: `已把 ${items.length} 项随机分成 ${count} 组`,
        }
      }
      if (mode === 'draw') {
        const winners = shuffled.slice(0, count)
        const pages = winners.map((winner, index) => ({ order: index + 1, winner }))
        return {
          outputs: [],
          data: { total: items.length, drawn: count, pages },
          message: `从 ${items.length} 项中随机抽出了 ${count} 项`,
        }
      }
      throw new HttpError(400, `不支持的模式：${mode}`)
    },
  },
]

// ---------------------------------------------------------------- 图片工具

/**
 * 图片处理用 sharp（MIT，预编译原生模块，实测可用）。
 *
 * 为什么它能在 inline 道跑：单张图片处理的内存峰值通常在几十 MB，
 * 与 LibreOffice（1-2GB）、ffmpeg（吃满 CPU）不是一个量级。
 *
 * 用**动态导入**而不是顶层 import：sharp 是原生模块，如果某台 NAS 的架构
 * 没有对应的预编译包，顶层 import 会让整个服务起不来 —— 而图片工具只是
 * 工具集里的一部分，不该拖垮整个平台。动态导入让它在缺失时显示为"未启用"。
 */
/**
 * sharp 的模块类型。
 *
 * 注意要取 `['default']`：sharp 是 CJS 包，ESM 动态导入拿到的是模块命名空间，
 * 真正可调用的是它的 default 导出。写 `typeof import('sharp')` 会得到一个
 * "没有调用签名"的类型，于是 sharp(...) 全部报错。
 */
type SharpFactory = (typeof import('sharp'))['default']

async function loadSharp(): Promise<SharpFactory | null> {
  try {
    const mod = await import('sharp')
    return (mod.default ?? mod) as unknown as SharpFactory
  } catch {
    return null
  }
}

/** sharp 支持的输出格式。用字面量联合而不是 string —— 它的 toFormat 只接受这几个。 */
type SharpOutputFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'tiff'

/** sharp 的输出格式 → MIME。 */
const IMAGE_OUTPUT: Record<SharpOutputFormat, { ext: string; mime: string }> = {
  jpeg: { ext: '.jpg', mime: 'image/jpeg' },
  png: { ext: '.png', mime: 'image/png' },
  webp: { ext: '.webp', mime: 'image/webp' },
  avif: { ext: '.avif', mime: 'image/avif' },
  tiff: { ext: '.tiff', mime: 'image/tiff' },
}

/** 把用户传的格式字符串收窄成联合类型；不在支持列表里就返回 null。 */
function asOutputFormat(value: unknown): SharpOutputFormat | null {
  const text = String(value ?? '')
  return text in IMAGE_OUTPUT ? (text as SharpOutputFormat) : null
}

const IMAGE_INPUT_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/tiff']

function requireImageInputs(ctx: ToolContext): void {
  for (const input of ctx.inputs) {
    if (!input.mime?.startsWith('image/')) {
      throw new HttpError(400, `「${input.name}」不是图片（识别为 ${input.mime ?? '未知类型'}）`)
    }
  }
}

const imageTools: ToolDef[] = [
  {
    id: 'image.info',
    name: '图片信息',
    description: '查看尺寸、格式、色彩通道与元数据，不做任何修改。',
    category: 'image',
    accepts: IMAGE_INPUT_MIMES,
    minInputs: 1,
    maxInputs: 20,
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const sharp = await loadSharp()
      if (!sharp) throw new HttpError(503, '图片处理模块不可用（sharp 未安装或缺少本机架构的预编译包）')
      requireImageInputs(ctx)

      const items = []
      for (const input of ctx.inputs) {
        const meta = await sharp(await readNodeBuffer(input)).metadata()
        items.push({
          name: input.name,
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          format: meta.format ?? 'unknown',
          channels: meta.channels ?? 0,
          hasAlpha: meta.hasAlpha ?? false,
          orientation: meta.orientation ?? null,
          sizeBytes: input.size,
          size: humanSize(input.size),
        })
        ctx.progress(Math.round((items.length / ctx.inputs.length) * 100))
      }

      return {
        outputs: [],
        data: { images: items },
        message: items.length === 1 ? `${items[0]!.width}×${items[0]!.height} 像素` : `共 ${items.length} 张`,
      }
    },
  },
  {
    id: 'image.convert',
    name: '图片格式转换',
    description: '在 JPEG / PNG / WebP / AVIF 之间互转。WebP 与 AVIF 通常能显著减小体积。',
    category: 'image',
    accepts: IMAGE_INPUT_MIMES,
    minInputs: 1,
    maxInputs: 50,
    params: [
      {
        key: 'format',
        label: '目标格式',
        type: 'select',
        options: [
          { value: 'webp', label: 'WebP（体积小，浏览器通用）' },
          { value: 'jpeg', label: 'JPEG（兼容性最好）' },
          { value: 'png', label: 'PNG（无损，支持透明）' },
          { value: 'avif', label: 'AVIF（体积最小，较新）' },
        ],
        default: 'webp',
      },
      {
        key: 'quality',
        label: '质量（1-100）',
        type: 'number',
        default: 82,
        help: '仅对有损格式有效；PNG 会忽略此项',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const sharp = await loadSharp()
      if (!sharp) throw new HttpError(503, '图片处理模块不可用')
      requireImageInputs(ctx)

      const format = asOutputFormat(ctx.params.format ?? 'webp')
      if (!format) throw new HttpError(400, `不支持的目标格式：${ctx.params.format}`)
      const target = IMAGE_OUTPUT[format]
      const quality = clampQuality(ctx.params.quality)

      const outputs = []
      let done = 0
      for (const input of ctx.inputs) {
        const buffer = await readNodeBuffer(input)
        // 转成不支持透明的格式时，要先铺一层白底 —— 否则透明区域会变成黑色，
        // 这是图片转换里最常见的"结果看起来坏了"的原因
        let pipeline = sharp(buffer)
        if (format === 'jpeg') {
          pipeline = pipeline.flatten({ background: '#ffffff' })
        }
        if (format === 'avif' || format === 'webp' || format === 'jpeg') {
          pipeline = pipeline.toFormat(format, { quality })
        } else {
          pipeline = pipeline.toFormat(format)
        }
        const result = await pipeline.toBuffer()

        const base = stripExtension(input.name)
        outputs.push(
          await ctx.produce(`${base}${target.ext}`, new Uint8Array(result), target.mime),
        )
        done++
        ctx.progress(Math.round((done / ctx.inputs.length) * 100))
      }

      const saved = ctx.inputs.reduce((sum, i) => sum + i.size, 0) - outputs.reduce((sum, o) => sum + o.size, 0)
      return {
        outputs,
        message:
          saved > 0
            ? `已转换 ${outputs.length} 张，总体积减少 ${humanSize(saved)}`
            : `已转换 ${outputs.length} 张`,
      }
    },
  },
  {
    id: 'image.resize',
    name: '调整尺寸',
    description: '按宽度或高度等比缩放，适合上传前压小图片。',
    category: 'image',
    accepts: IMAGE_INPUT_MIMES,
    minInputs: 1,
    maxInputs: 50,
    params: [
      {
        key: 'width',
        label: '最大宽度（像素）',
        type: 'number',
        default: 1920,
        help: '只缩小不放大 —— 把小图放大只会变模糊，没有意义',
      },
      {
        key: 'height',
        label: '最大高度（像素，可选）',
        type: 'number',
        default: 0,
        help: '留 0 表示按宽度等比缩放',
      },
      {
        key: 'format',
        label: '输出格式',
        type: 'select',
        options: [
          { value: 'keep', label: '保持原格式' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP' },
          { value: 'png', label: 'PNG' },
        ],
        default: 'keep',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const sharp = await loadSharp()
      if (!sharp) throw new HttpError(503, '图片处理模块不可用')
      requireImageInputs(ctx)

      const width = clampDimension(ctx.params.width, 1920)
      const height = clampDimension(ctx.params.height, 0)
      if (width === 0 && height === 0) {
        throw new HttpError(400, '宽度与高度至少要填一个')
      }
      const formatChoice = String(ctx.params.format ?? 'keep')

      const outputs = []
      let done = 0
      for (const input of ctx.inputs) {
        const buffer = await readNodeBuffer(input)
        const meta = await sharp(buffer).metadata()
        const originW = meta.width ?? 0
        const originH = meta.height ?? 0

        const resizeOptions: { width?: number; height?: number; fit: 'inside'; withoutEnlargement: boolean } = {
          fit: 'inside',
          // 关键：只缩小不放大。把 800px 的图"缩放到"1920px 只会得到一张模糊的大图，
          // 用户会以为工具坏了。
          withoutEnlargement: true,
        }
        if (width > 0) resizeOptions.width = width
        if (height > 0) resizeOptions.height = height

        let pipeline = sharp(buffer).resize(resizeOptions)

        let ext = extensionOf(input.name)
        let mime: string = input.mime ?? 'image/png'
        if (formatChoice !== 'keep') {
          const target2 = asOutputFormat(formatChoice)
          if (!target2) throw new HttpError(400, `不支持的目标格式：${formatChoice}`)
          if (target2 === 'jpeg') {
            pipeline = pipeline.flatten({ background: '#ffffff' })
          }
          pipeline = pipeline.toFormat(target2, { quality: 85 })
          ext = IMAGE_OUTPUT[target2].ext
          mime = IMAGE_OUTPUT[target2].mime
        } else if (meta.format && IMAGE_OUTPUT[meta.format as SharpOutputFormat]) {
          // 保持原格式，但要显式指定，否则 sharp 可能改掉编码
          const originalFormat = meta.format as SharpOutputFormat
          pipeline = pipeline.toFormat(originalFormat)
          mime = IMAGE_OUTPUT[originalFormat].mime
        }

        const result = await pipeline.toBuffer()
        const resized = await sharp(result).metadata()

        outputs.push(
          await ctx.produce(`${stripExtension(input.name)}-缩小${ext}`, new Uint8Array(result), mime),
        )
        done++
        ctx.progress(Math.round((done / ctx.inputs.length) * 100))
        void originW
        void originH
        void resized
      }

      return { outputs, message: `已处理 ${outputs.length} 张` }
    },
  },
  {
    id: 'image.compress',
    name: '压缩图片',
    description: '在画质基本不变的前提下减小体积，适合放进文档或发群里。',
    category: 'image',
    accepts: IMAGE_INPUT_MIMES,
    minInputs: 1,
    maxInputs: 50,
    params: [
      {
        key: 'level',
        label: '压缩强度',
        type: 'select',
        options: [
          { value: 'light', label: '轻度（几乎无损）' },
          { value: 'medium', label: '中等（推荐）' },
          { value: 'strong', label: '强力（体积优先）' },
        ],
        default: 'medium',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const sharp = await loadSharp()
      if (!sharp) throw new HttpError(503, '图片处理模块不可用')
      requireImageInputs(ctx)

      const level = String(ctx.params.level ?? 'medium')
      const settings =
        level === 'light'
          ? { quality: 92, maxWidth: 4000 }
          : level === 'strong'
            ? { quality: 62, maxWidth: 1280 }
            : { quality: 80, maxWidth: 2200 }

      const outputs = []
      let done = 0
      for (const input of ctx.inputs) {
        const buffer = await readNodeBuffer(input)
        const meta = await sharp(buffer).metadata()
        // 统一转成 WebP：在同等观感下它的体积通常最小。
        // 但如果原图本来就很小，转格式反而可能变大 —— 下面会比较后取小的那个。
        const compressed = await sharp(buffer)
          .resize({ width: settings.maxWidth, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: settings.quality })
          .toBuffer()

        if (compressed.byteLength < input.size) {
          outputs.push(
            await ctx.produce(
              `${stripExtension(input.name)}-压缩.webp`,
              new Uint8Array(compressed),
              'image/webp',
            ),
          )
        } else {
          // 压不小就原样输出，并如实说明 —— 假装压过更糟
          outputs.push(
            await ctx.produce(
              `${stripExtension(input.name)}-无法再压缩${extensionOf(input.name)}`,
              new Uint8Array(buffer),
              input.mime ?? 'application/octet-stream',
            ),
          )
        }
        done++
        ctx.progress(Math.round((done / itemsLength(ctx)) * 100))
        void meta
      }

      const before = ctx.inputs.reduce((s, i) => s + i.size, 0)
      const after = outputs.reduce((s, o) => s + o.size, 0)
      return {
        outputs,
        message:
          after < before
            ? `体积从 ${humanSize(before)} 减到 ${humanSize(after)}（省 ${Math.round((1 - after / before) * 100)}%）`
            : '这些图片已经压得比较紧了，原样输出更合适',
      }
    },
  },
  {
    id: 'pdf.images-to-pdf',
    name: '图片转 PDF',
    description: '把多张图片合成一个 PDF，每张图一页。整理截图、扫描件、活动照片时最常用。',
    // 归到 pdf 分类，但实现放在图片工具里：它依赖 sharp 做统一编码，
    // 又依赖 IMAGE_INPUT_MIMES 常量（在图片段才定义），放这里顺理成章。
    category: 'pdf',
    accepts: IMAGE_INPUT_MIMES,
    minInputs: 1,
    maxInputs: 50,
    params: [
      {
        key: 'pageSize',
        label: '页面尺寸',
        type: 'select',
        options: [
          { value: 'fit', label: '跟随图片（每页与图片同尺寸）' },
          { value: 'a4', label: 'A4（图片等比缩放居中）' },
          { value: 'letter', label: 'Letter' },
        ],
        default: 'fit',
      },
      {
        key: 'quality',
        label: '图片质量（1-100）',
        type: 'number',
        default: 85,
        help: '越高越清晰，PDF 体积也越大',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const sharp = await loadSharp()
      if (!sharp) throw new HttpError(503, '图片处理模块不可用（sharp 未安装或缺少本机架构的预编译包）')
      requireImageInputs(ctx)
      const pageSize = String(ctx.params.pageSize ?? 'fit')
      if (!['fit', 'a4', 'letter'].includes(pageSize)) {
        throw new HttpError(400, `不支持的页面尺寸：${pageSize}`)
      }
      const quality = clampQuality(ctx.params.quality)
      const doc = await PDFDocument.create()
      let done = 0
      for (const input of ctx.inputs) {
        const buffer = await readNodeBuffer(input)
        // 统一编码成 JPEG 再内嵌，而不是直接把原字节塞进 PDF：
        //   ① PDF 只能内嵌 PNG/JPEG，webp/avif/gif/bmp 必须先转；
        //   ② 手机竖拍照片带 EXIF orientation，先 rotate() 归正，否则进 PDF 会躺着；
        //   ③ 透明区域 flatten 到白底，否则 JPEG 化后透明处会变黑。
        // 同时把最长边限制在 4000px：一张 12000px 的扫描图 JPEG 化会占几十 MB 内存，
        // 而 inline 工具跑在 512MB 的进程里，需要一个兜底上限。
        const jpeg = await sharp(buffer)
          .rotate()
          .resize({ width: MAX_PDF_IMAGE_DIM, height: MAX_PDF_IMAGE_DIM, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality })
          .toBuffer()
        const meta = await sharp(jpeg).metadata()
        const iw = meta.width ?? 0
        const ih = meta.height ?? 0
        if (!iw || !ih) throw new HttpError(400, `「${input.name}」无法解码为图片`)
        const image = await doc.embedJpg(jpeg)
        if (pageSize === 'fit') {
          const page = doc.addPage([iw, ih])
          page.drawImage(image, { x: 0, y: 0, width: iw, height: ih })
        } else {
          const [pw, ph] = pageSize === 'a4' ? [595.28, 841.89] : [612, 792]
          // 页面方向跟随图片：横图塞进竖版 A4 会在上下留一大片空白，
          // 用户会觉得"排错了"。所以宽大于高时把页面横过来。
          const [pageW, pageH] = iw > ih ? [ph, pw] : [pw, ph]
          const margin = 24
          const scale = Math.min((pageW - margin * 2) / iw, (pageH - margin * 2) / ih)
          const w = iw * scale
          const h = ih * scale
          const page = doc.addPage([pageW, pageH])
          page.drawImage(image, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h })
        }
        done++
        ctx.progress(Math.round((done / ctx.inputs.length) * 95))
      }
      const bytes = await doc.save()
      const node = await ctx.produce(
        `${stripExtension(ctx.inputs[0]!.name)}-图片.pdf`,
        bytes,
        'application/pdf',
      )
      ctx.progress(100)
      return {
        outputs: [node],
        message: `已把 ${ctx.inputs.length} 张图片合成 PDF（共 ${doc.getPageCount()} 页）`,
      }
    },
  },
  {
    id: 'image.watermark',
    name: '图片加水印',
    description: '把「第一张图」当作水印，叠加到后面每一张图上。适合给照片批量加 logo。',
    category: 'image',
    accepts: IMAGE_INPUT_MIMES,
    // 第一张是水印，其余是要加水的图。所以至少要两张。
    minInputs: 2,
    maxInputs: 21,
    params: [
      {
        key: 'position',
        label: '水印位置',
        type: 'select',
        options: [
          { value: 'bottom-right', label: '右下角' },
          { value: 'bottom-left', label: '左下角' },
          { value: 'top-right', label: '右上角' },
          { value: 'top-left', label: '左上角' },
          { value: 'center', label: '居中' },
        ],
        default: 'bottom-right',
      },
      { key: 'scale', label: '水印宽度（占目标图百分比）', type: 'number', default: 20, help: '1-80' },
      { key: 'opacity', label: '不透明度（0-1）', type: 'number', default: 0.8 },
      { key: 'margin', label: '边距（像素）', type: 'number', default: 16 },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const sharp = await loadSharp()
      if (!sharp) throw new HttpError(503, '图片处理模块不可用')
      requireImageInputs(ctx)
      const [logoNode, ...targets] = ctx.inputs
      const position = String(ctx.params.position ?? 'bottom-right')
      const scale = clampNumber(ctx.params.scale, 20, { min: 1, max: 80 })
      const opacity = clampNumber(ctx.params.opacity, 0.8, { min: 0.02, max: 1 })
      const margin = clampInt(ctx.params.margin, 16, { min: 0, max: 500 })
      const logoRaw = await readNodeBuffer(logoNode!)

      const outputs = []
      let done = 0
      for (const target of targets) {
        // 先归正方向并落成一份内存缓冲：既要拿准确尺寸（EXIF 归正后的），
        // 也要在它上面叠加，不能对同一张原图反复解码。
        const oriented = await sharp(await readNodeBuffer(target))
          .rotate()
          .toBuffer({ resolveWithObject: true })
        const tw = oriented.info.width
        const th = oriented.info.height
        const logoWidth = Math.max(8, Math.round((tw * scale) / 100))
        // withoutEnlargement：水印图比目标还宽时不该被硬放大 —— 只会得到一块糊掉的 logo。
        const resized = await sharp(logoRaw)
          .rotate()
          .resize({ width: logoWidth, withoutEnlargement: true })
          .ensureAlpha()
          .png()
          .toBuffer({ resolveWithObject: true })
        const lw = resized.info.width
        const lh = resized.info.height
        // 用一张纯色、alpha=opacity 的遮罩做 dest-in 混合，把 logo 的整体透明度
        // 乘上 opacity。直接 ensureAlpha(opacity) 对**本来就带 alpha** 的 logo 无效，
        // dest-in 才是对它同样成立的写法。
        const masked = await sharp(resized.data)
          .ensureAlpha()
          .composite([
            {
              input: {
                create: {
                  width: lw,
                  height: lh,
                  channels: 4,
                  background: { r: 255, g: 255, b: 255, alpha: opacity },
                },
              },
              blend: 'dest-in',
            },
          ])
          .png()
          .toBuffer()
        const { left, top } = overlayPosition(position, tw, th, lw, lh, margin)
        const out = await sharp(oriented.data)
          .ensureAlpha()
          .composite([{ input: masked, left, top, blend: 'over' }])
          .png()
          .toBuffer()
        outputs.push(await ctx.produce(`${stripExtension(target.name)}-水印.png`, out, 'image/png'))
        done++
        ctx.progress(Math.round((done / targets.length) * 100))
      }
      return { outputs, message: `已为 ${outputs.length} 张图片添加水印` }
    },
  },
  {
    id: 'image.collage',
    name: '图片拼接',
    description: '把多张图片横向、纵向或按网格拼成一张图。做长图、拼图、合集时很方便。',
    category: 'image',
    accepts: IMAGE_INPUT_MIMES,
    minInputs: 2,
    maxInputs: 20,
    params: [
      {
        key: 'layout',
        label: '排版',
        type: 'select',
        options: [
          { value: 'horizontal', label: '横向（左右并排）' },
          { value: 'vertical', label: '纵向（上下堆叠）' },
          { value: 'grid', label: '网格' },
        ],
        default: 'horizontal',
      },
      { key: 'columns', label: '网格列数', type: 'number', default: 3, help: '仅网格排版时有效' },
      { key: 'gap', label: '间距（像素）', type: 'number', default: 0, help: '0-200' },
      { key: 'background', label: '背景色', type: 'text', default: '#ffffff', placeholder: '#ffffff' },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const sharp = await loadSharp()
      if (!sharp) throw new HttpError(503, '图片处理模块不可用')
      requireImageInputs(ctx)
      const layout = String(ctx.params.layout ?? 'horizontal')
      if (!['horizontal', 'vertical', 'grid'].includes(layout)) {
        throw new HttpError(400, `不支持的排版：${layout}`)
      }
      const gap = clampInt(ctx.params.gap, 0, { min: 0, max: 200 })
      const background = normalizeHexColor(ctx.params.background, '#ffffff')
      const columns = clampInt(ctx.params.columns, 3, { min: 1, max: 10 })

      // 先把压缩字节全部读进来（受总字节闸门约束），再只读元数据做一次像素总量闸门，
      // 最后才解码成原始像素。顺序很重要：解码才是吃内存的那一步，闸门必须在它之前。
      const sources: Buffer[] = []
      for (const input of ctx.inputs) sources.push(await readNodeBuffer(input))
      let totalPixels = 0
      for (const buffer of sources) {
        const meta = await sharp(buffer).metadata()
        totalPixels += (meta.width ?? 0) * (meta.height ?? 0)
      }
      if (totalPixels > MAX_COLLAGE_PIXELS) {
        throw new HttpError(
          413,
          `这些图片合计约 ${Math.round(totalPixels / 1_000_000)} 百万像素，超过拼接上限（${MAX_COLLAGE_PIXELS / 1_000_000} 百万像素）。请减少图片数量，或先用「调整尺寸」压小。`,
        )
      }
      // 归正方向并拿到尺寸（旋转过的图若不归正，拼出来会歪着）。
      const metas: Array<{ data: Buffer; width: number; height: number }> = []
      for (const buffer of sources) {
        const oriented = await sharp(buffer).rotate().toBuffer({ resolveWithObject: true })
        metas.push({
          data: oriented.data,
          width: oriented.info.width,
          height: oriented.info.height,
        })
      }

      const composites: Array<{ input: Buffer; left: number; top: number }> = []
      let canvasWidth = 0
      let canvasHeight = 0

      if (layout === 'horizontal' || layout === 'vertical') {
        // 并排/堆叠时统一短边：横向统一高度、纵向统一宽度，这样图之间不会错位。
        // 取**最小值**当基准，意味着只会缩小不会放大，不会糊。
        // 再按「总尺寸不超过 MAX_COLLAGE_DIM」反推一个上限，避免拼出一张巨图把内存吃光。
        if (layout === 'horizontal') {
          const sumAspect = metas.reduce((s, m) => s + m.width / m.height, 0)
          const cap = Math.floor(MAX_COLLAGE_DIM / Math.max(1, sumAspect))
          const targetHeight = Math.max(1, Math.min(...metas.map((m) => m.height), cap))
          let x = 0
          for (const m of metas) {
            const res = await sharp(m.data)
              .resize({ height: targetHeight, fit: 'inside', withoutEnlargement: true })
              .toBuffer({ resolveWithObject: true })
            composites.push({
              input: res.data,
              left: x,
              top: Math.round((targetHeight - res.info.height) / 2),
            })
            x += res.info.width + gap
          }
          canvasWidth = Math.max(1, x - gap)
          canvasHeight = targetHeight
        } else {
          const sumAspect = metas.reduce((s, m) => s + m.height / m.width, 0)
          const cap = Math.floor(MAX_COLLAGE_DIM / Math.max(1, sumAspect))
          const targetWidth = Math.max(1, Math.min(...metas.map((m) => m.width), cap))
          let y = 0
          for (const m of metas) {
            const res = await sharp(m.data)
              .resize({ width: targetWidth, fit: 'inside', withoutEnlargement: true })
              .toBuffer({ resolveWithObject: true })
            composites.push({
              input: res.data,
              left: Math.round((targetWidth - res.info.width) / 2),
              top: y,
            })
            y += res.info.height + gap
          }
          canvasWidth = targetWidth
          canvasHeight = Math.max(1, y - gap)
        }
      } else {
        // 网格：单元格取所有图的最大宽高，每张图等比缩进各自单元格并居中。
        const rows = Math.ceil(metas.length / columns)
        let cellW = Math.max(...metas.map((m) => m.width))
        let cellH = Math.max(...metas.map((m) => m.height))
        const rawW = columns * cellW + (columns - 1) * gap
        const rawH = rows * cellH + (rows - 1) * gap
        // 整张画布超过上限时，等比缩小单元格，让最终尺寸落回安全范围。
        const factor = Math.min(1, MAX_COLLAGE_DIM / rawW, MAX_COLLAGE_DIM / rawH)
        if (factor < 1) {
          cellW = Math.max(1, Math.floor(cellW * factor))
          cellH = Math.max(1, Math.floor(cellH * factor))
        }
        for (let i = 0; i < metas.length; i++) {
          const m = metas[i]!
          const row = Math.floor(i / columns)
          const col = i % columns
          const res = await sharp(m.data)
            .resize({ width: cellW, height: cellH, fit: 'inside', withoutEnlargement: true })
            .toBuffer({ resolveWithObject: true })
          composites.push({
            input: res.data,
            left: col * (cellW + gap) + Math.round((cellW - res.info.width) / 2),
            top: row * (cellH + gap) + Math.round((cellH - res.info.height) / 2),
          })
        }
        canvasWidth = columns * cellW + (columns - 1) * gap
        canvasHeight = rows * cellH + (rows - 1) * gap
      }

      // 用 3 通道画布：彩色背景是实心的，把带透明的叠加图合成上去时 alpha 自然混合，
      // 结果可以直接编码成 JPEG 而不需要再 flatten。
      const out = await sharp({
        create: { width: canvasWidth, height: canvasHeight, channels: 3, background },
      })
        .composite(composites)
        .jpeg({ quality: 90 })
        .toBuffer()
      ctx.progress(90)
      const node = await ctx.produce(
        `${stripExtension(ctx.inputs[0]!.name)}-拼接.jpg`,
        out,
        'image/jpeg',
      )
      ctx.progress(100)
      return { outputs: [node], message: `已拼接 ${composites.length} 张图片（${canvasWidth}×${canvasHeight}）` }
    },
  },
  {
    id: 'image.grid-slice',
    name: '九宫格切图',
    description: '把一张图按「行×列」切成多张小图，用于朋友圈九宫格、拼图等场景。',
    category: 'image',
    accepts: IMAGE_INPUT_MIMES,
    minInputs: 1,
    maxInputs: 1,
    params: [
      { key: 'rows', label: '行数', type: 'number', default: 3, help: '1-10' },
      { key: 'cols', label: '列数', type: 'number', default: 3, help: '1-10' },
      {
        key: 'format',
        label: '输出格式',
        type: 'select',
        options: [
          { value: 'png', label: 'PNG（无损）' },
          { value: 'jpeg', label: 'JPEG（体积小）' },
        ],
        default: 'png',
      },
    ],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const sharp = await loadSharp()
      if (!sharp) throw new HttpError(503, '图片处理模块不可用')
      requireImageInputs(ctx)
      const rows = clampInt(ctx.params.rows, 3, { min: 1, max: 10 })
      const cols = clampInt(ctx.params.cols, 3, { min: 1, max: 10 })
      if (rows * cols > 100) throw new HttpError(400, '切块数量过多（最多 100 块）')
      const asJpeg = String(ctx.params.format ?? 'png') === 'jpeg'

      const oriented = await sharp(await readNodeBuffer(ctx.inputs[0]!))
        .rotate()
        .toBuffer({ resolveWithObject: true })
      const width = oriented.info.width
      const height = oriented.info.height
      const base = stripExtension(ctx.inputs[0]!.name)
      const outputs = []
      for (let r = 0; r < rows; r++) {
        // 用 floor 算边界：即使宽高不能被行列整除，最后一格自动吃掉余数，
        // 保证所有格子严丝合缝拼回原图，不丢一行像素也不重叠。
        const top = Math.floor((height * r) / rows)
        const bottom = Math.floor((height * (r + 1)) / rows)
        for (let c = 0; c < cols; c++) {
          const left = Math.floor((width * c) / cols)
          const right = Math.floor((width * (c + 1)) / cols)
          const w = right - left
          const h = bottom - top
          if (w <= 0 || h <= 0) continue
          const tile = sharp(oriented.data).extract({ left, top, width: w, height: h })
          const buffer = asJpeg
            ? await tile.flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer()
            : await tile.png().toBuffer()
          outputs.push(
            await ctx.produce(
              `${base}-${r + 1}-${c + 1}${asJpeg ? '.jpg' : '.png'}`,
              buffer,
              asJpeg ? 'image/jpeg' : 'image/png',
            ),
          )
          ctx.progress(Math.round((outputs.length / (rows * cols)) * 100))
        }
      }
      return { outputs, message: `已切成 ${outputs.length} 块（${rows}×${cols}）` }
    },
  },
  {
    id: 'image.palette',
    name: '提取主色调',
    description: '分析图片里最主要的若干种颜色，给出色值与占比，并附一张色板图。',
    category: 'image',
    accepts: IMAGE_INPUT_MIMES,
    minInputs: 1,
    maxInputs: 1,
    params: [{ key: 'count', label: '颜色数量', type: 'number', default: 8, help: '1-24' }],
    kind: 'inline',
    availability: () => ({ available: true }),
    async run(ctx) {
      const sharp = await loadSharp()
      if (!sharp) throw new HttpError(503, '图片处理模块不可用')
      requireImageInputs(ctx)
      const count = clampInt(ctx.params.count, 8, { min: 1, max: 24 })
      // 缩到最多 64×64 再取原始像素：取主色不需要原图分辨率，小图能显著省内存与时间。
      // 缩放用 fit:'inside' 保留纵横比；withoutEnlargement 很关键 —— 把一张小图**放大**
      // 会由插值凭空造出中间色，于是纯两色的图会被报成好几种颜色（这是实测踩到的坑）。
      const { data, info } = await sharp(await readNodeBuffer(ctx.inputs[0]!))
        .rotate()
        .resize({ width: 64, height: 64, fit: 'inside', withoutEnlargement: true })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const total = info.width * info.height
      const channels = info.channels
      // 按「每通道高 4 位」分桶（16×16×16=4096 个桶）。不用聚类库：
      // 粗分桶 + 桶内求平均，对这种"看看主色调"的需求已经足够，且零额外依赖。
      const buckets = new Map<number, { r: number; g: number; b: number; n: number }>()
      for (let i = 0; i < total; i++) {
        const o = i * channels
        const r = data[o]!
        const g = data[o + 1]!
        const b = data[o + 2]!
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
        const entry = buckets.get(key)
        if (entry) {
          entry.r += r
          entry.g += g
          entry.b += b
          entry.n++
        } else {
          buckets.set(key, { r, g, b, n: 1 })
        }
      }
      const top = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, count)
      const colors = top.map((entry) => {
        const r = Math.round(entry.r / entry.n)
        const g = Math.round(entry.g / entry.n)
        const b = Math.round(entry.b / entry.n)
        return {
          hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
          rgb: `${r}, ${g}, ${b}`,
          percent: `${((entry.n / total) * 100).toFixed(1)}%`,
          pixels: entry.n,
        }
      })
      // 顺手画一张色板图，让结果不只是数字 —— 可以直接拿去当配色参考。
      const swatch = 80
      const palW = Math.max(1, colors.length * swatch)
      const palH = swatch
      const raw = Buffer.alloc(palW * palH * 3)
      colors.forEach((color, index) => {
        const [r, g, b] = hexToRgb(color.hex)
        for (let y = 0; y < palH; y++) {
          for (let x = 0; x < swatch; x++) {
            const o = (y * palW + index * swatch + x) * 3
            raw[o] = r
            raw[o + 1] = g
            raw[o + 2] = b
          }
        }
      })
      const palettePng = await sharp(raw, { raw: { width: palW, height: palH, channels: 3 } })
        .png()
        .toBuffer()
      const node = await ctx.produce(
        `${stripExtension(ctx.inputs[0]!.name)}-色板.png`,
        palettePng,
        'image/png',
      )
      ctx.progress(100)
      // data.pages 会被前端渲染成表格（见 ToolsApp 的 dataPages），
      // 这是本仓库里"让结构化结果可见"的既定形状 —— 结果不能只是一堆对象。
      return {
        outputs: [node],
        data: { colorCount: colors.length, pages: colors },
        message: `提取到 ${colors.length} 种主色`,
      }
    },
  },
]

function itemsLength(ctx: ToolContext): number {
  return Math.max(1, ctx.inputs.length)
}

function clampQuality(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 82
  return Math.min(100, Math.max(1, Math.round(n)))
}

/**
 * 尺寸参数的规范化。
 *
 * 两种情况要区分开，否则界面上的"清空"会变成"用默认值"：
 *   - **没填**（undefined / null / 空串）→ 用默认值（宽度 1920）
 *   - **显式填了 0 或负数** → 视为"不加这个约束"（返回 0）
 *
 * 这样界面把宽度清空时，用户得到的是"按高度缩放"而不是"偷偷用 1920"。
 */
function clampDimension(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  // 上限 10000 像素：再大就不是"图片处理"而该用别的工具了，也避免内存爆掉
  return Math.min(10000, Math.round(n))
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(0, idx) : name
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx).toLowerCase() : '.png'
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// ---------------------------------------------------------------- 通用小工具

/**
 * 「逐页拆分」一次最多产出多少文件。
 *
 * 起因：每拆一页都会落成一个独立文件节点。一份 2000 页的扫描件会瞬间生成
 * 2000 个节点，把目录塞爆、把任务列表卡死。与其等用户踩坑，不如提前挡住并
 * 告诉他改用「提取页码范围」分批处理。
 */
const MAX_SPLIT_PAGES = 200

/** 图片转 PDF 时单张图的最长边上限（像素）。见该工具里的注释。 */
const MAX_PDF_IMAGE_DIM = 4000

/**
 * 拼接画布单边像素上限。
 *
 * 拼接会把所有输入图同时持有在内存里再合成一张画布，画布面积直接决定峰值内存。
 * 上限压在 6000px：6000×6000 的 RGB 画布约 108MB，配合下面的像素总量闸门与
 * 按比例回缩，能让峰值留在 512MB 进程的安全范围内。
 */
const MAX_COLLAGE_DIM = 6000

/**
 * 拼接的输入像素总量上限（宽×高 之和）。
 *
 * 为什么单独设这道闸门：其它图片工具是"一次处理一张"，而拼接要先把每张图都
 * 解码成原始像素同时留在内存里 —— 20 张 2000×3000 的照片解码后就是 ~480MB，
 * 足以把 inline 的 512MB 进程打爆。字节数闸门挡不住这种"压缩比很高的小文件、
 * 解出来却是巨图"的情况，所以按像素数再挡一道。
 */
const MAX_COLLAGE_PIXELS = 40_000_000

/**
 * 取整并夹到范围内。
 *
 * 空值（undefined / null / 空串）一律回退到默认值 —— 这点很重要：界面上的
 * 数字输入框被清空时传上来的是空串而不是 undefined，若直接 Number('') 会得到 0，
 * 于是"清空"被误解成"填了 0"。显式把空值判成默认值更符合直觉。
 */
function clampInt(value: unknown, fallback: number, opts: { min?: number; max?: number } = {}): number {
  if (value === undefined || value === null || value === '') return applyRange(fallback, opts)
  const n = Number(value)
  if (!Number.isFinite(n)) return applyRange(fallback, opts)
  return applyRange(Math.round(n), opts)
}

/** 与 clampInt 相同，但保留小数（用于 0-1 的不透明度、比例这类值）。 */
function clampNumber(value: unknown, fallback: number, opts: { min?: number; max?: number } = {}): number {
  if (value === undefined || value === null || value === '') return applyRange(fallback, opts)
  const n = Number(value)
  if (!Number.isFinite(n)) return applyRange(fallback, opts)
  return applyRange(n, opts)
}

function applyRange(value: number, opts: { min?: number; max?: number }): number {
  let result = value
  if (opts.min !== undefined) result = Math.max(opts.min, result)
  if (opts.max !== undefined) result = Math.min(opts.max, result)
  return result
}

/**
 * 是否只含可打印 ASCII。
 *
 * 用在 PDF 文字水印上：标准字体（Helvetica 等）只覆盖 WinAnsi，写中文会整段丢失。
 * 空格到 ~ 是 WinAnsi 与 ASCII 重合的安全区，超出就得拦下来给用户明确提示。
 */
function isAsciiPrintable(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text)
}

/** 把 #RRGGBB 解析成 [r, g, b]（0-255）。格式不对直接报错，不静默用默认色。 */
function hexToRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) throw new HttpError(400, `颜色格式不对：「${hex}」，应为 #RRGGBB`)
  const value = Number.parseInt(match[1]!, 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** 供 sharp 的 create/background 使用；空值回退到默认色。 */
function normalizeHexColor(value: unknown, fallback: string): { r: number; g: number; b: number } {
  const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  const [r, g, b] = hexToRgb(text)
  return { r, g, b }
}

/**
 * 算出「把一个 w×h 的矩形绕自身中心旋转 θ 后，仍以页面中心为几何中心」时，
 * pdf-lib 需要的锚点坐标。
 *
 * pdf-lib 的 drawImage / drawText 的 rotate 都是**绕传入的 (x,y) 锚点**旋转的，
 * 而不是绕图形中心。若直接把 x,y 取成页面中心，水印会绕左上角甩出去。
 * 这里先求出旋转后图形中心相对锚点的位移，再从页面中心减掉它。
 */
function centeredRotatedAnchor(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  radians: number,
): { x: number; y: number } {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = (width / 2) * cos - (height / 2) * sin
  const dy = (width / 2) * sin + (height / 2) * cos
  return { x: centerX - dx, y: centerY - dy }
}

/** 按九宫格方位算出叠加图的左上角坐标（sharp composite 用的是左上角原点）。 */
function overlayPosition(
  position: string,
  targetW: number,
  targetH: number,
  overlayW: number,
  overlayH: number,
  margin: number,
): { left: number; top: number } {
  if (position === 'center') {
    return {
      left: Math.max(0, Math.round((targetW - overlayW) / 2)),
      top: Math.max(0, Math.round((targetH - overlayH) / 2)),
    }
  }
  const left = position.endsWith('left') ? margin : targetW - overlayW - margin
  const top = position.startsWith('top') ? margin : targetH - overlayH - margin
  return { left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) }
}

/**
 * Fisher-Yates 洗牌，随机数来自 node:crypto 而不是 Math.random。
 *
 * 抽签/分组这类场景，公平性是被质疑的第一件事。crypto 的随机源比 Math.random
 * 更适合对外承诺"结果不可预测"，成本也几乎可以忽略。
 */
function shuffle<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    const tmp = result[i]!
    result[i] = result[j]!
    result[j] = tmp
  }
  return result
}


/**
 * 需要外部重服务的工具。
 *
 * 这些不在后端进程里做，原因见文件头注释。未配置 WL_CONVERT_SERVICE_URL 时
 * 它们会以「未启用」出现在工具列表里 —— 这比让用户点了转圈然后超时要好。
 */
const externalTools: ToolDef[] = [
  {
    id: 'doc.to-pdf',
    name: '转为 PDF',
    description: 'Word / Excel / PPT / 图片 / 文本 转成 PDF。中文排版由服务端字体保证。',
    category: 'document',
    accepts: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      // 旧版 Office（.doc/.xls/.ppt）在文件头层面是 OLE2 复合文档，嗅探给出的
      // 是 application/x-ole-storage —— 而不是 application/msword。
      // 旧清单照着"扩展名该是什么"写，导致真实的 .doc 永远选不中这个工具；
      // 按"内容实际会被嗅探成什么"来列才对（名单要跟着 mime.ts 走）。
      'application/x-ole-storage',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation',
      'text/plain',
      'text/markdown',
      'image/png',
      'image/jpeg',
    ],
    minInputs: 1,
    maxInputs: 20,
    kind: 'external',
    availability: () =>
      CONVERT_SERVICE_URL
        ? { available: true }
        : {
            available: false,
            reason:
              '转换服务未启用。它需要 LibreOffice，单实例内存 1-2GB，在 NAS 上按需拉起而不是常驻。部署时配置 WL_CONVERT_SERVICE_URL 后这里会自动可用。',
          },
  },
  {
    id: 'media.transcode',
    name: '视频转码 / 压缩',
    description: '服务端 ffmpeg 处理：改分辨率、改码率、换封装。不做浏览器端多轨实时剪辑（NAS 硬件撑不住）。',
    category: 'media',
    accepts: ['video/', 'audio/'],
    minInputs: 1,
    maxInputs: 1,
    params: [
      {
        key: 'preset',
        label: '目标',
        type: 'select',
        options: [
          { value: 'compressed', label: '压缩体积（手机可播）' },
          { value: '720p', label: '720p' },
          { value: '1080p', label: '1080p' },
          { value: 'audio-mp3', label: '只抽音轨为 MP3' },
        ],
        default: 'compressed',
      },
    ],
    kind: 'external',
    availability: () =>
      CONVERT_SERVICE_URL
        ? { available: true }
        : {
            available: false,
            reason:
              '转码服务未启用。ffmpeg 转码会吃满 CPU 并与 NAS 自身的存储服务抢 IO，设计上按需拉起、用完即停。部署时配置后自动可用。',
          },
  },
]

/** 全部工具。新增工具只需往这里加一条。 */
export const TOOLS: ToolDef[] = [...pdfTools, ...imageTools, ...utilityTools, ...externalTools]

export function getTool(id: string): ToolDef | null {
  return TOOLS.find((t) => t.id === id) ?? null
}

export interface ToolDescriptor {
  id: string
  name: string
  description: string
  category: ToolDef['category']
  accepts: string[]
  minInputs: number
  maxInputs: number
  params: ToolDef['params']
  kind: ToolDef['kind']
  available: boolean
  unavailableReason: string | null
}

/** 给前端的工具清单（含可用性）。 */
export function describeTools(): ToolDescriptor[] {
  return TOOLS.map((tool) => {
    let available = false
    let reason: string | null = null
    if (!TOOLS_ENABLED) {
      reason = '工具集已被管理员关闭'
    } else {
      const verdict = tool.availability()
      available = verdict.available
      if (!verdict.available) reason = verdict.reason
    }
    return {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      category: tool.category,
      accepts: tool.accepts,
      minInputs: tool.minInputs,
      maxInputs: tool.maxInputs,
      params: tool.params ?? [],
      kind: tool.kind,
      available,
      unavailableReason: reason,
    }
  })
}

// ---------------------------------------------------------------- 任务队列

export interface Job {
  id: string
  user_id: string
  kind: string
  params: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  progress: number
  input_node_id: string | null
  output_node_id: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

export interface JobView extends Job {
  output_node_ids: string[]
  data: unknown
}

export function createJob(input: {
  userId: string
  toolId: string
  inputNodeIds: string[]
  params: Record<string, unknown>
  space: Space
}): string {
  const id = newId('j')
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO jobs (id, user_id, kind, params, state, progress, input_node_id, created_at)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.toolId,
      JSON.stringify({
        nodeIds: input.inputNodeIds,
        params: input.params,
        space: input.space,
      }),
      input.inputNodeIds[0] ?? null,
      ts,
    )
  return id
}

export function getJob(id: string): Job | null {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined
  return row ?? null
}

/** 把任务的行数据翻译成前端可用的视图。 */
export function jobView(job: Job): JobView {
  let outputIds: string[] = []
  let data: unknown = null
  const resultStr = (job as Job & { result?: string | null }).result
  if (resultStr) {
    try {
      const parsed = JSON.parse(resultStr) as { outputIds?: string[]; data?: unknown }
      outputIds = parsed.outputIds ?? []
      data = parsed.data ?? null
    } catch {
      // 结果字段坏掉不该让接口 500，退化成一个空结果即可
    }
  }
  if (outputIds.length === 0 && job.output_node_id) outputIds = [job.output_node_id]
  return { ...job, output_node_ids: outputIds, data }
}

/**
 * 启动任务执行循环。
 *
 * 刻意用「单并发」：与 NAS 上"同一时刻只有一个重任务"的设计保持一致。
 * inline 工具虽然轻，但保持简单比压榨吞吐更重要 —— 这是社团工具站，不是高并发服务。
 */
export function startJobRunner(): void {
  let running = false

  const tick = async (): Promise<void> => {
    if (running) return
    const job = transaction(() => {
      const next = getDb()
        .prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get() as Job | undefined
      if (!next) return null
      getDb()
        .prepare("UPDATE jobs SET state = 'running', started_at = ?, progress = 1 WHERE id = ?")
        .run(now(), next.id)
      return next
    })
    if (!job) return

    running = true
    try {
      await executeJob(job)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      getDb()
        .prepare("UPDATE jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run(message, now(), job.id)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, 1000)
  // 不要让这个定时器把进程钉住不退出
  timer.unref?.()
}

/**
 * inline 工具能处理的单文件体积上限。
 *
 * 为什么必须有：重工具（LibreOffice、ffmpeg）走的是独立容器的 external 道，
 * 而 inline 工具是**在业务进程里**跑的，进程的内存上限只有 512MB。
 * readNodeBuffer 用 readFile 一次性把整个文件读进内存 —— 成员上传一个
 * 1-2GB 的 PDF 再点一下"PDF 信息"，容器就被 OOM 杀掉了，全平台下线。
 *
 * 这不是"加固建议"，是一个不需要任何漏洞就能触发的宕机路径，
 * 所以把上限放在**工具入口**而不是指望每个工具自己检查。
 */
const MAX_INLINE_INPUT_BYTES = 100 * 1024 * 1024

/** inline 工具处理的输入总大小上限（合并类工具会同时持有多个文件）。 */
const MAX_INLINE_TOTAL_BYTES = 256 * 1024 * 1024

async function executeJob(job: Job): Promise<void> {
  const payload = JSON.parse(job.params) as {
    nodeIds: string[]
    params: Record<string, unknown>
    space: Space
  }

  const tool = getTool(job.kind)
  if (!tool) throw new HttpError(400, `未知工具：${job.kind}`)

  const verdict = tool.availability()
  if (!verdict.available) throw new HttpError(503, verdict.reason)

  if (tool.kind === 'external' || !tool.run) {
    // 外部工具由 NAS 侧的按需调度器接管：这里只把任务标成等待，
    // 并把请求投递到转换服务（若已配置）。
    await runExternalJob(job, tool, payload)
    return
  }

  const { getNode } = await import('./files.ts')
  const inputs: Node[] = []
  for (const id of payload.nodeIds) {
    const node = getNode(id)
    if (!node) throw new HttpError(404, `输入文件不存在：${id}`)
    inputs.push(node)
  }

  // 体积闸门：在读取之前挡住，而不是读到一半才 OOM
  if (tool.kind === 'inline') {
    for (const node of inputs) {
      if (node.size > MAX_INLINE_INPUT_BYTES) {
        throw new HttpError(
          413,
          `「${node.name}」有 ${Math.round(node.size / 1024 / 1024)}MB，超过了在线工具的处理上限（${Math.round(
            MAX_INLINE_INPUT_BYTES / 1024 / 1024,
          )}MB）。大文件的处理需要部署转换服务，见部署指南。`,
        )
      }
    }
    const total = inputs.reduce((sum, node) => sum + node.size, 0)
    if (total > MAX_INLINE_TOTAL_BYTES) {
      throw new HttpError(
        413,
        `本批文件合计 ${Math.round(total / 1024 / 1024)}MB，超过了在线工具的处理上限（${Math.round(
          MAX_INLINE_TOTAL_BYTES / 1024 / 1024,
        )}MB）。请分批处理。`,
      )
    }
  }

  const outputs: Node[] = []
  const setProgress = (value: number) => {
    getDb().prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(Math.round(value), job.id)
  }

  const result = await tool.run({
    userId: job.user_id,
    inputs,
    params: payload.params ?? {},
    space: payload.space ?? 'shared',
    outputParentId: inputs[0]?.parent_id ?? null,
    async produce(name, data, mime) {
      const node = await saveBufferAsNode({
        buffer: data,
        name,
        parentId: inputs[0]?.parent_id ?? null,
        ownerId: job.user_id,
        space: payload.space ?? 'shared',
        mime,
      })
      outputs.push(node)
      return node
    },
    progress: setProgress,
  })

  for (const node of result.outputs) {
    if (!outputs.includes(node)) outputs.push(node)
  }

  getDb()
    .prepare(
      `UPDATE jobs SET state = 'done', progress = 100, output_node_id = ?, finished_at = ?
         WHERE id = ?`,
    )
    .run(outputs[0]?.id ?? null, now(), job.id)

  // 结果（产物 id 与非文件型的 data）另存一处，供接口返回
  getDb()
    .prepare('UPDATE jobs SET error = NULL WHERE id = ?')
    .run(job.id)

  jobResults.set(job.id, {
    outputIds: outputs.map((n) => n.id),
    data: result.data ?? null,
    message: result.message ?? null,
  })
}

/** 非文件型结果与提示语的临时存放（进程内即可，重启丢失无妨）。 */
const jobResults = new Map<string, { outputIds: string[]; data: unknown; message: string | null }>()

export function jobResult(id: string): { outputIds: string[]; data: unknown; message: string | null } | null {
  return jobResults.get(id) ?? null
}

/**
 * 外部重任务：把请求推给转换服务，等它返回结果字节。
 *
 * ⚠️ 这里**必须**是推送式的（应用把文件发出去、拿字节回来自己存）。
 *
 * 早先这里是另一套写法：往 `${CONVERT_SERVICE_URL}/jobs` 发一段 JSON，
 * 里面带 `callback: /api/internal/jobs/<id>`，指望转换服务自己来取文件、
 * 干完再回调。那套约定有两个致命问题，而且都不是"还没写完"那么简单：
 *
 *   1. 应用侧**根本没有** /api/internal/jobs 这个路由 —— 回调没有接收方。
 *   2. 转换服务拿到的只有 nodeIds，没有任何鉴权、也没有取文件的接口，
 *      它**无法**把文件取到手。
 *
 * 也就是说那条路径在任何配置下都不可能跑通。而它在界面上表现为
 * "部署了转换服务就能用" —— 属于承诺了做不到的事，比直接显示"未启用"更糟。
 * 换成推送式之后，两边的接口都是真实存在的：
 *   应用 → POST {服务}/forms/libreoffice/convert（multipart，字段名 files）→ PDF 字节
 * 这个路由是 Gotenberg 真实提供的，不是我们凭空约定的。
 */
async function runExternalJob(
  job: Job,
  tool: ToolDef,
  payload: { nodeIds: string[]; params: Record<string, unknown>; space: Space },
): Promise<void> {
  if (!CONVERT_SERVICE_URL) {
    throw new HttpError(503, `${tool.name} 依赖的转换服务未启用`)
  }

  const { getNode } = await import('./files.ts')
  const inputs: Node[] = []
  for (const id of payload.nodeIds) {
    const node = getNode(id)
    if (!node) throw new HttpError(404, `输入文件不存在：${id}`)
    if (node.kind !== 'file') throw new HttpError(400, `「${node.name}」不是文件`)
    inputs.push(node)
  }
  if (inputs.length === 0) throw new HttpError(400, '没有输入文件')

  if (tool.id === 'doc.to-pdf') {
    await runDocToPdf(job, inputs, payload)
    return
  }

  // 其余 external 工具（视频转码）还没有服务端实现。
  // 明确报"没有实现"，而不是丢一个看不懂的超时 —— 后者会被当成网络问题排查半天。
  throw new HttpError(501, `「${tool.name}」还没有可用的服务端实现（当前只实现了「转为 PDF」）`)
}

/** 单次转换的超时。Gotenberg 侧的超时是 120s，这里留出网络与排队余量。 */
const CONVERT_TIMEOUT_MS = 180_000

/**
 * 把文件名降级成纯 ASCII，只用在 HTTP 头里。
 *
 * ⚠️ 这不是"洁癖"，是必须的。
 *
 * HTTP 头的值只能是 Latin-1 字节，而 Node 的 fetch（undici）遇到非 ASCII
 * 字符会**直接抛错**：
 *   Cannot convert argument to a ByteString because the character at index 0
 *   has a value of 36890 which is greater than 255
 * 它抛在**构造请求**的阶段，所以在我们这边表现为"连不上转换服务" ——
 * 跟网络、跟转换服务本身都毫无关系，光看错误信息根本猜不到是文件名的问题。
 *
 * 而中文文件名是常态。不处理就等于"凡是用中文名命名的文档都转不了"，
 * 且报错指向完全错误的方向。
 *
 * 做法：头里只放 ASCII 化后的名字（Gotenberg 用它命名响应里的文件），
 * 真正给用户看的产物名由我们自己定，**保留中文**。
 */
function asciiHeaderValue(name: string): string {
  const cleaned = name
    .replace(/[^\x20-\x7e]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || 'document'
}

async function runDocToPdf(
  job: Job,
  inputs: Node[],
  payload: { params: Record<string, unknown>; space: Space },
): Promise<void> {
  const first = inputs[0]
  if (!first) throw new HttpError(400, '没有输入文件')

  const form = new FormData()
  for (const node of inputs) {
    // readNodeBuffer 是 async 的，且会把整份文件读进内存。
    // 这里没有像 inline 道那样加体积闸门，是因为转换服务跑在**独立容器**里，
    // 内存压力在那一侧（它有 2GB 上限和自己的超时）。业务进程这一侧
    // 只做一次流式的转发，峰值与文件大小同阶 —— 这是下面 100MB 闸门的作用。
    if (node.size > MAX_INLINE_INPUT_BYTES) {
      throw new HttpError(
        413,
        `「${node.name}」有 ${Math.round(node.size / 1024 / 1024)}MB，超过了转换服务的单文件上限（${Math.round(
          MAX_INLINE_INPUT_BYTES / 1024 / 1024,
        )}MB）。`,
      )
    }
    const buffer = await readNodeBuffer(node)
    form.append('files', new Blob([new Uint8Array(buffer)], { type: node.mime ?? 'application/octet-stream' }), node.name)
  }

  const baseName = (first.name ?? 'document').replace(/\.[^.]+$/, '') || 'document'

  let response: Response
  try {
    response = await fetch(`${CONVERT_SERVICE_URL}/forms/libreoffice/convert`, {
      method: 'POST',
      // ⚠️ Gotenberg-Output-Filename 必须走 **HTTP 头**，而且必须**是 ASCII**。
      //
      // 写成表单字段（form.append）是个很容易犯的错：请求照样发出去、转换照样成功，
      // 只是产物名被 Gotenberg 忽略，退化成它自己的随机名，而你不知道为什么。
      //
      // 而中文名会让请求在构造阶段就抛错（见 asciiHeaderValue 的注释）——
      // 所以这里传的是 ASCII 化之后的名字，产物节点名另外用原名的中文版本。
      headers: { 'Gotenberg-Output-Filename': asciiHeaderValue(baseName) },
      body: form,
      signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
    })
  } catch (err) {
    // 连不上和转换失败要分开报：前者是部署问题，后者是文件问题
    throw new HttpError(
      502,
      `连不上转换服务（${CONVERT_SERVICE_URL}）：${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new HttpError(502, `转换失败（服务返回 ${response.status}）：${detail.slice(0, 300)}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? 'application/pdf'
  // 多个输入被合并成一个 PDF 时返回 PDF；需要产出多个文件时 Gotenberg 会打包成 ZIP。
  const isZip = contentType.includes('zip')
  const ext = isZip ? '.zip' : '.pdf'
  const mime = isZip ? 'application/zip' : 'application/pdf'

  const output = await saveBufferAsNode({
    buffer: bytes,
    name: `${baseName}${ext}`,
    parentId: first.parent_id ?? null,
    ownerId: job.user_id,
    space: payload.space ?? 'shared',
    mime,
  })

  getDb()
    .prepare(
      `UPDATE jobs SET state = 'done', progress = 100, output_node_id = ?, error = NULL, finished_at = ?
         WHERE id = ?`,
    )
    .run(output.id, now(), job.id)

  jobResults.set(job.id, { outputIds: [output.id], data: null, message: null })
}
