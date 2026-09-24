const $ = (id) => document.getElementById(id);
const key = new URLSearchParams(location.search).get('key');
const api = (path) => (key ? `${path}?key=${encodeURIComponent(key)}` : path);
if (key) $('back').href = `/?key=${encodeURIComponent(key)}`;

let library = { settings: { secondsPerQuestion: 20 }, questions: [] };
let editable = true;
let dirty = false;

function setStatus(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}

function markDirty() {
  dirty = true;
  $('save').disabled = !editable;
  setStatus('Unsaved changes');
}

// ---------------------------------------------------------------------------
// Read the form back into a library object
// ---------------------------------------------------------------------------

function readForm() {
  const questions = [...$('list').children].map((li) => {
    const type = li.querySelector('.q-type').value;
    const text = li.querySelector('.q-text').value;
    if (type === 'text') return { type, text };
    const options = li
      .querySelector('.q-options')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return { type, text, options };
  });
  return { settings: { secondsPerQuestion: Number($('seconds').value) }, questions };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  $('seconds').value = library.settings.secondsPerQuestion;
  const list = $('list');
  list.replaceChildren();
  library.questions.forEach((q) => list.append(questionItem(q)));
  renumber();

  $('locked').hidden = editable;
  document.querySelectorAll('input, textarea, select, [data-add], [data-move], [data-remove], #reset').forEach((node) => {
    node.disabled = !editable;
  });
  $('save').disabled = !editable || !dirty;
}

function questionItem(q) {
  const li = $('q-template').content.firstElementChild.cloneNode(true);
  li.querySelector('.q-type').value = q.type;
  li.querySelector('.q-text').value = q.text ?? '';
  li.querySelector('.q-options').value = (q.options ?? []).join('\n');
  li.querySelector('.q-options').rows = Math.min(12, Math.max(3, (q.options?.length ?? 0) + 1));
  syncType(li);
  return li;
}

function syncType(li) {
  const isChoice = li.querySelector('.q-type').value === 'choice';
  li.querySelector('.q-options-label').hidden = !isChoice;
  const count = li
    .querySelector('.q-options')
    .value.split('\n')
    .filter((s) => s.trim()).length;
  li.querySelector('.q-options-label').firstChild.textContent = `Options — one per line (${count}) `;
}

function renumber() {
  const items = [...$('list').children];
  items.forEach((li, i) => (li.querySelector('.q-index').textContent = `${i + 1}`));
  const seconds = Number($('seconds').value) || 20;
  // ~15s per question for the reveal + rankings on top of answer time.
  const minutes = (items.length * (seconds + 15)) / 60;
  $('summary').textContent = `${items.length} ${items.length === 1 ? 'question' : 'questions'} · roughly ${minutes.toFixed(1)} minutes to play`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

$('list').addEventListener('input', (event) => {
  const li = event.target.closest('.q-item');
  if (li) syncType(li);
  markDirty();
});

$('list').addEventListener('change', (event) => {
  if (event.target.matches('.q-type')) syncType(event.target.closest('.q-item'));
});

$('list').addEventListener('click', (event) => {
  const li = event.target.closest('.q-item');
  if (!li) return;
  const move = event.target.closest('[data-move]');
  if (move) {
    const sibling = move.dataset.move === '-1' ? li.previousElementSibling : li.nextElementSibling;
    if (!sibling) return;
    if (move.dataset.move === '-1') sibling.before(li);
    else sibling.after(li);
    renumber();
    markDirty();
  }
  if (event.target.closest('[data-remove]')) {
    const text = li.querySelector('.q-text').value || 'this question';
    if (!confirm(`Remove "${text}"?`)) return;
    li.remove();
    renumber();
    markDirty();
  }
});

$('seconds').addEventListener('input', () => {
  renumber();
  markDirty();
});

document.querySelectorAll('[data-add]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const q = btn.dataset.add === 'choice' ? { type: 'choice', text: '', options: [] } : { type: 'text', text: '' };
    const li = questionItem(q);
    $('list').append(li);
    renumber();
    markDirty();
    li.querySelector('.q-text').focus();
  }),
);

$('save').addEventListener('click', async () => {
  const res = await fetch(api('/api/questions'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readForm()),
  });
  const body = await res.json();
  if (!res.ok) return setStatus(body.error ?? 'Could not save.', true);
  ({ editable, ...library } = body);
  dirty = false;
  render();
  setStatus('Saved ✓');
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Replace all questions with the default set?')) return;
  const res = await fetch(api('/api/questions/reset'), { method: 'POST' });
  const body = await res.json();
  if (!res.ok) return setStatus(body.error ?? 'Could not reset.', true);
  ({ editable, ...library } = body);
  dirty = false;
  render();
  setStatus('Reset to defaults ✓');
});

window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const res = await fetch(api('/api/questions'));
if (res.status === 403) {
  document.querySelector('.editor').replaceChildren(
    Object.assign(document.createElement('p'), {
      className: 'notice',
      textContent: 'Questions can only be edited from the host laptop (or with the host link from the terminal).',
    }),
  );
} else {
  ({ editable, ...library } = await res.json());
  render();
}
