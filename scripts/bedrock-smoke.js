// Smoke test: `npm run bedrock:smoke` — sends "Say hello" to Bedrock and prints the reply.
import '../src/env.js';
import { converse, defaultModelId, region } from '../src/llm/bedrock.js';

const modelId = process.argv[2] || defaultModelId();
console.log(`Profile: ${process.env.AWS_PROFILE ?? '(default chain)'} · Region: ${region()} · Model: ${modelId}`);

try {
  const res = await converse({ modelId, messages: [{ role: 'user', content: 'Say hello' }], maxTokens: 100 });
  console.log(`\n${res.text}\n`);
  console.log(`✓ ${res.latencyMs} ms · ${res.usage?.inputTokens ?? '?'} in / ${res.usage?.outputTokens ?? '?'} out tokens`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
