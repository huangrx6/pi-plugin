#!/usr/bin/env bash
# bin/install.sh ——把 huangrx6/pi-plugin 的所有 extensions 软链到 pi 的扩展目录
#
# 用法:
#   bash <(curl -fsSL https://raw.githubusercontent.com/huangrx6/pi-plugin/main/bin/install.sh)
#   bash <(curl ...) ~/.pi/agent/extensions   # 默认目标
#   bash <(curl ...) ./.pi/extensions          # 项目级
#
# 默认目标：~/.pi/agent/extensions
# 工作原理：把 monorepo clone 到目标目录下的 _huangrx6-pi-plugin/，再软链每个
# extensions/<name>/ 到目标目录。升级只需 cd _huangrx6-pi-plugin && git pull。
#
# 只接受一个位置参数（目标目录），其它不做——更精细的选择请直接用
# `pi install git:github.com/huangrx6/pi-plugin` 走 pi 自己的包管理。

set -euo pipefail

DEFAULT_TARGET="$HOME/.pi/agent/extensions"
TARGET="${1:-$DEFAULT_TARGET}"
TARGET="${TARGET/#\~/$HOME}"
REPO_URL="https://github.com/huangrx6/pi-plugin.git"

SOURCE="$TARGET/_huangrx6-pi-plugin"

if [[ ! -d "$SOURCE/.git" ]]; then
  echo "克隆 $REPO_URL → $SOURCE"
  git clone --depth 1 "$REPO_URL" "$SOURCE"
fi

mkdir -p "$TARGET"
for ext in "$SOURCE"/extensions/*/; do
  [[ -d "$ext" ]] || continue
  name=$(basename "$ext")
  ln -sfn "$ext" "$TARGET/$name"
  echo "  🔗 $TARGET/$name → $ext"
done

echo ""
echo "✅ 已软链所有 extensions 到 $TARGET"
echo ""
echo "下一步：重启 pi 或执行 /reload"
echo "升级：  cd $SOURCE && git pull"