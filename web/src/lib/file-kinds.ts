/**
 * 文件"是什么类"的判定。只服务于界面：决定预览窗口该走哪条路。
 *
 * 这里的名单**必须与服务端对齐**，否则会出现"界面说能转、服务端说格式不支持"：
 * - OFFICE_MIMES 对应 `server/src/tools.ts` 里 `doc.to-pdf` 的 `accepts`；
 * - 能否内联对应 `server/src/index.ts` 预览路由的 `inline` 名单。
 * 改一端要同时看另一端。
 */

/**
 * Office / OpenDocument 的类型。
 *
 * 旧版 .doc/.xls/.ppt 在文件头层面是 OLE2 复合文档，嗅探给出
 * `application/x-ole-storage`（**不是** application/msword）—— 名单要按
 * "内容实际会被嗅探成什么"列，而不是按扩展名该是什么，否则真实的 .doc 永远选不中。
 */
export const OFFICE_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/x-ole-storage',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  // 少数环境（Windows 上传时带了 registry 里的类型）会给出这几个经典名
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
])

export const OFFICE_LABEL: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word 文档',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel 表格',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint 演示',
  'application/x-ole-storage': '旧版 Office 文档',
  'application/vnd.oasis.opendocument.text': 'OpenDocument 文本',
  'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument 表格',
  'application/vnd.oasis.opendocument.presentation': 'OpenDocument 演示',
  'application/msword': 'Word 文档',
  'application/vnd.ms-excel': 'Excel 表格',
  'application/vnd.ms-powerpoint': 'PowerPoint 演示',
}

export function isOfficeMime(mime: string | null | undefined): boolean {
  return !!mime && OFFICE_MIMES.has(mime)
}

/**
 * 表格型文本（渲染成表格而不是一坨纯文本）。
 *
 * 只认服务端嗅探给出的 `text/csv`，**不看扩展名**：名字是不可信的，
 * 按名字把任意文件当表格解析只会更糟（见 `server/src/mime.ts` 里关于
 * "类型永远不采信文件名"的说明）。
 *
 * TSV 不在其中：嗅探对制表符分隔没有判定，它会落在 text/plain 以纯文本渲染。
 * 这不是遗漏而是取舍 —— 加一条"名字叫 .tsv 就当表格"的规则，等于把上面那条
 * 不变量破一个口子。
 */
export function isDelimitedText(mime: string | null | undefined): boolean {
  return mime === 'text/csv'
}

/** 预览窗口能直接渲染的（与服务端 inline 名单一致）。 */
export function isInlinePreviewable(mime: string | null | undefined): boolean {
  const m = mime ?? ''
  return (
    (m.startsWith('image/') && m !== 'image/svg+xml') ||
    m === 'application/pdf' ||
    m.startsWith('text/') ||
    m.startsWith('video/') ||
    m.startsWith('audio/')
  )
}

/** 值得为它开一个预览窗口的类型（Office 需要"转成 PDF"这一步，也算）。 */
export function isPreviewable(mime: string | null | undefined): boolean {
  return isInlinePreviewable(mime) || isOfficeMime(mime)
}
