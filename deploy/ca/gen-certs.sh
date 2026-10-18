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
WL_HTTPS_PORT="${WL_HTTPS_PORT:-8443}"
WL_ONBOARD_PORT="${WL_ONBOARD_PORT:-8080}"

CA_KEY="ca.key"
CA_CRT="ca.crt"
SRV_KEY="server.key"
SRV_CRT="server.crt"
SRV_CSR="server.csr"
SRV_EXT="server.ext"

echo "==> 目标 IP: $WL_HOST_IP"
echo "==> 主机名: $WL_NAMES"

# ------------------------------------------------------------------ 根证书
if [ ! -f "$CA_KEY" ]; then
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
  chmod 600 "$CA_KEY"
  echo "    已生成 $CA_CRT / $CA_KEY"
else
  echo "==> 复用已有根证书 $CA_CRT"
fi

# ------------------------------------------------------------------ 服务器证书
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

chmod 600 "$SRV_KEY"
rm -f "$SRV_CSR" "$SRV_EXT"

echo "    已生成 $SRV_CRT / $SRV_KEY"

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
echo " 完成。接下来："
echo
echo " 1) 在 deploy/.env 里填访问地址与端口（**不需要改 Caddyfile**）："
echo "      WL_SITE_ADDRESS=https://$WL_HOST_IP:8443"
echo "      WL_ONBOARD_BASE=http://$WL_HOST_IP:8080"
echo "      以及 WL_HTTPS_PORT=8443 / WL_ONBOARD_PORT=8080"
echo "    ⚠️ 站地址里的端口必须与 WL_HTTPS_PORT 一致，否则 Caddy 匹配不到站点。"
echo "    ⚠️ 用 8443 而不是 443：很多 NAS 把 80/443 留给自己的 Web 管理界面。"
echo
echo " 2) 确认路由器里已给这台 NAS 做 MAC-IP 静态绑定，绑到 $WL_HOST_IP。"
echo "    改 IP 就要重跑本脚本重签证书，否则全站证书告警。"
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
echo "      http://$WL_HOST_IP:8080/onboard"
echo
echo "------------------------------------------------------------------"
echo " 自检 · 根证书主体（中文应当正常显示，不是乱码）："
echo "    $SUBJECT"
echo "=================================================================="
