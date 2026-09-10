#!/usr/bin/env bash
# baseline.sh — 仓库全 9 扩展测试基线（manual-only, 不替代各扩展自身 CI）
#
# 作用：
#   - 一次性跑完所有 9 个扩展的 `npm test`（policy-engine 加 `npm run check`）
#   - 收集每个扩展的 pass / fail 数
#   - 任一 fail 立即 exit 1（fail-fast）
#   - 退出时打印汇总
#
# 设计原则：
#   - 不读扩展内部、不依赖各扩展脚本命名（只调 npm 自带 test）
#   - 用 npm 自带 test 命令，不传额外参数；扩展可独立演进
#   - 不修改任何文件；纯只读 baseline
#   - 退出码 0 = 全绿，非 0 = 至少一扩展 fail
#
# 用法：
#   bash scripts/baseline.sh
#   或：npm run test:all（根 package.json 已挂载）

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 9 个扩展按字母序遍历（仓库根 pi.extensions 也是这个顺序）。
# policy-engine 是 plain JS，需要额外跑 `npm run check`（node --check glob）。
EXTENSIONS=(
  "pi-auto-compact"
  "pi-browser-test"
  "pi-footer-composer"
  "pi-mode-switcher"
  "pi-notify"
  "pi-policy-engine"
  "pi-quota-status"
  "pi-skill-inject"
  "pi-todo"
)

# 汇总表
declare -a NAMES
declare -a RESULTS
declare -a PASSES
declare -a FAILS
FAILED=0

# 解析 node --test 输出里的 pass / fail 数。
# node --test 默认在 stderr 打印 "ℹ pass N" / "ℹ fail N"；兼容 tsx --test。
# 用 awk 单遍扫描取最后一个匹配，避免 pipeline subshell 警告。
extract_pass_fail() {
  awk '
    {
      # 提取行末数字（node --test / tsx --test 的常见输出格式）
      line = $0
      if (line ~ /ℹ pass [0-9]+/) { match(line, /[0-9]+$/); pass = substr(line, RSTART, RLENGTH) }
      if (line ~ /ℹ fail [0-9]+/) { match(line, /[0-9]+$/); fail = substr(line, RSTART, RLENGTH) }
      # 兼容不带 ℹ 前缀的 runner
      if (line ~ /^pass [0-9]+/ && !pass) { match(line, /[0-9]+$/); pass = substr(line, RSTART, RLENGTH) }
      if (line ~ /^fail [0-9]+/ && !fail) { match(line, /[0-9]+$/); fail = substr(line, RSTART, RLENGTH) }
    }
    END { printf "%s / %s\n", (pass ? pass : "?"), (fail ? fail : "?") }
  ' "$1"
}

for ext in "${EXTENSIONS[@]}"; do
  ext_dir="extensions/$ext"
  if [ ! -d "$ext_dir" ]; then
    echo "✗ 跳过 $ext：目录不存在 ($ext_dir)"
    FAILED=1
    NAMES+=("$ext")
    RESULTS+=("MISSING")
    PASSES+=("?")
    FAILS+=("?")
    continue
  fi

  # 临时文件捕获 test 输出
  test_log=$(mktemp -t pi-baseline-XXXXXX)
  test_ok=0

  # policy-engine 的 npm test 内部已经跑 check 步骤；
  # 其余 8 扩展只跑 npm test。
  (
    cd "$ext_dir" || exit 1
    npm test >"$test_log" 2>&1
  ) && test_ok=1

  if [ "$test_ok" -eq 0 ]; then
    FAILED=1
    NAMES+=("$ext")
    RESULTS+=("FAIL")
    # 输出尾部 30 行便于定位
    echo
    echo "── $ext / npm test 失败，尾部输出 ──"
    tail -n 30 "$test_log" 2>/dev/null || true
    PASSES+=("?")
    FAILS+=("?")
  else
    NAMES+=("$ext")
    RESULTS+=("PASS")
    stats=$(extract_pass_fail "$test_log")
    PASSES+=("${stats% /*}")
    FAILS+=("${stats#* / }")
  fi

  rm -f "$test_log"
done

# 汇总
echo
echo "════════════════════════════════════════════════════════════════"
echo "  baseline 汇总（仓库根 ${REPO_ROOT}）"
echo "════════════════════════════════════════════════════════════════"
printf "  %-22s %-6s %-12s\n" "extension" "result" "pass / fail"
printf "  %-22s %-6s %-12s\n" "─────────" "──────" "──────────"
for i in "${!NAMES[@]}"; do
  printf "  %-22s %-6s %-12s\n" "${NAMES[$i]}" "${RESULTS[$i]}" "${PASSES[$i]} / ${FAILS[$i]}"
done
echo "════════════════════════════════════════════════════════════════"

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "✗ baseline 失败：至少一个扩展有 fail（fail-fast）"
  exit 1
fi

echo
echo "✓ baseline 全绿：9 扩展 check + test 通过"
exit 0
