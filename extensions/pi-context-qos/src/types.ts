export type ContextTier =
  | "pinned"
  | "working"
  | "evidence"
  | "historical"
  | "disposable";

export type Representation = "raw" | "extract" | "summary" | "tombstone";

export type PressureLevel =
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "critical";

export interface ContextQosConfig {
  enabled: boolean;
  budget: {
    outputReserveRatio: number;
    safetyReserveRatio: number;
    yellow: number;
    orange: number;
    red: number;
    critical: number;
    nativeCompactFallback: boolean;
  };
  frontier: {
    protectedUserTurns: number;
    protectedCausalBlocks: number;
  };
  storage: {
    directory: string;
    maxBytes: number;
    maxAgeDays: number;
  };
  epochs: {
    maxTurns: number;
  };
  security: {
    archiveSecrets: boolean;
    excludePatterns: string[];
  };
}

export interface StructuredSummary {
  headline: string;
  facts: string[];
  decisions: string[];
  errors: string[];
  files: string[];
  symbols: string[];
  unresolved: string[];
  nextRelevantActions: string[];
}

export interface ArchiveCandidate {
  sessionId: string;
  originEntryId: string | null;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  rawText: string;
  isError: boolean;
  turn: number;
  taskId: string | null;
}

export interface StoredContextItem {
  id: string;
  sessionId: string;
  taskId: string | null;
  originEntryId: string | null;
  toolCallId: string;
  toolName: string;
  kind: string;
  testIdentity: string | null;
  filePath: string | null;
  createdTurn: number;
  lastUsedTurn: number;
  rawHash: string;
  blobHash: string | null;
  rawTokens: number;
  activeTokens: number;
  tier: ContextTier;
  representation: Representation;
  importance: number;
  relevance: number;
  retentionScore: number;
  unresolved: boolean;
  pinned: boolean;
  supersededBy: string | null;
  duplicateOf: string | null;
  extractText: string;
  summaryText: string;
  searchText: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ContextStats {
  activeTokens: number;
  rawTokens: number;
  savedTokens: number;
  coldBytes: number;
  itemCount: number;
  pressure: PressureLevel;
  pressureRatio: number;
  frozen: boolean;
  byTier: Record<ContextTier, number>;
  byRepresentation: Record<Representation, number>;
}

export interface LooseMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  [key: string]: unknown;
}

export interface PlanDecision {
  item: StoredContextItem;
  representation: Representation;
}
