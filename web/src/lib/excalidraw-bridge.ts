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
import { Excalidraw } from '@excalidraw/excalidraw'

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

  // 用宽化的组件类型绕开 Excalidraw 内部 props 的窄类型 —— 我们只传三个
  // 回调，真正的类型约束靠上面的最小接口与运行时行为
  const ExcalidrawAny = Excalidraw as unknown as ComponentType<Record<string, unknown>>

  root.render(
    createElement(ExcalidrawAny, {
      // 主题跟随 CSS：不传 theme，用默认亮色（画布内容自成一体的视觉）
      gridModeEnabled: false,
      excalidrawAPI: (instance: ExcalidrawApi) => {
        api = instance
        onReady?.()
      },
      onChange: () => onChange?.(),
    }),
  )

  return {
    get api(): ExcalidrawApi {
      if (!api) throw new Error('Excalidraw 尚未就绪')
      return api
    },
    loadScene(data: string): void {
      const parsed = JSON.parse(data) as { elements?: unknown[] }
      api?.updateScene({ elements: parsed.elements ?? [] })
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
