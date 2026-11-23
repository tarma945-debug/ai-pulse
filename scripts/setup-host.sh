#!/usr/bin/env bash
# ============================================================
# 在目标机器上跑这一个脚本，把每日任务装好。
#
# 用法（在 110.52 上执行）：
#   bash scripts/setup-host.sh           安装依赖并注册定时任务
#   bash scripts/setup-host.sh --dry     只检查环境，不装不注册
#
# 这个脚本假设代码已经放在当前目录（git clone 或 rsync 过来都行）。
# 它做四件事：查依赖 → 装依赖 → 配 git 凭据 → 注册定时任务。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=0
[[ "${1:-}" == "--dry" ]] && DRY=1

ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*"; }

echo "== 1. 环境检查 =="

# --- node ---
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v)"
  MAJOR="${NODE_VER#v}"; MAJOR="${MAJOR%%.*}"
  if [[ "$MAJOR" -ge 18 ]]; then ok "node $NODE_VER"
  else bad "node $NODE_VER 太旧，需要 >= 18"; fi
else
  bad "没有 node（脚本用了 node: 内置模块和顶层 await）"
fi

# --- curl ---
command -v curl >/dev/null 2>&1 && ok "curl" || bad "没有 curl（抓取和 API 都靠它）"

# --- git ---
command -v git >/dev/null 2>&1 && ok "git" || bad "没有 git（推送需要）"

# --- lark-cli ---
if command -v lark-cli >/dev/null 2>&1; then
  ok "lark-cli $(lark-cli --version 2>/dev/null | head -1)"
  # bot 身份的 status 恒为 ready，要判 user 的 tokenStatus 才算真授权
  if lark-cli auth status 2>/dev/null | grep -q '"tokenStatus": "valid"'; then
    ok "lark-cli 已登录"
  else
    warn "lark-cli 未登录，需要跑 lark-cli auth login（会弹设备码，必须人工确认一次）"
  fi
else
  bad "没有 lark-cli — 这是 WorkBuddy 的连接器 CLI，需先装 Node 版并登录"
fi

# --- 代理 ---
echo "  · 探测代理…"
FOUND_PROXY=""
for p in 7897 7890 1087 8118 8119; do
  if nc -z -G 1 127.0.0.1 "$p" >/dev/null 2>&1; then
    CODE="$(curl -s -o /dev/null --max-time 8 -x "http://127.0.0.1:$p" \
            -w '%{http_code}' https://www.google.com/generate_204 2>/dev/null || echo 000)"
    if [[ "$CODE" == "204" || "$CODE" == "200" ]]; then
      FOUND_PROXY="http://127.0.0.1:$p"; ok "代理可用：$FOUND_PROXY"; break
    fi
  fi
done
[[ -z "$FOUND_PROXY" ]] && warn "没探测到可用代理 → Reddit 会抓不到，脚本会沿用上一份缓存（不会清空）"

# --- 出网能力 ---
for u in https://aihot.news/api/v1/dailies?limit=1 https://github.com; do
  if [[ -n "$FOUND_PROXY" ]]; then
    C="$(curl -s -o /dev/null -x "$FOUND_PROXY" --max-time 10 -w '%{http_code}' "$u" || echo 000)"
  else
    C="$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "$u" || echo 000)"
  fi
  if [[ "$C" == 2* || "$C" == 3* ]]; then ok "可达 $u"
  else bad "不可达 ${u}（HTTP ${C}）"; fi
done

# --- git 远端 ---
cd "$ROOT"
if git remote get-url origin >/dev/null 2>&1; then
  ok "git origin = $(git remote get-url origin)"
  if git config --get credential.helper >/dev/null 2>&1; then
    ok "git credential.helper = $(git config --get credential.helper)"
  else
    warn "git 没有配 credential.helper，推送会被问密码；建议配 osxkeychain（macOS）或 store（Linux）"
  fi
else
  bad "当前目录不是 git 仓库或没有 origin"
fi

if [[ $DRY -eq 1 ]]; then
  echo "== --dry，到此为止，未做任何修改 =="
  exit 0
fi

echo "== 2. 试跑（不发送、不推送）=="
node scripts/daily-report.mjs --dry || { bad "试跑失败，先解决上面的问题"; exit 1; }

echo "== 3. 注册定时任务 =="
if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.aipulse.daily.plist"
  NODE_BIN="$(command -v node)"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.aipulse.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/scripts/daily-report.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$ROOT/daily.log</string>
  <key>StandardErrorPath</key><string>$ROOT/daily.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  ok "已注册 launchd：${PLIST}（每天 10:00，日志 ${ROOT}/daily.log）"
else
  LINE="0 10 * * * cd $ROOT && $(command -v node) scripts/daily-report.mjs >> $ROOT/daily.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'ai-pulse' ; echo "$LINE" ) | crontab -
  ok "已注册 cron：每天 10:00，日志 $ROOT/daily.log"
  warn "确保 cron 的 PATH 能找到 lark-cli；必要时在 crontab 顶部加 PATH=..."
fi

echo "== 完成 =="
echo "手动跑一次完整流程： node scripts/daily-report.mjs"
