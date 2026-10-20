#!/usr/bin/env bash
# ============================================================================
# 备份脚本
#
# 评审团把"pg_dump + btrfs 快照 + restic，但 restic 目标还是同一块盘"列为
# blocker —— 那不叫备份，叫同一份数据换了个位置。所以这个脚本的**第一件事**
# 就是检查离机目标是否真的在线，不在线就直接失败告警，绝不在本地悄悄生成
# 一份"假备份"让人以为有备份。
#
# 一致性：本项目的存储是**内容寻址**的（blob 以 sha256 命名，写入走
# 临时文件 + rename，永不修改），所以文件侧天然不存在"拷到一半"的撕裂问题 ——
# 一个 blob 要么完整存在、要么不存在。需要一致性快照的只有 SQLite 数据库，
# 用 VACUUM INTO 即可（它在有并发读写时也能产出事务一致的副本）。
# 这比"先 dump 库还是先拷文件"那套两难要简单得多，是选型带来的额外收益。
#
# 用法（放在 NAS 上，由 cron 或 systemd timer 调用）：
#   WL_BACKUP_TARGET=/mnt/usb-backup ./backup.sh
#   WL_BACKUP_TARGET=/mnt/usb-backup WL_RESTIC_PASSWORD_FILE=... ./backup.sh
# ============================================================================
set -euo pipefail

WL_DATA_DIR="${WL_DATA_DIR:-/vol1/docker/wl-club/data}"
WL_BACKUP_TARGET="${WL_BACKUP_TARGET:-}"
WL_BACKUP_KEEP="${WL_BACKUP_KEEP:-7}"

DB="$WL_DATA_DIR/app.sqlite"
STAMP="$(date +%Y%m%d-%H%M%S)"

alert() {
  echo "[备份告警] $*" >&2
  # 如果配了通知地址就发一条（可选）
  if [ -n "${WL_ALERT_URL:-}" ]; then
    curl -s -m 5 -X POST "$WL_ALERT_URL" -d "text=社团空间备份: $*" || true
  fi
}

# ---------------------------------------------------------------------------
# 0) 依赖自检
#
# 为什么这一步不能省：备份脚本靠 sqlite3 命令行做一致性快照（VACUUM INTO）
# 与完整性校验。而**平台本身不需要它** —— 应用在容器里用的是 Node 内置的
# node:sqlite，所以一台完全正常运行的 NAS 上很可能压根没装 sqlite3 命令行。
# 缺了它的表现是脚本在第 80 行附近报 "sqlite3: command not found" 并以 127
# 退出，而 cron 只在夜里跑，没人会看到 —— 于是"配了备份"和"有备份"之间
# 差了一个从未被发现的失败。
# ---------------------------------------------------------------------------
if ! command -v sqlite3 >/dev/null 2>&1; then
  alert "宿主机缺少 sqlite3 命令行。请先安装：sudo apt-get update && sudo apt-get install -y sqlite3"
  exit 1
fi

# ---------------------------------------------------------------------------
# 0) 硬闸门：离机目标必须在线
#
# 这一步是整份脚本存在的前提。没有它，脚本会在本地生成一份备份，
# 打印"成功"，然后在 NAS 挂掉时发现那份备份跟着一起没了。
# ---------------------------------------------------------------------------
if [ -z "$WL_BACKUP_TARGET" ]; then
  alert "未配置 WL_BACKUP_TARGET（必须是**离开 NAS 本体**的介质：外接盘 / 另一台机器 / 网络位置）"
  exit 1
fi

if [ ! -d "$WL_BACKUP_TARGET" ]; then
  alert "备份目标不存在: $WL_BACKUP_TARGET"
  exit 1
fi

# 取设备号。GNU stat 是 `-c %d`，BSD/macOS 是 `-f %d`，两个都试一遍 ——
# 备份脚本最需要跑的场合（NAS、家用小主机）恰恰最容易是"非标准 Linux"。
# 都取不到就返回空串：调用方据此**明确拒绝**，而不是把空串当成"不同设备"。
device_of() {
  stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null || true
}

# 判断某个目录**本身**是不是挂载点。返回 0=是，1=不是，2=本机没有判断工具。
#
# 为什么不用 mountpoint(1)：它对 bind mount、NFS 子目录、overlayfs 的判定
# 并不一致（比如把一个子目录 bind 过来，它可能仍认为"不是挂载点"）。
# findmnt --target 会沿路径向上找到**承载**它的那个挂载点，只有输出与传入
# 路径逐字相等，才说明它自己是挂载点而不是挂载点里的子目录。
# findmnt 不在（Git Bash、精简容器、BusyBox）时退回 mountpoint，再没有就
# 返回 2 —— 返回 2 表示"无法判断"，调用方降级为只看设备号，**不因此崩掉**：
# 少一道检查不等于没有检查，设备号不同仍然能证伪"同一块盘"。
is_mount_point() {
  _dir="${1%/}"
  if command -v findmnt >/dev/null 2>&1; then
    _mp="$(findmnt -n -o TARGET --target "$_dir" 2>/dev/null || true)"
    [ -n "$_mp" ] && [ "${_mp%/}" = "$_dir" ]
    return
  fi
  if command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q "$_dir"
    return
  fi
  return 2
}

# 逃生阀：一次性跳过"挂载点 + 设备号"两道检查。
# **只用于演练 / CI / 故障注入**。生产 cron 里出现它就是错的：它让整份脚本
# 退化回"往本地盘写一份假备份"，而那正是这份脚本要防的东西，所以一旦生效
# 就在 stderr 上大声喊出来，让人在日志里一眼看见。
if [ "${WL_BACKUP_SKIP_DEVICE_CHECK:-0}" = "1" ]; then
  echo "############################################################" >&2
  echo "#  警告：WL_BACKUP_SKIP_DEVICE_CHECK=1 已生效" >&2
  echo "#  「目标必须在独立设备上」的检查被**完全跳过**。" >&2
  echo "#  此时备份很可能与原始数据躺在同一块盘上，盘坏则一起没。" >&2
  echo "#  仅限演练/测试使用，生产环境必须去掉这个变量。" >&2
  echo "############################################################" >&2
else
  # --- 第一道：目标本身是不是挂载点 ---------------------------------------
  MOUNT_RC=0
  is_mount_point "$WL_BACKUP_TARGET" || MOUNT_RC=$?
  if [ "$MOUNT_RC" -eq 1 ]; then
    # 不是挂载点也可能是有意为之（比如指向另一台机器的 NFS 子目录）
    # 但要给出明确警示，避免"盘没插、目录还在"这种情况被当成备份成功
    if [ "${WL_BACKUP_ALLOW_UNMOUNTED:-0}" != "1" ]; then
      alert "备份目标 $WL_BACKUP_TARGET 不是一个挂载点。若是外接盘，说明盘没插上。"
      alert "确认这是有意的（例如 NFS 路径）请设置 WL_BACKUP_ALLOW_UNMOUNTED=1"
      exit 1
    fi
  elif [ "$MOUNT_RC" -eq 2 ]; then
    echo "    ! 本机没有 findmnt/mountpoint，跳过挂载点检查，仅按设备号判断" >&2
  fi

  # --- 第二道：设备号 ------------------------------------------------------
  # **"是挂载点"不等于"在另一台设备上"**。数据目录和备份目标完全可以是
  # 同一块物理盘上的两个挂载点（比如 /vol1 与 /vol1/backup），也可以是同一
  # 台 NAS 自己 NFS 导出给自己。这两种情况下挂载点检查都会通过，而备份
  # 实际上与原始数据同生共死 —— 恰恰是这整份脚本要防的那件事。
  if [ "${WL_BACKUP_ALLOW_SAME_DEVICE:-0}" != "1" ]; then
    DATA_DEV="$(device_of "$WL_DATA_DIR")"
    TARGET_DEV="$(device_of "$WL_BACKUP_TARGET")"
    if [ -z "$TARGET_DEV" ]; then
      # 取不到目标设备号 = 无法证明它独立，按失败处理（fail closed）
      alert "读不到备份目标的设备号（$WL_BACKUP_TARGET），无法确认它在独立设备上。"
      alert "演练时可用 WL_BACKUP_SKIP_DEVICE_CHECK=1 跳过；生产环境请换 Linux 宿主机。"
      exit 1
    fi
    if [ -n "$DATA_DEV" ] && [ "$DATA_DEV" = "$TARGET_DEV" ]; then
      alert "备份目标与数据目录在**同一台设备**上（设备号都是 $DATA_DEV）。"
      alert "这不是离机备份：这块盘坏掉时，数据和备份会一起没。"
      alert "请换一块物理上分开的盘，或指向另一台机器。"
      alert "确实知道自己在做什么，就设 WL_BACKUP_ALLOW_SAME_DEVICE=1 跳过这项检查。"
      exit 1
    fi
    if [ -z "$DATA_DEV" ]; then
      echo "    ! 读不到数据目录设备号，无法与目标比对，仅依赖挂载点检查" >&2
    fi
  fi
fi

# 剩余空间检查：备份撑爆目标盘会让"备份成功"变成"上次的备份被挤掉"
AVAIL_KB="$(df -Pk "$WL_BACKUP_TARGET" | awk 'NR==2 {print $4}')"
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 1048576 ]; then
  alert "备份目标剩余空间不足 1GB（当前 $((AVAIL_KB / 1024)) MB）"
  exit 1
fi

DEST="$WL_BACKUP_TARGET/wl-club-$STAMP"
mkdir -p "$DEST"
echo "==> 备份目标: $DEST"

# ---------------------------------------------------------------------------
# 1) 数据库：VACUUM INTO 产出一致性快照
# ---------------------------------------------------------------------------
if [ -f "$DB" ]; then
  echo "==> 导出数据库一致性快照"
  rm -f "$DEST/app.sqlite"
  sqlite3 "$DB" "VACUUM INTO '$DEST/app.sqlite'"

  # 断言产物非空且可读 —— 不要产出"看起来成功了"的空文件
  if [ ! -s "$DEST/app.sqlite" ]; then
    alert "数据库快照为空，备份中止"
    exit 1
  fi
  INTEGRITY="$(sqlite3 "$DEST/app.sqlite" 'PRAGMA integrity_check;' 2>&1 || echo failed)"
  if [ "$INTEGRITY" != "ok" ]; then
    alert "数据库快照完整性校验失败: $INTEGRITY"
    exit 1
  fi
  USERS="$(sqlite3 "$DEST/app.sqlite" 'SELECT COUNT(*) FROM users;' 2>/dev/null || echo 0)"
  echo "    快照完整性 ok，$USERS 个用户"
else
  alert "找不到数据库 $DB"
  exit 1
fi

# ---------------------------------------------------------------------------
# 2) 审计链头锚定
#
# 单独把"当前链头"记到备份目录外的一个只追加文件里。
# 这样即使 NAS 被入侵、审计记录被删并重算整条链，只要拿这份历史链头去比对，
# 就能发现某一段被改过 —— 这是"可检测的不可篡改"里"可检测"那一半。
# ---------------------------------------------------------------------------
echo "==> 锚定审计链头"
sqlite3 "$DB" "SELECT seq || ' ' || hash FROM audit_log ORDER BY seq DESC LIMIT 1;" \
  >> "$WL_BACKUP_TARGET/audit-anchors.txt"
tail -1 "$WL_BACKUP_TARGET/audit-anchors.txt" | sed 's/^/    链头: /'

# ---------------------------------------------------------------------------
# 3) 文件内容
#
# blobs 是内容寻址且不可变的，所以用 rsync 增量同步即可 —— 已经同步过的
# 文件不会变，只需传新增的。--delete 关掉：宁可多留，也不要因为一次误操作
# 把备份侧的内容删掉。
# ---------------------------------------------------------------------------
# 目录**无条件**创建：恢复演练会检查这个目录是否存在，缺了就判定"备份不可用"。
# 而平台刚部署、还没人上传过任何文件时，源目录本来就不存在 ——
# 一份内容完全正确的空备份会被误判成坏的。
mkdir -p "$DEST/blobs"

# 统计目录下的普通文件数（目录不存在按 0 算）。
# 用普通文件数而不用 `du -s`：blobs 是每对象一个文件，份数就是对象数，
# 比字节数更容易在日志里读出"少了多少个"，也不受块大小/稀疏文件影响。
count_blobs() {
  if [ -d "$1" ]; then
    # find 失败（权限不足等）按 0 计，但不要因此让 set -e 把脚本打断 ——
    # 数量对不上时自然会在下面的比对里失败，失败要有告警可读，而不是静默退出。
    { find "$1" -type f 2>/dev/null || true; } | wc -l | tr -d ' '
  else
    echo 0
  fi
}

SRC_BLOBS="$WL_DATA_DIR/files/blobs"
SRC_BLOB_COUNT=0
DEST_BLOB_COUNT=0

if [ -d "$SRC_BLOBS" ]; then
  echo "==> 同步文件内容（内容寻址，增量）"
  SRC_BLOB_COUNT="$(count_blobs "$SRC_BLOBS")"

  # 同步**必须可失败**。这里原本是
  #   rsync ... 2>/dev/null || cp -rn ... 2>/dev/null || true
  # 最后那个 `|| true` 会把"rsync 和 cp 都失败"变成"同步成功"，脚本接着往下
  # 打印"备份完成"——盘满、目标只读、线掉了，全都会得到一份看起来正常、
  # 实际缺内容的备份。这正是"假成功"，比没有备份更危险：它会让人放心地
  # 删掉唯一还好的旧备份（见第 6 步）。
  # 现在的顺序是：rsync 成功就结束；rsync 失败（或没装）才用 cp 兜底；
  # 两者都失败就告警退出。stderr 不再丢进 /dev/null —— 失败原因要留在日志里。
  SYNC_OK=0
  if command -v rsync >/dev/null 2>&1; then
    if rsync -a --ignore-existing "$SRC_BLOBS/" "$DEST/blobs/"; then
      SYNC_OK=1
    else
      echo "    rsync 失败，改用 cp 兜底重试" >&2
    fi
  else
    echo "    ! 本机没有 rsync，直接用 cp 同步（慢，且不能续传）" >&2
  fi

  if [ "$SYNC_OK" -ne 1 ]; then
    if cp -rn "$SRC_BLOBS/." "$DEST/blobs/"; then
      SYNC_OK=1
    fi
  fi

  if [ "$SYNC_OK" -ne 1 ]; then
    alert "内容对象同步失败：rsync 与 cp 都未能完成（$SRC_BLOBS -> $DEST/blobs）"
    alert "本次备份不完整，已中止；**旧备份保持原样**，仍可用于恢复。"
    exit 1
  fi

  # 同步后一致性校验：命令返回 0 不代表数据到位（信号中断、部分写、目标是
  # 只读但 cp 对已存在的文件静默跳过……都可能返回 0）。用对象数做一次
  # 方向明确的核对：--ignore-existing 是增量语义，目标侧可能已有上次备份
  # 留下的对象，所以只可能是"目标数 >= 源数"；一旦少于源数，说明这次没同步全。
  DEST_BLOB_COUNT="$(count_blobs "$DEST/blobs")"
  if [ "$DEST_BLOB_COUNT" -lt "$SRC_BLOB_COUNT" ]; then
    alert "同步不完整：源 ${SRC_BLOB_COUNT} 个 / 目标 ${DEST_BLOB_COUNT} 个"
    alert "本次备份不完整，已中止；**旧备份保持原样**，仍可用于恢复。"
    exit 1
  fi
  echo "    已同步 $DEST_BLOB_COUNT 个内容对象（源 $SRC_BLOB_COUNT 个）"
fi

# ---------------------------------------------------------------------------
# 4) 配置与记录（密钥不进备份）
#
# .env 里有会话密钥，**不备份**。恢复时重新生成即可（代价只是所有人重新登录一次）。
# 备份里带密钥等于把"拿到备份盘"变成"拿到全部凭据"。
# ---------------------------------------------------------------------------
echo "==> 记录配置摘要"
{
  echo "# 备份时间: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "# 数据目录: $WL_DATA_DIR"
  echo "# 站点名称: ${WL_SITE_NAME:-未设置}"
  echo "# 应用版本: 1"
  echo "# 数据库 schema 版本: $(sqlite3 "$DB" 'SELECT version FROM schema_version;' 2>/dev/null || echo '?')"
  echo "# 存储对象数: $(sqlite3 "$DB" 'SELECT COUNT(*) FROM blobs;' 2>/dev/null || echo '?')"
  echo "# 文件节点数: $(sqlite3 "$DB" "SELECT COUNT(*) FROM nodes WHERE kind='file' AND deleted_at IS NULL;" 2>/dev/null || echo '?')"
  echo "# 审计记录数: $(sqlite3 "$DB" 'SELECT COUNT(*) FROM audit_log;' 2>/dev/null || echo '?')"
  echo "# 注意: .env 未包含在此备份中（含会话密钥），恢复后需重新生成"
} > "$DEST/README.txt"

# ---------------------------------------------------------------------------
# 5) 金丝雀：供恢复演练逐字节比对
# ---------------------------------------------------------------------------
CANARY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
echo "$STAMP $CANARY" >> "$DEST/canary.txt"
cp "$DEST/canary.txt" "$WL_BACKUP_TARGET/canary-history.txt" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 6) 轮转前自检 —— 确认这一份**能用**，再删旧的
#
# 为什么顺序不能反：轮转是这份脚本里唯一会**销毁**数据的地方。它的存在意义
# 是"给新备份腾位置"，前提是新备份确实写成了。如果本次备份是坏的而轮转照做，
# 结果就是那一夜之间既没有新备份、也没了旧的 —— 一次故障变成永久数据丢失。
# 所以先对 $DEST 做三项独立检查，全过才允许删任何东西；任一项不过就告警退出，
# 并且**故意保留**这份坏备份在原地，方便第二天排查到底坏在哪。
#
# 三项检查都针对"我们以为写好了、其实没写好"的具体形态：
#   - 金丝雀内容不符 → 写到了别的目录、或文件被别的进程覆盖（比如两次 cron 重叠）
#   - 库打不开/quick_check 不 ok → 快照是截断的、介质有坏块
#   - blob 数少于源 → 同步只做了一半（第 3 步已经查过一次，这里再查是防
#     两次检查之间磁盘写失败）
# ---------------------------------------------------------------------------
echo "==> 轮转前自检"
SELF_CHECK_FAIL=0

EXPECT_CANARY="$STAMP $CANARY"
ACTUAL_CANARY="$(cat "$DEST/canary.txt" 2>/dev/null || true)"
if [ "$ACTUAL_CANARY" != "$EXPECT_CANARY" ]; then
  alert "自检失败：canary.txt 内容不符（期望「$EXPECT_CANARY」，实际「$ACTUAL_CANARY」）"
  SELF_CHECK_FAIL=1
fi

if [ ! -s "$DEST/app.sqlite" ]; then
  alert "自检失败：$DEST/app.sqlite 不存在或为空"
  SELF_CHECK_FAIL=1
else
  # quick_check 比 integrity_check 快一个量级，用于"刚写完、马上就删旧备份"
  # 这个时间点足够了：它能抓到页结构损坏与索引/表不一致。
  QUICK_CHECK="$(sqlite3 "$DEST/app.sqlite" 'PRAGMA quick_check;' 2>&1 || echo failed)"
  if [ "$QUICK_CHECK" != "ok" ]; then
    alert "自检失败：备份库 quick_check 未通过（$QUICK_CHECK）"
    SELF_CHECK_FAIL=1
  fi
fi

FINAL_BLOB_COUNT="$(count_blobs "$DEST/blobs")"
if [ "$FINAL_BLOB_COUNT" -lt "$SRC_BLOB_COUNT" ]; then
  alert "自检失败：blob 数量不足（源 $SRC_BLOB_COUNT 个 / 目标 $FINAL_BLOB_COUNT 个）"
  SELF_CHECK_FAIL=1
fi

if [ "$SELF_CHECK_FAIL" -ne 0 ]; then
  alert "本次备份未通过轮转前自检，**不执行保留策略**，旧备份全部保留。"
  alert "坏掉的这一份留在 $DEST 供排查，修好原因后手动删除即可。"
  exit 1
fi
echo "    金丝雀、数据库 quick_check、blob 数量（$FINAL_BLOB_COUNT）均通过"

# ---------------------------------------------------------------------------
# 7) 保留策略（只在自检通过后才会走到这里）
# ---------------------------------------------------------------------------
echo "==> 清理过期备份（保留最近 $WL_BACKUP_KEEP 份）"
ls -1dt "$WL_BACKUP_TARGET"/wl-club-* 2>/dev/null | tail -n +$((WL_BACKUP_KEEP + 1)) | while read -r old; do
  # 双保险：只删形如 wl-club-<时间戳> 的目录，且绝不删本次刚写的 $DEST
  case "$old" in
    "$WL_BACKUP_TARGET"/wl-club-[0-9]*) ;;
    *) echo "    跳过（不是备份目录）: $old"; continue ;;
  esac
  if [ "$old" = "$DEST" ]; then
    continue
  fi
  echo "    删除 $old"
  rm -rf "$old"
done

# 同步落盘，然后提示可以安全拔出
sync

echo
echo "==> 备份完成: $DEST"
echo "    金丝雀: $CANARY"
echo
echo "    恢复演练（**没演练过的备份不算备份**）:"
echo "      ./restore-drill.sh $DEST"
echo

# 若挂载的是可移除介质，这里可以自动卸载：
#   udisksctl power-off -b /dev/sdX
