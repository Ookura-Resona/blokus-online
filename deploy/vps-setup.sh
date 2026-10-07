#!/usr/bin/env bash
#
# 在一台全新的 Ubuntu / Debian 服务器上，把角斗士棋装成开机自启的常驻服务。
#
#   1. 把整个项目目录传到服务器
#   2. cd 进项目目录，然后：
#        sudo bash deploy/vps-setup.sh
#
# 装完就是一个 systemd 服务，开机自启、崩溃自动重启，不依赖任何登录会话。
#
# 可选：装完后再配个域名 + HTTPS，最省事的是 Caddy：
#        sudo apt install -y caddy
#        sudo caddy reverse-proxy --from blokus.example.com --to 127.0.0.1:3000
#   Caddy 默认就会正确转发 WebSocket 升级，不用手写任何头。

set -euo pipefail

APP_DIR=/opt/blokus
SERVICE=blokus
RUN_USER=blokus
PORT="${PORT:-3000}"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/vps-setup.sh"

# ── 1. 确认 Node 版本够 ─────────────────────────────────────────

log "检查 Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  ver="$(node -v)"
  major="${ver#v}"; major="${major%%.*}"
  if [[ "$major" -ge 18 ]]; then
    echo "  已有 $ver，够用"
    need_node=0
  else
    warn "已有 $ver，太旧（需要 18+）"
  fi
fi

if [[ "$need_node" -eq 1 ]]; then
  log "安装 Node.js 22（NodeSource 官方源）"
  if ! command -v curl >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq curl ca-certificates
  fi
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
  echo "  已安装 $(node -v)"
fi

NODE_BIN="$(command -v node)"

# ── 2. 建一个专用系统用户（不给登录 shell）─────────────────────

log "创建运行用户 $RUN_USER"
if id "$RUN_USER" >/dev/null 2>&1; then
  echo "  已存在"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
  echo "  已创建"
fi

# ── 3. 拷贝代码 ─────────────────────────────────────────────────

log "部署到 $APP_DIR"
mkdir -p "$APP_DIR"
# 只拷运行期需要的东西；用 rsync 有就更好，没有就用 cp
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' --exclude 'art' --exclude 'test' --exclude 'tools' \
    --exclude '*.md' --exclude 'start-public.ps1' \
    "$SRC_DIR"/ "$APP_DIR"/
else
  rm -rf "$APP_DIR"/server "$APP_DIR"/shared "$APP_DIR"/public
  cp -r "$SRC_DIR"/server "$SRC_DIR"/shared "$SRC_DIR"/public "$APP_DIR"/
  cp "$SRC_DIR"/package.json "$APP_DIR"/ 2>/dev/null || true
fi
chown -R root:root "$APP_DIR"
chmod -R a-w "$APP_DIR"   # 运行期不需要写，顺手锁死
echo "  文件：$(find "$APP_DIR" -type f | wc -l) 个"

# ── 4. 装 systemd 服务 ──────────────────────────────────────────

log "安装 systemd 服务"
install -m 0644 "$SRC_DIR/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
# 把模板里的 /usr/bin/node 换成实际路径（有的系统装在 /usr/local/bin）
sed -i "s#^ExecStart=.*#ExecStart=$NODE_BIN server/index.js#" "/etc/systemd/system/$SERVICE.service"
sed -i "s#^Environment=PORT=.*#Environment=PORT=$PORT#" "/etc/systemd/system/$SERVICE.service"

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

# ── 5. 等它起来并自检 ───────────────────────────────────────────

log "等待服务就绪"
ok=0
for _ in $(seq 1 30); do
  sleep 0.5
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
done

if [[ "$ok" -ne 1 ]]; then
  warn "服务没起来，最近日志："
  journalctl -u "$SERVICE" -n 25 --no-pager || true
  die "部署失败"
fi

echo "  健康检查通过：$(curl -fsS "http://127.0.0.1:$PORT/healthz")"

# ── 6. 防火墙（如果有 ufw）─────────────────────────────────────

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  log "放行 ufw 端口"
  ufw allow "$PORT"/tcp >/dev/null && echo "  已放行 $PORT/tcp"
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  echo "  已放行 80/443（给将来的 HTTPS 用）"
else
  warn "没检测到启用的 ufw。如果用云服务器，记得在控制台的「安全组」里放行 $PORT 端口。"
fi

# ── 7. 收尾 ────────────────────────────────────────────────────

IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<服务器IP>')"

cat <<EOF

  ══════════════════════════════════════════════════════════
   部署完成，现在它不依赖你任何设备了。

   访问：  http://$IP:$PORT/
   局域网/公网都可以直接用这个地址发群里

   常用命令：
     systemctl status $SERVICE        看状态
     systemctl restart $SERVICE       重启
     journalctl -u $SERVICE -f        看实时日志
     systemctl disable --now $SERVICE 卸载
  ══════════════════════════════════════════════════════════

   下一步建议（想要 https 和域名）：
     1. 把域名 A 记录解析到 $IP
     2. sudo apt install -y caddy
     3. sudo caddy reverse-proxy --from 你的域名 --to 127.0.0.1:$PORT

   然后就能用 https://你的域名/?r=房号 发给群里了。
   （HTTPS 下手机上才有原生分享面板和剪贴板权限）

EOF
