import type { FooterConfig, StatusKind } from "./config.ts";

/** User mappings are exact, content-agnostic and take precedence over prefixes. */
export function sectionOf(key: string, routes?: FooterConfig["statusRoutes"]): StatusKind {
  if (routes && Object.hasOwn(routes, key)) return routes[key];
  for (const kind of ["quota", "usage", "context", "integration", "config"] as const) {
    if (key.startsWith(`${kind}:`)) return kind;
  }
  return "misc";
}
