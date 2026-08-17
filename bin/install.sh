#!/usr/bin/env bash
# bin/install.sh ——把 huangrx6/pi-plugin 的所有 extensions 软链到 pi 的扩展目录
#
# 用法（全交互，无需参数）:
#   bash <(curl -fsSL https://raw.githubusercontent.com/huangrx6/pi-plugin/main/bin/install.sh)
#
# 流程:
#   1. 显示仓库里所有 extensions
#   2. 让你勾选要装的（多选 / 全选）
#   3. 让你输入目标目录（默认 ~/.pi/agent/extensions）
#   4. 把 monorepo clone 到 目标/_huangrx6-pi-plugin/，软链每个选中的 extension
#
# 升级：cd 目标/_huangrx6-pi-plugin && git pull，然后 /reload。

set -euo pipefail

DEFAULT_TARGET="$HOME/.pi/agent/extensions"
REPO_URL="https://github.com/huangrx6/pi-plugin.git"

# ----------------------------------------------------------------------------
# 1. Discover available extensions
# ----------------------------------------------------------------------------
TMP=$(mktemp -d -t pi-plugin-discover-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

echo "正在探测仓库 extensions/ ..."
if ! git clone --depth 1 --filter=blob:none --sparse "$REPO_URL" "$TMP/repo" 2>/dev/null; then
  echo "❌ 克隆失败：$REPO_URL" >&2
  exit 1
fi
git -C "$TMP/repo" sparse-checkout set extensions 2>/dev/null

EXTS=()
for d in "$TMP/repo/extensions"/*/; do
  [[ -d "$d" ]] && EXTS+=("$(basename "$d")")
done

if [[ ${#EXTS[@]} -eq 0 ]]; then
  echo "❌ 仓库内未找到 extensions/"
  exit 1
fi

# ----------------------------------------------------------------------------
# 2. Select extensions (interactive multi-select)
# ----------------------------------------------------------------------------
echo ""
echo "可用 extensions（共 ${#EXTS[@]} 个）："
for i in "${!EXTS[@]}"; do
  printf "  [%d] %s\n" $((i+1)) "${EXTS[$i]}"
done
echo ""
read -rp "选择要装的扩展（逗号分隔编号 / all / 回车 = 全部）: " ans

SELECTED=()
if [[ -z "$ans" || "$ans" == "all" ]]; then
  SELECTED=("${EXTS[@]}")
else
  IFS=',' read -ra NUMS <<< "$ans"
  for n in "${NUMS[@]}"; do
    n="${n// /}"
    if [[ "$n" =~ ^[0-9]+$ ]] && (( n >= 1 && n <= ${#EXTS[@]} )); then
      SELECTED+=("${EXTS[$((n-1))]}")
    else
      echo "⚠️  无效编号 '$n'，跳过"
    fi
  done
fi

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  echo "未选择任何扩展，退出"
  exit 0
fi

# ----------------------------------------------------------------------------
# 3. Ask for target directory (interactive)
# ----------------------------------------------------------------------------
echo ""
read -rp "安装目录 [回车 = $DEFAULT_TARGET]: " TARGET
TARGET="${TARGET:-$DEFAULT_TARGET}"
TARGET="${TARGET/#\~/$HOME}"

if [[ ! -d "$TARGET" ]]; then
  read -rp "目录 $TARGET 不存在，要创建吗? (y/N) " ans
  [[ ! "$ans" =~ ^[Yy]$ ]] && { echo "取消"; exit 1; }
  mkdir -p "$TARGET"
fi

# ----------------------------------------------------------------------------
# 4. Clone + symlink
# ----------------------------------------------------------------------------
SOURCE="$TARGET/_huangrx6-pi-plugin"

if [[ ! -d "$SOURCE/.git" ]]; then
  echo ""
  echo "克隆仓库到 $SOURCE ..."
  git clone --depth 1 "$REPO_URL" "$SOURCE"
fi

mkdir -p "$TARGET"
echo ""
echo "安装 ${#SELECTED[@]} 个 extension 到 ${TARGET}："
for ext in "${SELECTED[@]}"; do
  src="$SOURCE/extensions/$ext"
  dst="$TARGET/$ext"
  ln -sfn "$src" "$dst"
  echo "  🔗 $dst → $src"
done

echo ""
echo "✅ 完成。"
echo ""
echo "下一步：重启 pi 或 /reload"
echo "升级：  cd $SOURCE && git pull"