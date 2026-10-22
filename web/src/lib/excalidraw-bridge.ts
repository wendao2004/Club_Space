/**
 * Excalidraw 与 Vue 的桥接。
 *
 * @excalidraw/excalidraw 是 React 组件（MIT），在 Vue 里挂一个独立的
 * React root —— 两个框架各自渲染各自的 DOM 子树，互不干涉。桥接层
 * 只暴露三个动作：载入场景、导出场景、销毁。
 *
 * 类型刻意收敛成一个最小接口而不是引 Excalidraw 的类型名：它的
 * imperative API 类型名在 0.17/0.18 之间换过，锁具体名字会让升级变成
 * 编译灾难，这里用结构化类型（duck typing）只声明我们用到的三个方法。
 */
import { createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
// ⚠️ Excalidraw 的样式是**单独一份 css**（包 exports 里的 ./index.css），
// 不引入就是裸 DOM：工具栏消失、欢迎页内容按文档流堆成一列、canvas 不可用
// —— 线上那条“白板用不了”的截图就是这个。必须与组件一起进来。
import '@excalidraw/excalidraw/index.css'
import { Excalidraw } from '@excalidraw/excalidraw'

/**
 * 资产同源化：不设它，Excalidraw 会从 esm.sh 外网 CDN 拉字体 —— 内网
 * 拉不到，线上 CSP（default-src 'self'）也会拦，表现为画布字体全丢。
 * 资产由 web/scripts/copy-excalidraw-assets.mjs 在构建后拷进
 * dist/excalidraw-assets/（随站点同源提供）。
 *
 * 在渲染前设置即可（Excalidraw 是运行时读这个值，不是模块初始化时）。
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string
  }
}
window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'

export interface ExcalidrawApi {
  updateScene(scene: { elements: unknown[] }): void
  getSceneElements(): unknown[]
  getAppState(): { viewBackgroundColor?: string }
}

export interface ExcalidrawBridge {
  api: ExcalidrawApi
  /** 用服务端存的场景 JSON 覆盖当前画布。 */
  loadScene(data: string): void
  /** 导出当前画布为可持久化的场景 JSON（Excalidraw 官方文件格式）。 */
  exportScene(): string
  destroy(): void
}

export function mountExcalidraw(
  el: HTMLElement,
  onReady?: () => void,
  onChange?: () => void,
): ExcalidrawBridge {
  const root: Root = createRoot(el)
  let api: ExcalidrawApi | null = null
  /**
   * 初始化/程序化改场景会触发 onChange —— 那不是"用户改了"，不该标记
   * 未保存（否则一打开就顶着个"未保存"，而且此时点保存会把空场景
   * 覆盖回去）。
   *
   * 两层防护：suppressChange 标志盖住同步派发的回调；**时间窗**
   * （quietUntil）盖住 Excalidraw 拖到微任务/下一帧才派发的那部分 ——
   * 只靠 rAF 清除靠不住，实际就见过"打开即脏"。窗口内用户不可能
   * 已经开始画画（打开→看见界面就不止 1 秒）。
   */
  let suppressChange = false
  let quietUntil = 0
  const quietFor = (ms: number): void => {
    quietUntil = Date.now() + ms
  }
  quietFor(1200)

  // 用宽化的组件类型绕开 Excalidraw 内部 props 的窄类型 —— 我们只传三个
  // 回调，真正的类型约束靠上面的最小接口与运行时行为
  const ExcalidrawAny = Excalidraw as unknown as ComponentType<Record<string, unknown>>

  root.render(
    createElement(ExcalidrawAny, {
      // 主题跟随 CSS：不传 theme，用默认亮色（画布内容自成一体的视觉）
      gridModeEnabled: false,
      /**
       * 界面语言：简体中文。语言包是带内容哈希的 js 模块，Excalidraw 在
       * 首次渲染后按需动态 import（`${EXCALIDRAW_ASSET_PATH}locales/zh-CN-*.js`）
       * —— 所以构建时拷贝的 locales/ 目录既是字体以外的另一份必需品，
       * 也是 CSP 下"必须同源"的原因（外网 CDN 的 js 会被 script-src 拦）。
       */
      langCode: 'zh-CN',
      // 关掉"嵌入库"按钮 —— 它会开一个指向 excalidraw.com 的 iframe，
      // 内网够不到，CSP 的 frame-src 'self' 也会拦
      UIOptions: {
        canvasActions: {
          loadLibrary: null,
        },
      },
      excalidrawAPI: (instance: ExcalidrawApi) => {
        api = instance
        /**
         * 只读调试钩子：线上探针与自动化断言用它读"场景里到底有几个元素"，
         * 否则 Excalidraw 全画在 canvas 上、DOM 里查不到任何形状 —— 出现过
         * "保存成功但存的是空场景"这种只能靠它定位的问题。无敏感数据。
         */
        ;(window as unknown as { __wlWhiteboard?: unknown }).__wlWhiteboard = {
          elementCount: (): number => (instance.getSceneElements() ?? []).length,
          elementIds: (): string[] => (instance.getSceneElements() ?? []).map((e) => (e as { id?: string }).id ?? '?'),
          updateScene: (elements: unknown[]): void => instance.updateScene({ elements }),
        }
        onReady?.()
      },
      onChange: () => {
        if (suppressChange || Date.now() < quietUntil) return
        onChange?.()
      },
    }),
  )

  return {
    get api(): ExcalidrawApi {
      if (!api) throw new Error('Excalidraw 尚未就绪')
      return api
    },
    loadScene(data: string): void {
      const parsed = JSON.parse(data) as { elements?: unknown[] }
      suppressChange = true
      quietFor(600)
      api?.updateScene({ elements: parsed.elements ?? [] })
      // updateScene 是同步的，但它的 onChange 回调可能在同一轮或下一帧派发
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          suppressChange = false
        })
      })
    },
    exportScene(): string {
      const elements = api?.getSceneElements() ?? []
      const viewBackgroundColor = api?.getAppState()?.viewBackgroundColor ?? '#ffffff'
      return JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: 'wl-club',
        elements,
        appState: { viewBackgroundColor, gridSize: null },
        files: {},
      })
    },
    destroy(): void {
      root.unmount()
    },
  }
}
