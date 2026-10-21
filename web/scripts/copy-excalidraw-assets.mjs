/**
 * 把 Excalidraw 的字体/语言包拷进 dist/excalidraw-assets/。
 *
 * 为什么必须这么做：不设置 window.EXCALIDRAW_ASSET_PATH 时，Excalidraw
 * 会从 esm.sh 外网 CDN 拉字体 —— 内网环境拉不到，线上 CSP（default-src
 * 'self'）也会拦。同源化之后 CSP 放行、断外网也能画。
 *
 * 白板 bridge（excalidraw-bridge.ts）会设 window.EXCALIDRAW_ASSET_PATH =
 * '/excalidraw-assets/'。目录结构必须保持 prod/ 下的相对布局
 * （fonts/、locales/、excalidraw-assets/）。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// 不能 resolve('.../package.json') —— 它的 exports 不导出 package.json；
// 先解析主入口，再向上找 dist/prod
const entryPath = require.resolve('@excalidraw/excalidraw')
const prodDir = join(dirname(entryPath)) // 主入口就在 dist/prod/ 里

if (!existsSync(prodDir)) {
  console.error(`[copy-excalidraw-assets] 找不到 ${prodDir}`)
  process.exit(1)
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'excalidraw-assets')
mkdirSync(outDir, { recursive: true })

for (const dir of ['fonts', 'locales', 'excalidraw-assets']) {
  const src = join(prodDir, dir)
  if (existsSync(src)) {
    cpSync(src, join(outDir, dir), { recursive: true })
    console.log(`[copy-excalidraw-assets] ${dir}/ ✓`)
  }
}
console.log('[copy-excalidraw-assets] 完成 →', outDir)
