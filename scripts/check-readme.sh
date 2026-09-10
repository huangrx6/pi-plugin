#!/usr/bin/env bash
# check-readme.sh — 文档一致性检查 (P3.4)
#
# 验证（每扩展）：
#   1. package.json version === CHANGELOG.md 最新条目 version
#   2. description 字面量 ≤ 120 字符（npm 字段限制）
#   3. description 不含 TODO/FIXME 占位文本
#
# 退出码：0 = 全部干净；1 = 至少一个 error（warning 不影响退出码）。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

errors=0
warnings=0

error() {
  echo "[error] $1"
  errors=$((errors + 1))
}
warn() {
  echo "[warn] $1"
  warnings=$((warnings + 1))
}

for ext_dir in extensions/*/; do
  pkg="${ext_dir%/}"
  name="$(basename "$ext_dir")"

  # 跳过下划线前缀的内部目录（如 extensions/_shared/）
  case "$name" in
  _*) continue ;;
  esac

  pkg_json="$pkg/package.json"
  changelog="$pkg/CHANGELOG.md"
  if [ ! -f "$pkg_json" ]; then
    warn "$name: 无 package.json，跳过"
    continue
  fi

  # --- 1. version === CHANGELOG ---
  pkg_version=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$pkg_json','utf8')).version)}catch(e){console.log('?')}" 2>/dev/null)
  if [ ! -f "$changelog" ]; then
    error "$name: 缺 CHANGELOG.md"
    continue
  fi
  cl_version=$(awk '/^## / { sub(/^## /,""); sub(/[[:space:]-].*/,""); print; exit }' "$changelog" 2>/dev/null)
  if [ "$pkg_version" = "?" ]; then
    error "$name: package.json version 无法解析"
  elif [ "$cl_version" = "" ]; then
    error "$name: CHANGELOG.md 无 H2 版本条目"
  elif [ "$pkg_version" != "$cl_version" ]; then
    error "$name: version 失同步（package.json=$pkg_version vs CHANGELOG=$cl_version）"
  fi

  # --- 2. description 字数 ≤ 120 ---
  desc=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('$pkg_json','utf8')).description||'';console.log(d)}catch(e){console.log('')}" 2>/dev/null)
  desc_len=${#desc}
  if [ "$desc_len" -gt 120 ]; then
    error "$name: description 长度 $desc_len > 120（npm 字段限制）"
  fi

  # --- 3. description 不含 TODO/FIXME 占位 ---
  if echo "$desc" | grep -qiE "TODO|FIXME|XXX|占位"; then
    error "$name: description 含 TODO/FIXME 占位文本（应改为正式文案）"
  fi
done

echo
echo "════════════════════════════════════════════════════════════════"
echo "  check-readme 汇总"
echo "════════════════════════════════════════════════════════════════"
if [ "$errors" -eq 0 ] && [ "$warnings" -eq 0 ]; then
  echo "✓ 无问题：所有扩展 version 同步、description 合法"
elif [ "$errors" -eq 0 ]; then
  echo "  $warnings warning(s)（不阻断）"
else
  echo "  $errors error(s), $warnings warning(s)"
fi

exit "$errors"
