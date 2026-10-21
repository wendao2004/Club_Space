/**
 * 打字背单词的词库汇总。
 *
 * CET-4/6 与考研词库由 ECDICT（MIT，github.com/skywind3000/ECDICT）生成
 * （gen-*.ts，脚本 scripts/.build-dicts.mjs，按 BNC 词频取高频词、每章 20 词），
 * 不要手改那三个文件 —— 下次生成会覆盖。
 *
 * 玩法参考 qwerty-learner（GPL-3，代码一个字没搬，见 docs/迭代记录）。
 * coder 词库是代码标识符（不是英文单词），音标留空，界面自行隐藏；
 * 每章 15 词，与生成词库的每章 20 词并存没有问题 —— 章是独立的。
 */
import { genCet4 } from './gen-cet4.ts'
import { genCet6 } from './gen-cet6.ts'
import { genKaoyan } from './gen-ky.ts'
import type { TypingDict } from './types.ts'

export type { TypingChapter, TypingDict, TypingWord } from './types'

const coder: TypingDict = {
  id: 'coder',
  name: '程序员 · API 与常用词',
  chapters: [
    {
      title: '第 1 章 · Web API',
      words: [
        { w: 'querySelector', t: '查找 DOM 元素' },
        { w: 'addEventListener', t: '绑定事件监听' },
        { w: 'getElementById', t: '按 id 取元素' },
        { w: 'appendChild', t: '追加子节点' },
        { w: 'removeChild', t: '移除子节点' },
        { w: 'setTimeout', t: '延时执行' },
        { w: 'setInterval', t: '定时循环执行' },
        { w: 'clearTimeout', t: '取消延时' },
        { w: 'preventDefault', t: '阻止默认行为' },
        { w: 'stopPropagation', t: '阻止事件冒泡' },
        { w: 'localStorage', t: '本地存储' },
        { w: 'sessionStorage', t: '会话存储' },
        { w: 'encodeURIComponent', t: 'URL 编码' },
        { w: 'requestAnimationFrame', t: '下一帧回调' },
        { w: 'IntersectionObserver', t: '交叉观察器' },
      ],
    },
    {
      title: '第 2 章 · JavaScript 关键字',
      words: [
        { w: 'function', t: '函数' },
        { w: 'return', t: '返回' },
        { w: 'undefined', t: '未定义' },
        { w: 'prototype', t: '原型' },
        { w: 'constructor', t: '构造器' },
        { w: 'instanceof', t: '类型判断' },
        { w: 'typeof', t: '取类型' },
        { w: 'async', t: '异步' },
        { w: 'await', t: '等待' },
        { w: 'yield', t: '产出' },
        { w: 'extends', t: '继承' },
        { w: 'implements', t: '实现' },
        { w: 'interface', t: '接口' },
        { w: 'namespace', t: '命名空间' },
        { w: 'deprecated', t: '已弃用的' },
      ],
    },
    {
      title: '第 3 章 · 后端与网络',
      words: [
        { w: 'middleware', t: '中间件' },
        { w: 'callback', t: '回调' },
        { w: 'websocket', t: '长连接协议' },
        { w: 'localhost', t: '本机地址' },
        { w: 'endpoint', t: '接口地址' },
        { w: 'payload', t: '请求体' },
        { w: 'handshake', t: '握手' },
        { w: 'timestamp', t: '时间戳' },
        { w: 'serialize', t: '序列化' },
        { w: 'deserialize', t: '反序列化' },
        { w: 'authenticate', t: '身份验证' },
        { w: 'authorization', t: '鉴权' },
        { w: 'throughput', t: '吞吐量' },
        { w: 'concurrency', t: '并发' },
        { w: 'backpressure', t: '背压' },
      ],
    },
    {
      title: '第 4 章 · 数据库与工程',
      words: [
        { w: 'transaction', t: '事务' },
        { w: 'rollback', t: '回滚' },
        { w: 'migration', t: '迁移' },
        { w: 'schema', t: '模式' },
        { w: 'constraint', t: '约束' },
        { w: 'index', t: '索引' },
        { w: 'cache', t: '缓存' },
        { w: 'checkpoint', t: '检查点' },
        { w: 'replication', t: '主从复制' },
        { w: 'sharding', t: '分片' },
        { w: 'idempotent', t: '幂等的' },
        { w: 'consistency', t: '一致性' },
        { w: 'deployment', t: '部署' },
        { w: 'observability', t: '可观测性' },
        { w: 'benchmark', t: '基准测试' },
      ],
    },
  ],
}

export const TYPING_DICTS: TypingDict[] = [genCet4, genCet6, genKaoyan, coder]
