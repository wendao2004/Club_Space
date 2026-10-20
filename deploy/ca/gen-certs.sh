#!/usr/bin/env bash
# ============================================================================
# 生成社团内网 CA 与服务器证书。
#
# 在 NAS 上执行一次即可（证书私钥绝不出 NAS）。
#
# 关键设计：**证书里必须带 IP SAN**。
#   评审团核查过：mDNS（*.local）在家用 AP 上经常被多播过滤 / IGMP snooping
#   拦掉，Android 本来就完全不解析 mDNS；而"给每台成员设备改 DNS"在执行上
#   必然失败。所以 IP 直连是唯一 100% 可解析的访问方式，而要让 IP 访问不弹
#   证书错误，证书就必须包含 IP 类型的 SAN 项。
#
# 用法：
#   ./gen-certs.sh                      # 用下面的默认值
#   WL_HOST_IP=192.168.1.100 WL_NAMES="wl.club wl.local" ./gen-certs.sh
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

# ------------------------------------------------------------------ 配置
# 本机 IP —— 必须与路由器里给 NAS 做的 MAC-IP 静态绑定一致。
# IP 漂移会导致证书 IP SAN 失配、全站告警，这是设计里明确的运维前置条件。
WL_HOST_IP="${WL_HOST_IP:-192.168.1.100}"

# 主机名们。第一个是主名字（Caddyfile 里也要用它）。
WL_NAMES="${WL_NAMES:-wl.club wl.local}"

WL_ORG="${WL_ORG:-社团内网}"
WL_DAYS="${WL_DAYS:-397}"      # 397 天：规避 Apple 对 398 天以上证书的限制

# 端口。必须与 deploy/.env 里的 WL_HTTPS_PORT / WL_ONBOARD_PORT 一致 ——
# 引导页靠它们拼出"进平台"的地址，对不上就会把成员送到错的地方去。
# 默认值与 deploy/.env.example 保持一致（曾经这里是 8443、模板里是 9443，
# 不显式传变量的部署会生成一个指向 8443 的引导页链接，而站点在 9443）。
WL_HTTPS_PORT="${WL_HTTPS_PORT:-9443}"
WL_ONBOARD_PORT="${WL_ONBOARD_PORT:-8080}"

# 根 CA：**留在这个目录，绝不挂进任何容器**。
# ca.crt 是公开的（要发给成员安装），ca.key 是整条信任链的根私钥。
CA_KEY="ca.key"
CA_CRT="ca.crt"

# 对外证书：**只有这个目录会被挂进 caddy 容器**（见 docker-compose.yml）。
# 与根 CA 分开是刻意的 —— 容器只需要 server 证书，没有任何理由让根私钥
# 出现在它的文件系统里。
SERVED_DIR="served"
SRV_KEY="$SERVED_DIR/server.key"
SRV_CRT="$SERVED_DIR/server.crt"
SRV_CSR="$SERVED_DIR/server.csr"
SRV_EXT="$SERVED_DIR/server.ext"

mkdir -p "$SERVED_DIR"

# 目录存在但写不进去，最常见的来源是：有人先跑了 `docker compose up -d`，
# Docker 为缺失的绑定挂载点自动建了这个目录，属主是 root。这种失败会表现为
# openssl 报 "Permission denied"，看不出根因，所以在这里直接说清楚。
if [ ! -w "$SERVED_DIR" ]; then
  echo "错误：$PWD/$SERVED_DIR 不可写（很可能是 docker 以 root 身份自动创建的）。" >&2
  echo "      处理：sudo chown $(id -u):$(id -g) \"$SERVED_DIR\"  然后重跑本脚本。" >&2
  exit 1
fi

echo "==> 目标 IP: $WL_HOST_IP"
echo "==> 主机名: $WL_NAMES"

# ------------------------------------------------------------------ 根证书
#
# **幂等**：已经有 ca.key + ca.crt 就原样复用。
# 这一条不是"保持仓库干净"，而是硬要求 —— 重新生成根 CA 会让**每一台**
# 已经装过证书的设备全部失效（浏览器重新告警、PWA/Service Worker 全丢），
# 而重装证书要靠成员自己照着引导页再走一遍。脚本重跑多少次都不该改变 CA。
if [ -f "$CA_KEY" ] && [ -f "$CA_CRT" ]; then
  echo "==> 复用已有根证书 $CA_CRT（指纹不变，成员无需重装）"
elif [ -f "$CA_KEY" ] || [ -f "$CA_CRT" ]; then
  # 只剩一半时**必须停下来**，不能"缺什么补什么"：
  # 有 key 无 crt 时重新自签会得到一张与已分发证书不同的 CA；
  # 有 crt 无 key 时新签的服务器证书不会被任何客户端接受。
  # 两种情况的正确做法都是从备份里恢复，而不是悄悄生成一张新的。
  echo "错误：$CA_KEY 与 $CA_CRT 只剩下一个，状态不一致。" >&2
  echo "      不要重新生成（会让所有已装证书的设备失效）。" >&2
  echo "      请先查明原因，或从备份恢复这两个文件（ca.key 与 ca.crt 是一对）。" >&2
  exit 1
else
  echo "==> 生成根证书（有效期 10 年，只生成一次）"
  # ⚠️ `-utf8` 不能省。
  #
  # 实测（OpenSSL 3.0.20）：不加这个标志时，`-subj` 里任何非 ASCII 字符都会被
  # 当成 Latin-1 再转一次 UTF-8 —— "社团内网" 会变成 "ç¤¾å›¢å†…ç½‘"，
  # 而且**只在证书里坏掉**，脚本本身没有任何报错。成员装证书时看到的就是这串乱码。
  # 加上 -utf8 之后字节原样保留。
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes -utf8 \
    -keyout "$CA_KEY" -out "$CA_CRT" \
    -subj "/O=${WL_ORG}/OU=LAN/CN=${WL_ORG}根证书" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  echo "    已生成 $CA_CRT / $CA_KEY"
fi

# 权限：只有两个私钥是 600，两张证书是 644。
# 证书要给成员下载、也要被容器里的进程读，所以不能是 600；
# 私钥除属主外谁都不该读 —— 尤其是 ca.key。
chmod 600 "$CA_KEY"
chmod 644 "$CA_CRT"

# ------------------------------------------------------------------ 旧结构迁移
#
# 旧版本（本改动之前）把 server.crt / server.key 直接生成在 ca/ 根目录，
# 而 docker-compose.yml 挂的是整个 ./ca。现在对外证书挪到了 served/。
#
# 检测到旧的 server.crt + server.key 就**原样搬过来，不重签**：
# 已经分发出去、正在被客户端信任的就是这一对，重签没有任何好处，
# 只会在成员机器上多出一次"证书变了"的噪音。
NEED_SIGN=1
if [ -f server.crt ] && [ -f server.key ] && [ ! -f "$SRV_CRT" ]; then
  echo "==> 检测到旧目录结构，把 server.crt / server.key 迁移到 $SERVED_DIR/（不重签）"
  mv -f server.key "$SRV_KEY"
  mv -f server.crt "$SRV_CRT"
  NEED_SIGN=0
elif [ -f server.crt ] || [ -f server.key ]; then
  # 半边旧文件、或 served/ 已有证书但旧文件没清掉：
  # 不猜哪个是对的，交给部署者确认。以 served/ 为准。
  echo "⚠️  ca/ 根目录里还有旧的 server.crt / server.key，本次以 $SERVED_DIR/ 为准。"
  echo "    确认服务正常后删掉旧文件：rm -f server.crt server.key"
fi

# ------------------------------------------------------------------ 服务器证书
if [ "$NEED_SIGN" -eq 1 ]; then
  echo "==> 生成服务器证书（有效期 ${WL_DAYS} 天）"
  openssl req -newkey rsa:2048 -sha256 -nodes -utf8 \
    -keyout "$SRV_KEY" -out "$SRV_CSR" \
    -subj "/O=${WL_ORG}/CN=$(echo "$WL_NAMES" | cut -d' ' -f1)"

  {
    echo "basicConstraints=CA:FALSE"
    echo "keyUsage=critical,digitalSignature,keyEncipherment"
    echo "extendedKeyUsage=serverAuth"
    echo "subjectAltName=@alt"
    echo "[alt]"
    i=1
    for name in $WL_NAMES; do
      echo "DNS.$i=$name"
      i=$((i + 1))
    done
    # 这一行是整份脚本存在的理由：没有它，用 IP 访问就要忍受证书告警，
    # 而 Chrome 对带证书错误的站点**禁止注册 Service Worker** —— 那不是体验差，
    # 是功能没有（没有通知、没有摄像头、没有剪贴板）。
    echo "IP.1=$WL_HOST_IP"
  } > "$SRV_EXT"

  openssl x509 -req -in "$SRV_CSR" \
    -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "$SRV_CRT" -days "$WL_DAYS" -sha256 -extfile "$SRV_EXT"

  rm -f "$SRV_CSR" "$SRV_EXT"

  echo "    已生成 $SRV_CRT / $SRV_KEY"
else
  echo "==> 沿用已迁移的服务器证书 $SRV_CRT（未重签）"
fi

chmod 600 "$SRV_KEY"
chmod 644 "$SRV_CRT"

# ------------------------------------------------------------------ iOS 描述文件
# iOS 装根证书是**两步**：先装描述文件，再去"证书信任设置"里手动开启完全信任。
# 只做第一步无效 —— 这是最容易卡住成员的地方，所以直接把描述文件生成好，
# 让成员点一下就能完成第一步。
if command -v python3 >/dev/null 2>&1; then
  echo "==> 生成 iOS 描述文件 ca.mobileconfig"
  python3 - "$WL_ORG" <<'PY' > ca.mobileconfig
import base64, sys
org = sys.argv[1]
ca = base64.b64encode(open('ca.crt', 'rb').read()).decode()
print(f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadIdentifier</key><string>club.lan.ca</string>
<key>PayloadUUID</key><string>0C0FFEE0-1111-2222-3333-444455556666</string>
<key>PayloadDisplayName</key><string>{org}根证书</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadContent</key><data>{ca}</data>
</dict></array>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadIdentifier</key><string>club.lan.profile</string>
<key>PayloadUUID</key><string>11111111-2222-3333-4444-555566667777</string>
<key>PayloadDisplayName</key><string>{org}内网信任配置</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>''')
PY
else
  echo "    (未找到 python3，跳过 iOS 描述文件生成；可在有 python 的机器上补生成)"
fi

# ------------------------------------------------------------------ 分发到引导页
mkdir -p ../onboard/certs
cp "$CA_CRT" ../onboard/certs/ca.crt
[ -f ca.mobileconfig ] && cp ca.mobileconfig ../onboard/certs/ca.mobileconfig

# 指纹单独落一个文件给引导页读。
#
# 为什么不让页面自己从 ca.crt 里算：引导页走的是**明文 HTTP**，而
# crypto.subtle 只在安全上下文里存在 —— 页面里现算必然抛错，指纹永远显示不出来。
# 而指纹核对是页面上唯一防止有人在局域网里调包证书的功能，不能让它静默失效。
FINGERPRINT="$(openssl x509 -in "$CA_CRT" -noout -fingerprint -sha256 | cut -d= -f2)"
echo "$FINGERPRINT" > ../onboard/certs/ca.sha256

# 引导页要用的端口配置。
#
# 页面在 8080、主站在另一个端口，两者不同，而且 location.hostname 会丢掉端口，
# 所以页面**猜不出**主站地址，只能由部署方告诉它。
cat > ../onboard/certs/deploy-config.js <<EOF
// 由 gen-certs.sh 生成，请勿手改（改端口请重跑本脚本）
// 与 deploy/.env 的 WL_ONBOARD_PORT / WL_HTTPS_PORT 保持一致
window.WL_DEPLOY_CONFIG = {
  onboardPort: ${WL_ONBOARD_PORT},
  httpsPort: ${WL_HTTPS_PORT}
}
EOF
echo "    已生成 ca.sha256 与 deploy-config.js（端口 ${WL_ONBOARD_PORT}/${WL_HTTPS_PORT}）"

# Windows 一键安装脚本（把证书内容内联进去，成员不用手动导入）
WINDOWS_CMD=../onboard/certs/install-windows.cmd
{
  echo '@echo off'
  echo 'chcp 65001 >nul'
  echo 'net session >nul 2>&1 || (echo 请右键"以管理员身份运行"本脚本 & pause & exit /b 1)'
  echo 'set "TMPCRT=%TEMP%\wl-ca.crt"'
  echo '> "%TMPCRT%" echo -----BEGIN CERTIFICATE-----'
  # 把 PEM 的每一行都写成 echo 追加
  grep -v -- '-----' "$CA_CRT" | sed 's/^/>>"%TMPCRT%" echo /'
  echo '>>"%TMPCRT%" echo -----END CERTIFICATE-----'
  echo 'certutil -addstore -f "ROOT" "%TMPCRT%"'
  echo 'del "%TMPCRT%"'
  echo 'echo.'
  echo 'echo 安装完成。请完全关闭并重新打开浏览器。'
  echo 'pause'
} > "$WINDOWS_CMD"

# ------------------------------------------------------------------ 指纹核对
# FINGERPRINT 已在上面「分发到引导页」一节算好，这里不再重算。

# 自检：确认证书里的中文没被 openssl 编坏。
# 这个检查存在的理由是它真的坏过一次 —— 而且坏得毫无声息：
# 脚本全程没有任何报错，只有证书里那个组织名变成了乱码。
SUBJECT="$(openssl x509 -in "$CA_CRT" -noout -subject -nameopt utf8)"

echo
echo "=================================================================="
echo " 完成。文件分布（只有 served/ 会被挂进 caddy 容器）："
echo "    $PWD/$CA_KEY     ← 根 CA 私钥，600，**不进容器、不进 git、不备份到公开位置**"
echo "    $PWD/$CA_CRT     ← 根证书，644（公开，要发给成员安装）"
echo "    $PWD/$SERVED_DIR/server.crt  ← Caddy 用的服务器证书，644"
echo "    $PWD/$SERVED_DIR/server.key  ← Caddy 用的服务器私钥，600"
echo
echo " 接下来："
echo
echo " 1) 在 deploy/.env 里填端口（**不需要改 Caddyfile**）："
echo "      WL_HTTPS_PORT=$WL_HTTPS_PORT"
echo "      WL_ONBOARD_PORT=$WL_ONBOARD_PORT"
echo "      WL_ONBOARD_BASE=http://$WL_HOST_IP:$WL_ONBOARD_PORT"
echo "    ⚠️ 这三项必须与本次生成时一致，否则引导页会把成员送到错端口。"
echo "    ⚠️ 用高位端口而不是 443：很多 NAS 把 80/443 留给自己的 Web 管理界面。"
echo
echo " 2) 确认路由器里已给这台 NAS 做 MAC-IP 静态绑定，绑到 $WL_HOST_IP。"
echo "    改 IP 就要重跑本脚本重签服务器证书（根 CA 会复用），否则全站证书告警。"
echo
echo " 3) 把下面的根证书指纹发到社团群里，让成员安装前核对，"
echo "    防止有人在内网里做中间人调包证书："
echo
echo "    SHA-256 指纹: $FINGERPRINT"
echo
echo " 4) 数据目录的属主必须与容器内的 uid 对齐，否则容器能起来但写不进数据："
echo "      sudo mkdir -p <WL_DATA_DIR> && sudo chown -R 10001:10001 <WL_DATA_DIR>"
echo
echo " 5) docker compose up -d --build，然后把引导页地址发给成员："
echo "      http://$WL_HOST_IP:$WL_ONBOARD_PORT/onboard"
echo
echo " 6) 确认容器里**看不到**根 CA 私钥（应该只有两个文件）："
echo "      docker compose exec caddy ls -l /certs"
echo
echo "------------------------------------------------------------------"
echo " 自检 · 根证书主体（中文应当正常显示，不是乱码）："
echo "    $SUBJECT"
echo "=================================================================="
