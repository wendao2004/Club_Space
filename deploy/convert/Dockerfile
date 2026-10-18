# ============================================================================
# 转换镜像：Gotenberg + 中文字体
#
# 为什么必须自建而不是直接用 gotenberg/gotenberg:8：
#   官方镜像里没有 CJK 字体。用它转一份中文 Word 文档，结果是**方框或丢字**。
#   这不是"排版不完美"，是功能不可用 —— 而"Word 转 PDF"是需求清单里的第一项。
#
# 字体选择：Noto Sans CJK SC（思源黑体的 Google 版本），覆盖简繁日韩，
# Apache-2.0 / OFL 授权，可自由分发。
# ============================================================================
FROM gotenberg/gotenberg:8

USER root

# fonts-noto-cjk 提供简繁日韩全字集；fonts-wqy-zenhei 作为笔画风格的补充。
# 装完必须 fc-cache 刷新字体缓存，否则 LibreOffice 仍然找不到这些字体。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-noto-cjk \
        fonts-wqy-zenhei \
    && fc-cache -fv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 改动 HOME 下的字体缓存目录属主，Gotenberg 以非 root 运行
RUN mkdir -p /home/gotenberg/.cache && chown -R gotenberg:gotenberg /home/gotenberg/.cache || true

USER gotenberg

# 启动时自检：确认中文字体确实被识别了。
# 如果字体没装上，容器会在日志里明确报出来，而不是等到用户转换后发现全是方框。
# 这比"看起来部署成功了"要诚实。
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD fc-list :lang=zh | head -1 | grep -q . \
      && wget -q -O - http://127.0.0.1:3000/health \
      || exit 1
