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
  db = new DatabaseSync(DB_PATH)
  // WAL：读写不互相阻塞；NORMAL 同步在 WAL 下已能抵御应用崩溃。
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
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

  const row = database.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined
  let version = row?.version ?? 0

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
  ]

  if (version < migrations.length) {
    database.exec('BEGIN IMMEDIATE')
    try {
      for (let i = version; i < migrations.length; i++) {
        migrations[i]!(database)
      }
      version = migrations.length
      database.exec('DELETE FROM schema_version')
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version)
      database.exec('COMMIT')
    } catch (err) {
      database.exec('ROLLBACK')
      throw err
    }
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
