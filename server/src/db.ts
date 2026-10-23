/**
 * 数据库层：Node 24 内置的 node:sqlite。
 *
 * 为什么不用 PostgreSQL：评审团的设计里 Postgres 常驻要 250-400MB，而整台 NAS
 * 留给业务容器的只有 2-4GB。本项目是「单进程 + 10-100 人」的形态，SQLite 开 WAL
 * 完全够用，而且它带来两个关键好处：
 *   1. 开发机（没有 Docker）可以原生跑起来，不需要先起一个数据库容器；
 *   2. 省下的一整个容器内存，让重任务（格式转换）峰值有空间。
 * 代价是放弃了多进程并发写与 pg_dump 级别的可移植备份 —— 备份改用
 * VACUUM INTO 做一致性快照（见 backup 相关脚本）。
 */
import { DatabaseSync } from 'node:sqlite'
import { ensureDirs, DB_PATH } from './config.ts'

let db: DatabaseSync | null = null

/** 打开数据库连接（单例），并确保 schema 是最新的。 */
export function getDb(): DatabaseSync {
  if (db) return db
  ensureDirs()

  // 整个"打开 + 设 PRAGMA + 迁移"要能整体重试。
  //
  // 为什么不是只重试迁移：并发启动时真正会炸的地方不止一处 —— 实测过
  // `PRAGMA journal_mode = WAL` 之后紧接着的 `CREATE TABLE IF NOT EXISTS
  // schema_version` 会返回 SQLITE_READONLY（errcode 8）。那条错误看起来
  // 像"文件权限不对"，实际是"另一个进程正在切换日志模式 / 正在迁移"，
  // 而 SQLite 在切换 WAL 的那一瞬间不会走 busy handler。
  //
  // 迁移整体在一个 BEGIN IMMEDIATE 事务里，中途失败会回滚，所以重试是安全的。
  const deadline = Date.now() + 5_000
  for (;;) {
    let candidate: DatabaseSync | null = null
    try {
      candidate = openWithPragmas()
      migrate(candidate)
      db = candidate
      return db
    } catch (err) {
      try {
        candidate?.close()
      } catch {
        // 关不掉就算了，进程马上要重试同一条路径
      }
      // 只对"锁冲突"重试。磁盘只读、文件损坏这类要立刻抛出去 ——
      // 用 5 秒的沉默把它们伪装成"再等等就好了"，是最难查的那种故障。
      if (!/locked|busy|readonly/i.test(String((err as Error)?.message ?? ''))) throw err
      if (Date.now() > deadline) throw err
      sleepSync(100)
    }
  }
}

/**
 * 打开连接并设好 PRAGMA。
 *
 * ⚠️ **顺序是有讲究的**，这不是风格问题：
 *
 * `busy_timeout` 必须第一个设。它之前，这条连接遇到被别的进程占着的锁会
 * **立刻**失败，而不是等 —— 报错是一句 `database is locked`，或者更难认的
 * `attempt to write a readonly database`（并发切 WAL 时的表现）。
 * 两个进程同时启动就会撞上，而报错完全指向不了"多实例同时启动"这个原因。
 *
 * 这个坑是用 scripts/db-migrate-test.mjs 抓出来的：那个测试起 4 个真子进程
 * 同时打开一个空库，早期版本大约每 5 次就有 1 次挂在切换 WAL 之后的
 * `CREATE TABLE IF NOT EXISTS schema_version` 上（errcode 8 / SQLITE_READONLY）。
 */
function openWithPragmas(): DatabaseSync {
  const database = new DatabaseSync(DB_PATH)
  // 先于一切：后面每一个 PRAGMA 都要拿锁
  database.exec('PRAGMA busy_timeout = 5000')
  enableWal(database)
  // WAL 下 NORMAL 已能抵御应用崩溃（掉电可能丢最后一个事务，可接受）
  database.exec('PRAGMA synchronous = NORMAL')
  database.exec('PRAGMA foreign_keys = ON')
  return database
}

/** 同步睡一小会儿（启动路径，不在请求里，可以阻塞）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 把库切到 WAL，并发安全。
 *
 * `PRAGMA journal_mode = WAL` 需要一把排他锁，而**SQLite 在切换日志模式时
 * 不会走 busy handler** —— 也就是说 busy_timeout 在这里帮不上忙，别人正在切
 * （或正在迁移）的时候它会直接返回 SQLITE_BUSY。
 *
 * 所以这里先读当前模式：已经是 WAL 就什么都不做。没切过去就等 50ms 再看一次，
 * 最多 20 次（约 1 秒）。并发场景下第一个进程切完提交，后面的重读就是 WAL，
 * 全部安静退出。
 */
function enableWal(database: DatabaseSync): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = database.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: string }
      | undefined
    if (String(current?.journal_mode ?? '').toLowerCase() === 'wal') return

    try {
      database.exec('PRAGMA journal_mode = WAL')
      return
    } catch (err) {
      const message = String((err as Error)?.message ?? '')
      // 只对"锁冲突"重试。真正的错误（磁盘只读、文件损坏）要立刻抛出去，
      // 别用 1 秒的沉默把它们伪装成"再等等就好了"。
      if (!/locked|busy|readonly database/i.test(message)) throw err
      sleepSync(50)
    }
  }
  throw new Error(
    '切换 WAL 超时：database is locked（重试约 1 秒仍被占用）。' +
      '通常是另一个进程正在迁移或持锁不放，请确认只有预期数量的服务端在跑。',
  )
}

/** 关闭连接（测试与优雅退出用）。 */
export function closeDb(): void {
  db?.close()
  db = null
}

/**
 * 迁移。
 *
 * 刻意用手写的 schema_version 表而不是迁移框架：本项目表结构稳定、单人维护，
 * 引入迁移工具带来的复杂度大于收益。每条迁移一旦发布就不许再改，只能追加新的。
 */
function migrate(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)

  const readVersion = (): number => {
    const row = database.prepare('SELECT version FROM schema_version').get() as
      | { version: number }
      | undefined
    return row?.version ?? 0
  }

  const migrations: Array<(d: DatabaseSync) => void> = [
    // ---- v1: 初始 schema ----
    (d) => {
      d.exec(`
        -- 用户
        CREATE TABLE users (
          id            TEXT PRIMARY KEY,
          username      TEXT NOT NULL UNIQUE,
          display_name  TEXT NOT NULL,
          password_hash TEXT NOT NULL,             -- scrypt: "<salt-hex>:<hash-hex>"
          role          TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
          status        TEXT NOT NULL DEFAULT 'active',  -- active | disabled
          created_at    INTEGER NOT NULL,
          last_login_at INTEGER
        );

        -- 会话（存 token 的哈希，不存明文）
        CREATE TABLE sessions (
          id         TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          user_agent TEXT,
          ip         TEXT
        );
        CREATE INDEX ix_sessions_user ON sessions(user_id);

        -- 邀请码：内网平台不能开放注册，必须持码入场
        CREATE TABLE invites (
          code       TEXT PRIMARY KEY,
          created_by TEXT NOT NULL REFERENCES users(id),
          role       TEXT NOT NULL DEFAULT 'member',
          max_uses   INTEGER NOT NULL DEFAULT 1,
          uses       INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          note       TEXT
        );

        -- 内容寻址的二进制存储。
        -- 同一份内容只落一份盘，nodes 通过 sha256 引用它：
        --   * 上传时若 sha256 已存在，直接建节点、不传字节（"秒传"）；
        --   * 删除节点时 refs 减一，归零才真正删文件。
        -- 之所以要做内容寻址而不是一个节点一份文件：社团场景下同一个安装包 /
        -- 同一部影片会被多个人反复上传，去重能实打实省下 NAS 空间。
        CREATE TABLE blobs (
          sha256     TEXT PRIMARY KEY,
          size       INTEGER NOT NULL,
          refs       INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        -- 文件与目录（统一的树）
        CREATE TABLE nodes (
          id          TEXT PRIMARY KEY,
          parent_id   TEXT REFERENCES nodes(id) ON DELETE CASCADE,
          owner_id    TEXT NOT NULL REFERENCES users(id),
          name        TEXT NOT NULL,
          kind        TEXT NOT NULL,               -- folder | file
          -- 空间：shared=全社团可见，private=仅所有者可见。
          -- 用一列而不是两棵树，列表查询只多一个 WHERE 条件。
          space       TEXT NOT NULL DEFAULT 'shared',
          size        INTEGER NOT NULL DEFAULT 0,
          mime        TEXT,
          sha256      TEXT,
          storage_key TEXT,                        -- 文件专有：相对存储根的路径
          deleted_at  INTEGER,                     -- 软删除
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          UNIQUE (parent_id, name, deleted_at)
        );
        CREATE INDEX ix_nodes_parent ON nodes(parent_id);
        CREATE INDEX ix_nodes_owner ON nodes(owner_id);
        CREATE INDEX ix_nodes_sha ON nodes(sha256);

        -- 分片上传会话（断点续传）
        CREATE TABLE uploads (
          id              TEXT PRIMARY KEY,
          user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          parent_id       TEXT REFERENCES nodes(id),
          name            TEXT NOT NULL,
          declared_size   INTEGER NOT NULL,
          declared_sha256 TEXT,
          tmp_path        TEXT NOT NULL,
          received        INTEGER NOT NULL DEFAULT 0,  -- 已落盘字节数，用于续传
          status          TEXT NOT NULL DEFAULT 'open', -- open | completed | aborted
          error           TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE INDEX ix_uploads_user ON uploads(user_id, status);

        -- 工具任务队列
        CREATE TABLE jobs (
          id             TEXT PRIMARY KEY,
          user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind           TEXT NOT NULL,            -- convert.doc2pdf / pdf.merge / image.convert ...
          params         TEXT NOT NULL,            -- JSON
          state          TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed|canceled
          progress       INTEGER NOT NULL DEFAULT 0,
          input_node_id  TEXT REFERENCES nodes(id),
          output_node_id TEXT REFERENCES nodes(id),
          error          TEXT,
          created_at     INTEGER NOT NULL,
          started_at     INTEGER,
          finished_at    INTEGER
        );
        CREATE INDEX ix_jobs_pick ON jobs(state, created_at);
        CREATE INDEX ix_jobs_user ON jobs(user_id, created_at DESC);

        -- 审计日志：哈希链，append-only
        CREATE TABLE audit_log (
          seq       INTEGER PRIMARY KEY AUTOINCREMENT,
          ts        INTEGER NOT NULL,
          actor_id  TEXT,
          actor_ip  TEXT,
          category  TEXT NOT NULL,                 -- auth|file|tool|chat|ledger|admin|system
          action    TEXT NOT NULL,
          target    TEXT,
          payload   TEXT,                          -- canonical JSON
          prev_hash TEXT NOT NULL,
          hash      TEXT NOT NULL UNIQUE
        );
        CREATE INDEX ix_audit_ts ON audit_log(ts);
        CREATE INDEX ix_audit_actor ON audit_log(actor_id, ts);

        -- 系统设置（键值）
        CREATE TABLE settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
    },

    // ---- v2: 聊天 ----
    (d) => {
      d.exec(`
        -- 会话：单聊与群聊用同一张表，靠 kind 区分。
        -- 单聊的"唯一性"靠 pair_key 保证（两个用户只应有一个单聊），
        -- 而不是靠应用层去查重 —— 并发下应用层查重一定会漏。
        CREATE TABLE conversations (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL,              -- direct | group
          title       TEXT,                       -- 群聊名称；单聊为 NULL（前端用对方名字显示）
          created_by  TEXT NOT NULL REFERENCES users(id),
          -- 单聊的两个用户 id 排序后拼接，保证 (a,b) 与 (b,a) 视为同一个会话；
          -- 群聊为 NULL。用 UNIQUE 索引挡住并发重复创建。
          pair_key    TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX ux_conversations_pair
          ON conversations(pair_key) WHERE pair_key IS NOT NULL;
        CREATE INDEX ix_conversations_updated ON conversations(updated_at DESC);

        CREATE TABLE conversation_members (
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role            TEXT NOT NULL DEFAULT 'member',   -- owner | member
          joined_at       INTEGER NOT NULL,
          -- 最后已读的消息 seq；未读数由 max(seq) 与它相减得出，不需要额外的计数表
          last_read_seq   INTEGER NOT NULL DEFAULT 0,
          muted           INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (conversation_id, user_id)
        );
        CREATE INDEX ix_members_user ON conversation_members(user_id);

        -- 消息。
        -- seq 是全局自增，同时也是游标：客户端用 "since=seq" 拉增量，
        -- 比时间戳可靠（同一毫秒内可能有多条，时间戳会丢消息）。
        -- 注意：一张表只能有一个 PRIMARY KEY，所以 seq 做自增主键，
        -- 对外暴露的 id 用 UNIQUE 约束保证唯一。
        CREATE TABLE messages (
          seq             INTEGER PRIMARY KEY AUTOINCREMENT,
          id              TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          sender_id       TEXT NOT NULL REFERENCES users(id),
          kind            TEXT NOT NULL DEFAULT 'text',   -- text | file | system
          body            TEXT,                            -- 文本内容；文件消息为说明文字
          file_node_id    TEXT REFERENCES nodes(id),       -- 文件消息引用的文件
          reply_to        TEXT REFERENCES messages(id),
          edited_at       INTEGER,
          deleted_at      INTEGER,
          created_at      INTEGER NOT NULL
        );
        CREATE INDEX ix_messages_conv ON messages(conversation_id, seq DESC);
        CREATE INDEX ix_messages_sender ON messages(sender_id, created_at DESC);

        -- 全文检索：SQLite 自带的 FTS5。
        --
        -- 分词器必须用 trigram，不能用 unicode61。
        -- 原因：unicode61 按"字母/数字 vs 其他"切分，而中文字符在 Unicode 里属于字母，
        -- 所以一整串中文会被切成**一个词**。结果是"我会带上次的会议纪要过去"这整句
        -- 成为一个 token，搜"会议纪要"完全匹配不上 —— 测试实测命中 0 条。
        -- trigram 按三元组索引，天然支持子串匹配，对中文可用，且不引入额外依赖。
        -- 代价是查询词至少要 3 个字符（少于 3 个字符时应用层退回 LIKE，见 chat.ts）。
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          body,
          content='messages',
          content_rowid='seq',
          tokenize='trigram'
        );

        -- 用触发器让 FTS 索引与 messages 保持同步。
        -- 手动在应用层同步迟早会漏（某条插入路径忘了写），触发器不会。
        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, body) VALUES (new.seq, COALESCE(new.body, ''));
        END;
        CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.seq, COALESCE(old.body, ''));
        END;
        CREATE TRIGGER messages_fts_update AFTER UPDATE OF body ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.seq, COALESCE(old.body, ''));
          INSERT INTO messages_fts(rowid, body) VALUES (new.seq, COALESCE(new.body, ''));
        END;

        -- 在线状态：只记"最后一次心跳时间"，不记布尔值。
        -- 布尔值在进程崩溃时会永久卡在"在线"，而时间戳会自然过期。
        CREATE TABLE presence (
          user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          last_seen   INTEGER NOT NULL,
          connection_count INTEGER NOT NULL DEFAULT 0
        );
      `)
    },

    // ---- v3: 记账 ----
    (d) => {
      d.exec(`
        -- 收支分类。由管理员维护，可归档但不可删除（历史记录还要引用它）。
        CREATE TABLE ledger_categories (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          kind        TEXT NOT NULL,               -- income | expense
          icon        TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          archived    INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL,
          UNIQUE (name, kind)
        );

        -- 账目。
        --
        -- **金额一律用整数「分」存储，绝不用浮点数。**
        -- 0.1 + 0.2 !== 0.3 这件事在记账上是灾难：几十笔之后余额就对不上了，
        -- 而且用户会觉得"这软件算错了"。所有加减都在整数域完成，只在显示时除 100。
        --
        -- occurred_on 存业务发生日期（YYYY-MM-DD 字符串），与 created_at 分开：
        -- 周五的聚餐可能周一才补录，按创建时间统计会把账算到错误的月份。
        CREATE TABLE ledger_entries (
          id            TEXT PRIMARY KEY,
          kind          TEXT NOT NULL,              -- income | expense
          amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
          category_id   TEXT REFERENCES ledger_categories(id),
          title         TEXT NOT NULL,
          note          TEXT,
          occurred_on   TEXT NOT NULL,              -- YYYY-MM-DD
          -- 状态机：draft → submitted → approved/rejected → paid
          -- draft 只有创建者能改；submitted 之后要走审批
          status        TEXT NOT NULL DEFAULT 'draft',
          created_by    TEXT NOT NULL REFERENCES users(id),
          submitted_at  INTEGER,
          decided_by    TEXT REFERENCES users(id),
          decided_at    INTEGER,
          decision_note TEXT,
          paid_at       INTEGER,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX ix_ledger_occurred ON ledger_entries(occurred_on DESC);
        CREATE INDEX ix_ledger_status ON ledger_entries(status, occurred_on DESC);
        CREATE INDEX ix_ledger_creator ON ledger_entries(created_by, occurred_on DESC);
        CREATE INDEX ix_ledger_category ON ledger_entries(category_id);

        -- 凭证附件：复用文件模块的存储，不另起一套上传通道。
        CREATE TABLE ledger_attachments (
          entry_id  TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
          node_id   TEXT NOT NULL REFERENCES nodes(id),
          added_at  INTEGER NOT NULL,
          PRIMARY KEY (entry_id, node_id)
        );

        -- 分摊：一笔支出由哪些人分摊、各承担多少。
        -- 社团报账的现实是"一起吃了饭，AA 或按人头"，
        -- 只记总额而不记分摊，事后就算不清谁该给谁多少钱。
        CREATE TABLE ledger_splits (
          id            TEXT PRIMARY KEY,
          entry_id      TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
          user_id       TEXT NOT NULL REFERENCES users(id),
          amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
          settled       INTEGER NOT NULL DEFAULT 0,
          settled_at    INTEGER,
          UNIQUE (entry_id, user_id)
        );
        CREATE INDEX ix_ledger_splits_user ON ledger_splits(user_id, settled);
        CREATE INDEX ix_ledger_splits_entry ON ledger_splits(entry_id);
      `)
    },

    // ---- v4: 游戏房间 ----
    (d) => {
      d.exec(`
        -- 对局房间。棋类游戏的局面本身很小（象棋棋盘 90 格），
        -- 所以直接整盘序列化存在一行里，不做增量存盘 —— 简单且不会出现
        -- "事件流与快照不一致"这类难查的问题。
        CREATE TABLE game_rooms (
          id           TEXT PRIMARY KEY,
          kind         TEXT NOT NULL,              -- xiangqi（后续可加 doudizhu 等）
          title        TEXT NOT NULL,
          -- waiting = 等人；playing = 对局中；finished = 已结束
          status       TEXT NOT NULL DEFAULT 'waiting',
          created_by   TEXT NOT NULL REFERENCES users(id),
          -- 两方各一个座位。允许为 NULL（等人加入）。
          red_player   TEXT REFERENCES users(id),
          black_player TEXT REFERENCES users(id),
          -- 当前局面（序列化字符串，见 games/xiangqi.ts 的 serializeBoard）
          board        TEXT NOT NULL,
          turn         TEXT NOT NULL DEFAULT 'red',
          -- 着法历史（JSON 数组）。用于悔棋与复盘。
          moves        TEXT NOT NULL DEFAULT '[]',
          -- 结果（JSON）：{ winner, reason }
          result       TEXT,
          -- 观战人数不落库：它是瞬时状态，存下来只会变陈旧
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL,
          finished_at  INTEGER
        );
        CREATE INDEX ix_game_rooms_status ON game_rooms(status, updated_at DESC);
        CREATE INDEX ix_game_rooms_kind ON game_rooms(kind, updated_at DESC);
      `)
    },

    // ---- v5: 管理员两步验证 ----
    (d) => {
      d.exec(`
        -- TOTP 秘密（用 WL_SESSION_SECRET 派生的密钥加密后存这里，见 admin/totp.ts）。
        -- pending 表示"已生成但还没用验证码确认过"，此时不生效 ——
        -- 否则用户扫完码关掉页面就会把自己锁在外面。
        ALTER TABLE users ADD COLUMN totp_secret TEXT;
        ALTER TABLE users ADD COLUMN totp_pending TEXT;
        ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;
      `)
    },

    // ---- v6: 牌类游戏（斗地主）----
    (d) => {
      d.exec(`
        -- 通用状态列：棋类的局面很小（象棋 90 格）可以塞进 board 列里，
        -- 但斗地主有手牌、底牌、叫地主流程、出牌历史 —— 结构化数据更适合 JSON。
        -- 用一列 JSON 而不是给每种游戏加一堆列：游戏的种类会变，schema 不该跟着变。
        ALTER TABLE game_rooms ADD COLUMN state TEXT;

        -- 座位：棋类用 red_player/black_player，牌类用 0/1/2 号座。
        -- 单独一列而不是复用红黑两列 —— 三个座位的语义和"两方"不一样，
        -- 硬塞进两列会让后面的代码到处写特判。
        ALTER TABLE game_rooms ADD COLUMN seat_1 TEXT;
        ALTER TABLE game_rooms ADD COLUMN seat_2 TEXT;
        -- seat_0 复用 red_player（见 doudizhu-rooms.ts 的说明）
      `)
    },

    // ---- v7: 财物管理（物品台账 + 借还记录）----
    (d) => {
      d.exec(`
        -- 分类。社团的东西天然就那么几类（器材、设备、文具、服装……），
        -- 让它们自己分而不是写死一个枚举 —— 每个社团的家当都不一样。
        CREATE TABLE asset_categories (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          icon        TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          archived    INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL
        );

        -- 物品台账。
        --
        -- 刻意**没有** available_qty 列：可用量 = total_qty − 未归还的借出数，
        -- 是算出来的。存一个冗余字段它迟早会漂移，而"账面还有 3 件、
        -- 柜子里只剩 1 件"这种不一致事后根本查不出是哪一步错的。
        --
        -- value_cents 与账本一样用整数「分」，理由见 ledger_entries 的注释。
        -- 单价 × 总数才是这件资产的账面价值，不在库里存乘积。
        CREATE TABLE asset_items (
          id            TEXT PRIMARY KEY,
          code          TEXT UNIQUE,                 -- 社团自己编的资产编号，可空
          name          TEXT NOT NULL,
          category_id   TEXT REFERENCES asset_categories(id),
          total_qty     INTEGER NOT NULL DEFAULT 1 CHECK (total_qty >= 0),
          value_cents   INTEGER NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
          purchased_on  TEXT,                        -- YYYY-MM-DD
          location      TEXT,
          condition     TEXT NOT NULL DEFAULT 'good',-- good | fair | broken | lost
          note          TEXT,
          status        TEXT NOT NULL DEFAULT 'active', -- active | retired
          created_by    TEXT NOT NULL REFERENCES users(id),
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX ix_asset_items_category ON asset_items(category_id);
        CREATE INDEX ix_asset_items_status ON asset_items(status, name);

        -- 借还记录。
        --
        -- 归还用「写 returned_at」而不是删掉这条记录 —— 借还历史本身
        -- 就是这个模块存在的主要理由（"上个月那顶帐篷是谁借走的"）。
        --
        -- due_on 存日期字符串而不是时间戳：应还日期是"几号还"，不是"几点几分"，
        -- 存时间戳反而会在跨时区/跨夏令时的时候差一天。
        --
        -- 逾期状态**不存**字段：它每天都在变，存下来必然有一批数据是过期的。
        -- 查询时用 due_on < 今天 且 returned_at IS NULL 现算（见 assets.ts）。
        CREATE TABLE asset_loans (
          id                TEXT PRIMARY KEY,
          item_id           TEXT NOT NULL REFERENCES asset_items(id) ON DELETE CASCADE,
          qty               INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
          borrower_id       TEXT NOT NULL REFERENCES users(id),
          lent_at           INTEGER NOT NULL,
          due_on            TEXT,
          returned_at       INTEGER,
          returned_by       TEXT REFERENCES users(id),
          return_condition  TEXT,                    -- 归还时报的状态，与借出时对比
          purpose           TEXT,
          note              TEXT,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX ix_asset_loans_item ON asset_loans(item_id);
        CREATE INDEX ix_asset_loans_borrower ON asset_loans(borrower_id, returned_at);
        -- 部分索引：只给"没还的"建索引。未归还记录永远是少数，
        -- 而这个索引正是每次计算可用量和找逾期时都要走的那条路径。
        CREATE INDEX ix_asset_loans_open ON asset_loans(item_id) WHERE returned_at IS NULL;
        CREATE INDEX ix_asset_loans_due ON asset_loans(due_on) WHERE returned_at IS NULL;
      `)
    },

    // ---- v8: 活动/比赛归集 ----
    (d) => {
      d.exec(`
        -- 活动（比赛 / 一次活动 / 其它）。
        --
        -- 为什么要单独一张表而不是给 ledger_entries 加个自由文本的"活动名"：
        -- 用户要的是"按一个比赛或一次活动来汇总收支"，而汇总需要稳定地按活动分组。
        -- 自由文本必然出现"迎新杯" / "迎新杯比赛" / "迎新杯 " 这种同一次活动被拆成三组，
        -- 事后要人工去猜哪些该合并 —— 那正是记账最不该有的模糊地带。
        --
        -- status 只有 open / closed 两态：
        --   open   —— 进行中，可以继续往里记、往改；
        --   closed —— 已封账。比赛结算之后账目不该再被改（否则报表会随人手一变再变，
        --             而"这次比赛到底花了多少"是要写进总结的定数）。封账只冻结"写"，
        --             历史账目一条都不会删 —— 封账不是删除。
        CREATE TABLE ledger_events (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          kind        TEXT NOT NULL DEFAULT 'activity',  -- competition | activity | other
          start_on    TEXT,                              -- YYYY-MM-DD，可空
          end_on      TEXT,                              -- YYYY-MM-DD，可空
          status      TEXT NOT NULL DEFAULT 'open',      -- open | closed
          note        TEXT,
          created_by  TEXT NOT NULL REFERENCES users(id),
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          closed_at   INTEGER,
          closed_by   TEXT REFERENCES users(id)
        );
        CREATE INDEX ix_ledger_events_status ON ledger_events(status, created_at DESC);

        -- 账目归属的活动，**可空**：不归任何活动的日常账目仍然要能记
        -- （会费、水电这类不属于某一次活动的收支占大多数）。
        -- SQLite 允许 ADD COLUMN 带 REFERENCES 子句，前提是默认值为 NULL —— 正是这里的情况。
        ALTER TABLE ledger_entries ADD COLUMN event_id TEXT REFERENCES ledger_events(id);
        CREATE INDEX ix_ledger_entry_event ON ledger_entries(event_id);
      `)
    },

    // ---- v9: 借还记录可作废 ----
    (d) => {
      d.exec(`
        -- 记错了借用人 / 数量 / 日期时，最直接的"更正"是删除这条记录，
        -- 但借还历史本身就是这个模块存在的主要理由（"上个月那顶帐篷是谁借走的"），
        -- 硬删等于抹掉痕迹 —— 与"物品退役而非删除"的既有取舍不一致。
        --
        -- 所以走**作废**：记录保留、账面（可用量）不再把它算作在外，
        -- 界面把它标成"已作废"。谁作废的、什么时候，都留在行上。
        ALTER TABLE asset_loans ADD COLUMN voided_at INTEGER;
        ALTER TABLE asset_loans ADD COLUMN voided_by TEXT REFERENCES users(id);
        -- 部分索引：可用量计算只关心"没归还且没作废"的那批，索引跟着收窄。
        CREATE INDEX ix_asset_loans_voided ON asset_loans(item_id) WHERE voided_at IS NULL;
      `)
    },

    // ---- v10: 上传会话记住自己的空间（并修复存量错位数据）----
    (d) => {
      d.exec(`
        -- 上传会话原来不存 space：complete 时靠调用方从 query string 里取，
        -- 而前端完成上传时从不带 ?space= —— 于是**往个人空间上传的文件会被建成
        -- 共享空间的节点**：传进私人子目录的，两个空间里都列不出来（用户报的"看不到"）。
        -- 让会话自己记住空间，complete 以会话为准，调用方再怎么传都改不了归属。
        ALTER TABLE uploads ADD COLUMN space TEXT NOT NULL DEFAULT 'shared';

        -- 存量修复：子节点的空间必须与父节点一致（空间是树，不允许跨树挂）。
        -- 被错位成 shared 的私人文件在这一步回到私人空间、重新可见。
        UPDATE nodes
           SET space = (SELECT p.space FROM nodes p WHERE p.id = nodes.parent_id)
         WHERE parent_id IS NOT NULL
           AND space != (SELECT p.space FROM nodes p WHERE p.id = nodes.parent_id);
      `)
    },
    // ---- v11: 人机对战（象棋机器人）----
    (d) => {
      d.exec(`
        -- 机器人的座位不占 users 表：给它建一个假账号意味着它会出现在成员列表、
        -- 聊天联系人、审计的 actor 里，还会有一个谁也登不上的口令 ——
        -- 为了显示一个"电脑对手"而污染账号体系，代价太大。
        -- 所以只在这张表上记"哪一边是电脑、什么难度"，human 一方照旧占 player 列。
        ALTER TABLE game_rooms ADD COLUMN bot_side TEXT;
        ALTER TABLE game_rooms ADD COLUMN bot_level TEXT;
      `)
    },

    // ---- v12: 审计表真的不可改删 ----
    (d) => {
      d.exec(`
        -- audit.ts 的注释一直写着"在数据库层加触发器禁止 UPDATE/DELETE"，
        -- 而实际上从来没有这两个触发器 —— 承诺只存在于注释里。
        -- 补上之后，"不提供删除接口"才不只是"没写那个接口"：
        -- 任何拿到连接池的代码路径（包括以后某个手滑的 DELETE）都会被数据库挡住。
        --
        -- 局限仍然要如实说：root 能 DROP TRIGGER 再改，所以这不是防 root，
        -- 而是防"应用层出错"。真正的篡改检测靠 audit.ts 的哈希链。
        CREATE TRIGGER audit_log_no_update
        BEFORE UPDATE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is not allowed');
        END;

        CREATE TRIGGER audit_log_no_delete
        BEFORE DELETE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is not allowed');
        END;
      `)
    },

    // ---- v13: 你画我猜的对局存档 ----
    (d) => {
      d.exec(`
        -- 用户要"历史对局里能看到每个人画了什么"。
        --
        -- 为什么不塞进 game_rooms.state：那只装"当前这一局"的状态，一局结束
        -- 就该有人接管它；而"每个回合一张图"是 append-only 的存档，天然是
        -- 一张子表。也不塞进 backups —— 那是备份，不是可查询的数据。
        --
        -- strokes 存的是**回合结束时**的画布（JSON 序列化的笔画数组），
        -- 回合内的增量只走内存广播、永不落库（见 draw-rooms.ts 的说明）。
        -- 单回合点数有上限（archiveRound 里截断），一行通常几十 KB。
        CREATE TABLE draw_rounds (
          id          TEXT PRIMARY KEY,
          room_id     TEXT NOT NULL,
          round_no    INTEGER NOT NULL,
          -- 本局第几个回合（1 起，跨轮累加）。存档的唯一键用它而不是
          -- (round, drawer)：有人中途退房时 players 会变，同一个"第 2 轮
          -- 第 1 位"可能对应过不同的人。
          turn_no     INTEGER NOT NULL,
          drawer_id   TEXT NOT NULL,
          drawer_name TEXT NOT NULL,
          word        TEXT NOT NULL,
          strokes     TEXT NOT NULL,
          results     TEXT NOT NULL,
          started_at  INTEGER NOT NULL,
          ended_at    INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX ux_draw_rounds_turn ON draw_rounds(room_id, turn_no);
        CREATE INDEX ix_draw_rounds_room ON draw_rounds(room_id, turn_no);
      `)
    },

    // ---- v14: 留言板 ----
    (d) => {
      d.exec(`
        -- 用户要一块"大家都能留言吐槽、主要用来收集 bug"的地方。
        --
        -- 为什么不复用聊天：聊天是**会话**结构（一对一会拉群），消息会被
        -- 会话的成员边界切开 —— 而留言板要的是"谁都能看见同一个列表"。
        -- 也不复用 ledger/notes：那些各有各的语义，硬塞会把两件事搅在一起。
        --
        -- 一行一条留言，不做楼层/回复树：留言板的用途是"收集"，不是讨论；
        -- 管理员的"已处理"标记加一句说明就够了（resolution）。
        CREATE TABLE board_posts (
          id          TEXT PRIMARY KEY,
          author_id   TEXT NOT NULL REFERENCES users(id),
          -- bug / idea / complaint —— 主要是 bug，另外两类是顺手的
          kind        TEXT NOT NULL DEFAULT 'bug',
          body        TEXT NOT NULL,
          -- 管理员标记"已解决"时填；不删留言，只标状态（留言本身就是工单）
          resolved_at INTEGER,
          resolved_by TEXT REFERENCES users(id),
          resolution  TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX ix_board_posts_created ON board_posts(created_at DESC);
        CREATE INDEX ix_board_posts_open ON board_posts(created_at DESC) WHERE resolved_at IS NULL;
      `)
    },

    // ---- v15: 投票 / 约时间 ----
    (d) => {
      d.exec(`
        -- 社团排活动时间、决定团建去哪儿的刚需。参考 Rallly/Bitpoll 的交互
        -- （网格投票、人人可见结果），自己实现 —— 那两个分别是 AGPL/GPL，
        -- 代码不能搬，玩法本身没有许可问题。
        --
        -- 为什么不复用 board：留言板是"收集"（谁发了什么），投票是"决策"
        -- （结果聚合 + 一人一票的约束），硬塞会把两种语义搅在一起。
        CREATE TABLE polls (
          id          TEXT PRIMARY KEY,
          creator_id  TEXT NOT NULL REFERENCES users(id),
          title       TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          -- 0 = 单选（改票 = 换一项），1 = 多选（改票 = 全量替换）
          multi       INTEGER NOT NULL DEFAULT 0,
          -- 选项存 JSON 字符串数组（下标即选项 id）。社团规模（2-20 个选项、
          -- 几十人投票）用不着单独的选项表 —— 选项没有自己的生命周期，
          -- 永远跟着投票走，拆表只增加一次 JOIN。
          options     TEXT NOT NULL,
          -- 到点不能再投（null = 不限时，由创建者手动关）
          deadline_at INTEGER,
          -- 手动关闭后结果定稿；重开 = 清掉这个字段
          closed_at   INTEGER,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX ix_polls_created ON polls(created_at DESC);

        -- 一行 = 某人对某选项的一票。主键即业务约束：
        --   单选（改票时先删旧票）+ 多选（同选项不会重复插）都靠它兜底。
        CREATE TABLE poll_votes (
          poll_id    TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          user_id    TEXT NOT NULL REFERENCES users(id),
          option_idx INTEGER NOT NULL,
          voted_at   INTEGER NOT NULL,
          PRIMARY KEY (poll_id, user_id, option_idx)
        );
        CREATE INDEX ix_poll_votes_user ON poll_votes(user_id);
      `)
    },

    // ---- v16: 听歌房 ----
    (d) => {
      d.exec(`
        -- 轻量听歌房（u-wave 的 DJ 队列思路，自己实现）：全站**一个**房间，
        -- 共享播放队列。不做逐字节音频同步 —— 服务端只记"当前曲目 + 起播
        -- 时间戳"，客户端各自拉流对齐进度；误差对"大家一起听"足够了，
        -- 换来的是不用搭媒体同步服务。
        --
        -- 为什么全站一个房间：听歌房的乐趣在于"不管谁上线都在同一个厅"，
        -- 拆多房间就把人散掉了。以后真需要再多也不迟。
        CREATE TABLE music_queue (
          id         TEXT PRIMARY KEY,
          node_id    TEXT NOT NULL REFERENCES nodes(id),
          added_by   TEXT NOT NULL REFERENCES users(id),
          added_at   INTEGER NOT NULL
        );
        CREATE INDEX ix_music_queue_added ON music_queue(added_at);

        -- 当前正在播的曲目。单行表（id 恒为 1）：当前曲目是"状态"不是
        -- "队列成员"，单独放才好表达"队头被跳过 → 提升为正在播"。
        -- started_at 用来让客户端对齐进度；played_token 每次换曲自增，
        -- 客户端上报 ended 时带 token 比对，防止旧的上报错 advance 新曲。
        CREATE TABLE music_state (
          id            INTEGER PRIMARY KEY CHECK (id = 1),
          -- ON DELETE CASCADE：文件被删时这一行跟着消失（ purge 在删除前
          -- 调用会先推进到下一首，正常路径轮不到级联；这是兜底）
          node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          started_by    TEXT NOT NULL REFERENCES users(id),
          started_at    INTEGER NOT NULL,
          played_token  INTEGER NOT NULL DEFAULT 0
        );
      `)
    },

    // ---- v17: 打字练习（个人进度与错题本） ----
    (d) => {
      d.exec(`
        -- 打字背单词的个人数据。词库本身在前端（静态 JSON，随构建走），
        -- 服务端只存"练到哪了"和"错在哪"—— 两张表都是个人维度的，
        -- 没有共享语义，也就没有权限问题：一律只读写自己的行。
        --
        -- 进度按 (dict, chapter) 粒度记 position（第几个词，0 起）：
        -- 够"接着上次练"用了。整章的正确率这类统计不做 —— 错题本
        -- 已经是更有效的复习入口，统计会鼓励凑数字。
        CREATE TABLE typing_progress (
          user_id    TEXT NOT NULL REFERENCES users(id),
          dict       TEXT NOT NULL,
          chapter    INTEGER NOT NULL,
          position   INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, dict, chapter)
        );

        -- 错题本：在这个词上出过错就记一笔，重复错累加次数（排序复习用）。
        -- word 存原词而不是下标 —— 词库内容日后修订，下标会漂，原词不会。
        CREATE TABLE typing_wrong (
          user_id    TEXT NOT NULL REFERENCES users(id),
          dict       TEXT NOT NULL,
          word       TEXT NOT NULL,
          wrong_count INTEGER NOT NULL DEFAULT 1,
          last_at    INTEGER NOT NULL,
          PRIMARY KEY (user_id, dict, word)
        );
        CREATE INDEX ix_typing_wrong_user ON typing_wrong(user_id, last_at DESC);
      `)
    },

    // ---- v18: 白板 ----
    (d) => {
      d.exec(`
        -- Excalidraw 协作白板的场景存储。存 DB 而不是文件系统：场景是
        -- 小而频繁改写的 JSON（几 KB～几百 KB），文件系统的"上传会话 +
        -- 内容寻址"是为大文件设计的，每次改一笔都走一遍 sha256 是浪费。
        --
        -- 权限取最简单的模型：**全员可读、作者/管理员可写** —— 白板墙的
        -- 意义就是公开讨论，协作是"最后写入胜"（不做 OT/CRDT，见
        -- routes/whiteboard.ts 的注释），复杂权限会把轻量协作变成文档管理。
        CREATE TABLE whiteboards (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          owner_id   TEXT NOT NULL REFERENCES users(id),
          data       TEXT NOT NULL DEFAULT '{"elements":[]}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX ix_whiteboards_updated ON whiteboards(updated_at DESC);
      `)
    },

    // ---- v19: 听歌房的同步播放（暂停/继续 + 服务端权威进度） ----
    (d) => {
      d.exec(`
        -- 之前只有 started_at（起播时刻），客户端各自用本地时钟去减 ——
        -- 两台机器时钟差几秒，"同步播放"就是各听各的。加暂停态后，服务端
        -- 成为唯一的进度权威：
        --   播放中 = now - started_at
        --   暂停中 = paused_position_ms（固定值，不再随时间涨）
        -- 恢复时把 started_at 往回拨 paused_position_ms，进度就接上了。
        ALTER TABLE music_state ADD COLUMN paused_position_ms INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE music_state ADD COLUMN paused_at INTEGER;
        ALTER TABLE music_state ADD COLUMN paused_by TEXT;
      `)
    },

    // ---- v20: 听歌房的"在场成员" ----
    (d) => {
      d.exec(`
        -- 之前是"打开窗口就算在厅里"：谁都能被同步播放、都能切歌。
        -- 用户要的是显式加入 —— 自己在不在厅里应该是个明确状态。
        -- last_seen 做心跳（前端每 40s 续期），90s 没动静就算离开了
        -- （关窗口没发 leave 的僵尸靠这个清）。
        CREATE TABLE music_members (
          user_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          joined_at INTEGER NOT NULL,
          last_seen INTEGER NOT NULL
        );
        CREATE INDEX ix_music_members_seen ON music_members(last_seen DESC);
      `)
    },

    // ---- v21: 回填 last_login_at ----
    (d) => {
      d.exec(`
        -- 注册路径以前只建会话、不写 last_login_at（见 auth.ts createSession
        -- 的注释），于是"注册后一直用着会话"的用户在管理页全部显示"从未登录"。
        --
        -- 回填优先级：
        --   1. 审计里的登录 / 注册事件（最持久：登出、会话过期都不会删审计）
        --   2. 现存会话的创建时间（审计被裁剪时的兜底）
        --
        -- 只填 NULL：已有值的用户保留真实的最后登录时间，不被探测/测试会话覆盖。
        UPDATE users
           SET last_login_at = COALESCE(
             (SELECT MAX(ts) FROM audit_log
               WHERE actor_id = users.id
                 AND action IN ('login', 'register', 'bootstrap-owner')),
             (SELECT MAX(created_at) FROM sessions WHERE user_id = users.id)
           )
         WHERE last_login_at IS NULL;
      `)
    },
  ]

  // 版本号必须在**拿到写锁之后**重读，锁外那一次只是"要不要进锁"的快速判断。
  //
  // 原先只在锁外读一次，然后 BEGIN IMMEDIATE 再迁移。单实例跑一万次都不会出问题，
  // 但只要有人为了零停机起了第二个 app 容器（或者一次 `docker compose up --scale
  // app=2`），两边会同时读到 10，先拿到锁的那位迁到 11 并提交，后到的那位拿着
  // 已经过期的 10 再跑一遍 `ALTER TABLE ... ADD COLUMN`，直接撞
  // `duplicate column name` 然后启动失败 —— 而报错信息看起来像是 schema 写错了。
  //
  // 双检（锁外快速判断 + 锁内重读）比"每次启动都上写锁"好：已经是最新版本的
  // 正常启动完全不会碰写锁，不会和正在跑的业务抢锁。
  const current = readVersion()
  if (current >= migrations.length) {
    if (current > migrations.length) {
      // 库比代码新：说明用旧镜像回滚了（upgrade.sh 的 prev-<ts> 回滚路径就是这样）。
      // 这里**不能抛**，否则回滚永远起不来；但要留一条日志 —— 旧代码在新 schema 上
      // 跑可能读不到新列，那不是"没事"，只是"比起不来强"。
      console.warn(
        `[db] 数据库 schema 版本 ${current} 高于本程序支持的 ${migrations.length}，` +
          '正在用旧版本代码运行（回滚态），未做任何迁移。',
      )
    }
    return
  }

  database.exec('BEGIN IMMEDIATE')
  try {
    // 锁内重读：另一个实例可能已经替我们迁完了
    const version = readVersion()
    if (version < migrations.length) {
      for (let i = version; i < migrations.length; i++) {
        migrations[i]!(database)
      }
      database.exec('DELETE FROM schema_version')
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migrations.length)
    }
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

/** 生成一个短小的、按时间粗略有序的 id。 */
export function newId(prefix = ''): string {
  // 不用 uuid 包：node:crypto 的 randomUUID 已经够用且零依赖。
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 20)
  return prefix ? `${prefix}_${id}` : id
}

/** 当前毫秒时间戳。集中一处方便将来做时区处理。 */
export function now(): number {
  return Date.now()
}

/**
 * 在一个事务里执行 fn。嵌套调用会复用最外层事务。
 *
 * node:sqlite 没有内建的 transaction 辅助函数，手写一个能让路由代码干净很多。
 */
let txDepth = 0
export function transaction<T>(fn: () => T): T {
  const database = getDb()
  if (txDepth > 0) return fn()
  database.exec('BEGIN IMMEDIATE')
  txDepth++
  try {
    const result = fn()
    database.exec('COMMIT')
    return result
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  } finally {
    txDepth--
  }
}
