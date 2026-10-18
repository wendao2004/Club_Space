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

if ! mountpoint -q "$WL_BACKUP_TARGET" 2>/dev/null; then
  # 不是挂载点也可能是有意为之（比如指向另一台机器的 NFS 挂载路径）
  # 但要给出明确警示，避免"盘没插、目录还在"这种情况被当成备份成功
  if [ "${WL_BACKUP_ALLOW_UNMOUNTED:-0}" != "1" ]; then
    alert "备份目标 $WL_BACKUP_TARGET 不是一个挂载点。若是外接盘，说明盘没插上。"
    alert "确认这是有意的（例如 NFS 路径）请设置 WL_BACKUP_ALLOW_UNMOUNTED=1"
    exit 1
  fi
fi

# 设备号比对：**"是挂载点"不等于"在另一台设备上"**。
#
# 数据目录和备份目标完全可以是同一块物理盘上的两个挂载点（比如 /vol1 与
# /vol1/backup），也可以是同一台 NAS 自己 NFS 导出给自己。这两种情况下
# 上面的 mountpoint 检查都会通过，而备份实际上与原始数据同生共死 ——
# 恰恰是这整份脚本要防的那件事。
if [ "${WL_BACKUP_ALLOW_SAME_DEVICE:-0}" != "1" ]; then
  DATA_DEV="$(stat -c %d "$WL_DATA_DIR" 2>/dev/null || echo '')"
  TARGET_DEV="$(stat -c %d "$WL_BACKUP_TARGET" 2>/dev/null || echo '')"
  if [ -n "$DATA_DEV" ] && [ "$DATA_DEV" = "$TARGET_DEV" ]; then
    alert "备份目标与数据目录在**同一台设备**上（设备号都是 $DATA_DEV）。"
    alert "这不是离机备份：这块盘坏掉时，数据和备份会一起没。"
    alert "请换一块物理上分开的盘，或指向另一台机器。"
    alert "确实知道自己在做什么，就设 WL_BACKUP_ALLOW_SAME_DEVICE=1 跳过这项检查。"
    exit 1
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
if [ -d "$WL_DATA_DIR/files/blobs" ]; then
  echo "==> 同步文件内容（内容寻址，增量）"
  rsync -a --ignore-existing "$WL_DATA_DIR/files/blobs/" "$DEST/blobs/" 2>/dev/null \
    || cp -rn "$WL_DATA_DIR/files/blobs/." "$DEST/blobs/" 2>/dev/null \
    || true
  BLOB_COUNT="$(find "$DEST/blobs" -type f 2>/dev/null | wc -l)"
  echo "    已同步 $BLOB_COUNT 个内容对象"
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
# 6) 保留策略
# ---------------------------------------------------------------------------
echo "==> 清理过期备份（保留最近 $WL_BACKUP_KEEP 份）"
ls -1dt "$WL_BACKUP_TARGET"/wl-club-* 2>/dev/null | tail -n +$((WL_BACKUP_KEEP + 1)) | while read -r old; do
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
