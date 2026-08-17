/**
 * pi-skill-inject — Inline skill loading for pi
 *
 * Type `/skill-name` inside a prompt to inject that skill's content into the
 * current turn without switching context or executing a command. Slash tokens
 * stay visible in the prompt so rewinding and editing previous prompts is easy.
 *
 * Design goals (vs. the upstream @tifan/pi-inline-skills):
 *  - Zero monkey-patching: no touching CustomEditor.prototype; uses the
 *    documented input/before_agent_start event flow.
 *  - Structured injection: passes ParsedSkillBlock through the message
 *    details instead of hand-building XML strings.
 *  - Cached skill lookup: skills, command names, normalized paths, and loaded
 *    skill contents are all cached per session.
 *  - Strict token matching: no false positives on URLs or partial words.
 *  - Case handling: exact match first, then case-insensitive fallback.
 *  - Idempotent autocomplete registration: safe across session switches
 *    (pi clears wrappers on session invalidate; re-registering on every
 *    session_start keeps the provider alive, and the idempotent shim
 *    prevents wrapper stacking).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ParsedSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkillCommand = {
  name: string;
  description?: string;
  source: string;
  sourceInfo?: {
    path?: string;
    source: string;
    scope: "user" | "project" | "temporary";
  };
};

type SkillInfo = {
  name: string;
  description?: string;
  /** Normalized (realpath'd) path to SKILL.md — computed once per session. */
  path: string;
  scope: SkillCommand["sourceInfo"]["scope"];
  source: string;
};

type AutocompleteItem = {
  value: string;
  label: string;
  description?: string;
};

type AutocompleteSuggestions = {
  items: AutocompleteItem[];
  prefix: string;
};

type AutocompleteProvider = {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
};

type LoadedSkillEntryData = {
  name?: string;
  source?: "tool-result";
};

type InlineSkillSessionEntry = {
  type: string;
  customType?: string;
  data?: LoadedSkillEntryData;
  details?: { names?: string[]; skills?: ParsedSkillBlock[] };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INLINE_SKILL_MESSAGE_TYPE = "inline-skill";
const LOADED_SKILL_ENTRY_TYPE = "loaded-skill";
const MAX_SUGGESTIONS = 30;

/**
 * Trigger token regex.
 * Matches a slash-prefixed token: `/name` where name is [a-z0-9][a-z0-9-]*.
 * Boundary rules:
 *  - matches ANYWHERE in the text (not only after whitespace), so
 *    `帮我看看/design-api-contracts` works too
 *  - NOT followed by `[a-z0-9-]` (avoids partial words)
 *  - URL-ish slashes (`//` or `:` before the token) are skipped in
 *    findInlineSkills by checking the preceding character
 */
const SKILL_TOKEN_RE =
  /\/([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-])(?=[\s.,;!?"')\]}])?/gi;

// ---------------------------------------------------------------------------
// Skill discovery & caching
// ---------------------------------------------------------------------------

/** Normalize a path for deduplication (realpath when possible). */
function normalizePath(path: string, cwd: string): string {
  const abs = path.startsWith("/") ? path : resolve(cwd, path);
  try {
    if (existsSync(abs)) return realpathSync(abs);
  } catch {
    /* fall through to resolved path */
  }
  return abs;
}

/**
 * Collect skill info + non-skill command names from pi's registered commands.
 * Skill paths are normalized once here so the hot tool_result path never
 * touches the filesystem.
 */
function collectResources(
  pi: ExtensionAPI,
  cwd: string,
): { skills: SkillInfo[]; commandNames: Set<string> } {
  const commands = pi.getCommands() as unknown as SkillCommand[];
  const skills: SkillInfo[] = [];
  const commandNames = new Set<string>();
  for (const cmd of commands) {
    if (cmd.source === "skill") {
      if (!cmd.name?.startsWith("skill:")) continue;
      const name = cmd.name.slice("skill:".length);
      const path = cmd.sourceInfo?.path;
      if (!path) continue;
      skills.push({
        name,
        description: cmd.description,
        path: normalizePath(path, cwd),
        scope: cmd.sourceInfo.scope ?? "user",
        source: cmd.sourceInfo.source ?? "",
      });
    } else if (cmd.name) {
      commandNames.add(cmd.name.toLowerCase());
    }
  }
  return { skills, commandNames };
}

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------

/**
 * Find inline skill tokens in text. Returns unique skill infos in order.
 * Exact name match first; falls back to case-insensitive.
 */
function findInlineSkills(
  text: string,
  skills: SkillInfo[],
): SkillInfo[] {
  const exact = new Map(skills.map((s) => [s.name, s]));
  const loose = new Map(skills.map((s) => [s.name.toLowerCase(), s]));

  const selected: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(SKILL_TOKEN_RE)) {
    const token = match[1];
    // Skip URL-ish slashes: `//` or `:` immediately before the token.
    const slashIdx = match.index;
    const prev = slashIdx > 0 ? text[slashIdx - 1] : "";
    if (prev === "/" || prev === ":") continue;
    const skill = exact.get(token) ?? loose.get(token.toLowerCase());
    if (!skill || seen.has(skill.name)) continue;
    seen.add(skill.name);
    selected.push(skill);
  }
  return selected;
}

/** Extract the slash-prefix being typed before the cursor, if any. */
function extractSlashSkillPrefix(textBeforeCursor: string): string | undefined {
  const slashIdx = textBeforeCursor.lastIndexOf("/");
  if (slashIdx === -1) return undefined;
  // Exclude URLs: `//` (protocol) or `:` before the slash (`http://`).
  const prev = slashIdx > 0 ? textBeforeCursor[slashIdx - 1] : "";
  if (prev === "/" || prev === ":") return undefined;
  const after = textBeforeCursor.slice(slashIdx + 1);
  if (!/^[a-z0-9:.-]*$/i.test(after)) return undefined;
  return after;
}

/** True when this is a bare `/token` at the very start of a prompt. */
function isPromptStartSlashToken(
  lines: string[],
  cursorLine: number,
  textBeforeCursor: string,
  prefix: string,
): boolean {
  const slashStart = textBeforeCursor.length - prefix.length - 1;
  if (slashStart < 0) return false;
  const earlierLinesBlank = lines
    .slice(0, cursorLine)
    .every((line) => line.trim().length === 0);
  return (
    earlierLinesBlank &&
    textBeforeCursor.slice(0, slashStart).trim() === ""
  );
}

// ---------------------------------------------------------------------------
// Skill content loading (with per-session cache)
// ---------------------------------------------------------------------------

/** Escape text for safe embedding in a single-line attribute. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n]/g, " ");
}

/** Strip YAML frontmatter, tolerant of `---` inside quoted description. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const lines = content.split("\n");
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return content;
  return lines.slice(closeIndex + 1).join("\n");
}

/** Read skill content and build the inline block (cached per skill path). */
function loadSkillBlockCached(
  skill: SkillInfo,
  cache: Map<string, ParsedSkillBlock>,
): ParsedSkillBlock {
  const cached = cache.get(skill.path);
  if (cached) return cached;
  const raw = readFileSync(skill.path, "utf-8");
  const body = stripFrontmatter(raw).trim();
  const block: ParsedSkillBlock = {
    name: skill.name,
    location: skill.path,
    content: `References are relative to ${dirname(skill.path)}.\n\n${body}`,
    userMessage: undefined,
  };
  cache.set(skill.path, block);
  return block;
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

function fuzzyScore(value: string, query: string): number {
  const target = value.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 1;
  if (target === needle) return 1000;
  if (target.startsWith(needle)) return 800 - target.length;
  if (target.includes(needle)) return 600 - target.indexOf(needle) - target.length;
  let score = 0;
  let last = -1;
  for (const ch of needle) {
    const idx = target.indexOf(ch, last + 1);
    if (idx === -1) return 0;
    score += idx === last + 1 ? 20 : 5;
    last = idx;
  }
  return score - target.length;
}

function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  // `/skill` browse-all trigger: list every skill.
  if (query === "skill") {
    return skills.slice(0, MAX_SUGGESTIONS);
  }
  // `/skill:name` filters by name (so /skill:design shows design-* only).
  if (query.startsWith("skill:")) {
    const sub = query.slice("skill:".length).toLowerCase();
    if (!sub) return skills.slice(0, MAX_SUGGESTIONS);
    return skills
      .filter((s) => s.name.toLowerCase().includes(sub))
      .slice(0, MAX_SUGGESTIONS);
  }
  return skills
    .map((s) => ({ s, score: fuzzyScore(s.name, query) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .map((e) => e.s);
}

function scopeTag(scope: SkillInfo["scope"]): string {
  return scope === "user" ? "u" : scope === "project" ? "p" : "t";
}

function itemDescription(skill: SkillInfo): string | undefined {
  const base = skill.description;
  const tag = `[${scopeTag(skill.scope)}]`;
  return base ? `${tag} ${base}` : tag;
}

/** Merge native + extension autocomplete items, deduplicating skills by name. */
function mergeAutocompleteItems(options: {
  current: AutocompleteSuggestions | null;
  skillItems: AutocompleteItem[];
  preferCommands: boolean;
  prefix: string;
}): AutocompleteSuggestions {
  const currentItems = options.current?.items ?? [];
  const ordered = options.preferCommands
    ? [...currentItems, ...options.skillItems]
    : [...options.skillItems, ...currentItems];
  const seen = new Set<string>();
  const items = ordered.filter((item) => {
    const isSkill = item.label.startsWith("skill:");
    const key = isSkill ? `skill:${item.label}` : `${item.label}\u0000${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { prefix: options.prefix, items: items.slice(0, MAX_SUGGESTIONS) };
}

/**
 * Create an idempotent autocomplete wrapper.
 *
 * pi clears extension autocomplete wrappers on session invalidate but keeps
 * the extension module loaded, so we re-register on every session_start.
 * Re-registering appends another wrapper closure; the shim detects
 * self-wrapping (current === shim) and returns itself to prevent stacking.
 */
function createIdempotentSkillWrapper(
  getSkills: () => SkillInfo[],
): (current: AutocompleteProvider) => AutocompleteProvider {
  let currentProvider: AutocompleteProvider | null = null;

  const shim: AutocompleteProvider = {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const native = currentProvider;
      if (!native) return null;
      const line = lines[cursorLine] ?? "";
      const before = line.slice(0, cursorCol);
      const query = extractSlashSkillPrefix(before);
      // Not a slash-skill context (or bare "/") — defer to native.
      if (query === undefined || (query === "" && before === "/")) {
        return native.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      const skills = getSkills();
      if (skills.length === 0) {
        return native.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      const matches = query
        ? filterSkills(skills, query).slice(0, MAX_SUGGESTIONS)
        : skills.slice(0, MAX_SUGGESTIONS);
      const atPromptStart = isPromptStartSlashToken(lines, cursorLine, before, query);
      // Consult native only at the prompt start (slash-command suggestions)
      // or when nothing skill-ish matches (fall back to file completion on
      // Tab). Mid-text skill matches skip native: the "/word" prefix would
      // otherwise trigger a root-filesystem search and return path noise.
      let nativeSuggestions: AutocompleteSuggestions | null = null;
      if (atPromptStart || matches.length === 0) {
        nativeSuggestions = await native.getSuggestions(
          lines,
          cursorLine,
          cursorCol,
          options,
        );
      }
      if (options.signal.aborted) return nativeSuggestions;
      if (matches.length === 0) return nativeSuggestions;

      const skillItems = matches.map((skill) => ({
        value: `/${skill.name}`,
        label: `skill:${skill.name}`,
        description: itemDescription(skill),
      }));

      return mergeAutocompleteItems({
        current: nativeSuggestions,
        skillItems,
        preferCommands: atPromptStart,
        prefix: query,
      });
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const native = currentProvider;
      const line = lines[cursorLine] ?? "";
      const slashStart = cursorCol - prefix.length - 1;
      const isSkillCompletion =
        item.label.startsWith("skill:") &&
        item.value.startsWith("/") &&
        slashStart >= 0 &&
        line[slashStart] === "/";
      if (!isSkillCompletion) {
        return native
          ? native.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
          : { lines, cursorLine, cursorCol };
      }
      const beforePrefix = line.slice(0, slashStart);
      const after = line.slice(cursorCol);
      const suffix = after.startsWith(" ") ? "" : " ";
      const next = [...lines];
      next[cursorLine] = `${beforePrefix}${item.value}${suffix}${after}`;
      return {
        lines: next,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + suffix.length,
      };
    },
  };

  return (current: AutocompleteProvider): AutocompleteProvider => {
    // Self-wrap detection: don't stack another layer over our own shim.
    if (current === shim) return shim;
    currentProvider = current;
    return shim;
  };
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

function restoreLoadedSkills(ctx: ExtensionContext): Set<string> {
  const loaded = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch() as InlineSkillSessionEntry[]) {
    if (entry.type === "custom" && entry.customType === LOADED_SKILL_ENTRY_TYPE) {
      const data = entry.data;
      if (data?.source === "tool-result" && data.name?.trim()) {
        loaded.add(data.name);
      }
    } else if (
      entry.type === "custom_message" &&
      entry.customType === INLINE_SKILL_MESSAGE_TYPE
    ) {
      for (const skill of entry.details?.skills ?? []) {
        if (skill.name.trim()) loaded.add(skill.name);
      }
    }
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  let pendingSkills: ParsedSkillBlock[] = [];
  let pendingNames: string[] = [];
  let loadedSkills = new Set<string>();

  // Session caches (reset on session_start).
  let skillsCache: SkillInfo[] = [];
  let commandNamesCache = new Set<string>();
  const contentCache = new Map<string, ParsedSkillBlock>();

  const skillWrapper = createIdempotentSkillWrapper(() => skillsCache);

  // TUI renderer for inline-skill messages.
  pi.registerMessageRenderer(
    INLINE_SKILL_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = message.details as
        | { names?: string[]; skills?: ParsedSkillBlock[] }
        | undefined;
      const names = details?.names?.length ? details.names.join(", ") : "skill";
      const label = theme.fg(
        "customMessageLabel",
        "\x1b[1m[inline-skill]\x1b[22m",
      );
      const container = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
      if (details?.skills?.length) {
        container.addChild(
          new Text(`${label} ${theme.fg("customMessageText", names)} ${theme.fg("dim", `(${details.skills.length} skills)`)}`, 0, 0),
        );
      } else {
        container.addChild(
          new Text(`${label} ${theme.fg("customMessageText", names)}`, 0, 0),
        );
      }
      void expanded;
      return container;
    },
  );

  // /loaded-skills command.
  pi.registerCommand("loaded-skills", {
    description: "List skills loaded inline in this session",
    handler: async (_args, ctx) => {
      const names = [...restoreLoadedSkills(ctx)].sort((a, b) =>
        a.localeCompare(b),
      );
      if (names.length === 0) {
        ctx.ui.notify("No inline skills loaded yet", "info");
        return;
      }
      ctx.ui.notify(`Inline skills loaded: ${names.join(", ")}`, "info");
    },
  });

  // Session start: refresh caches, (re-)register autocomplete.
  // Re-registering every time is required: pi clears extension autocomplete
  // wrappers on session invalidate without reloading this module.
  pi.on("session_start", async (_event, ctx) => {
    const resources = collectResources(pi, ctx.cwd);
    skillsCache = resources.skills;
    commandNamesCache = resources.commandNames;
    contentCache.clear();
    loadedSkills = restoreLoadedSkills(ctx);
    ctx.ui.addAutocompleteProvider(skillWrapper);
  });

  // Session tree change: refresh loaded set (rewind/fork support).
  pi.on("session_tree", async (_event, ctx) => {
    loadedSkills = restoreLoadedSkills(ctx);
  });

  // Mark skills as loaded when the model reads their SKILL.md.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    const readPath = normalizePath(input.path, ctx.cwd);
    for (const skill of skillsCache) {
      if (skill.path === readPath) {
        loadedSkills.add(skill.name);
        pi.appendEntry(LOADED_SKILL_ENTRY_TYPE, {
          name: skill.name,
          source: "tool-result",
        });
      }
    }
  });

  // Input: detect /token inline skills, queue for injection.
  pi.on("input", async (event, ctx) => {
    pendingSkills = [];
    pendingNames = [];
    loadedSkills = restoreLoadedSkills(ctx);
    if (event.source === "extension" || !event.text.includes("/")) {
      return { action: "continue" };
    }
    // Skip when a registered (non-skill) command starts the prompt.
    const startMatch = event.text.match(/^\/([a-z0-9][a-z0-9-]{0,63})/i);
    if (startMatch && commandNamesCache.has(startMatch[1].toLowerCase())) {
      return { action: "continue" };
    }

    const found = findInlineSkills(event.text, skillsCache);
    if (found.length === 0) return { action: "continue" };

    const toInject = found.filter((skill) => !loadedSkills.has(skill.name));
    if (toInject.length > 0) {
      try {
        pendingSkills = toInject.map((skill) =>
          loadSkillBlockCached(skill, contentCache),
        );
        pendingNames = toInject.map((skill) => skill.name);
      } catch (error) {
        pendingSkills = [];
        pendingNames = [];
        ctx.ui.notify(
          `inline-skills: failed to load skill: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return { action: "continue" };
      }
    }
    return { action: "transform", text: event.text };
  });

  // Inject queued skills into the agent start message.
  pi.on("before_agent_start", async () => {
    if (pendingSkills.length === 0) return;
    const skills = pendingSkills;
    const names = pendingNames;
    pendingSkills = [];
    pendingNames = [];
    return {
      message: {
        customType: INLINE_SKILL_MESSAGE_TYPE,
        content: skills
          .map((s) => `<skill name="${escapeXml(s.name)}" location="${escapeXml(s.location)}">\n${s.content}\n</skill>`)
          .join("\n\n"),
        display: true,
        details: { names, skills },
      },
    };
  });
}
