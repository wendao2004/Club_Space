#!/usr/bin/env bash
# ============================================================================
# 升级闸门：备份 → 打时间戳 tag → 构建 → 起新容器 → 验证健康 → 打印回滚命令
#
# 为什么需要这个脚本（评审 P1-6）：
#
# 1. **原来的升级命令不可回滚。** `docker compose up -d --build` 配的是固定
#    tag `wl-club/app:1`，docker 会用新镜像**覆盖**旧 tag。等发现新版本有问题，
#    旧镜像已经没有任何名字指向它了 —— 想退回上一版，唯一的办法是
#    `git checkout <旧 commit>` 再重新 build，而那时你连"上一版是哪个 commit"
#    都不一定记得。数据迁移一旦跑过，数据库也回不去了。
#
# 2. **升级前没有强制备份。** 文档里写"升级前先备份一次"，而这句是给人看的。
#    人会在赶时间的时候跳过它，然后在迁移逻辑出错时没有任何退路。
#
# 所以这里把三件事固定下来：
#   - 先备份，备份不成功就**不许**继续（`backup.sh` 自己会验证离机介质、
#     金丝雀、quick_check、blob 数量，任一不过就非零退出）；
#   - 构建前给**当前正在跑**的镜像打一个时间戳 tag，让旧版始终可指认；
#   - 新容器起来后等 `/api/health`，不健康就打印确切回滚命令并以非零退出。
#
# 用法（在 NAS 的 deploy 目录下）：
#   ./upgrade.sh
#
# 前置：`.env` 里必须有 `WL_BACKUP_TARGET`（备份目标），否则脚本拒绝升级。
#
# 逃生阀：`WL_SKIP_BACKUP=1` 跳过备份，仅用于演练/故障注入。
# 生效时会在 stderr 打醒目横幅 —— 生产误用必须在日志里一眼看见。
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"
APP_CONTAINER="wl-app"
IMAGE_REPO="wl-club/app"
HEALTH_TIMEOUT="${WL_HEALTH_TIMEOUT:-120}"
KEEP_IMAGE_TAGS="${WL_KEEP_IMAGE_TAGS:-3}"
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { printf '\n── %s ──\n' "$*"; }
die() { printf '\n[升级中止] %s\n' "$*" >&2; exit 1; }

[ -f "$COMPOSE_FILE" ] || die "找不到 $COMPOSE_FILE（请在 deploy 目录下运行）"

# docker 命令行本身要先在。不先检查的话，后面每一步都会以
# "docker: command not found" 收场，而那些报错不会告诉你在哪一步失败的。
command -v docker >/dev/null || die "找不到 docker 命令（这个脚本要在 NAS 上跑，不是在开发机上）"

# ---------------------------------------------------------------------------
# 前置检查：HOME 必须可写
#
# 这不是洁癖：`docker build` 起步时会去建 ~/.docker 存上下文与缓存，HOME 不可写
# 就中止在 **构建阶段**，报错是 `mkdir /home/admin: permission denied` ——
# 既不像权限问题（当前用户明明能写项目目录），也不提 docker，很容易被当成镜像问题。
#
# 飞牛 fnOS 上就是这样：admin 是 uid 1000 但 /home/admin 压根不存在，
# 而 /home 归 root，admin 建不了自己的家目录。这台 NAS 上第一次跑本脚本就卡在这里。
# ---------------------------------------------------------------------------
# 注意 `${HOME:-}`：脚本开了 set -u，而"HOME 根本没被设"正是要处理的形态之一
# （ssh 非交互执行、systemd 单元、cron 里都可能没有），直接写 $HOME 会在判断之前就报
# "HOME: unbound variable" 退出。
if [ ! -d "${HOME:-}" ] || [ ! -w "${HOME:-}" ]; then
  ORIGIN_HOME="${HOME:-<空>}"
  HOME="$PWD/.home"
  export HOME
  mkdir -p "$HOME" || die "HOME（$ORIGIN_HOME）不可写，兜底目录 $HOME 也建不出来"
  printf '  （HOME=%s 不可写，本次改用 %s）\n' "$ORIGIN_HOME" "$HOME"
fi

# ---------------------------------------------------------------------------
# 前置检查：站点证书必须是**文件**
#
# compose 里 app 挂了一行 `./ca/served/server.crt:/certs/server.crt:ro`，
# 只为了让 /api/health 能算出证书还剩几天（到期那天所有成员同时红屏，
# 而那时候平台本身已经打不开了）。
#
# ⚠️ 危险之处：Docker 遇到"宿主机上不存在的文件路径"时**会建一个同名目录**。
# 于是 `docker compose up` 在没有证书的机器上跑一次，`ca/served/server.crt`
# 就变成了目录 —— 之后 gen-certs.sh 里 openssl 写这个路径必然失败
# （Is a directory），而报错完全看不出根因是"某个 compose 挂载提前跑过"。
# 所以在这里拦住，而不是等它发生。
# ---------------------------------------------------------------------------
CERT_FILE="ca/served/server.crt"
if [ -d "$CERT_FILE" ]; then
  die "$CERT_FILE 是个**目录**，不是证书文件。
  成因：在没有证书的机器上先跑过 docker compose（Docker 会给缺失的挂载点建目录）。
  处理：
    rmdir '$CERT_FILE' 2>/dev/null || true
    bash ca/gen-certs.sh          # 重新生成（已有根 CA 会复用，成员无需重装）
    然后重跑本脚本。"
fi
if [ ! -f "$CERT_FILE" ]; then
  die "找不到 $CERT_FILE。
  先在有证书材料的机器上跑 bash ca/gen-certs.sh，
  并把 ca/（含 served/）同步到 NAS 的 deploy 目录。"
fi

# ---------------------------------------------------------------------------
# 前置检查：.env 权限
#
# WL_SESSION_SECRET 能伪造任意用户的会话，WL_ADMIN_RUNNER_TOKEN 能驱动持有
# docker.sock 的执行器。这些值都躺在 .env 里，而同组/其他人可读（644 是
# 很多人的默认 umask 结果）意味着**同一台 NAS 上的任何本地账号**都能读走它们。
#
# 文档里一直写着"要 chmod 600"，但那句话是给人看的。这里做成动作。
# ---------------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  ENV_MODE="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '')"
  case "$ENV_MODE" in
    '' | 400 | 600) : ;;
    *)
      if chmod 600 "$ENV_FILE" 2>/dev/null; then
        echo "  .env 权限 $ENV_MODE → 600（改前同组/其他人可读，等于会话密钥对本地账号公开）"
      else
        echo "  ⚠️ .env 权限是 $ENV_MODE（应收紧到 600），但当前用户改不动：" >&2
        echo "     sudo chmod 600 $PWD/$ENV_FILE" >&2
      fi
      ;;
  esac

  # 600 会挡住 ops-runner：它把 .env 挂进容器做 compose 变量插值（见 compose 注释），
  # 而容器里的进程是非 root 用户。真开了运维管控的话，600 + 属主不匹配 =
  # 运维页每个操作都失败，且看起来像平台 bug。所以这里必须提示，不能默默改完就走。
  if grep -qE '^[[:space:]]*WL_ADMIN_DOCKER_ENABLED[[:space:]]*=[[:space:]]*1' "$ENV_FILE"; then
    echo "  提示：WL_ADMIN_DOCKER_ENABLED=1，ops-runner 需要读 .env。"
    echo "        若运维页报 permission denied，把 .env 的属主/权限对齐给执行器容器里的用户。"
  fi
fi

# ---------------------------------------------------------------------------
# 0) 读 .env 里的备份目标
#
# 只读这一个键，不用 `source .env`：.env 里可能有带空格/引号的值，
# source 会按 shell 语义解释它们，出错的姿势比读不到更难排查。
# ---------------------------------------------------------------------------
env_value() {
  # 取 KEY=VALUE 里第一个匹配行的值，去掉可能存在的引号与行尾空白
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" 2>/dev/null \
    | tail -n 1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/' | tr -d '\r'
}

BACKUP_TARGET="${WL_BACKUP_TARGET:-$(env_value WL_BACKUP_TARGET)}"

# ---------------------------------------------------------------------------
# 1) 备份闸门
# ---------------------------------------------------------------------------
log "1/5 备份闸门"
if [ "${WL_SKIP_BACKUP:-0}" = "1" ]; then
  printf '\n  ****************************************************************\n' >&2
  printf '  *  警告：WL_SKIP_BACKUP=1 —— 本次升级**没有**备份。         *\n' >&2
  printf '  *  数据库迁移是不可逆的：出错时没有可恢复的退路。          *\n' >&2
  printf '  ****************************************************************\n\n' >&2
else
  [ -n "$BACKUP_TARGET" ] || die "WL_BACKUP_TARGET 未配置。
  .env 里填上离机备份目标（例如 WL_BACKUP_TARGET=/mnt/usb-backup），
  或明确接受风险后用 WL_SKIP_BACKUP=1 ./upgrade.sh 跳过备份。"

  # 直接调用现成的备份脚本：它自己会校验介质、金丝雀、quick_check、blob 数量，
  # 任一不过就以非零退出。这里**不做**二次判断 —— 备份是否可信只该有一个标准。
  # 用 `bash ./backup.sh` 而不是 `./backup.sh`：这个仓库里的 shell 脚本是从
  # Windows 提交的，git 里记的是 100644（没有执行位）。在 NAS 上 git pull 之后
  # `./backup.sh` 会直接报 Permission denied —— 而"升级时备份没跑"是最不该
  # 因为这种原因失败的一步。
  WL_BACKUP_TARGET="$BACKUP_TARGET" bash ./backup.sh
  echo "  备份通过（$BACKUP_TARGET）"
fi

# ---------------------------------------------------------------------------
# 2) 给当前正在跑的镜像留一个时间戳 tag
#
# 注意：容器可能根本不存在（首次部署），那种情况没有"上一版"可留，跳过即可。
# ---------------------------------------------------------------------------
log "2/5 保留当前镜像"
if docker inspect "$APP_CONTAINER" >/dev/null 2>&1; then
  PREV_ID="$(docker inspect "$APP_CONTAINER" --format '{{.Image}}')"
  PREV_TAG="prev-$STAMP"
  docker tag "$PREV_ID" "$IMAGE_REPO:$PREV_TAG"
  echo "  当前镜像 $PREV_ID → $IMAGE_REPO:$PREV_TAG"
else
  PREV_TAG=""
  echo "  没有正在运行的 $APP_CONTAINER（首次部署？），无可回滚的上一版"
fi

# ---------------------------------------------------------------------------
# 3) 构建并启动
#
# 新镜像打**时间戳 tag**，不覆盖任何已有 tag。
# 之所以把 tag 写回 .env：compose 之后任何一次 `up -d`（改 .env、重启、
# 加 profile）都会重新读 image 字段。如果 tag 只存在于本次 shell 的环境变量里，
# 下一次 `docker compose up -d` 就会去找默认 tag，悄悄切回别的镜像 ——
# 那种"回滚了半天没生效"的事故排查起来极其费劲。
# ---------------------------------------------------------------------------
log "3/5 构建并启动（新 tag: $STAMP）"
NEW_TAG="$STAMP"
WL_IMAGE_TAG="$NEW_TAG" docker compose -f "$COMPOSE_FILE" up -d --build app

if [ -f "$ENV_FILE" ]; then
  if grep -qE '^[[:space:]]*WL_IMAGE_TAG[[:space:]]*=' "$ENV_FILE"; then
    # 用 `|` 作分隔符，避免 tag 里出现 `/` 时炸掉（tag 本身不含，但规则别依赖这点）
    sed -i.bak -E "s|^[[:space:]]*WL_IMAGE_TAG[[:space:]]*=.*$|WL_IMAGE_TAG=$NEW_TAG|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  else
    printf '\n# 由 upgrade.sh 维护：当前部署的镜像 tag（回滚时改这里）\nWL_IMAGE_TAG=%s\n' "$NEW_TAG" >>"$ENV_FILE"
  fi
  echo "  已把 WL_IMAGE_TAG=$NEW_TAG 写回 $ENV_FILE"
fi

# ---------------------------------------------------------------------------
# 4) 验证新容器确实能用
#
# 用 `docker exec` 在容器内自问自答，而不是从宿主机打端口：app 不发布端口
# （只有 Caddy 能访问），宿主机上根本没有 3000 可打。
# 探的是 /api/health 而不是"/容器 Up" —— 后者只证明进程没退出，
# 而这个接口会真的写一次数据库、读一次磁盘余量、校验增量审计链。
# ---------------------------------------------------------------------------
log "4/5 等待健康检查（最多 ${HEALTH_TIMEOUT} 秒）"
healthy=0
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if ! docker inspect "$APP_CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
    echo "  容器进程已退出"
    break
  fi
  if docker exec "$APP_CONTAINER" node -e \
    "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done

rollback_hint() {
  if [ -n "$PREV_TAG" ]; then
    cat <<EOF

────────────────────────────────────────────────────────────
回滚到升级前的镜像（数据库不会自动回滚，见下）：

  WL_IMAGE_TAG=$PREV_TAG docker compose -f $COMPOSE_FILE up -d app
  # 确认起来后用下面这行把 .env 也改回去，否则下次 up -d 又会回到新版本：
  sed -i 's/^WL_IMAGE_TAG=.*/WL_IMAGE_TAG=$PREV_TAG/' $ENV_FILE

⚠️ 镜像回滚**不会**撤销数据库迁移。本项目迁移只增不改，通常旧版本能读新库；
   如果新版本写了旧版本不认识的数据，就只能从备份恢复：
     ls -1dt ${BACKUP_TARGET:-<WL_BACKUP_TARGET>}/wl-club-* | head -1   # 最近一次备份
     ./restore-drill.sh <那个目录>                   # 先演练，别直接覆盖生产
────────────────────────────────────────────────────────────
EOF
  else
    echo "  （首次部署，没有可回滚的上一版）"
  fi
}

if [ "$healthy" -ne 1 ]; then
  echo "  健康检查未通过，最近的容器日志：" >&2
  docker logs --tail 40 "$APP_CONTAINER" 2>&1 | sed 's/^/    /' >&2 || true
  rollback_hint >&2
  die "新版本不健康（或 ${HEALTH_TIMEOUT} 秒内没起来）"
fi
echo "  /api/health 返回 200"

# ---------------------------------------------------------------------------
# 5) 清理过旧的 prev-* tag
#
# 保留策略按 tag 名排序（名字里是时间戳，字典序即时间序）。
# 只删本脚本自己打的 `prev-` 前缀，绝不动 latest / 手动打的 tag。
# ---------------------------------------------------------------------------
log "5/5 清理旧镜像 tag（保留最近 ${KEEP_IMAGE_TAGS} 个 prev-*）"
old_tags="$(docker image ls "$IMAGE_REPO" --format '{{.Tag}}' \
  | grep -E '^prev-[0-9]{8}-[0-9]{6}$' | sort -r | tail -n +$((KEEP_IMAGE_TAGS + 1)) || true)"
if [ -n "$old_tags" ]; then
  while read -r tag; do
    [ -n "$tag" ] || continue
    docker image rm "$IMAGE_REPO:$tag" >/dev/null 2>&1 || echo "  跳过 $tag（仍被引用）"
    echo "  已删除 $IMAGE_REPO:$tag"
  done <<<"$old_tags"
else
  echo "  没有需要清理的旧 tag"
fi

log "升级完成（镜像 $IMAGE_REPO:$NEW_TAG）"
echo
echo "  回滚命令："
if [ -n "$PREV_TAG" ]; then
  echo "    WL_IMAGE_TAG=$PREV_TAG docker compose -f $COMPOSE_FILE up -d app"
else
  echo "    （首次部署，无可回滚版本）"
fi
echo "  当前版本：$(docker image inspect "$IMAGE_REPO:$NEW_TAG" --format '{{.Id}}' 2>/dev/null | cut -c8-19)"
echo
