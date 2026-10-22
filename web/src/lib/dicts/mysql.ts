/**
 * MySQL 插入语句训练。
 *
 * 为什么单独一套：SQL 是"打得多才会"的技能 —— 引号、括号、逗号的次序错
 * 一个就报错，而报错信息往往不告诉你错在哪。这里把常见 INSERT 写法按难度
 * 分章，一字不差地打出来（打错整句重来），并且配了“看中文写 SQL”的默写
 * 模式（Ctrl+V）—— 真正练的是"给我需求，我写出语句"。
 *
 * 语句都是标准 MySQL 8 语法；表名/字段名用英文，值也尽量用英文，
 * 免得训练变成中文输入练习。
 */
import type { TypingDict } from './types.ts'

export const mysqlDict: TypingDict = {
  id: 'mysql',
  name: 'MySQL 插入语句',
  chapters: [
    {
      title: '第 1 章 · 基础 INSERT',
      words: [
        { w: "INSERT INTO users (name, age) VALUES ('Alice', 18);", t: '插入一条用户记录（两列）' },
        { w: "INSERT INTO users (name) VALUES ('Bob');", t: '只插入一个字段，其余走默认值' },
        { w: 'INSERT INTO users VALUES (1);', t: '省略列名，按表结构顺序插入' },
        { w: "INSERT INTO products (title, price) VALUES ('Keyboard', 299.00);", t: '插入商品与价格' },
        { w: "INSERT INTO notes (body) VALUES ('hello world');", t: '插入一段文本' },
        { w: 'INSERT INTO counters (id, n) VALUES (1, 0);', t: '初始化一个计数器' },
        { w: "INSERT INTO tags (name) VALUES ('sql');", t: '插入一个标签' },
        { w: 'INSERT INTO logs (level, code) VALUES (3, 404);', t: '插入一条数值型日志' },
      ],
    },
    {
      title: '第 2 章 · 多行与可空值',
      words: [
        { w: "INSERT INTO users (name, age) VALUES ('Bob', 20), ('Carol', 22);", t: '一条语句插入多行' },
        { w: "INSERT INTO users (name, age) VALUES ('Dan', 25), ('Eve', 27), ('Finn', 30);", t: '三行一次插入' },
        { w: "INSERT INTO users (name, email) VALUES ('Gina', NULL);", t: '显式插入 NULL' },
        { w: "INSERT INTO orders (user_id, total) VALUES (7, 99.50), (8, 12.00);", t: '批量插入订单' },
        { w: 'INSERT INTO events (title) VALUES (DEFAULT);', t: '用 DEFAULT 取列默认值' },
        { w: "INSERT INTO users (name) VALUES ('Hank'), ('Ivy');", t: '只填必填列的多行插入' },
        { w: "INSERT INTO scores (player, point) VALUES ('amy', 100), ('ben', 95);", t: '插入排行榜数据' },
        { w: "INSERT INTO settings (k, v) VALUES ('theme', 'dark');", t: '插入键值配置' },
      ],
    },
    {
      title: '第 3 章 · 时间与特殊值',
      words: [
        { w: "INSERT INTO events (title, happen_at) VALUES ('demo', '2026-10-22 09:00:00');", t: '插入日期时间字符串' },
        { w: "INSERT INTO events (title, happen_at) VALUES ('launch', NOW());", t: '用 NOW() 写入当前时间' },
        { w: 'INSERT INTO visits (user_id, seen_at) VALUES (3, CURRENT_TIMESTAMP);', t: '用 CURRENT_TIMESTAMP' },
        { w: "INSERT INTO logs (msg, created_at) VALUES ('boot', NOW() - INTERVAL 1 DAY);", t: '写入昨天的时间' },
        { w: "INSERT INTO users (name, created_at) VALUES ('Jack', '2026-01-01');", t: '只写日期，时间补零' },
        { w: 'INSERT INTO metrics (value) VALUES (3.14), (2.71), (1.41);', t: '插入多个小数' },
        { w: "INSERT INTO users (name, bio) VALUES ('Kim', '');", t: '插入空字符串（不是 NULL）' },
        { w: "INSERT INTO products (title, price) VALUES ('Mouse', 0.99);", t: '插入小于 1 的价格' },
      ],
    },
    {
      title: '第 4 章 · 冲突处理与子查询',
      words: [
        { w: "INSERT IGNORE INTO tags (name) VALUES ('js');", t: 'IGNORE：主键冲突时静默跳过' },
        { w: "INSERT INTO tags (name) VALUES ('js') ON DUPLICATE KEY UPDATE name = VALUES(name);", t: '冲突时更新已有行' },
        { w: 'INSERT INTO counters (id, n) VALUES (1, 1) ON DUPLICATE KEY UPDATE n = n + 1;', t: '原子自增写法' },
        { w: 'INSERT INTO users_backup SELECT * FROM users;', t: 'INSERT ... SELECT 全表复制' },
        { w: 'INSERT INTO users_backup (name) SELECT name FROM users WHERE age > 18;', t: '按条件复制部分列' },
        { w: "INSERT INTO tags (name) SELECT DISTINCT tag FROM posts;", t: '去重后插入' },
        { w: 'REPLACE INTO settings (k, v) VALUES (\'theme\', \'light\');', t: 'REPLACE：先删后插' },
        { w: "INSERT INTO users (name) VALUES ('Leo') ON DUPLICATE KEY UPDATE updated_at = NOW();", t: '冲突时只更新时间戳' },
      ],
    },
  ],
}
