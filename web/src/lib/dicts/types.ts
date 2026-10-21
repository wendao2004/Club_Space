/**
 * 词库的类型定义（数据文件 gen-*.ts 由脚本生成，coder 词库手写在 index.ts）。
 */

export interface TypingWord {
  /** 单词本身。 */
  w: string
  /** 音标（可空，空则界面不显示）。 */
  ipa?: string
  /** 释义（一到两个常用义）。 */
  t: string
}

export interface TypingChapter {
  title: string
  words: TypingWord[]
}

export interface TypingDict {
  id: string
  name: string
  chapters: TypingChapter[]
}
