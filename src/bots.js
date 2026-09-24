// Bots that fill small games up to a minimum number of players (handy for testing solo).
// Multiple choice: bots pick a random option. Free text: one LLM call per question asks for
// a handful of realistic answers; if Bedrock is unavailable or slow, bots use canned answers.

import { normalizeAnswer } from './matching.js';

export const BOT_NAMES = ['Bessie', 'Clarabelle', 'Moolinda', 'Buttercup', 'Daisy', 'Hamish', 'Angus', 'Marigold'];

const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// Offline answers for the default free-text questions, plus a generic pool for anything else.
const FALLBACK_ANSWERS = {
  'name a breakfast food': ['Toast', 'Eggs', 'Pancakes', 'Bacon', 'Cereal', 'Avocado toast', 'Porridge', 'Croissant'],
  'name a country you d love to travel to': ['Japan', 'Italy', 'Iceland', 'Greece', 'Canada', 'Peru', 'France', 'Japan'],
  'favourite room in a house': ['Living room', 'Kitchen', 'Bedroom', 'Lounge', 'Kitchen', 'Bathroom', 'Study', 'Bedroom'],
  'most well known person': ['Taylor Swift', 'Barack Obama', 'Elon Musk', 'Beyoncé', 'Jesus', 'Michael Jackson', 'Obama'],
};
const GENERIC_ANSWERS = ['Pizza', 'Blue', 'Dogs', 'Coffee', 'Friday', 'The beach', 'Chocolate', 'Summer', 'Music'];

const SYSTEM_PROMPT = `You generate answers for bot players in a party game like "Herd Mentality", where people try to give the same answer as most others.
Answers must be short (1-4 words), realistic and varied: usually include one or two very common answers and some less common ones. Occasionally repeat a common answer, as real players would.
Reply with JSON only: {"answers":["...", "..."]}`;

export function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function fallbackAnswers(questionText, count) {
  const pool = FALLBACK_ANSWERS[normalizeAnswer(questionText)] ?? GENERIC_ANSWERS;
  return Array.from({ length: count }, () => pool[randomInt(pool.length)]);
}

/** Pull the answers array out of a model reply; throws on anything unusable. */
export function parseAnswers(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON in model reply');
  const answers = JSON.parse(text.slice(start, end + 1))?.answers;
  if (!Array.isArray(answers)) throw new Error('No answers array');
  const clean = answers
    .filter((a) => typeof a === 'string')
    .map((a) => a.replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(Boolean);
  if (!clean.length) throw new Error('Empty answers');
  return clean;
}

/**
 * @param {{ converse?: Function, enabled?: boolean, modelId?: string, timeoutMs?: number, log?: Console }} opts
 *   enabled: whether to ask the LLM for free-text answers (otherwise canned answers only)
 */
export function createBotBrain({ converse, enabled = true, modelId = DEFAULT_MODEL_ID, timeoutMs = 4000, log = console } = {}) {
  /** Free-text answers for `count` bots. Never rejects. */
  async function textAnswers(questionText, count) {
    if (!enabled || !converse || count < 1) return fallbackAnswers(questionText, count);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await converse({
        modelId,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: `Question: ${questionText}\nGive ${count} answers from ${count} different players.` },
        ],
        maxTokens: 300,
        temperature: 1,
        abortSignal: controller.signal,
      });
      const answers = shuffle(parseAnswers(res.text));
      // Top up with canned answers if the model returned too few.
      return [...answers, ...fallbackAnswers(questionText, count)].slice(0, count);
    } catch (err) {
      const reason = controller.signal.aborted ? `timed out after ${timeoutMs / 1000}s` : err.message;
      log.warn(`Bot answers from LLM failed, using canned answers: ${reason}`);
      return fallbackAnswers(questionText, count);
    } finally {
      clearTimeout(timer);
    }
  }

  return { textAnswers };
}
