import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFreeText, normalizeAnswer, isSameAnswer } from '../src/matching.js';
import { scoreQuestion, rankPlayers, validateLibrary, validateSettings, secondsFor, defaultLibrary } from '../src/game.js';

test('normalizeAnswer strips case, accents, punctuation and articles', () => {
  assert.equal(normalizeAnswer('  The Café!! '), 'cafe');
  assert.equal(normalizeAnswer('A   Pancake'), 'pancake');
  assert.equal(normalizeAnswer('Salt & Pepper'), 'salt and pepper');
});

test('isSameAnswer allows 1-2 character differences, scaled by length', () => {
  assert.ok(isSameAnswer('pepperoni', 'peperoni')); // 1 missing
  assert.ok(isSameAnswer('pancake', 'pancakes')); // plural
  assert.ok(isSameAnswer('croissant', 'crossant')); // 1 missing
  assert.ok(isSameAnswer('australia', 'austrlia'));
  assert.ok(isSameAnswer('guitar', 'guiter')); // 6 letters, 1 edit
  assert.ok(!isSameAnswer('guitar', 'guitr1x')); // too different
  assert.ok(!isSameAnswer('cat', 'car')); // short words must match exactly
  assert.ok(!isSameAnswer('japan', 'spain'));
});

test('groupFreeText clusters near-misses and labels with the most common spelling', () => {
  const groups = groupFreeText([
    { playerId: 'a', text: 'Pancakes' },
    { playerId: 'b', text: 'pancakes' },
    { playerId: 'c', text: 'Pancake' },
    { playerId: 'd', text: 'pancakse' },
    { playerId: 'e', text: 'Toast' },
    { playerId: 'f', text: 'toast!' },
    { playerId: 'g', text: 'Eggs' },
  ]);
  assert.equal(groups[0].playerIds.length, 4);
  assert.equal(groups[0].label, 'Pancakes');
  assert.deepEqual(groups[1].playerIds.sort(), ['e', 'f']);
  assert.equal(groups[2].label, 'Eggs');
  // merged spellings are reported so the reveal can show them
  assert.deepEqual(groups[0].variants.sort(), ['Pancake', 'pancakse']);
});

test('scoreQuestion: choice — biggest group scores', () => {
  const q = { type: 'choice', options: ['Cats', 'Dogs', 'Neither'] };
  const r = scoreQuestion(q, { a: 1, b: 1, c: 0, d: 2 });
  assert.deepEqual(r.herdLabels, ['Dogs']);
  assert.deepEqual(r.herdPlayerIds.sort(), ['a', 'b']);
  assert.equal(r.groups.length, 3); // zero-vote options still listed
});

test('scoreQuestion: ties for the top all score', () => {
  const q = { type: 'choice', options: ['Cats', 'Dogs'] };
  const r = scoreQuestion(q, { a: 0, b: 0, c: 1, d: 1 });
  assert.deepEqual(r.herdLabels, ['Cats', 'Dogs']);
  assert.equal(r.herdPlayerIds.length, 4);
});

test('scoreQuestion: no herd when nobody shares an answer', () => {
  const r = scoreQuestion({ type: 'text' }, { a: 'Harry Potter', b: 'Gandalf', c: 'Merlin' });
  assert.deepEqual(r.herdLabels, []);
  assert.equal(r.herdPlayerIds.length, 0);
});

test('rankPlayers uses competition ranking for ties', () => {
  const players = {
    a: { id: 'a', name: 'A', joinedAt: 1 },
    b: { id: 'b', name: 'B', joinedAt: 2 },
    c: { id: 'c', name: 'C', joinedAt: 3 },
    d: { id: 'd', name: 'D', joinedAt: 4 },
  };
  const results = [{ herdPlayerIds: ['a', 'b'] }, { herdPlayerIds: ['a', 'c'] }, null];
  const board = rankPlayers(players, results);
  assert.deepEqual(
    board.map((p) => [p.name, p.score, p.rank]),
    [
      ['A', 2, 1],
      ['B', 1, 2],
      ['C', 1, 2],
      ['D', 0, 4],
    ],
  );
});

test('default questions: 13 total, last 4 free text, 15s/20s timers', () => {
  const lib = validateLibrary(defaultLibrary());
  assert.equal(lib.questions.length, 13);
  assert.deepEqual(
    lib.questions.map((q) => q.type),
    [...Array(9).fill('choice'), ...Array(4).fill('text')],
  );
  assert.deepEqual(lib.settings, { choiceSeconds: 15, textSeconds: 20 });
});

test('timer settings: per-type seconds, defaults, and legacy single value', () => {
  assert.deepEqual(validateSettings({}), { choiceSeconds: 15, textSeconds: 20 });
  assert.deepEqual(validateSettings({ secondsPerQuestion: 25 }), { choiceSeconds: 25, textSeconds: 25 });
  assert.deepEqual(validateSettings({ choiceSeconds: 10, textSeconds: 30 }), { choiceSeconds: 10, textSeconds: 30 });
  assert.throws(() => validateSettings({ choiceSeconds: 2 }));
  const settings = { choiceSeconds: 10, textSeconds: 30 };
  assert.equal(secondsFor({ type: 'choice' }, settings), 10);
  assert.equal(secondsFor({ type: 'text' }, settings), 30);
});

test('validateLibrary rejects bad questions', () => {
  const settings = { choiceSeconds: 15, textSeconds: 20 };
  assert.throws(() => validateLibrary({ settings, questions: [{ type: 'choice', text: 'Q', options: ['one'] }] }));
  assert.throws(() => validateLibrary({ settings, questions: [{ type: 'text', text: '  ' }] }));
  assert.throws(() => validateLibrary({ settings: { secondsPerQuestion: 1 }, questions: [] }));
});
