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
if (key) {
  $('edit-questions').href = `/questions?key=${encodeURIComponent(key)}`;
  $('llm-test').href = `/llm?key=${encodeURIComponent(key)}`;
}

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
  question: (s) => (s.judging ? { label: 'Counting…', disabled: true, action: 'close' } : { label: 'Close answers', action: 'close' }),
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

  renderLlmStatus(s.llm);

  const list = $('players');
  $('count').textContent = String(s.onlineCount);
  $('empty').hidden = s.players.length > 0;
  const humans = s.players.filter((p) => !p.isBot).length;
  const botsNeeded = Math.max(0, (s.minPlayers ?? 0) - humans);
  $('lobby-hint').textContent = [
    s.players.length ? 'Click a name to remove it.' : '',
    botsNeeded
      ? `Fewer than ${s.minPlayers} players — ${botsNeeded} ${botsNeeded === 1 ? 'bot' : 'bots'} will join the herd when you start.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

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

function renderLlmStatus(llm) {
  const el = $('llm-status');
  if (!llm) {
    el.textContent = '';
    return;
  }
  el.dataset.state = llm.state;
  el.textContent =
    llm.state === 'disabled'
      ? 'AI grouping off — free text uses text matching'
      : llm.state === 'error'
        ? `AI grouping unavailable (${llm.message}) — free text will use text matching`
        : llm.state === 'ready'
          ? `AI grouping ready · ${llm.modelName}`
          : `AI grouping · ${llm.modelName} (checking…)`;
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
  $('judging').hidden = !s.judging;
  $('timer').classList.toggle('judging', s.judging);
  if (s.judging) {
    $('timer-text').textContent = '…';
    $('timer-ring').style.strokeDashoffset = '0';
    return;
  }

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
  $('r-grouping').textContent = r.groupingNote ?? '';
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

// An original crowned-cow illustration, used for the frontrunner and the final coronation.
const COW_SVG = `
<svg viewBox="0 0 120 120" role="img" aria-label="Crowned cow">
  <path class="cow-crown" d="M34 30 L40 8 L52 22 L60 4 L68 22 L80 8 L86 30 Z" />
  <circle class="cow-jewel" cx="60" cy="20" r="3.5" />
  <path class="cow-horn" d="M30 42 C18 40 14 30 16 24 C22 30 28 32 36 34 Z" />
  <path class="cow-horn" d="M90 42 C102 40 106 30 104 24 C98 30 92 32 84 34 Z" />
  <ellipse class="cow-ear" cx="22" cy="54" rx="14" ry="8" transform="rotate(-20 22 54)" />
  <ellipse class="cow-ear" cx="98" cy="54" rx="14" ry="8" transform="rotate(20 98 54)" />
  <path class="cow-head" d="M32 38 C32 32 88 32 88 38 L92 80 C92 100 28 100 28 80 Z" />
  <path class="cow-spot" d="M36 44 C44 40 52 46 48 56 C44 62 36 58 36 52 Z" />
  <path class="cow-spot" d="M76 42 C84 44 86 52 80 56 C74 58 70 50 76 42 Z" />
  <circle class="cow-eye" cx="46" cy="62" r="4.5" />
  <circle class="cow-eye" cx="74" cy="62" r="4.5" />
  <circle class="cow-glint" cx="47.5" cy="60.5" r="1.4" />
  <circle class="cow-glint" cx="75.5" cy="60.5" r="1.4" />
  <ellipse class="cow-snout" cx="60" cy="86" rx="24" ry="15" />
  <ellipse class="cow-nostril" cx="51" cy="86" rx="3.5" ry="4.5" />
  <ellipse class="cow-nostril" cx="69" cy="86" rx="3.5" ry="4.5" />
</svg>`;
document.querySelectorAll('[data-cow]').forEach((node) => (node.innerHTML = COW_SVG));

function renderBoard(s) {
  const final = s.phase === 'finished';
  const board = s.leaderboard;
  const leaders = board.filter((p) => p.rank === 1 && p.score > 0);
  $('b-empty').hidden = board.length > 0;
  $('coronation').hidden = !final;

  if (final) {
    renderCoronation(leaders);
    $('b-kind').textContent = 'The rest of the herd';
    $('b-title').hidden = true;
  } else {
    $('b-kind').textContent = `After question ${s.questionIndex + 1} of ${s.totalQuestions}`;
    $('b-title').hidden = false;
    $('b-title').textContent = leaders.length ? 'Who will be crowned the Almighty Cow?' : 'The throne awaits its Almighty Cow…';
  }

  // Between questions: podium for the top 3. Final: the winners are on the coronation above,
  // so the podium starts from the runners-up.
  const podium = board.filter((p) => p.rank <= 3 && !(final && leaders.includes(p)));
  const rest = board.filter((p) => p.rank > 3);

  // Frontrunners get their own full-width row with the crowned cow; everyone else on the podium below.
  const frontrunners = final ? [] : podium.filter((p) => p.rank === 1 && p.score > 0);
  const others = podium.filter((p) => !frontrunners.includes(p));

  const leadersList = $('leaders');
  leadersList.replaceChildren();
  frontrunners.forEach((p, i) => {
    const li = el('li', 'podium gold frontrunner');
    li.style.animationDelay = `${i * 120}ms`;
    const icon = el('span', 'podium-cow');
    icon.innerHTML = COW_SVG;
    const text = el('span', 'frontrunner-text');
    text.append(
      el('span', 'podium-rank', frontrunners.length > 1 ? 'Joint frontrunner' : 'Frontrunner for Almighty Cow'),
      el('span', 'podium-name', p.name),
      scoreEl(p),
    );
    li.append(icon, text);
    leadersList.append(li);
  });
  leadersList.hidden = frontrunners.length === 0;

  const top3 = $('top3');
  top3.replaceChildren();
  others.forEach((p, i) => {
    const li = el('li', `podium ${MEDALS[p.rank - 1]}`);
    li.style.animationDelay = `${(frontrunners.length + i) * 120}ms`;
    li.append(el('span', 'podium-rank', ordinal(p.rank)), el('span', 'podium-name', p.name), scoreEl(p));
    top3.append(li);
  });

  top3.hidden = others.length === 0;
  if (final) $('b-kind').hidden = podium.length + rest.length === 0;
  else $('b-kind').hidden = false;

  const ranks = $('ranks');
  ranks.replaceChildren();
  rest.forEach((p) => {
    const li = el('li', 'rank-row');
    li.append(el('span', 'rank-num', String(p.rank)), el('span', 'rank-name', p.name), scoreEl(p));
    ranks.append(li);
  });
}

function renderCoronation(leaders) {
  if (!leaders.length) {
    $('almighty-title').textContent = 'No Almighty Cow this time';
    $('almighty-name').textContent = '';
    $('almighty-sub').textContent = 'Nobody managed to follow the herd. Truly independent thinkers.';
    $('confetti').replaceChildren();
    return;
  }
  const points = leaders[0].score;
  $('almighty-title').textContent = leaders.length > 1 ? 'The Almighty Cows' : 'The Almighty Cow';
  $('almighty-name').textContent = leaders.map((p) => p.name).join(' & ');
  $('almighty-sub').textContent =
    `${leaders.length > 1 ? 'They think' : 'Thinks'} most like the herd · ${points} ${points === 1 ? 'point' : 'points'}. Bow before ${leaders.length > 1 ? 'them' : 'greatness'}.`;
  launchConfetti();
}

function launchConfetti() {
  const box = $('confetti');
  box.replaceChildren();
  const colours = ['var(--gold)', 'var(--accent)', 'var(--bronze)', 'var(--silver)', 'var(--gold)'];
  for (let i = 0; i < 60; i++) {
    const bit = el('span', 'confetti-bit');
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colours[i % colours.length];
    bit.style.animationDelay = `${Math.random() * 1.8}s`;
    bit.style.animationDuration = `${2.6 + Math.random() * 2}s`;
    bit.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
    bit.style.setProperty('--spin', `${(Math.random() - 0.5) * 1080}deg`);
    box.append(bit);
  }
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
