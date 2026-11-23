#!/usr/bin/env bash
# ============================================================
# 在 192.168.110.52 上执行这一个脚本，把每日任务完整装好。
#
# 用法（先在你自己的 mac 上执行第一条，把脚本推过去）：
#   scp scripts/bootstrap-110-52.sh <你的用户名>@192.168.110.52:~/
# 然后 ssh 上去跑：
#   bash ~/bootstrap-110-52.sh
#
# 它会做：
#   1. 检查系统与依赖（node / git / curl）
#   2. 缺 node 就装（Homebrew 或 apt，会先问你）
#   3. 装 lark-cli 并引导你完成一次授权
#   4. 配好 Git 推送用的 SSH 部署密钥
#   5. clone 仓库
#   6. 注册定时任务（每天 10:00）
#   7. 试跑一次验证
#
# 每步都会打印在做什么，任何一步失败会停下来告诉你怎么修。
# ============================================================
set -uo pipefail

REPO_SSH="git@github.com:tarma945-debug/ai-pulse.git"
REPO_DIR="$HOME/ai-pulse"
LARK_APP_ID="cli_aa45daaa9a799c00"

ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  !\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m  ✗\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ask()  { printf '  → %s [y/N] ' "$*"; read -r a; [[ "$a" == "y" || "$a" == "Y" ]]; }

OS="$(uname -s)"

step "1. 系统"
echo "  $(uname -a)"
if [[ "$OS" == "Darwin" ]]; then
  ok "macOS $(sw_vers -productVersion 2>/dev/null)"
  PKG="brew"
else
  ok "Linux"
  if command -v apt-get >/dev/null 2>&1; then PKG="apt"
  elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
  elif command -v yum >/dev/null 2>&1; then PKG="yum"
  else PKG=""; fi
fi

step "2. Node.js"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  V="$(node -v)"; M="${V#v}"; M="${M%%.*}"
  if [[ "$M" -ge 18 ]]; then ok "node ${V}"; NODE_OK=1
  else warn "node ${V} 太旧（需要 ≥18）"; fi
else
  warn "没装 node"
fi

if [[ $NODE_OK -eq 0 ]]; then
  echo "  需要安装 Node.js ≥ 18。"
  if [[ "$PKG" == "brew" ]]; then
    ask "用 brew install node 安装？" && { brew install node && NODE_OK=1; }
  elif [[ -n "$PKG" ]]; then
    ask "用 ${PKG} 安装 NodeSource 的 nodejs 22？" && {
      if [[ "$PKG" == "apt" ]]; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs && NODE_OK=1
      else
        sudo "$PKG" install -y nodejs npm && NODE_OK=1
      fi
    }
  else
    bad "没有可用的包管理器，请手动装 node ≥18 后重跑本脚本"
  fi
  [[ $NODE_OK -eq 0 ]] && { bad "node 没装好，停止"; exit 1; }
  ok "node $(node -v)"
fi

step "3. git 与 curl"
for c in git curl; do
  if command -v "$c" >/dev/null 2>&1; then ok "$c"
  else
    warn "缺 $c"
    if [[ "$PKG" == "brew" ]]; then ask "brew install ${c}？" && brew install "$c"
    elif [[ -n "$PKG" ]]; then ask "sudo ${PKG} install -y ${c}？" && sudo "$PKG" install -y "$c"
    fi
  fi
done
command -v git  >/dev/null 2>&1 || { bad "git 装不上，停止"; exit 1; }
command -v curl >/dev/null 2>&1 || { bad "curl 装不上，停止"; exit 1; }

step "4. lark-cli（发飞书用）"
if command -v lark-cli >/dev/null 2>&1; then
  ok "已装：$(lark-cli --version 2>/dev/null | head -1)"
else
  warn "没装"
  ask "用 npm 全局安装 @larksuite/cli？" && {
    npm install -g @larksuite/cli && hash -r
    command -v lark-cli >/dev/null 2>&1 && ok "装好了" || bad "装完仍找不到 lark-cli，检查 npm 全局 bin 是否在 PATH"
  }
fi

if command -v lark-cli >/dev/null 2>&1; then
  # 注意：auth status 里 bot 和 user 各有 status，bot 通常先出现且恒为 ready。
  # 判用户身份要看 tokenStatus，别用 "status": "ready" 会误判。
  if lark-cli auth status 2>/dev/null | grep -q '"tokenStatus": "valid"'; then
    ok "已授权，不用再登录"
  else
    echo
    echo "  ┌─────────────────────────────────────────────┐"
    echo "  │  接下来会打印一个授权链接。用浏览器打开，     │"
    echo "  │  用你的飞书账号确认一次即可。只需要一次。     │"
    echo "  └─────────────────────────────────────────────┘"
    echo
    ask "现在开始授权？" && lark-cli auth login --domain im
  fi
fi

step "5. Git 推送权限"
echo "  仓库用 SSH 部署密钥推送（比复制 token 安全，且不会跟着你的账号失效）。"
KEY="$HOME/.ssh/aipulse_deploy"
if [[ ! -f "$KEY" ]]; then
  ssh-keygen -t ed25519 -N "" -C "aipulse-deploy@$(hostname)" -f "$KEY" -q
  ok "已生成部署密钥 $KEY"
fi
echo
echo "  把下面这一整行（以 ssh-ed25519 开头）加到 GitHub："
echo "  https://github.com/tarma945-debug/ai-pulse/settings/keys/new"
echo "  ⚠ 务必勾选 Allow write access（否则推不上去）"
echo
echo "  ┌──────────────────────────────────────────────────────────────────"
cat "$KEY.pub"
echo "  └──────────────────────────────────────────────────────────────────"
echo
ask "已经加好了？" || { warn "那先停在这里，加完再重跑本脚本"; exit 0; }

if ! ssh-keyscan -T 5 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null; then
  warn "ssh-keyscan 失败（可能没网），跳过"
fi
# 让 git 对 github 使用这把专用密钥
if ! grep -q "Host github-aipulse" "$HOME/.ssh/config" 2>/dev/null; then
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  cat >> "$HOME/.ssh/config" <<SSHCFG

Host github-aipulse
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
SSHCFG
  chmod 600 "$HOME/.ssh/config"
  ok "已写 ~/.ssh/config（别名 github-aipulse）"
fi

if ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github-aipulse 2>&1 | grep -qi "successfully authenticated"; then
  ok "GitHub 认证成功"
else
  warn "GitHub 认证没通过 —— 多半是密钥还没加、或没勾 Allow write access。先继续，推送那步会报错。"
fi

step "6. 拉取代码"
if [[ -d "$REPO_DIR/.git" ]]; then
  ok "已有仓库，直接更新"
  git -C "$REPO_DIR" pull --ff-only || warn "pull 失败，用现有代码继续"
else
  git clone "git@github-aipulse:tarma945-debug/ai-pulse.git" "$REPO_DIR" \
    && ok "已 clone 到 $REPO_DIR" \
    || { bad "clone 失败，检查密钥权限后重跑"; exit 1; }
fi
cd "$REPO_DIR" || exit 1
git remote set-url origin "$REPO_SSH"
git config core.sshCommand "ssh -i $KEY -o IdentitiesOnly=yes"
ok "origin 已设为 $REPO_SSH"

step "7. 环境体检与试跑"
bash scripts/setup-host.sh --dry || warn "体检有告警，看上面内容"
echo
echo "  试跑（不发送、不推送）…"
node scripts/daily-report.mjs --dry || warn "试跑有问题，看上面输出"

step "8. 注册定时任务（每天 10:00）"
ask "现在注册？" || { warn "跳过，之后可手动跑 bash scripts/setup-host.sh"; exit 0; }
bash scripts/setup-host.sh

echo
ok "全部完成"
echo "  手动跑一次： cd $REPO_DIR && node scripts/daily-report.mjs"
echo "  看日志：     tail -f $REPO_DIR/daily.log"
echo
warn "别忘了停掉原来那台机器上的定时任务，否则会双发。"
