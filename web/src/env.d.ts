/// <reference types="vite/client" />

/**
 * 让编辑器（以及任何不经过 vue-tsc 的 TS 服务）认得 .vue 导入。
 *
 * `vue-tsc` 本身能直接解析 .vue 文件，所以命令行类型检查不需要这一段；
 * 但编辑器的 TS 服务没有这个能力，缺了它整个项目会显示满屏的
 * "找不到模块 @/apps/XxxApp.vue"，噪音会淹没真正的错误。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
