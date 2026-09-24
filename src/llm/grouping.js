// LLM-assisted grouping for free-text answers.
//
// Text matching (src/matching.js) runs first and catches typos and plurals. The LLM then
// merges groups that mean the same thing but are spelled differently ("Obama" and
// "Barack Obama"). It can only MERGE existing groups — it never sees or moves individual
// players — and anything it returns is validated. If Bedrock fails, times out, or returns
// junk, the text-matching groups are used unchanged, so the game never stalls or crashes.

import { MODELS } from './bedrock.js';

const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'; // fast + cheap for this job

const SYSTEM_PROMPT = `You judge answers for a party game like "Herd Mentality", where players score by giving the same answer as most other players.
Answers have already been grouped by spelling. Your job is to MERGE groups that clearly refer to the same thing.

Merge when answers are the same thing written differently:
- full vs short names and nicknames ("Barack Obama" = "Obama", "Maccas" = "McDonald's")
- synonyms and common alternative names ("soda" = "soft drink", "football" = "soccer" only if the question makes that clear)
- abbreviations, translations, articles or filler words ("the USA" = "United States" = "America")
- misspellings the spelling pass missed

Keep answers separate when they are genuinely different, even if related:
- a specific variety vs something else ("Toast" ≠ "French toast", "Eggs" ≠ "Eggs Benedict")
- different people, places or characters ("Harry Potter" ≠ "Hermione Granger")
When unsure, keep them separate.

Reply with JSON only, no prose, in exactly this shape:
{"groups":[{"label":"<best display name>","ids":["g1","g3"]}]}
Every input id must appear in exactly one group. Use the most recognisable form of the answer as the label.`;

/** Build the user message listing each text-matched group. */
export function buildPrompt(questionText, groups) {
  const lines = groups.map((g, i) => {
    const also = g.variants?.length ? ` (also typed: ${g.variants.join(', ')})` : '';
    return `g${i + 1} | ${g.label}${also} | ${g.playerIds.length} ${g.playerIds.length === 1 ? 'player' : 'players'}`;
  });
  return `Question: ${questionText}\n\nAnswer groups (id | answer | players):\n${lines.join('\n')}`;
}

/** Pull the first JSON object out of a model reply (tolerates code fences or stray prose). */
export function parseReply(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON in model reply');
  const data = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(data?.groups)) throw new Error('Model reply has no groups array');
  return data;
}

/**
 * Apply the model's merges to the text-matched groups, defensively:
 * unknown ids are ignored, duplicate ids count once (first group wins),
 * and any group the model forgot stays on its own.
 */
export function applyMerges(groups, reply) {
  const byId = new Map(groups.map((g, i) => [`g${i + 1}`, g]));
  const used = new Set();
  const merged = [];

  for (const entry of reply.groups) {
    const members = (Array.isArray(entry?.ids) ? entry.ids : [])
      .map(String)
      .filter((id) => byId.has(id) && !used.has(id));
    if (!members.length) continue;
    members.forEach((id) => used.add(id));
    merged.push(combine(members.map((id) => byId.get(id)), entry.label));
  }
  for (const [id, g] of byId) if (!used.has(id)) merged.push(g);

  return merged.sort((a, b) => b.playerIds.length - a.playerIds.length || a.label.localeCompare(b.label));
}

function combine(members, suggestedLabel) {
  if (members.length === 1 && !suggestedLabel) return members[0];
  const biggest = [...members].sort((a, b) => b.playerIds.length - a.playerIds.length)[0];
  const label =
    typeof suggestedLabel === 'string' && suggestedLabel.trim() && suggestedLabel.length <= 60
      ? suggestedLabel.trim()
      : biggest.label;

  // Everything people typed that isn't the label, so the reveal shows what was merged.
  const seen = new Set([label.toLowerCase()]);
  const variants = [];
  for (const g of members) {
    for (const s of [g.label, ...(g.variants ?? [])]) {
      if (seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      variants.push(s);
    }
  }
  return { label, variants, playerIds: members.flatMap((g) => g.playerIds) };
}

/**
 * Create the grouping judge used by the game.
 * @param {{ converse: Function, enabled?: boolean, modelId?: string, timeoutMs?: number, log?: Console }} opts
 */
export function createJudge({
  converse,
  enabled = true,
  modelId = DEFAULT_MODEL_ID,
  timeoutMs = 8000,
  log = console,
}) {
  const status = {
    enabled,
    state: enabled ? 'unknown' : 'disabled', // unknown | ready | error | disabled
    message: enabled ? 'Not used yet' : 'Turned off (LLM_GROUPING=off)',
    modelId,
    modelName: MODELS[modelId] ?? modelId,
  };

  /**
   * @returns {Promise<{ groups: object[], method: 'llm' | 'text', note: string }>} never rejects
   */
  async function group(questionText, textGroups) {
    if (!enabled) return { groups: textGroups, method: 'text', note: 'Grouped by text matching' };
    if (textGroups.length < 2) {
      return { groups: textGroups, method: 'text', note: 'Grouped by text matching' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await converse({
        modelId,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(questionText, textGroups) }],
        maxTokens: 2000,
        temperature: 0,
        abortSignal: controller.signal,
      });
      const groups = applyMerges(textGroups, parseReply(res.text));
      const merges = textGroups.length - groups.length;
      Object.assign(status, { state: 'ready', message: `Working (${status.modelName}, ${Date.now() - started} ms)` });
      log.log(`LLM grouping: ${textGroups.length} -> ${groups.length} groups in ${Date.now() - started} ms`);
      return {
        groups,
        method: 'llm',
        note: `Grouped by ${status.modelName}${merges ? ` · ${merges} ${merges === 1 ? 'merge' : 'merges'}` : ''}`,
      };
    } catch (err) {
      const reason = controller.signal.aborted ? `timed out after ${timeoutMs / 1000}s` : err.message;
      Object.assign(status, { state: 'error', message: reason });
      log.warn(`LLM grouping failed, using text matching: ${reason}`);
      return { groups: textGroups, method: 'text', note: 'Grouped by text matching (AI unavailable)' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { group, status };
}
