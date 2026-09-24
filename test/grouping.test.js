import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { applyMerges, parseReply, createJudge, buildPrompt } from '../src/llm/grouping.js';
import { groupFreeText } from '../src/matching.js';
import { Game, scoreQuestion } from '../src/game.js';
import { createStore } from '../src/store.js';

const quiet = { log() {}, warn() {} };

const textGroups = () =>
  groupFreeText([
    { playerId: 'a', text: 'Barack Obama' },
    { playerId: 'b', text: 'Obama' },
    { playerId: 'c', text: 'obama' },
    { playerId: 'd', text: 'Taylor Swift' },
    { playerId: 'e', text: 'Taylor Swift' },
    { playerId: 'f', text: 'Beyonce' },
  ]);

test('buildPrompt lists groups with ids and counts', () => {
  const prompt = buildPrompt('Most well known person', textGroups());
  assert.match(prompt, /Question: Most well known person/);
  assert.match(prompt, /g1 \| (Obama|Taylor Swift) .*\| 2 players/);
});

test('parseReply tolerates code fences and prose', () => {
  assert.deepEqual(parseReply('```json\n{"groups":[{"label":"x","ids":["g1"]}]}\n```').groups.length, 1);
  assert.throws(() => parseReply('no json here'));
  assert.throws(() => parseReply('{"nope":1}'));
});

test('applyMerges merges groups and keeps anything the model forgot', () => {
  const groups = textGroups(); // [Obama(b,c), Taylor Swift(d,e), Barack Obama(a), Beyonce(f)] in some order
  const idOf = (label) => `g${groups.findIndex((g) => g.label === label) + 1}`;
  const merged = applyMerges(groups, {
    groups: [
      { label: 'Barack Obama', ids: [idOf('Obama'), idOf('Barack Obama'), 'g99'] }, // g99 unknown → ignored
      { label: 'Taylor Swift', ids: [idOf('Taylor Swift'), idOf('Obama')] }, // duplicate Obama → ignored
      // Beyonce omitted → kept on its own
    ],
  });
  assert.equal(merged.length, 3);
  assert.equal(merged[0].label, 'Barack Obama');
  assert.deepEqual(merged[0].playerIds.sort(), ['a', 'b', 'c']);
  assert.ok(merged[0].variants.includes('Obama'));
  assert.deepEqual(merged.find((g) => g.label === 'Beyonce').playerIds, ['f']);
  // every player still appears exactly once
  assert.deepEqual(merged.flatMap((g) => g.playerIds).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('judge returns LLM groups on success', async () => {
  const judge = createJudge({
    log: quiet,
    converse: async () => ({ text: '{"groups":[{"label":"Barack Obama","ids":["g1","g3"]},{"label":"Taylor Swift","ids":["g2"]},{"label":"Beyonce","ids":["g4"]}]}' }),
  });
  const groups = textGroups();
  const res = await judge.group('Most well known person', groups);
  assert.equal(res.method, 'llm');
  assert.equal(judge.status.state, 'ready');
  assert.ok(res.groups.length < groups.length);
});

test('judge falls back to text matching when Bedrock fails, times out or replies with junk', async () => {
  const groups = textGroups();
  for (const converse of [
    async () => {
      throw new Error('AWS SSO session expired or missing — run `aws sso login --profile dev`');
    },
    async () => ({ text: 'Sorry, I cannot help with that.' }),
    ({ abortSignal }) =>
      new Promise((_, reject) => abortSignal.addEventListener('abort', () => reject(new Error('aborted')))),
  ]) {
    const judge = createJudge({ converse, timeoutMs: 50, log: quiet });
    const res = await judge.group('Q', groups);
    assert.equal(res.method, 'text');
    assert.equal(res.groups, groups);
    assert.equal(judge.status.state, 'error');
  }
});

test('judge disabled → text matching, no calls', async () => {
  let called = false;
  const judge = createJudge({ enabled: false, converse: async () => (called = true), log: quiet });
  const res = await judge.group('Q', textGroups());
  assert.equal(res.method, 'text');
  assert.equal(called, false);
  assert.equal(judge.status.state, 'disabled');
});

// --- Game integration -------------------------------------------------------

function makeGame(judge, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herd-test-'));
  const store = createStore(dir);
  const game = new Game(store, { onChange() {}, isOnline: () => true, judge, minPlayers: 0, ...extra });
  game.setLibrary({
    settings: { choiceSeconds: 15, textSeconds: 20 },
    questions: extra.questions ?? [{ type: 'text', text: 'Most well known person' }],
  });
  return game;
}

const waitFor = async (fn) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};

test('game: free text is judged by the LLM, then revealed with merged groups', async () => {
  const judge = createJudge({
    log: quiet,
    converse: async () => ({ text: '{"groups":[{"label":"Barack Obama","ids":["g1","g2"]}]}' }),
  });
  const game = makeGame(judge);
  const p1 = game.join('One').id;
  const p2 = game.join('Two').id;
  game.start();
  game.answer(p1, 'Obama');
  game.answer(p2, 'Barack Obama'); // everyone in → closes → judging
  assert.equal(game.state.judging, true);
  assert.throws(() => game.answer(p1, 'late'), /closed/);
  await waitFor(() => game.state.phase === 'reveal');
  const r = game.state.results[0];
  assert.deepEqual(r.herdLabels, ['Barack Obama']);
  assert.equal(r.herdPlayerIds.length, 2);
  assert.match(r.groupingNote, /Grouped by/);
  clearTimeout(game.timer);
});

test('game: a broken judge still reveals using text matching (no crash)', async () => {
  const brokenJudge = { status: {}, group: async () => { throw new Error('kaboom'); } };
  const game = makeGame(brokenJudge);
  const p1 = game.join('One').id;
  const p2 = game.join('Two').id;
  game.start();
  game.answer(p1, 'Obama');
  game.answer(p2, 'obama');
  await waitFor(() => game.state.phase === 'reveal');
  assert.deepEqual(game.state.results[0].herdPlayerIds.sort(), [p1, p2].sort());
  assert.match(game.state.results[0].groupingNote, /text matching/);
});

test('scoring: a single player scores; two different answers do not', () => {
  const choice = { type: 'choice', options: ['Cats', 'Dogs'] };
  assert.deepEqual(scoreQuestion(choice, { solo: 1 }).herdPlayerIds, ['solo']);
  assert.deepEqual(scoreQuestion({ type: 'text' }, { solo: 'Gandalf' }).herdPlayerIds, ['solo']);
  assert.deepEqual(scoreQuestion(choice, { a: 0, b: 1 }).herdPlayerIds, []);
  assert.deepEqual(scoreQuestion(choice, {}).herdPlayerIds, []);
});

// --- Bots -------------------------------------------------------------------

test('bots fill a solo game up to 3 and answer free text with LLM answers', async () => {
  const brain = { textAnswers: async (_q, n) => Array.from({ length: n }, () => 'Taylor Swift') };
  const game = makeGame(null, { minPlayers: 3, botBrain: brain, botDelayMs: [5, 20] });
  const me = game.join('Jeff').id;
  game.start();
  const bots = Object.values(game.state.players).filter((p) => p.isBot);
  assert.equal(bots.length, 2);
  assert.ok(bots.every((b) => b.name.endsWith('(bot)')));
  game.answer(me, 'Taylor Swift');
  await waitFor(() => game.state.phase === 'reveal'); // closes once bots answer too
  const r = game.state.results[0];
  assert.equal(r.answeredCount, 3);
  assert.equal(r.herdPlayerIds.length, 3);
});

test('bots pick valid options for multiple choice and fall back if the brain fails', async () => {
  const brain = { textAnswers: async () => { throw new Error('no LLM'); } };
  const game = makeGame(null, {
    minPlayers: 3,
    botBrain: brain,
    botDelayMs: [5, 20],
    questions: [
      { type: 'choice', text: 'Cats or dogs?', options: ['Cats', 'Dogs', 'No pets'] },
      { type: 'text', text: 'Favourite room in a house' },
    ],
  });
  game.join('Jeff');
  game.start();
  await waitFor(() => Object.keys(game.state.answers[0]).length === 2);
  for (const v of Object.values(game.state.answers[0])) assert.ok([0, 1, 2].includes(v));
  game.close();
  game.next(); // reveal -> leaderboard
  game.next(); // -> question 2 (text)
  await waitFor(() => Object.keys(game.state.answers[1]).length === 2);
  for (const v of Object.values(game.state.answers[1])) assert.equal(typeof v, 'string');
  clearTimeout(game.timer);
});

test('restart drops bots; they come back only if still needed', () => {
  const game = makeGame(null, { minPlayers: 3, botDelayMs: [60000, 60000] });
  game.join('A');
  game.start();
  assert.equal(Object.keys(game.state.players).length, 3);
  game.restart();
  assert.equal(Object.keys(game.state.players).length, 1);
  game.join('B');
  game.join('C');
  game.start();
  assert.equal(Object.values(game.state.players).filter((p) => p.isBot).length, 0);
  game.restart();
  clearTimeout(game.timer);
});
