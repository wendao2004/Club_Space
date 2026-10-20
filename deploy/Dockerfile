# 应用容器：多阶段构建。
#
# 为什么把前端和后端打进同一个镜像：
# 评审团对比过多套方案后明确要求"入口只留一个 Caddy、后端只留一个 Node 应用" ——
# NAS 的业务容器预算只有 2-4GB，多一个常驻容器就是多固定占用。
# 后端已经内建了静态资源服务（web/dist 存在时自动挂载 + SPA 回退），
# 所以一个容器就够了。

# ---------- 阶段 1：构建前端 ----------
FROM node:24-alpine AS build
WORKDIR /app

# 国内网络下 npm 官方源不可达，构建时必须走镜像源。
# 这一行对局域网内离线构建同样重要：镜像源可达，构建才能重复。
COPY .npmrc ./
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/
COPY web/package.json ./web/

# ⚠️ 这一行不能省。
#
# `.npmrc` 里的 registry 只影响 **pnpm/npm 装包**，管不到 corepack 自己 ——
# corepack 去下载 pnpm 这个二进制时用的是它自己的默认源 registry.npmjs.org，
# 而在国内网络（以及任何屏蔽了 npm 官源的局域网）那个地址是不可达的。
# 结果就是构建在 `corepack prepare pnpm@9` 这一步卡住直到超时，
# 报错信息看起来像是网络问题而不是配置问题。
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com

RUN corepack enable && corepack prepare pnpm@9 --activate \
  && pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY web ./web
COPY server ./server

RUN pnpm -F @wl/web build

# ---------- 阶段 2：运行时 ----------
FROM node:24-alpine
WORKDIR /app

# 只装服务端运行时依赖，不带开发依赖
COPY .npmrc ./
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/

ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com

RUN corepack enable && corepack prepare pnpm@9 --activate \
  && pnpm install --frozen-lockfile --prod --filter @wl/server... \
  && pnpm store prune

# 服务端源码：直接用 Node 24 的原生类型剥离运行 .ts，不产出编译中间物
COPY server ./server
# 前端构建产物：由后端静态服务
COPY --from=build /app/web/dist ./web/dist

# 不以 root 运行。数据目录由 compose 挂进来，权限在部署时对齐。
#
# ⚠️ 这里**只 chown /data**，不要写成 `chown -R app:app /data /app`。
#
# 在 NAS 上实测过：对 /app 递归 chown 会遍历 node_modules 里上万个文件，
# 在 overlay2 + NAS 存储上慢到几分钟都不结束（进程长期处于不可中断的 D 状态，
# 从外面看就是"构建卡死了"，且没有任何输出）。
#
# 而它完全不必要：这个容器运行期只往 /data 写，/app 下的源码只需要**可读**，
# 而 COPY 出来的文件本来就可读。少 chown 一个目录，顺手省掉几分钟构建时间。
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app \
  && mkdir -p /data && chown -R app:app /data

USER app:app

ENV NODE_ENV=production \
    WL_DATA_DIR=/data \
    WL_HOST=0.0.0.0 \
    WL_PORT=3000

EXPOSE 3000

# 健康检查用 node 自己发请求：alpine 镜像里没有 curl，
# 装一个只为探活不值得。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ⚠️ `--max-old-space-size=384` 是**内存防线**，不是性能调优。
#
# 容器有 512MB 硬上限（compose 的 `mem_limit`），默认的 V8 堆上限跟着宿主机
# 内存走（在这类 NAS 上远大于 512MB）。于是进程把堆涨到 400MB+ 时 GC 还觉得
# "很宽裕"，继续分配 —— 直到 cgroup 直接 SIGKILL，日志里连 OOM 堆栈都没有，
# 运维只会看到容器反复重启。把堆压到 384MB 之后，V8 会先在堆内 OOM 并打印
# 真实的分配现场，而且给堆外内存（Buffer / libvips / SQLite）留下 ~128MB。
#
# 为什么写在这里（而不是 server/package.json 的 start，也不是 compose 的 command）：
#   - 镜像里**唯一**的启动路径就是下面这行 CMD（compose 没有覆盖 command）；
#   - `package.json` 的 `start` 只在本地 `pnpm start`/`pnpm dev` 时用得到，
#     改了它对这个容器毫无作用，反而会让人以为生产已经生效；
#   - 写进 compose 的 command 会把启动命令复制一份，以后改 CMD 时容易只改一处。
# 所以只在这里加，保持"生产启动命令只有一处"。
CMD ["node", "--max-old-space-size=384", "server/src/index.ts"]
