import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBotBrain, parseAnswers, fallbackAnswers } from '../src/bots.js';

const quiet = { log() {}, warn() {} };

test('parseAnswers reads the JSON answers list', () => {
  assert.deepEqual(parseAnswers('Sure! {"answers":["Gandalf"," Merlin ",""]}'), ['Gandalf', 'Merlin']);
  assert.throws(() => parseAnswers('nope'));
});

test('fallback answers match the default question when known', () => {
  const answers = fallbackAnswers('Name a country you’d love to travel to', 5);
  assert.equal(answers.length, 5);
  assert.ok(answers.every((a) => ['Japan', 'Italy', 'Iceland', 'Greece', 'Canada', 'Peru', 'France'].includes(a)));
  assert.equal(fallbackAnswers('Something custom?', 2).length, 2);
});

test('bot brain uses the LLM and tops up short replies', async () => {
  const brain = createBotBrain({ log: quiet, converse: async () => ({ text: '{"answers":["Gandalf"]}' }) });
  const answers = await brain.textAnswers('Name a famous wizard', 3);
  assert.equal(answers.length, 3);
  assert.ok(answers.includes('Gandalf'));
});

test('bot brain falls back when the LLM fails or is slow', async () => {
  const failing = createBotBrain({ log: quiet, converse: async () => { throw new Error('expired'); } });
  assert.equal((await failing.textAnswers('Name a famous wizard', 2)).length, 2);
  const slow = createBotBrain({
    log: quiet,
    timeoutMs: 30,
    converse: ({ abortSignal }) => new Promise((_, reject) => abortSignal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  assert.equal((await slow.textAnswers('Q', 2)).length, 2);
});
