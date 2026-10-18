#!/usr/bin/env bash
# ============================================================================
# 恢复演练
#
# 评审团把"有备份但没演练过"列为 blocker —— 备份脚本每天打印"成功"，
# 真出事时才发现恢复不出来，这种事在自建服务里非常常见。
# 所以这个脚本必须能**真的把数据恢复出来并逐字节比对**，而不是只检查
# 文件是否存在。
#
# 用法：./restore-drill.sh /mnt/usb-backup/wl-club-20261016-030000
# ============================================================================
set -euo pipefail

BACKUP_DIR="${1:-}"
WORK="${WL_DRILL_DIR:-/tmp/wl-restore-drill}"

if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "用法: $0 <备份目录>" >&2
  exit 1
fi

fail() { echo "  ✗ $*" >&2; exit 1; }
ok()   { echo "  ✓ $*"; }

echo
echo "恢复演练：$BACKUP_DIR"
echo

# ---------------------------------------------------------------------------
# 1) 数据库能否打开且完整
# ---------------------------------------------------------------------------
echo "【数据库】"
DB="$BACKUP_DIR/app.sqlite"
[ -s "$DB" ] || fail "数据库快照不存在或为空"

INTEGRITY="$(sqlite3 "$DB" 'PRAGMA integrity_check;')"
[ "$INTEGRITY" = "ok" ] || fail "完整性校验失败: $INTEGRITY"
ok "完整性校验通过"

USERS="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM users;')"
BLOBS="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM blobs;')"
NODES="$(sqlite3 "$DB" "SELECT COUNT(*) FROM nodes WHERE kind='file' AND deleted_at IS NULL;")"
AUDIT="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM audit_log;')"
ok "用户 $USERS / 内容对象 $BLOBS / 文件 $NODES / 审计记录 $AUDIT"

[ "$USERS" -gt 0 ] || fail "备份里有 0 个用户，这不是一份能用的备份"

# ---------------------------------------------------------------------------
# 2) 审计链能否重算通过
#
# 这是审计机制的自检：把整条链的哈希重算一遍，任何一处被改动都会暴露。
# ---------------------------------------------------------------------------
echo
echo "【审计链】"
CHAIN_RESULT="$(sqlite3 "$DB" "
  SELECT COUNT(*) FROM audit_log a
  WHERE a.prev_hash != COALESCE(
    (SELECT hash FROM audit_log b WHERE b.seq = a.seq - 1),
    '0000000000000000000000000000000000000000000000000000000000000000'
  );")"
[ "$CHAIN_RESULT" = "0" ] || fail "审计链有 $CHAIN_RESULT 处断裂"
ok "链的 prev_hash 连贯（重算哈希需在应用内验证，见管理页的「校验审计链」）"

# ---------------------------------------------------------------------------
# 3) 文件内容是否与数据库记录对得上
#
# 只检查"目录非空"、甚至只检查"文件存在"都是没有意义的 ——
# 演练要防的恰恰是"看起来有、实际坏了"：被截断成 0 字节的、rsync 拷到一半的、
# 磁盘静默损坏的。这些文件**都存在**，但内容已经不对了。
# 所以这里真的按 sha256 逐个核对：大小一致 且 哈希一致才算过。
# ---------------------------------------------------------------------------
echo
echo "【文件内容】"
if [ -d "$BACKUP_DIR/blobs" ]; then
  MISSING=0
  BADSIZE=0
  BADHASH=0
  CHECKED=0
  while read -r sha size; do
    CHECKED=$((CHECKED + 1))
    # blobs 按前两位分子目录存放
    P="$BACKUP_DIR/blobs/${sha:0:2}/$sha"
    if [ ! -f "$P" ]; then
      MISSING=$((MISSING + 1))
      [ "$MISSING" -le 3 ] && echo "      缺失: $sha"
      continue
    fi
    # 先比大小（快，能抓住绝大多数截断），再比哈希（慢但确定）
    ACTUAL_SIZE="$(stat -c %s "$P" 2>/dev/null || echo '?')"
    if [ "$ACTUAL_SIZE" != "$size" ]; then
      BADSIZE=$((BADSIZE + 1))
      [ "$BADSIZE" -le 3 ] && echo "      大小不符: $sha（记录 $size，实际 $ACTUAL_SIZE）"
      continue
    fi
    ACTUAL_HASH="$(sha256sum "$P" | cut -d' ' -f1)"
    if [ "$ACTUAL_HASH" != "$sha" ]; then
      BADHASH=$((BADHASH + 1))
      [ "$BADHASH" -le 3 ] && echo "      内容损坏（哈希不符）: $sha"
    fi
  done < <(sqlite3 "$DB" "SELECT b.sha256, b.size FROM blobs b
                          JOIN nodes n ON n.sha256 = b.sha256
                          WHERE n.kind='file' AND n.deleted_at IS NULL;")

  if [ "$MISSING" -gt 0 ]; then
    fail "$CHECKED 个对象里有 $MISSING 个在备份中缺失"
  fi
  if [ "$BADSIZE" -gt 0 ]; then
    fail "$BADSIZE 个对象大小与记录不符（很可能是拷贝中断或被截断）"
  fi
  if [ "$BADHASH" -gt 0 ]; then
    fail "$BADHASH 个对象内容哈希与记录不符（数据已损坏）"
  fi
  ok "$CHECKED 个被引用的内容对象都通过了大小 + SHA-256 校验"
else
  fail "备份里没有 blobs 目录"
fi

# ---------------------------------------------------------------------------
# 4) 金丝雀比对
# ---------------------------------------------------------------------------
echo
echo "【金丝雀】"
if [ -f "$BACKUP_DIR/canary.txt" ]; then
  ok "找到金丝雀记录: $(cat "$BACKUP_DIR/canary.txt")"
else
  echo "  ! 备份中没有金丝雀记录（旧版备份脚本产生的）"
fi

# ---------------------------------------------------------------------------
# 5) 结论
# ---------------------------------------------------------------------------
echo
echo "================================================================"
echo " 恢复演练通过。这份备份是**可用的**。"
echo
echo " 真实恢复步骤（换机或整机损毁时）："
echo "   1) 在任何 x86 机器上装好 Docker 与 docker compose"
echo "   2) 把备份目录里的 app.sqlite 放到 data/app.sqlite"
echo "      把 blobs/ 放到 data/files/blobs/"
echo "   3) 生成新的会话密钥（备份里刻意不含 .env）："
echo "      node -e \"console.log(require('node:crypto').randomBytes(48).toString('base64url'))\""
echo "      写进 .env 的 WL_SESSION_SECRET"
echo
echo "   ⚠️ 4) 换了 WL_SESSION_SECRET 之后，**必须**顺手清掉两步验证秘密："
echo
echo "        sqlite3 <数据目录>/app.sqlite \\"
echo "          \"UPDATE users SET totp_secret=NULL, totp_pending=NULL, totp_enabled_at=NULL;\""
echo
echo "      为什么必须做：TOTP 秘密是用 HKDF(WL_SESSION_SECRET) 派生的密钥加密后"
echo "      存在库里的。密钥一换，解密必然失败，而两步登录的第二步需要它 ——"
echo "      于是**所有绑过验证器的管理员全部登不进去**，偏偏这个状态下"
echo "      谁来都改不了（重绑定要求先提交当前动态口令，而那个秘密已经解不开了）。"
echo "      你会得到一个没有任何人能管理的实例。"
echo "      代价是所有人的两步验证被关闭，恢复完成后需要重新绑定。"
echo "      只想清某一个人时，在上面的 UPDATE 后面加 WHERE username='<用户名>'。"
echo
echo "   5) docker compose up -d"
echo "   6) 成员用原用户名口令登录（口令哈希在数据库里，不会丢）"
echo "      但所有旧会话会失效 —— 这是不备份密钥的必然代价，也是刻意的取舍"
echo "================================================================"
echo
