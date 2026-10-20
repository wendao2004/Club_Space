#!/usr/bin/env bash
#
# 生产镜像冒烟：把镜像真的跑起来，确认"生产的启动路径"是活的。
#
# 为什么不能只靠 `pnpm test`：
#   - 测试套件用 `node scripts/run-all-tests.mjs` 自己 spawn 子进程
#     （cwd=server，命令 `node src/index.ts`），跑的是**工作区源码**；
#   - 生产的启动路径是镜像里的 CMD：`node --max-old-space-size=384 server/src/index.ts`
#     （见 deploy/Dockerfile 末尾），工作目录 /app、USER app、NODE_ENV=production。
# 两者之间能出问题的地方（COPY 漏文件、/data 不可写、生产必需的环境变量、
# CMD 写错、静态资源没进镜像）只有在容器里才能暴露。
#
# 用法：
#   container-smoke.sh inspect <image>
#   container-smoke.sh smoke   <image> [host-port]
#
# 依赖：docker、curl、python3（ubuntu-latest 自带）。
# 本机没有 Docker，所以这个脚本只能在 CI / 有 Docker 的机器上跑。

set -euo pipefail

IMAGE="${2:-}"
HOST_PORT="${3:-3494}"
# 等健康检查的上限。给慢机器留余量；本地验证脚本分支时可以调小。
HEALTH_TIMEOUT="${SMOKE_HEALTH_TIMEOUT:-90}"
CONTAINER="wl-smoke-$$"
BASE_DIR="${RUNNER_TEMP:-/tmp}"

log() { printf '\n── %s ──\n' "$*"; }
die() { printf '::error::%s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

[ -n "$IMAGE" ] || usage
command -v docker >/dev/null || die "本机没有 docker，这个脚本只能在有 Docker 的环境运行"

# ---------------------------------------------------------------------------
# inspect：镜像元数据必须与"生产启动命令只有一处"的约定一致
# ---------------------------------------------------------------------------
inspect_image() {
  log "镜像元数据（$IMAGE）"
  docker image inspect "$IMAGE" --format \
    'CMD={{json .Config.Cmd}}
USER={{.Config.User}}
WORKDIR={{.Config.WorkingDir}}
EXPOSE={{json .Config.ExposedPorts}}
HEALTHCHECK={{if .Config.Healthcheck}}present{{else}}missing{{end}}'

  local cmd user workdir health ports
  cmd=$(docker image inspect "$IMAGE" --format '{{json .Config.Cmd}}')
  user=$(docker image inspect "$IMAGE" --format '{{.Config.User}}')
  workdir=$(docker image inspect "$IMAGE" --format '{{.Config.WorkingDir}}')
  health=$(docker image inspect "$IMAGE" --format '{{if .Config.Healthcheck}}present{{else}}missing{{end}}')
  ports=$(docker image inspect "$IMAGE" --format '{{json .Config.ExposedPorts}}')

  # CMD 的最后一个参数就是入口文件。不整体字符串比对，是因为内存上限
  # （--max-old-space-size）属于可调策略，而"入口指向 server/src/index.ts"
  # 才是不能漂的契约。
  [[ "$cmd" == *'"server/src/index.ts"'* ]] \
    || die "镜像 CMD 没有指向 server/src/index.ts：${cmd}"

  # 以 root 跑等于把用户上传的解析面暴露成 root，Dockerfile 明确要求非 root。
  [[ -n "$user" && "$user" != "root" && "$user" != "0" ]] \
    || die "镜像以 root 运行（USER='${user}'）"
  [[ "$workdir" == "/app" ]] || die "镜像 WORKDIR 应为 /app，实际 '${workdir}'"
  [[ "$ports" == *"3000/tcp"* ]] || die "镜像没有 EXPOSE 3000：${ports}"
  [[ "$health" == "present" ]] \
    || die "镜像没有 HEALTHCHECK —— 编排层与看板就失去了唯一的探活依据"

  # 基础镜像必须是 Node 24：CI 的 Job 1 用 24，镜像若还是 22，
  # "本地/CI 过、生产挂"的裂缝就又回来了。
  local node_version
  node_version=$(docker run --rm --entrypoint node "$IMAGE" --version)
  [[ "$node_version" == v24.* ]] \
    || die "镜像里的 Node 是 ${node_version}，期望 v24.x（与 CI 的 NODE_VERSION 一致）"

  log "元数据校验通过（Node ${node_version}，USER ${user}，EXPOSE 3000，HEALTHCHECK 存在）"
}

# ---------------------------------------------------------------------------
# 诊断输出：容器起不来时必须给出"为什么"，而不是一个 404/超时
# ---------------------------------------------------------------------------
diagnostics() {
  log "docker inspect"
  docker inspect "$CONTAINER" --format \
    'Status={{.State.Status}} ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}} RestartCount={{.RestartCount}} Health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' \
    2>/dev/null || echo "(容器不存在)"
  log "docker logs（最后 50 行）"
  docker logs "$CONTAINER" 2>&1 | tail -n 50 || echo "(没有日志)"
}

# ---------------------------------------------------------------------------
# smoke：不覆盖 CMD，用镜像自带的启动命令起容器
# ---------------------------------------------------------------------------
smoke() {
  local data_dir body
  data_dir=$(mktemp -d "${BASE_DIR}/wl-smoke-data.XXXXXX")
  body=$(mktemp "${BASE_DIR}/wl-smoke-body.XXXXXX")

  # 注意：trap 在函数返回之后才触发，那时 local 已经出栈，所以这里必须带默认值，
  # 否则 `set -u` 会让"冒烟成功"也以 1 退出（踩过一次）。
  cleanup() {
    docker logs "$CONTAINER" >"${BASE_DIR}/wl-smoke-container.log" 2>&1 || true
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "${data_dir:-}" "${body:-}"
  }
  trap cleanup EXIT

  # 生产用的是绑定挂载（compose: ${WL_DATA_DIR}:/data），这里照抄这个形态。
  # 容器内以 uid 10001 运行，宿主机目录要可写 —— 生产由部署脚本对齐权限，
  # CI 里直接放宽，避免把"宿主机 uid"这种与本次验证无关的变量引进来。
  chmod 0777 "$data_dir"

  log "启动容器（不覆盖 CMD）"
  docker run --detach \
    --name "$CONTAINER" \
    --publish "127.0.0.1:${HOST_PORT}:3000" \
    --volume "${data_dir}:/data" \
    --env "WL_SESSION_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n')" \
    "$IMAGE" >/dev/null
  echo "容器 ${CONTAINER} 已创建，端口 127.0.0.1:${HOST_PORT} -> 3000"

  # ---- 等 /api/health ------------------------------------------------------
  #
  # 关键区别（项目里的 health 会在磁盘/数据库异常时返回 503）：
  #   连不上 / 000/502 → 还没监听，或进程崩了 → 继续等，超时算"没起来"
  #   503              → **进程活着但自检不通过** → 继续等（启动初期允许），
  #                      超时则报"活着但降级"，而不是误报成"起不来"
  #   200              → 就绪
  #   其它（404/500）  → 立刻失败：进程在，但跑的不是这个应用
  log "等待 /api/health（最多 ${HEALTH_TIMEOUT} 秒）"
  local status="" code deadline=$((SECONDS + HEALTH_TIMEOUT)) last_body=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null || echo false)" != "true" ]; then
      diagnostics
      die "容器进程已退出（根本没起来），见上面的 CMD/日志"
    fi
    code=$(curl --noproxy "*" --silent --output "$body" --write-out '%{http_code}' \
      --max-time 5 "http://127.0.0.1:${HOST_PORT}/api/health" || true)
    case "$code" in
      200)
        status=ok
        break
        ;;
      503)
        status=degraded
        last_body=$(cat "$body" 2>/dev/null || true)
        printf '  503（进程活着、自检不通过），继续等…\n'
        sleep 2
        ;;
      000|502|"")
        # 000 = 连不上；502 = 环境里配了代理、代理替我们拒绝了连接
        # （本机验证时就遇到过，代理会把 connection refused 包装成 502）。
        # 两者都只说明"还没监听"，继续等。
        sleep 1
        ;;
      *)
        diagnostics
        die "GET /api/health 返回了意外的状态码 ${code}（进程在，但不像这个应用）"
        ;;
    esac
  done

  if [ "$status" = "degraded" ]; then
    printf '\n健康检查持续 503 的响应体：\n%s\n' "$last_body"
    diagnostics
    die "容器活着，但 /api/health 在 ${HEALTH_TIMEOUT} 秒内一直 503（数据目录不可写 / 磁盘余量不足 / 数据库探针失败）"
  fi
  [ "$status" = "ok" ] || { diagnostics; die "${HEALTH_TIMEOUT} 秒内 /api/health 没有任何响应（监听失败或启动即崩）"; }

  curl --noproxy "*" --silent --output "$body" "http://127.0.0.1:${HOST_PORT}/api/health"
  python3 - "$body" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
def need(cond, msg):
    if not cond:
        raise SystemExit('::error::' + msg)
need(d.get('ok') is True, 'health.ok 不是 true: %r' % (d.get('ok'),))
need((d.get('db') or {}).get('ok') is True, '数据库探针失败: %r' % (d.get('db'),))
need((d.get('disk') or {}).get('ok') is True, '磁盘探针失败: %r' % (d.get('disk'),))
need((d.get('audit') or {}).get('chainOk') is True, '审计链校验失败: %r' % (d.get('audit'),))
disk = d['disk']
print('  health 200 · db.ok=True · disk.free=%sMB · chainOk=True'
      % round(disk.get('freeBytes', -1) / 1024 / 1024))
PY

  # ---- /api/bootstrap ------------------------------------------------------
  # 这个接口会真的读库（firstRun 来自 userCount()），因此它同时证明了
  # "数据库建好并且可读"，而不只是"HTTP 进程在监听"。
  log "GET /api/bootstrap"
  code=$(curl --noproxy "*" --silent --output "$body" --write-out '%{http_code}' \
    --max-time 10 "http://127.0.0.1:${HOST_PORT}/api/bootstrap" || true)
  [ "$code" = "200" ] || { cat "$body"; diagnostics; die "/api/bootstrap 返回 ${code}"; }
  python3 - "$body" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
def need(cond, msg):
    if not cond:
        raise SystemExit('::error::' + msg)
need(bool(d.get('siteName')), 'bootstrap.siteName 为空: %r' % (d.get('siteName'),))
need(d.get('firstRun') is True, '全新数据目录应当 firstRun=true，实际 %r' % (d.get('firstRun'),))
need(d.get('user') is None, '未登录请求不应返回用户: %r' % (d.get('user'),))
print('  bootstrap 200 · siteName=%s · firstRun=true' % d['siteName'])
PY

  # ---- 静态前端 ------------------------------------------------------------
  # 镜像里 web/dist 是 `COPY --from=build` 来的。没拷进来的话 `/` 会 404，
  # 而 /api/* 全都正常 —— 这种"API 好的、页面白屏"用接口测试是抓不到的。
  log "GET /（web/dist 是否真的进了镜像）"
  curl --noproxy "*" --silent --fail "http://127.0.0.1:${HOST_PORT}/" | grep -q '<div id="app"' \
    || { diagnostics; die "根路径没有返回前端外壳（web/dist 没进镜像，或静态服务没挂载）"; }
  echo "  前端外壳正常返回"

  # ---- 数据目录可写 --------------------------------------------------------
  # 以容器内的运行用户（app，uid 10001）真的写一个文件。
  # 只做 statfs/健康检查是不够的：health 的磁盘探针在 statfs 失败时也返回 ok。
  log "/data 可写性（以容器内运行用户）"
  docker exec "$CONTAINER" sh -c 'test -d /data/files && test -d /data/tmp' \
    || { diagnostics; die "数据子目录不存在：ensureDirs() 没能创建 /data/{files,tmp}"; }
  docker exec "$CONTAINER" sh -c 'printf ok > /data/.smoke-write && rm /data/.smoke-write' \
    || { diagnostics; die "/data 对容器运行用户不可写（uid=$(docker exec "$CONTAINER" id -u)）"; }
  docker exec "$CONTAINER" sh -c 'ls -ln /data' | sed 's/^/  /'
  echo "  uid=$(docker exec "$CONTAINER" id -u) 可以写入 /data"

  log "容器日志（最后 20 行）"
  docker logs "$CONTAINER" 2>&1 | tail -n 20 || true
  log "冒烟通过：生产 CMD 起得来、健康检查 200、bootstrap 可读、/data 可写、静态资源已就位"
}

case "${1:-}" in
  inspect) inspect_image ;;
  smoke) smoke ;;
  *) usage ;;
esac
