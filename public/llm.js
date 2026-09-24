// Browser side of the LLM test page. It only talks to our own server (/api/llm);
// the server is what calls Bedrock, using credentials on the host machine.

const $ = (id) => document.getElementById(id);
const key = new URLSearchParams(location.search).get('key');
const api = (path) => (key ? `${path}?key=${encodeURIComponent(key)}` : path);
if (key) $('back').href = `/?key=${encodeURIComponent(key)}`;

function showResult(meta, text, isError = false) {
  $('result').hidden = false;
  $('result').classList.toggle('error', isError);
  $('result-meta').textContent = meta;
  $('output').textContent = text;
}

async function loadModels() {
  const res = await fetch(api('/api/llm/models'));
  if (res.status === 403) {
    $('send').disabled = true;
    showResult('Host only', 'Open this page on the laptop running the game (or with the host key link).', true);
    return;
  }
  const { models, defaultModelId, region } = await res.json();
  for (const [id, label] of Object.entries(models)) {
    $('model').append(new Option(`${label} — ${id}`, id, id === defaultModelId, id === defaultModelId));
  }
  $('meta').textContent = `Region ${region}. Each send is a fresh request to Bedrock with no history.`;
}

$('llm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt) return;

  $('send').disabled = true;
  $('send').textContent = 'Sending…';
  showResult('Waiting for Bedrock…', '');
  const started = performance.now();

  try {
    const res = await fetch(api('/api/llm'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        system: $('system').value,
        modelId: $('model').value || undefined,
        maxTokens: Number($('max-tokens').value) || 1024,
        temperature: $('temperature').value === '' ? undefined : Number($('temperature').value),
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      showResult(`Error ${res.status}`, body.error ?? 'Request failed.', true);
      return;
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const usage = body.usage ? ` · ${body.usage.inputTokens} in / ${body.usage.outputTokens} out tokens` : '';
    showResult(`${body.modelId} · ${seconds}s${usage} · stop: ${body.stopReason}`, body.text || '(empty response)');
  } catch (err) {
    showResult('Error', `Could not reach the server: ${err.message}`, true);
  } finally {
    $('send').disabled = false;
    $('send').textContent = 'Send';
  }
});

$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('llm-form').requestSubmit();
});

loadModels().catch((err) => showResult('Error', `Could not load models: ${err.message}`, true));
