#!/usr/bin/env bash
# bin/install.sh — 一行命令交互式从 huangrx6/pi-plugin 安装 pi 扩展
#
# 用法:
#   bash <(curl -fsSL https://raw.githubusercontent.com/huangrx6/pi-plugin/main/bin/install.sh)
#   bash <(curl ...) -s -- --only pi-skill-inject,pi-mode-switcher
#   bash <(curl ...) -s -- --target ~/.pi/agent/extensions --mode symlink
#
# 选项:
#   --only <list>      逗号分隔的扩展名（默认交互式让选）
#   --target <path>    安装目录（默认 ~/.pi/agent/extensions）
#   --mode <mode>      symlink | copy（默认 symlink）
#   --repo <owner/repo> 源仓库（默认 huangrx6/pi-plugin）
#   -y, --yes          跳过所有确认
#   -h, --help         显示本帮助
#
# 适合:
#   - 想把单个扩展装到 pi 的自动发现目录（不走 pi install 包加载）
#   - 想要 symlink 模式（pi-plugin 仓库更新后立刻生效，无需重装）
#   - CI / 脚本化场景
#
# 不适合:
#   - 想走 pi 自己的包加载机制 → 用 `pi install git:github.com/huangrx6/pi-plugin`

set -euo pipefail

# ----------------------------------------------------------------------------
# Defaults
# ----------------------------------------------------------------------------
REPO="${REPO:-huangrx6/pi-plugin}"
DEFAULT_TARGET="$HOME/.pi/agent/extensions"
TARGET="$DEFAULT_TARGET"
MODE="symlink"
ONLY=""
YES=false
GIT_URL="https://github.com/${REPO}.git"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
err() { echo "❌ $*" >&2; }
info() { echo "ℹ️  $*"; }

usage() {
  cat <<EOF
一行命令交互式从 $REPO 安装 pi 扩展。

用法:
  $0 [OPTIONS]

选项:
  --only <list>      逗号分隔的扩展名（默认交互式让选）
  --target <path>    安装目录（默认 $DEFAULT_TARGET）
  --mode <mode>      symlink | copy（默认 symlink）
  --repo <owner/repo> 源仓库（默认 huangrx6/pi-plugin）
  -y, --yes          跳过所有确认
  -h, --help         显示本帮助

一行命令:
  bash <(curl -fsSL https://raw.githubusercontent.com/$REPO/main/bin/install.sh)
  bash <(curl ...) -s -- --only pi-skill-inject --target ~/.pi/agent/extensions

适合：单扩展 + 自定义目录 + symlink 模式。
不适合：用 pi 包加载机制（用 'pi install git:github.com/huangrx6/pi-plugin'）。
EOF
}

# ----------------------------------------------------------------------------
# Parse args
# ----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)     ONLY="$2"; shift 2 ;;
    --target)   TARGET="$2"; shift 2 ;;
    --mode)     MODE="$2"; shift 2 ;;
    --repo)     REPO="$2"; GIT_URL="https://github.com/${REPO}.git"; shift 2 ;;
    -y|--yes)   YES=true; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) err "未知参数: $1"; usage; exit 1 ;;
  esac
done

if [[ "$MODE" != "symlink" && "$MODE" != "copy" ]]; then
  err "--mode 必须是 symlink 或 copy，当前: $MODE"
  exit 1
fi

# ----------------------------------------------------------------------------
# Shallow + sparse clone
# ----------------------------------------------------------------------------
# symlink 模式用持久 cache（避免 trap 清理后 symlink 变断链）
# copy 模式用临时目录（不需要持久化）
if [[ "$MODE" == "symlink" ]]; then
  CACHE_KEY=$(printf '%s' "$REPO" | shasum -a 256 | cut -c1-12)
  TMP="$HOME/.cache/pi-plugin-install/$CACHE_KEY"
  mkdir -p "$TMP"
  trap '' EXIT   # symlink 模式不清理 cache
else
  TMP=$(mktemp -d -t pi-plugin-install-XXXXXX)
  trap 'rm -rf "$TMP"' EXIT
fi

if [[ ! -d "$TMP/repo" ]]; then
  info "正在克隆 $REPO 的 extensions/ 目录…"
  if ! git clone --depth 1 --filter=blob:none --sparse "$GIT_URL" "$TMP/repo" 2>/dev/null; then
    err "克隆失败：$GIT_URL"
    err "检查网络或仓库名（--repo <owner/repo>）"
    exit 1
  fi
fi

if ! git -C "$TMP/repo" sparse-checkout set extensions 2>/dev/null; then
  err "sparse-checkout 失败：仓库内可能没有 extensions/ 目录"
  exit 1
fi

# ----------------------------------------------------------------------------
# Discover extensions
# ----------------------------------------------------------------------------
EXTS=()
for d in "$TMP/repo/extensions"/*/; do
  [[ -d "$d" ]] && EXTS+=("$(basename "$d")")
done

if [[ ${#EXTS[@]} -eq 0 ]]; then
  err "仓库内未找到 extensions/"
  exit 1
fi

# ----------------------------------------------------------------------------
# Select extensions
# ----------------------------------------------------------------------------
SELECTED=()
if [[ -n "$ONLY" ]]; then
  IFS=',' read -ra WANTED <<< "$ONLY"
  for w in "${WANTED[@]}"; do
    w="${w// /}"
    found=false
    for e in "${EXTS[@]}"; do
      if [[ "$e" == "$w" ]]; then
        SELECTED+=("$e"); found=true; break
      fi
    done
    [[ "$found" == false ]] && err "扩展 '$w' 不存在，跳过（可用：${EXTS[*]}）"
  done
elif [[ "$YES" == true ]]; then
  SELECTED=("${EXTS[@]}")
else
  echo ""
  echo "可用扩展（共 ${#EXTS[@]} 个）："
  for i in "${!EXTS[@]}"; do
    printf "  [%d] %s\n" $((i+1)) "${EXTS[$i]}"
  done
  echo ""
  read -rp "选择要装的扩展（逗号分隔编号，留空 = 全部）: " ans
  if [[ -z "$ans" ]]; then
    SELECTED=("${EXTS[@]}")
  else
    IFS=',' read -ra NUMS <<< "$ans"
    for n in "${NUMS[@]}"; do
      n="${n// /}"
      if [[ "$n" =~ ^[0-9]+$ ]] && (( n >= 1 && n <= ${#EXTS[@]} )); then
        SELECTED+=("${EXTS[$((n-1))]}")
      else
        err "无效编号 '$n'，跳过"
      fi
    done
  fi
fi

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  err "未选择任何扩展，退出"
  exit 0
fi

# ----------------------------------------------------------------------------
# Confirm target
# ----------------------------------------------------------------------------
if [[ "$TARGET" == "$DEFAULT_TARGET" && "$YES" == false ]]; then
  read -rp "安装目录 [$DEFAULT_TARGET]? (回车确认 / 输入新路径): " ans
  [[ -n "$ans" ]] && TARGET="$ans"
fi

# Expand ~ if used
TARGET="${TARGET/#\~/$HOME}"

if [[ ! -d "$TARGET" ]]; then
  if [[ "$YES" == true ]]; then
    info "创建目录：$TARGET"
  else
    read -rp "目录不存在：$TARGET，要创建吗? (y/N) " ans
    [[ ! "$ans" =~ ^[Yy]$ ]] && { err "取消"; exit 1; }
  fi
  mkdir -p "$TARGET"
fi

# ----------------------------------------------------------------------------
# Install
# ----------------------------------------------------------------------------
echo ""
info "开始安装 ${#SELECTED[@]} 个扩展到 ${TARGET}（${MODE} 模式）"
echo ""

for ext in "${SELECTED[@]}"; do
  src="$TMP/repo/extensions/$ext"
  dst="$TARGET/$ext"
  case "$MODE" in
    symlink)
      ln -sfn "$src" "$dst"
      echo "  🔗 $dst -> $src"
      ;;
    copy)
      rm -rf "$dst"
      cp -R "$src" "$dst"
      echo "  📋 $dst (复制)"
      ;;
  esac
done

echo ""
echo "✅ 已安装 ${#SELECTED[@]} 个扩展：${SELECTED[*]}"
echo "   目标：$TARGET"
echo ""
echo "重启 pi 或执行 /reload 加载新扩展"