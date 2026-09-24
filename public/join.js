const STORAGE_KEY = 'herd:playerId';
const $ = (id) => document.getElementById(id);

const views = ['join', 'lobby', 'question', 'reveal', 'rank'].map((name) => $(`view-${name}`));

let ws;
let state = null;
let joinedId = null;
let editingName = false;
let pendingName = null;
let clockOffset = 0;
let timerHandle = null;
let renderedQuestionKey = null;

const storage = {
  get: () => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      /* private mode: rejoin after refresh won't work, everything else does */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
};

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function show(id) {
  for (const v of views) v.hidden = v.id !== id;
}

function setError(message = '') {
  $('error').textContent = message;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  if (!state) return;
  clearInterval(timerHandle);
  const you = state.you;

  $('me').hidden = !you;
  if (you) $('me').textContent = `${you.name} · ${you.score} ${you.score === 1 ? 'pt' : 'pts'}`;

  if (!you || editingName) {
    show('view-join');
    $('join-button').disabled = Boolean(pendingName);
    $('join-note').textContent =
      !you && state.phase !== 'lobby' ? 'A game is in progress — join now and play from the next question.' : '';
    return;
  }

  switch (state.phase) {
    case 'lobby':
      show('view-lobby');
      $('lobby-name').textContent = you.name;
      break;
    case 'question':
      show('view-question');
      renderQuestion();
      break;
    case 'reveal':
      show('view-reveal');
      renderReveal();
      break;
    case 'leaderboard':
    case 'finished':
      show('view-rank');
      renderRank();
      break;
  }
}

function renderQuestion() {
  const q = state.question;
  const key = `${state.gameId}:${state.questionIndex}`;

  // Only rebuild inputs when the question changes, so typing isn't interrupted by updates.
  if (renderedQuestionKey !== key) {
    renderedQuestionKey = key;
    $('q-num').textContent = `Question ${state.questionIndex + 1} of ${state.totalQuestions}`;
    $('q-text').textContent = q.text;
    const choices = $('q-choices');
    choices.replaceChildren();
    choices.classList.toggle('many', q.type === 'choice' && q.options.length > 6);
    if (q.type === 'choice') {
      q.options.forEach((option, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'choice';
        btn.textContent = option;
        btn.addEventListener('click', () => {
          choices.querySelectorAll('button').forEach((b) => (b.disabled = true));
          btn.classList.add('picked');
          send({ type: 'answer', value: index });
        });
        choices.append(btn);
      });
    }
    $('q-input').value = '';
    $('q-form').querySelector('button').disabled = false;
  }

  const answered = state.myAnswer !== null && state.myAnswer !== undefined;
  const closed = answered || state.judging;
  $('q-choices').hidden = closed || q.type !== 'choice';
  $('q-form').hidden = closed || q.type !== 'text';
  $('q-locked').hidden = !closed;
  $('q-locked-label').textContent = answered ? 'Locked in' : 'Time’s up';
  $('q-locked-answer').textContent = answered ? state.myAnswer : 'No answer';
  $('q-locked-status').textContent = state.judging ? 'Counting the herd…' : 'Waiting for the rest of the herd…';
  if (state.judging) {
    $('q-timer').textContent = '';
    return;
  }

  const tick = () => {
    const left = Math.max(0, state.deadline - (Date.now() + clockOffset));
    $('q-timer').textContent = `${Math.ceil(left / 1000)}s`;
    $('q-timer').classList.toggle('urgent', left <= 5000);
  };
  tick();
  timerHandle = setInterval(tick, 250);
}

function renderReveal() {
  const answered = state.myAnswer !== null && state.myAnswer !== undefined;
  const herd = state.herdLabels.join(' / ');
  const card = $('view-reveal');
  card.classList.toggle('matched', state.matched);

  $('r-title').textContent = state.matched
    ? 'You’re in the herd! +1'
    : answered
      ? 'You strayed from the herd'
      : 'You didn’t answer in time';

  const parts = [];
  if (answered) parts.push(`You said: ${state.myAnswer}.`);
  parts.push(herd ? `The herd said: ${herd}.` : 'No herd this time — nobody scores.');
  $('r-detail').textContent = parts.join(' ');
}

function renderRank() {
  const { you } = state;
  const final = state.phase === 'finished';
  $('k-label').textContent = final ? 'Final ranking' : 'Your ranking';
  $('k-rank').textContent = `#${you.rank}`;
  $('k-detail').textContent =
    `of ${you.totalPlayers} ${you.totalPlayers === 1 ? 'player' : 'players'} · ${you.score} ${you.score === 1 ? 'point' : 'points'}` +
    (final ? (you.rank === 1 ? ' — you are the ultimate herd!' : ' — thanks for playing!') : '');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('name').value.trim();
  if (!name) return setError('Please enter a name.');
  setError();
  pendingName = name;
  $('join-button').disabled = true;
  send({ type: 'join', name, playerId: storage.get() });
});

$('change-name').addEventListener('click', () => {
  editingName = true;
  $('name').value = state?.you?.name ?? '';
  render();
  $('name').focus();
  $('name').select();
});

$('q-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('q-input').value.trim();
  if (!text) return setError('Type an answer first.');
  setError();
  event.submitter?.setAttribute('disabled', '');
  send({ type: 'answer', value: text });
});

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    setError();
    const storedId = storage.get();
    if (pendingName) send({ type: 'join', name: pendingName, playerId: storedId });
    else if (storedId) send({ type: 'rejoin', playerId: storedId });
    else send({ type: 'hello' });
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'state':
        state = msg.state;
        clockOffset = state.serverNow - Date.now();
        // The server only knows us once join/rejoin has completed.
        if (state.you) joinedId = state.you.id;
        render();
        break;
      case 'joined':
        joinedId = msg.player.id;
        pendingName = null;
        editingName = false;
        storage.set(joinedId);
        break;
      case 'unknown-player':
      case 'kicked':
        storage.clear();
        joinedId = null;
        editingName = false;
        if (msg.type === 'kicked') setError('You were removed from the game. You can join again.');
        send({ type: 'hello' });
        break;
      case 'error':
        pendingName = null;
        setError(msg.message);
        render();
        // Re-enable inputs so they can try again.
        $('q-choices').querySelectorAll('button').forEach((b) => (b.disabled = false));
        $('q-form').querySelector('button').disabled = false;
        break;
    }
  });

  ws.addEventListener('close', () => {
    setError('Reconnecting…');
    setTimeout(connect, 1500);
  });
}

connect();
