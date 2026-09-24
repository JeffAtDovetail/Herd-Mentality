import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBedrockError, defaultModelId, MODELS } from '../src/llm/bedrock.js';

const err = (name, message = 'boom') => Object.assign(new Error(message), { name });

test('expired or missing SSO credentials get the login hint', () => {
  for (const e of [
    err('ExpiredTokenException', 'The security token included in the request is expired'),
    err('CredentialsProviderError', 'Could not load credentials from any providers'),
    err('Error', 'The SSO session associated with this profile has expired or is otherwise invalid.'),
    err('TokenProviderError', 'Token is expired. To refresh this SSO session run aws sso login'),
  ]) {
    const mapped = toBedrockError(e);
    assert.equal(mapped.code, 'CREDENTIALS');
    assert.equal(mapped.status, 401);
    assert.equal(mapped.message, 'AWS SSO session expired or missing — run `aws sso login --profile dev`');
  }
});

test('access errors mention the model and region', () => {
  const mapped = toBedrockError(err('AccessDeniedException', "You don't have access to the model"), {
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    awsRegion: 'us-east-1',
  });
  assert.equal(mapped.code, 'ACCESS');
  assert.match(mapped.message, /us\.anthropic\.claude-haiku-4-5-20251001-v1:0/);
  assert.match(mapped.message, /us-east-1/);

  const invalid = toBedrockError(err('ValidationException', 'The provided model identifier is invalid.'));
  assert.equal(invalid.code, 'ACCESS');
});

test('throttling and other errors are mapped', () => {
  assert.equal(toBedrockError(err('ThrottlingException', 'Too many requests')).status, 429);
  const other = toBedrockError(err('InternalServerException', 'oops'));
  assert.equal(other.status, 502);
  assert.match(other.message, /\(InternalServerException\): oops/);
});

test('default model is Sonnet 4.5 inference profile unless BEDROCK_MODEL_ID is set', () => {
  const saved = process.env.BEDROCK_MODEL_ID;
  delete process.env.BEDROCK_MODEL_ID;
  assert.equal(defaultModelId(), 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
  assert.equal(defaultModelId(), 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
  if (saved === undefined) delete process.env.BEDROCK_MODEL_ID;
  else process.env.BEDROCK_MODEL_ID = saved;
  assert.ok(Object.keys(MODELS).every((id) => id.startsWith('us.anthropic.')));
});
