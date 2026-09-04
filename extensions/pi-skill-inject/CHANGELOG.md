# Changelog

## 0.2.0 - 2026-09-04

- Replace the English inline marker with a compact themed “技能已加载” activity row; expanded mode now shows the complete sanitized skill names and source paths used for that turn, wrapped at the actual terminal width and aligned with Pi's output padding.
- Make `/loaded-skills` a readable Chinese vertical list and keep its empty state concise.
- Sanitize and display-width-truncate skill descriptions, paths and load errors before rendering them in terminal UI.

## 0.1.1 - 2026-08-27

- Fix false-positive skill injection: the token regex ended with an OPTIONAL boundary lookahead `(?=[\s.,;!?"')\]}])?` — the trailing `?` made the whole lookahead a no-op, so `/review的`, `/api=v2`, and `/name中文` all matched their prefixes and injected skills the user never asked for. The boundary is now anchored: whitespace, punctuation, or end of input (`(?=[...]|$)`).
- Cache realpath normalization per session: the `tool_result` handler fires on every `read` result and used to pay two synchronous syscalls (`existsSync` + `realpathSync`) each time; the cache is cleared on `session_start` alongside `contentCache`.
- Add test infrastructure (tsconfig + ambient shims + `npm run check` / `npm test`) per the repo convention, with token-boundary regression tests covering the CJK-suffix and `=` cases plus findInlineSkills resolution.

## 0.1.0 - 2026-08-27

- Inline skill loading: type `/skill-name` in a prompt to inject that skill's content for the current turn.
