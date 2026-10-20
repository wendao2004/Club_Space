/**
 * 文件类型嗅探。
 *
 * 这个文件只回答一个问题：**这段字节实际是什么**。它不回答"允不允许上传"。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 上传策略的变迁（2026-10-18）
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 早先的实现是一份 ALLOWED_MIME 白名单 + 「扩展名与真实类型交叉校验」，
 * 两道都不过就 415 拒绝。后来用户明确说「现在的上传限制太多了，
 * 我要求能上传任何格式的文件」—— 和"4GiB 单文件上限"一样（见 files.ts 里
 * 磁盘余量守卫的注释），这份白名单的毛病也是**该拦的没拦住、不该拦的拦了**：
 *
 *   - 它挡不住任何真实的攻击。真正要防的是「存储型 XSS：上传一个带脚本的
 *     文件，让它在同源下被浏览器当文档执行」—— 那靠的是**响应端**的处理
 *     （类型按内容判定后，预览只内联位图/PDF/文本/音视频，SVG 与 HTML
 *     永远不会被内联执行，见 index.ts 的预览路由），而不是拒绝某些字节
 *     **存进来**。文件躺在存储里永远是惰性的，只有被"当成什么"回应出去
 *     才有危险性。
 *   - 它却把一堆正常文件拒之门外：.rar / .7z / .mkv / .heic / 无扩展名的
 *     文件…… 甚至连一张真实的 .doc 都传不上 —— OLE2 的魔数被嗅探成
 *     application/x-ole-storage，永远进不了白名单；旧代码里
 *     EXT_EXPECTED['.doc'] 期望 application/msword，交叉校验必然失败。
 *
 * 于是现在只剩一条规则：**内容说了算，名字不作数，认不出来也不拒绝**。
 *
 * ⚠️ 删除或放宽这个文件里任何判断之前，先确认下面的不变量还成立：
 *   **类型判定永远不采信扩展名/文件名，只读字节。** 因为 mime 决定两件事：
 *   ① 下载/预览响应头里的 Content-Type；② 预览能否内联。如果按扩展名标类型，
 *   一个叫 logo.png 的 HTML 文档就会拿到 text/html 并被同源内联执行 ——
 *   这是一条不需要任何前置权限的存储型 XSS 通道。
 */

/** 认不出内容时给的最保守的类型：浏览器只会下载它，不会当文档渲染。 */
export const FALLBACK_MIME = 'application/octet-stream'

/**
 * 只根据文件头判断类型。识别不出来返回空字符串（调用方用 FALLBACK_MIME 兜底，
 * 但**不因此拒绝**）。
 *
 * 刻意不引入 file-type 之类的依赖：一来本机可获取的依赖越少越好，
 * 二来我们要照顾的是常见格式，手写一张魔数表比引入依赖更可控。
 */
export function sniffMime(head: Uint8Array): string {
  const b = head
  const has = (offset: number, bytes: number[]): boolean =>
    bytes.every((v, i) => b[offset + i] === v)
  const ascii = (offset: number, len: number): string =>
    String.fromCharCode(...b.subarray(offset, offset + len))

  // ---- 文档 ----
  if (has(0, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf' // %PDF

  // ---- 图片 ----
  if (has(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (has(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(0, 3) === 'GIF') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  // TIFF：小端 "II*\0" 或大端 "MM\0*"
  if (has(0, [0x49, 0x49, 0x2a, 0x00]) || has(0, [0x4d, 0x4d, 0x00, 0x2a]))
    return 'image/tiff'

  // ---- 容器格式：ftyp 盒子里带品牌名 ----
  //
  // 顺序有讲究：HEIC 与 AVIF 都可能带 mif1 兼容品牌，所以必须先查 avif 再查 heic。
  // 品牌名可能出现在主品牌（offset 8）或兼容品牌列表里（紧随其后），
  // 所以对这一段做子串匹配而不是只比对 4 个字节。
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4)
    const brands = ascii(8, 64)
    if (brand.startsWith('qt')) return 'video/quicktime'
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif'
    if (
      brands.includes('heic') ||
      brands.includes('heix') ||
      brands.includes('hevc') ||
      brands.includes('hevx') ||
      brands.includes('mif1')
    )
      return 'image/heic'
    if (brands.includes('M4A') || brands.includes('M4B')) return 'audio/mp4'
    return brand === 'webm' ? 'video/webm' : 'video/mp4'
  }
  // EBML/Matroska 家族：webm 与 mkv 的头一样，靠 DocType 字符串区分。
  // 分不出来的按 webm 处理（浏览器更可能直接播）。
  if (has(0, [0x1a, 0x45, 0xdf, 0xa3])) {
    const doctype = ascii(0, Math.min(b.length, 128))
    return doctype.includes('matroska') ? 'video/x-matroska' : 'video/webm'
  }

  // ---- 音频 ----
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg'
  if (has(0, [0xff, 0xfb]) || has(0, [0xff, 0xf3]) || has(0, [0xff, 0xf2])) return 'audio/mpeg'
  if (ascii(0, 4) === 'OggS') return 'audio/ogg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav'
  if (ascii(0, 4) === 'fLaC') return 'audio/flac'

  // ---- 压缩包 ----
  // 认得出更多压缩格式不是为了放行（任何格式本来就都收），而是为了让响应头
  // 和图标更准确 —— 按内容给出的类型比按扩展名猜的可信。
  if (has(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed'
  if (ascii(0, 4) === 'Rar!') return 'application/vnd.rar'
  if (has(0, [0x1f, 0x8b])) return 'application/gzip'

  // ---- 字体（社团里互传字体是常事）----
  if (ascii(0, 4) === 'wOFF') return 'font/woff'
  if (ascii(0, 4) === 'wOF2') return 'font/woff2'
  if (ascii(0, 4) === 'OTTO') return 'font/otf'

  // OOXML / ODF / zip 都是 zip 容器，需要看第一个条目的名字来区分
  if (has(0, [0x50, 0x4b])) {
    const text = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 4096)))
    if (text.includes('word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if (text.includes('xl/')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    if (text.includes('ppt/')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    if (text.includes('mimetypeapplication/vnd.oasis.opendocument')) {
      if (text.includes('text')) return 'application/vnd.oasis.opendocument.text'
      if (text.includes('spreadsheet')) return 'application/vnd.oasis.opendocument.spreadsheet'
      if (text.includes('presentation')) return 'application/vnd.oasis.opendocument.presentation'
    }
    return 'application/zip'
  }

  // 旧版 Office（OLE2 复合文档，也涵盖 .msi/.msg 等）
  if (has(0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return 'application/x-ole-storage'
  }

  // 文本类放在最后：能打印的字节占比高就当作文本
  const sample = b.subarray(0, Math.min(b.length, 512))
  if (sample.length > 0) {
    let printable = 0
    for (const byte of sample) {
      if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f)) printable++
      else if (byte >= 0x80) printable++ // 允许 UTF-8 多字节
    }
    if (printable / sample.length > 0.95) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(sample)
      if (/^\s*<(\?xml|svg)/i.test(text)) return 'image/svg+xml'
      if (/^\s*#|^\s*[-*]\s|^\s*>/.test(text)) return 'text/markdown'
      if (isLikelyCsv(text)) return 'text/csv'
      return 'text/plain'
    }
  }

  return ''
}

/**
 * 像不像 CSV。
 *
 * 判据刻意宽松（只要"至少两行、每行都有逗号"），因为认错成 CSV 的代价
 * 只是预览时多画一个表格，而漏认的代价是表格型文件被当成一大坨纯文本。
 *
 * ⚠️ 空行必须先滤掉。原来的写法是 `text.split('\n').every(...)`：
 * 任何以换行结尾的文件（**几乎所有导出的 CSV 都带**）最后都会多出一个空串，
 * 它 split 出来长度是 1，于是 `every` 恒为 false —— 结果就是真实的 CSV
 * 一律被判成 text/plain，表格预览永远走不到。这个 bug 藏得很深：
 * 文件照样能上传、能下载、能用纯文本打开，只有"预览是表格还是文本"这一处不同。
 */
function isLikelyCsv(text: string): boolean {
  if (!text.includes(',')) return false
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  // 只要求两行：单行文本里出现一个逗号（"你好,世界"）不该被当成表格
  return lines.length >= 2 && lines.every((line) => line.split(',').length > 1)
}

/**
 * 给一段上传内容定内容类型。**永远不会失败。**
 *
 * 任何字节都能选出结果：认得出就报真实种类，认不出就 application/octet-stream。
 * "不认识的类型"从来不是拒绝上传的理由（用户明确要求能上传任何格式），
 * 它只影响下载/预览响应里那个给浏览器看的 Content-Type。
 *
 * 返回值**不参与任何安全放行**：一个伪装成 .png 的 HTML 会被嗅探成 text/plain，
 * 于是既不会被当成图片渲染，也不会被当成 HTML 执行。预览能否内联的名单在
 * index.ts 的预览路由里（只认位图/PDF/文本/音视频，不含 SVG 与 HTML）。
 */
export function classifyUpload(head: Uint8Array): string {
  return sniffMime(head) || FALLBACK_MIME
}
