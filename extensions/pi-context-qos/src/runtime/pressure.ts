import type {
  ContextQosConfig,
  PressureLevel,
} from "../types.ts";

export interface PressureReading {
  level: PressureLevel;
  ratio: number;
  effectiveBudget: number;
}

export function calculatePressure(
  tokens: number,
  contextWindow: number,
  config: ContextQosConfig,
): PressureReading {
  const reserve =
    contextWindow *
    (config.budget.outputReserveRatio + config.budget.safetyReserveRatio);
  const effectiveBudget = Math.max(1, Math.floor(contextWindow - reserve));
  const ratio = tokens / effectiveBudget;
  let level: PressureLevel = "green";
  if (ratio >= config.budget.critical) level = "critical";
  else if (ratio >= config.budget.red) level = "red";
  else if (ratio >= config.budget.orange) level = "orange";
  else if (ratio >= config.budget.yellow) level = "yellow";
  return { level, ratio, effectiveBudget };
}
