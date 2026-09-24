import { randomUUID } from 'node:crypto';
import { groupFreeText } from './matching.js';
import { DEFAULT_QUESTIONS, DEFAULT_SETTINGS } from './default-questions.js';

// Phases, in order:
//   lobby -> question -> reveal -> leaderboard -> question -> ... -> reveal -> finished
export const PHASES = ['lobby', 'question', 'reveal', 'leaderboard', 'finished'];

const MAX_NAME_LENGTH = 24;
const MAX_ANSWER_LENGTH = 60;
const LEADERBOARD_SIZE = 10;

// ---------------------------------------------------------------------------
// Question library validation
// ---------------------------------------------------------------------------

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Validate timer settings. Missing values fall back to the defaults. */
export function validateSettings(input = {}) {
  const read = (key, label) => {
    // Older saves used a single secondsPerQuestion for everything.
    const raw = input[key] ?? input.secondsPerQuestion ?? DEFAULT_SETTINGS[key];
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120) {
      throw new Error(`${label} timer must be between 5 and 120 seconds.`);
    }
    return Math.round(seconds);
  };
  return {
    choiceSeconds: read('choiceSeconds', 'Multiple choice'),
    textSeconds: read('textSeconds', 'Free text'),
  };
}

export function secondsFor(question, settings) {
  return question.type === 'choice' ? settings.choiceSeconds : settings.textSeconds;
}

/** Validate and normalise a question library; throws with a readable message on bad input. */
export function validateLibrary(input) {
  const settings = validateSettings(input?.settings);
  if (!Array.isArray(input?.questions)) throw new Error('Questions must be a list.');
  if (input.questions.length > 50) throw new Error('That is a lot of questions — keep it under 50.');

  const questions = input.questions.map((q, i) => {
    const label = `Question ${i + 1}`;
    const text = cleanText(q?.text, 140);
    if (!text) throw new Error(`${label} needs some text.`);
    if (q.type === 'text') return { type: 'text', text };
    if (q.type !== 'choice') throw new Error(`${label} has an unknown type.`);
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => cleanText(o, 60)).filter(Boolean);
    if (options.length < 2) throw new Error(`${label} needs at least 2 options.`);
    if (options.length > 24) throw new Error(`${label} has too many options (max 24).`);
    const lower = options.map((o) => o.toLowerCase());
    if (new Set(lower).size !== lower.length) throw new Error(`${label} has duplicate options.`);
    return { type: 'choice', text, options };
  });

  return { settings, questions };
}

export function defaultLibrary() {
  return structuredClone({ settings: DEFAULT_SETTINGS, questions: DEFAULT_QUESTIONS });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Work out the herd for one question.
 * Everyone in the most popular answer scores a point. Ties for most popular all score.
 * If nobody shares an answer (top group of 1) there is no herd and nobody scores.
 */
export function scoreQuestion(question, answers) {
  let groups;
  if (question.type === 'choice') {
    groups = question.options.map((label, index) => ({
      label,
      playerIds: Object.entries(answers)
        .filter(([, value]) => value === index)
        .map(([pid]) => pid),
    }));
    // Stable sort keeps the original option order for equal counts.
    groups.sort((a, b) => b.playerIds.length - a.playerIds.length);
  } else {
    groups = groupFreeText(Object.entries(answers).map(([playerId, text]) => ({ playerId, text })));
  }

  const top = groups[0]?.playerIds.length ?? 0;
  const herdGroups = top >= 2 ? groups.filter((g) => g.playerIds.length === top) : [];

  return {
    groups: groups.map((g) => ({ ...g, isHerd: herdGroups.includes(g) })),
    herdLabels: herdGroups.map((g) => g.label),
    herdPlayerIds: herdGroups.flatMap((g) => g.playerIds),
    answeredCount: Object.keys(answers).length,
  };
}

/** Standard competition ranking (1, 2, 2, 4) over all players in the game. */
export function rankPlayers(players, results) {
  const scores = new Map(Object.keys(players).map((id) => [id, 0]));
  for (const result of results) {
    if (!result) continue;
    for (const id of result.herdPlayerIds) {
      if (scores.has(id)) scores.set(id, scores.get(id) + 1);
    }
  }
  const sorted = Object.values(players)
    .map((p) => ({ id: p.id, name: p.name, score: scores.get(p.id), joinedAt: p.joinedAt }))
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);

  let rank = 0;
  return sorted.map((p, i) => {
    if (i === 0 || p.score !== sorted[i - 1].score) rank = i + 1;
    return { id: p.id, name: p.name, score: p.score, rank };
  });
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

function freshGame(players = {}) {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    startedAt: null,
    phase: 'lobby',
    questionIndex: -1,
    questions: [], // snapshot of the library taken when the game starts
    settings: null,
    deadline: null,
    players,
    answers: [], // answers[questionIndex] = { playerId: optionIndex | text }
    results: [], // results[questionIndex] = scoreQuestion(...)
  };
}

export class Game {
  /**
   * @param {ReturnType<import('./store.js').createStore>} store
   * @param {{ onChange: () => void, isOnline: (playerId: string) => boolean }} hooks
   */
  constructor(store, { onChange, isOnline }) {
    this.store = store;
    this.onChange = onChange;
    this.isOnline = isOnline;
    this.timer = null;

    this.library = this.loadLibrary();
    this.state = store.read('game.json', null) ?? freshGame();
    if (this.state.settings) this.state.settings = validateSettings(this.state.settings); // older saves
    if (this.state.phase === 'question') this.scheduleClose(); // resume a timer after restart
  }

  loadLibrary() {
    const saved = this.store.read('questions.json', null);
    if (!saved) return defaultLibrary();
    try {
      return validateLibrary(saved);
    } catch (err) {
      console.warn(`data/questions.json is invalid (${err.message}); using defaults.`);
      return defaultLibrary();
    }
  }

  // --- persistence ---------------------------------------------------------

  changed() {
    this.store.write('game.json', this.state);
    this.onChange();
  }

  archive() {
    const s = this.state;
    if (!s.startedAt) return; // nothing worth keeping
    const stamp = s.startedAt.replace(/[:.]/g, '-');
    this.store.writeNow(`games/${stamp}.json`, { ...s, leaderboard: this.leaderboard() });
  }

  // --- questions -------------------------------------------------------------

  setLibrary(input) {
    if (this.state.phase !== 'lobby') throw new Error('Questions can only be edited before the game starts.');
    this.library = validateLibrary(input);
    this.store.write('questions.json', this.library);
    this.onChange();
    return this.library;
  }

  resetLibrary() {
    return this.setLibrary(defaultLibrary());
  }

  /** Change just the timers (from the lobby screen) without touching the questions. */
  setSettings(input) {
    if (this.state.phase !== 'lobby') throw new Error('Timers can only be changed before the game starts.');
    this.library.settings = validateSettings({ ...this.library.settings, ...input });
    this.store.write('questions.json', this.library);
    this.onChange();
    return this.library.settings;
  }

  get currentQuestion() {
    return this.state.questions[this.state.questionIndex] ?? null;
  }

  get isLastQuestion() {
    return this.state.questionIndex >= this.state.questions.length - 1;
  }

  // --- players ---------------------------------------------------------------

  uniqueName(name, excludeId) {
    const taken = new Set(
      Object.values(this.state.players)
        .filter((p) => p.id !== excludeId)
        .map((p) => p.name.toLowerCase()),
    );
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const candidate = `${name} (${n})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  join(rawName, playerId) {
    const name = cleanText(rawName, MAX_NAME_LENGTH);
    if (!name) throw new Error('Please enter a name.');
    const existing = typeof playerId === 'string' ? this.state.players[playerId] : undefined;
    const id = existing?.id ?? randomUUID();
    this.state.players[id] = {
      id,
      name: this.uniqueName(name, id),
      joinedAt: existing?.joinedAt ?? Date.now(),
    };
    this.changed();
    return this.state.players[id];
  }

  getPlayer(id) {
    return typeof id === 'string' ? this.state.players[id] : undefined;
  }

  kick(id) {
    if (!this.state.players[id]) return false;
    delete this.state.players[id];
    for (const answers of this.state.answers) if (answers) delete answers[id];
    this.changed();
    return true;
  }

  // --- flow ------------------------------------------------------------------

  start() {
    if (this.state.phase !== 'lobby') throw new Error('The game has already started.');
    if (this.library.questions.length === 0) throw new Error('Add at least one question first.');
    this.state.questions = structuredClone(this.library.questions);
    this.state.settings = structuredClone(this.library.settings);
    this.state.startedAt = new Date().toISOString();
    this.openQuestion(0);
  }

  openQuestion(index) {
    const s = this.state;
    s.phase = 'question';
    s.questionIndex = index;
    s.answers[index] = {};
    s.results[index] = null;
    s.deadline = Date.now() + secondsFor(s.questions[index], s.settings) * 1000;
    this.scheduleClose();
    this.changed();
  }

  scheduleClose() {
    clearTimeout(this.timer);
    const delay = Math.max(0, (this.state.deadline ?? Date.now()) - Date.now());
    this.timer = setTimeout(() => this.close(), delay);
  }

  answer(playerId, value) {
    const s = this.state;
    if (s.phase !== 'question') throw new Error('Answers are closed.');
    if (!s.players[playerId]) throw new Error('Join the game first.');
    const answers = s.answers[s.questionIndex];
    if (playerId in answers) throw new Error('You already answered.');

    const q = this.currentQuestion;
    if (q.type === 'choice') {
      if (!Number.isInteger(value) || value < 0 || value >= q.options.length) throw new Error('Pick an option.');
      answers[playerId] = value;
    } else {
      const text = cleanText(value, MAX_ANSWER_LENGTH);
      if (!text) throw new Error('Type an answer first.');
      answers[playerId] = text;
    }

    // Close early once every connected player has answered.
    const online = Object.keys(s.players).filter((id) => this.isOnline(id));
    const allIn = online.length > 0 && online.every((id) => id in answers);
    if (allIn) this.close();
    else this.changed();
  }

  close() {
    const s = this.state;
    if (s.phase !== 'question') return;
    clearTimeout(this.timer);
    s.results[s.questionIndex] = scoreQuestion(this.currentQuestion, s.answers[s.questionIndex] ?? {});
    s.phase = 'reveal';
    s.deadline = null;
    this.changed();
  }

  next() {
    const s = this.state;
    switch (s.phase) {
      case 'lobby':
        return this.start();
      case 'question':
        return this.close();
      case 'reveal':
        s.phase = this.isLastQuestion ? 'finished' : 'leaderboard';
        if (s.phase === 'finished') this.archive();
        return this.changed();
      case 'leaderboard':
        return this.openQuestion(s.questionIndex + 1);
      default:
        throw new Error('The game is over — start a new game.');
    }
  }

  /** Start over from the lobby. Players stay joined (scores reset) unless clearPlayers is set. */
  restart({ clearPlayers = false } = {}) {
    clearTimeout(this.timer);
    this.archive();
    this.state = freshGame(clearPlayers ? {} : this.state.players);
    this.changed();
  }

  // --- views -----------------------------------------------------------------

  leaderboard() {
    return rankPlayers(this.state.players, this.state.results);
  }

  hostView() {
    const s = this.state;
    const inGame = s.phase !== 'lobby';
    const players = Object.values(s.players)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, connected: this.isOnline(p.id) }));

    const view = {
      phase: s.phase,
      gameId: s.id,
      serverNow: Date.now(),
      questionIndex: s.questionIndex,
      totalQuestions: inGame ? s.questions.length : this.library.questions.length,
      isLastQuestion: inGame && this.isLastQuestion,
      players,
      onlineCount: players.filter((p) => p.connected).length,
      settings: this.library.settings, // timers for the next game (editable in the lobby)
    };

    const q = this.currentQuestion;
    if (s.phase === 'question') {
      Object.assign(view, {
        question: q,
        deadline: s.deadline,
        durationMs: secondsFor(q, s.settings) * 1000,
        answeredCount: Object.keys(s.answers[s.questionIndex] ?? {}).length,
      });
    }
    if (s.phase === 'reveal') {
      const r = s.results[s.questionIndex];
      Object.assign(view, {
        question: q,
        result: {
          groups: r.groups.map((g) => ({
            label: g.label,
            count: g.playerIds.length,
            isHerd: g.isHerd,
            variants: g.variants ?? [],
          })),
          herdLabels: r.herdLabels,
          pointsAwarded: r.herdPlayerIds.length,
          answeredCount: r.answeredCount,
        },
      });
    }
    if (s.phase === 'leaderboard' || s.phase === 'finished') {
      const scoredLast = new Set(s.results[s.questionIndex]?.herdPlayerIds ?? []);
      view.leaderboard = this.leaderboard()
        .filter((p) => p.rank <= LEADERBOARD_SIZE)
        .slice(0, LEADERBOARD_SIZE + 5) // ties at 10th can spill over slightly
        .map((p) => ({ ...p, scoredLast: scoredLast.has(p.id) }));
      view.question = q;
    }
    return view;
  }

  /** @param board pass a precomputed leaderboard when rendering many players at once */
  playerView(playerId, board = null) {
    const s = this.state;
    const player = this.getPlayer(playerId);
    const view = {
      phase: s.phase,
      gameId: s.id,
      serverNow: Date.now(),
      questionIndex: s.questionIndex,
      totalQuestions: s.phase === 'lobby' ? this.library.questions.length : s.questions.length,
      you: null,
    };

    if (player) {
      board ??= this.leaderboard();
      const me = board.find((p) => p.id === playerId);
      view.you = { id: player.id, name: player.name, score: me.score, rank: me.rank, totalPlayers: board.length };
    }

    const q = this.currentQuestion;
    const mine = s.answers[s.questionIndex]?.[playerId];
    const answerLabel = mine === undefined ? null : q?.type === 'choice' ? q.options[mine] : mine;

    if (s.phase === 'question') {
      Object.assign(view, {
        question: { type: q.type, text: q.text, options: q.options },
        deadline: s.deadline,
        durationMs: secondsFor(q, s.settings) * 1000,
        myAnswer: answerLabel,
        myChoice: q.type === 'choice' ? (mine ?? null) : null,
      });
    }
    if (s.phase === 'reveal' || s.phase === 'leaderboard' || s.phase === 'finished') {
      const r = s.results[s.questionIndex];
      Object.assign(view, {
        question: { type: q.type, text: q.text },
        myAnswer: answerLabel,
        matched: Boolean(r?.herdPlayerIds.includes(playerId)),
        herdLabels: r?.herdLabels ?? [],
      });
    }
    return view;
  }
}
