// D-HA-GEMINI-HINT-1: the query of the replace handle line. A bare command (`cat logs/app.log`) shares no word with
// the output, so the handle call listed the first chunks by position (D-HL-H9-1) and missed the line the user asked
// for. The second query is the words of the last user prompt that the output holds, fewest occurrences
// first, at most HANDLE_PROMPT_WORDS. No prompt or no shared word -> "" (the handle line is unchanged).
import { HANDLE_PROMPT_WORDS } from "../contracts/constants.ts";
import { wordTokens } from "../store/words.ts";

// T1007: a tool with none of description, command, file path, pattern or URL (an MCP search such as mem_search) used to
// give an empty first query. The fallback is the tool's own name plus the words of its string arguments, never empty.
export const TOOL_INTENT_ARG_WORDS = 6;
export function toolIntent(canonicalName: string, input: Record<string, unknown>): string {
  const name = wordTokens(canonicalName.slice(canonicalName.lastIndexOf(":") + 1).toLowerCase());
  const seen = new Set(name);
  const args: string[] = [];
  for (const value of Object.values(input)) {
    if (typeof value !== "string") continue;
    for (const w of wordTokens(value.toLowerCase())) {
      if (seen.has(w) || args.length >= TOOL_INTENT_ARG_WORDS) continue;
      seen.add(w); args.push(w);
    }
  }
  const words = [...name, ...args];
  return words.length === 0 ? canonicalName : words.join(" ");
}

export function askedWords(intent: string, prompt: string, text: string): string {
  const want = new Set(wordTokens(prompt.toLowerCase()));
  for (const w of wordTokens(intent.toLowerCase())) want.delete(w);
  if (want.size === 0) return "";
  const counts = new Map<string, number>();
  for (const w of wordTokens(text.toLowerCase())) {
    if (want.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const picked = [...counts.entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, HANDLE_PROMPT_WORDS)
    .map((e) => e[0]);
  return picked.join(" ");
}
