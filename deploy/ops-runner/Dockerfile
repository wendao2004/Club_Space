# 运维执行器镜像
#
# 设计取向是"越小越好审阅"：
#   - 只有 node:http 一个服务，没有框架、没有额外依赖
#   - 不装 curl / bash / 包管理器之外的东西（减少攻破后可用的工具）
#   - 只有这一个容器持有 docker.sock
#
# 它需要 docker CLI：执行 `docker compose stop <service>` 这类命令。
# 用 alpine 的 docker-cli 包（约 50MB），不需要完整 dockerd。
FROM node:24-alpine

# docker-cli 提供 docker 与 docker compose 两个命令
RUN apk add --no-cache docker-cli docker-cli-compose \
    && rm -rf /var/cache/apk/*

WORKDIR /app
COPY runner.mjs ./runner.mjs

# 非 root 运行。注意：能访问 docker.sock 本身已经等价于 root，
# 但用非 root 至少让"攻破后能做的事"少一点（例如改不了自己的文件、装不了包）。
RUN addgroup -g 10002 -S ops && adduser -u 10002 -S ops -G ops \
    && chown -R ops:ops /app

USER ops:ops

ENV NODE_ENV=production \
    OPS_PORT=9119

EXPOSE 9119

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9119/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "runner.mjs"]
