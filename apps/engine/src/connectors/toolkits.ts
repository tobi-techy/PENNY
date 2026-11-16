/**
 * Which connector toolkits a crew member may use.
 *
 * A built-in bot's apps are fixed (they ship with the product). A custom bot's
 * apps come from its grants: each capability tool names the toolkit it unlocks,
 * so a bot that was granted `post_x` gets X, and a bot that was granted nothing
 * gets no connector tools at all. The grant list is the single source of truth;
 * there is no separate "toolkits" setting that could disagree with it.
 */

/** Explicit toolkits per built-in bot. null = no connector tools at all. */
const BUILT_IN_TOOLKITS: Record<string, string[] | null> = {
  penny: ['gmail', 'github'],
  mail: ['gmail'],
  finance: ['gmail'],
  errand: ['gmail', 'github'],
  invest: null,
  guard: null,
};

/**
 * Capability tools: granting one asks for that app's tools. They are not
 * callable themselves (ToolDef.capability), because the real work is done by the
 * toolkit's own tools, whose names come from the connector at runtime.
 *
 * The value is the connector's own toolkit slug: sessions are created with these
 * exact strings, and a write slug must start with the toolkit name (TWITTER_* for
 * twitter), so "x" the product is "twitter" here.
 */
export const TOOLKIT_FOR_TOOL: Record<string, string> = {
  read_github: 'github',
  github_comment: 'github',
  read_x: 'twitter',
  post_x: 'twitter',
};

/** Old default for a bot-shaped caller with no tool list (bills scan, smoke scripts). */
const FALLBACK_TOOLKITS = ['gmail', 'github'];

/** Every toolkit a write may name when no bot is in the picture. */
export const ALL_TOOLKITS: readonly string[] = [
  ...new Set([
    ...Object.values(BUILT_IN_TOOLKITS).flatMap((t) => t ?? []),
    ...Object.values(TOOLKIT_FOR_TOOL),
  ]),
].sort();

/** The apps a set of granted tools asks for. Deterministic order (sorted, deduped). */
export function toolkitsForTools(toolIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of toolIds) {
    const toolkit = TOOLKIT_FOR_TOOL[id];
    if (toolkit) out.add(toolkit);
  }
  return [...out].sort();
}

/**
 * Toolkits for one crew member.
 * - built-in: the fixed list above (null stays null)
 * - custom with a grant list: exactly the apps its grants name (possibly none)
 * - no bot row and no list: the old default, for callers that only have a slug
 */
export function toolkitsForBot(
  botSlug: string | null | undefined,
  toolIds?: readonly string[],
): string[] | null {
  if (botSlug && botSlug in BUILT_IN_TOOLKITS) return BUILT_IN_TOOLKITS[botSlug] ?? null;
  if (toolIds) return toolkitsForTools(toolIds);
  return FALLBACK_TOOLKITS;
}
