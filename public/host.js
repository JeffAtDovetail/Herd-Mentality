const $ = (id) => document.getElementById(id);
const key = new URLSearchParams(location.search).get('key');

const els = {
  status: $('status'),
  progress: $('progress'),
  primary: $('primary'),
  menu: $('menu'),
  denied: $('denied'),
  phases: {
    lobby: $('phase-lobby'),
    question: $('phase-question'),
    reveal: $('phase-reveal'),
    board: $('phase-board'),
  },
};

let ws;
let state = null;
let clockOffset = 0; // serverNow - Date.now()
let timerHandle = null;

// Keep the host key on links to other host pages.
if (key) $('edit-questions').href = `/questions?key=${encodeURIComponent(key)}`;

// ---------------------------------------------------------------------------
// Join info (QR code)
// ---------------------------------------------------------------------------

fetch('/api/info')
  .then((r) => r.json())
  .then(({ joinUrl, qrSvg }) => {
    document.querySelectorAll('[data-qr]').forEach((el) => (el.innerHTML = qrSvg)); // our own SVG
    document.querySelectorAll('[data-join-url]').forEach((el) => (el.textContent = joinUrl));
  })
  .catch(() => {
    document.querySelectorAll('[data-join-url]').forEach((el) => (el.textContent = 'Could not load join link'));
  });

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // always textContent: names/answers are user input
  return node;
};

function showPhase(name) {
  for (const [key, section] of Object.entries(els.phases)) section.hidden = key !== name;
}

const PRIMARY = {
  lobby: (s) => ({ label: s.totalQuestions ? `Start game (${s.totalQuestions} questions)` : 'Add questions first', disabled: !s.totalQuestions, action: 'next' }),
  question: () => ({ label: 'Close answers', action: 'close' }),
  reveal: (s) => ({ label: s.isLastQuestion ? 'Final results' : 'Show rankings', action: 'next' }),
  leaderboard: () => ({ label: 'Next question', action: 'next' }),
  finished: () => ({ label: 'New game', action: 'restart' }),
};

function render(s) {
  state = s;
  clockOffset = s.serverNow - Date.now();

  const primary = PRIMARY[s.phase](s);
  els.primary.hidden = false;
  els.primary.textContent = primary.label;
  els.primary.disabled = Boolean(primary.disabled);
  els.primary.dataset.action = primary.action;

  $('edit-questions').hidden = s.phase !== 'lobby';
  els.progress.textContent =
    s.phase === 'lobby' || s.phase === 'finished' ? '' : `Question ${s.questionIndex + 1} of ${s.totalQuestions}`;

  clearInterval(timerHandle);

  switch (s.phase) {
    case 'lobby':
      showPhase('lobby');
      renderLobby(s);
      break;
    case 'question':
      showPhase('question');
      renderQuestion(s);
      break;
    case 'reveal':
      showPhase('reveal');
      renderReveal(s);
      break;
    case 'leaderboard':
    case 'finished':
      showPhase('board');
      renderBoard(s);
      break;
  }
}

function renderLobby(s) {
  // Don't overwrite a timer input while the host is typing in it.
  for (const [id, value] of [
    ['t-choice', s.settings.choiceSeconds],
    ['t-text', s.settings.textSeconds],
  ]) {
    if (document.activeElement !== $(id)) $(id).value = value;
  }

  const list = $('players');
  $('count').textContent = String(s.onlineCount);
  $('empty').hidden = s.players.length > 0;
  $('lobby-hint').textContent = s.players.length ? 'Click a name to remove it.' : '';

  const existing = new Map([...list.children].map((li) => [li.dataset.id, li]));
  const seen = new Set();
  for (const p of s.players) {
    seen.add(p.id);
    let li = existing.get(p.id);
    if (!li) {
      li = el('li', 'player');
      li.dataset.id = p.id;
      li.tabIndex = 0;
      list.append(li);
    }
    li.textContent = p.name;
    li.classList.toggle('offline', !p.connected);
    li.title = `${p.connected ? 'Connected' : 'Disconnected'} — click to remove`;
  }
  for (const [id, li] of existing) if (!seen.has(id)) li.remove();
}

function kindLabel(q) {
  return q.type === 'choice' ? 'Pick one' : 'Free text — match the herd';
}

function renderQuestion(s) {
  const q = s.question;
  $('q-kind').textContent = kindLabel(q);
  $('q-text').textContent = q.text;
  const options = $('q-options');
  options.replaceChildren();
  options.hidden = q.type !== 'choice';
  $('q-free').hidden = q.type === 'choice';
  if (q.type === 'choice') {
    options.classList.toggle('many', q.options.length > 6);
    q.options.forEach((o) => options.append(el('li', 'option', o)));
  }
  $('answered').textContent = String(s.answeredCount);
  $('online').textContent = String(s.onlineCount);

  const ring = $('timer-ring');
  const circumference = 2 * Math.PI * 44;
  ring.style.strokeDasharray = String(circumference);
  const duration = Math.max(s.durationMs, 1);
  const tick = () => {
    const left = Math.max(0, s.deadline - (Date.now() + clockOffset));
    $('timer-text').textContent = String(Math.ceil(left / 1000));
    ring.style.strokeDashoffset = String(circumference * (1 - left / duration));
    $('timer').classList.toggle('urgent', left <= 5000);
  };
  tick();
  timerHandle = setInterval(tick, 200);
}

function renderReveal(s) {
  const { question: q, result: r } = s;
  $('r-kind').textContent = r.herdLabels.length ? 'The herd says…' : 'No herd this time';
  $('r-text').textContent = q.text;

  const isText = q.type === 'text';
  const allGroups = r.answeredCount ? r.groups : [];
  let groups = allGroups;
  if (q.type === 'choice' && groups.length > 8) groups = groups.filter((g) => g.count > 0);
  // Free text: a few bars for the top answers, then every answer in the list below.
  const barLimit = isText ? 5 : 10;
  const hiddenCount = isText ? 0 : Math.max(0, groups.length - barLimit);
  groups = groups.slice(0, barLimit);
  const max = Math.max(1, ...groups.map((g) => g.count));
  renderAllAnswers(isText ? allGroups : []);

  const bars = $('bars');
  bars.replaceChildren();
  groups.forEach((g, i) => {
    const li = el('li', `bar${g.isHerd ? ' herd' : ''}`);
    li.style.setProperty('--w', `${(g.count / max) * 100}%`);
    li.style.animationDelay = `${i * 70}ms`;
    const label = el('span', 'bar-label', g.label);
    if (g.isHerd) label.append(el('span', 'badge', 'Herd'));
    li.append(label, el('span', 'bar-track'), el('span', 'bar-count', String(g.count)));
    li.querySelector('.bar-track').append(el('span', 'bar-fill'));
    bars.append(li);
  });
  if (hiddenCount) bars.append(el('li', 'bar-more', `+ ${hiddenCount} more answers`));
  if (!groups.length) bars.append(el('li', 'bar-more', 'Nobody answered!'));

  $('r-summary').textContent = r.herdLabels.length
    ? `${r.pointsAwarded} ${r.pointsAwarded === 1 ? 'player gets' : 'players get'} a point`
    : r.answeredCount
      ? 'Everyone gave a different answer — nobody scores.'
      : '';
}

/** Every free-text answer group, most popular first, with merged spellings shown. */
function renderAllAnswers(groups) {
  const section = $('all-answers');
  section.hidden = groups.length === 0;
  if (!groups.length) return;
  const total = groups.reduce((n, g) => n + g.count, 0);
  $('all-answers-title').textContent =
    `All answers · ${total} from ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}`;

  const list = $('answer-list');
  list.replaceChildren();
  // Dense lists get smaller text so ~100 answers still fit on a projector.
  list.classList.toggle('dense', groups.length > 24);
  groups.forEach((g, i) => {
    const li = el('li', `answer${g.isHerd ? ' herd' : ''}`);
    li.style.animationDelay = `${Math.min(i, 30) * 25}ms`;
    li.append(el('span', 'answer-label', g.label));
    if (g.count > 1) li.append(el('span', 'answer-count', `×${g.count}`));
    if (g.variants.length) li.append(el('span', 'answer-variants', g.variants.join(', ')));
    list.append(li);
  });
}

const MEDALS = ['gold', 'silver', 'bronze'];

function renderBoard(s) {
  const final = s.phase === 'finished';
  $('b-kind').textContent = final ? 'Final results' : `After question ${s.questionIndex + 1} of ${s.totalQuestions}`;
  const leaders = s.leaderboard.filter((p) => p.rank === 1);
  $('b-title').textContent = final
    ? leaders.length
      ? `${leaders.map((p) => p.name).join(' & ')} ${leaders.length > 1 ? 'are' : 'is'} the ultimate herd!`
      : 'Game over'
    : 'Rankings';

  const top = s.leaderboard.filter((p) => p.rank <= 3);
  const rest = s.leaderboard.filter((p) => p.rank > 3);
  $('b-empty').hidden = s.leaderboard.length > 0;

  const top3 = $('top3');
  top3.replaceChildren();
  top.forEach((p, i) => {
    const li = el('li', `podium ${MEDALS[p.rank - 1]}`);
    li.style.animationDelay = `${(top.length - i) * 120}ms`;
    li.append(el('span', 'podium-rank', ordinal(p.rank)), el('span', 'podium-name', p.name), scoreEl(p));
    top3.append(li);
  });

  const ranks = $('ranks');
  ranks.replaceChildren();
  rest.forEach((p) => {
    const li = el('li', 'rank-row');
    li.append(el('span', 'rank-num', String(p.rank)), el('span', 'rank-name', p.name), scoreEl(p));
    ranks.append(li);
  });
}

function scoreEl(p) {
  const span = el('span', 'score', `${p.score} ${p.score === 1 ? 'pt' : 'pts'}`);
  if (p.scoredLast && state.phase === 'leaderboard') span.append(el('span', 'plus', '+1'));
  return span;
}

function ordinal(n) {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function command(action, extra = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cmd', action, ...extra }));
}

els.primary.addEventListener('click', () => {
  const action = els.primary.dataset.action;
  if (action === 'restart' || !els.primary.disabled) command(action);
  els.primary.blur();
});

document.querySelectorAll('[data-cmd]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const message =
      btn.dataset.cmd === 'reset'
        ? 'Reset everything? This clears all players and scores — everyone will need to rejoin.'
        : 'Restart the game from the beginning? Scores reset, players stay joined.';
    els.menu.open = false;
    if (confirm(message)) command(btn.dataset.cmd);
  }),
);

// Timers: saved as soon as a value is changed (blur / Enter), used for the next game.
function saveTimers() {
  const choiceSeconds = Number($('t-choice').value);
  const textSeconds = Number($('t-text').value);
  const valid = [choiceSeconds, textSeconds].every((n) => Number.isFinite(n) && n >= 5 && n <= 120);
  if (!valid) {
    $('t-status').textContent = 'Timers must be 5–120 seconds.';
    $('t-status').classList.add('error');
    return;
  }
  command('settings', { settings: { choiceSeconds, textSeconds } });
  $('t-status').textContent = 'Saved ✓';
  $('t-status').classList.remove('error');
  setTimeout(() => ($('t-status').textContent = ''), 1500);
}
$('t-choice').addEventListener('change', saveTimers);
$('t-text').addEventListener('change', saveTimers);
$('timer-settings').addEventListener('submit', (event) => {
  event.preventDefault();
  saveTimers();
  document.activeElement.blur();
});

$('players').addEventListener('click', (event) => {
  const li = event.target.closest('.player');
  if (li && confirm(`Remove ${li.textContent} from the game?`)) command('kick', { playerId: li.dataset.id });
});

// Space / Enter / → advance the game, so you can drive it like a slide deck.
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, button, summary, a')) return;
  if (!['Space', 'Enter', 'ArrowRight'].includes(event.code)) return;
  event.preventDefault();
  if (!els.primary.hidden && !els.primary.disabled) els.primary.click();
});

document.addEventListener('click', (event) => {
  if (!els.menu.contains(event.target)) els.menu.open = false;
});

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    els.status.textContent = '';
    els.status.classList.remove('error');
    ws.send(JSON.stringify({ type: 'host', key }));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'state') render(msg.state);
    if (msg.type === 'host-denied') {
      els.denied.hidden = false;
      els.primary.hidden = true;
      els.menu.hidden = true;
      showPhase(null);
      ws.close();
    }
    if (msg.type === 'error') {
      els.status.textContent = msg.message;
      els.status.classList.add('error');
    }
  });

  ws.addEventListener('close', () => {
    if (!els.denied.hidden) return;
    els.status.textContent = 'Reconnecting…';
    els.status.classList.add('error');
    setTimeout(connect, 1500);
  });
}

connect();
