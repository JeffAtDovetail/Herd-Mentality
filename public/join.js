const STORAGE_KEY = 'herd:playerId';

const form = document.getElementById('join-form');
const nameInput = document.getElementById('name');
const joinButton = document.getElementById('join-button');
const statusEl = document.getElementById('status');
const joinedCard = document.getElementById('joined');
const joinedName = document.getElementById('joined-name');
const changeNameButton = document.getElementById('change-name');

let ws;
let player = null;
let pendingName = null; // name to (re)send once the socket is open

const storage = {
  get() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* private mode etc. — rejoin after refresh just won't work */
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
};

function showForm(message = '') {
  form.hidden = false;
  joinedCard.hidden = true;
  changeNameButton.hidden = true;
  joinButton.disabled = false;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', Boolean(message));
}

function showJoined() {
  form.hidden = true;
  joinedCard.hidden = false;
  changeNameButton.hidden = false;
  joinedName.textContent = player.name;
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    statusEl.textContent = '';
    statusEl.classList.remove('error');
    const storedId = storage.get();
    if (pendingName) {
      send({ type: 'join', name: pendingName, playerId: storedId });
    } else if (storedId) {
      send({ type: 'rejoin', playerId: storedId });
    }
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'joined':
        player = msg.player;
        pendingName = null;
        storage.set(player.id);
        showJoined();
        break;
      case 'unknown-player':
        // Server restarted or lobby was reset — ask for the name again.
        storage.clear();
        showForm();
        break;
      case 'error':
        pendingName = null;
        showForm(msg.message);
        break;
    }
  });

  ws.addEventListener('close', () => {
    if (!form.hidden) {
      statusEl.textContent = 'Reconnecting…';
    }
    setTimeout(connect, 1500);
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) {
    showForm('Please enter a name.');
    return;
  }
  joinButton.disabled = true;
  pendingName = name;
  if (ws?.readyState === WebSocket.OPEN) {
    send({ type: 'join', name, playerId: storage.get() });
  } else {
    statusEl.textContent = 'Connecting…';
  }
});

changeNameButton.addEventListener('click', () => {
  nameInput.value = player?.name ?? '';
  showForm();
  nameInput.focus();
  nameInput.select();
});

connect();
