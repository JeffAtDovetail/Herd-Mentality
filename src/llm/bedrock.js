// Amazon Bedrock (Claude) via the Converse API. Server-side only — credentials come from
// the AWS SDK default provider chain (locally: the `dev` SSO profile), never from keys in code.

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

// Cross-region inference profile IDs (not bare model IDs), matching the platform repo.
export const MODELS = {
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'Claude Sonnet 4.5',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'Claude Haiku 4.5',
  'us.anthropic.claude-sonnet-4-20250514-v1:0': 'Claude Sonnet 4',
};

const FALLBACK_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

export function defaultModelId() {
  return process.env.BEDROCK_MODEL_ID || FALLBACK_MODEL_ID;
}

export function region() {
  return process.env.AWS_REGION ?? 'us-east-1';
}

let client = null;

/** One client for the life of the process (created on first use so .env is loaded by then). */
export function getBedrockClient() {
  client ??= new BedrockRuntimeClient({
    region: region(),
    credentials: fromNodeProviderChain(),
    // Built-in retries with client-side rate limiting handle ThrottlingException.
    maxAttempts: 4,
    retryMode: 'adaptive',
  });
  return client;
}

/** A Bedrock failure with a message that's safe and useful to show the host. */
export class BedrockError extends Error {
  constructor(message, { status = 502, cause, code } = {}) {
    super(message, { cause });
    this.name = 'BedrockError';
    this.status = status;
    this.code = code;
  }
}

/** Translate SDK errors into actionable messages. */
export function toBedrockError(err, { modelId = defaultModelId(), awsRegion = region() } = {}) {
  if (err instanceof BedrockError) return err;
  const name = err?.name ?? '';
  const message = err?.message ?? String(err);

  const credentialProblem =
    name === 'ExpiredTokenException' ||
    name === 'CredentialsProviderError' ||
    name === 'TokenProviderError' ||
    name === 'UnrecognizedClientException' ||
    /token (has|is) expired|sso session|sso.*(expired|login)|could not load credentials|refresh.*token/i.test(message);
  if (credentialProblem) {
    return new BedrockError('AWS SSO session expired or missing — run `aws sso login --profile dev`', {
      status: 401,
      code: 'CREDENTIALS',
      cause: err,
    });
  }

  const accessProblem =
    name === 'AccessDeniedException' ||
    name === 'ResourceNotFoundException' ||
    (name === 'ValidationException' && /model|inference profile/i.test(message));
  if (accessProblem) {
    return new BedrockError(
      `No access to model "${modelId}" in region ${awsRegion} (${name}: ${message}). ` +
        'Check model access / inference profiles for this account, or set BEDROCK_MODEL_ID.',
      { status: 403, code: 'ACCESS', cause: err },
    );
  }

  if (name === 'ThrottlingException' || name === 'ServiceQuotaExceededException') {
    return new BedrockError(`Bedrock is throttling requests for ${modelId} — wait a moment and try again.`, {
      status: 429,
      code: 'THROTTLED',
      cause: err,
    });
  }

  return new BedrockError(`Bedrock request failed (${name || 'Error'}): ${message}`, { cause: err });
}

/**
 * Send a conversation to a Claude model and return the text reply.
 * @param {{
 *   messages: Array<{ role: 'user' | 'assistant', content: string }>,
 *   system?: string,
 *   maxTokens?: number,
 *   temperature?: number,
 *   modelId?: string,
 *   abortSignal?: AbortSignal,
 * }} params
 */
export async function converse({
  messages,
  system,
  maxTokens = 1024,
  temperature,
  modelId = defaultModelId(),
  abortSignal,
}) {
  const input = {
    modelId,
    messages: messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
    inferenceConfig: { maxTokens, ...(temperature === undefined ? {} : { temperature }) },
    ...(system ? { system: [{ text: system }] } : {}),
  };

  const started = Date.now();
  try {
    const res = await getBedrockClient().send(new ConverseCommand(input), { abortSignal });
    const text = (res.output?.message?.content ?? [])
      .map((block) => block.text ?? '')
      .join('')
      .trim();
    return {
      text,
      modelId,
      stopReason: res.stopReason,
      usage: res.usage, // { inputTokens, outputTokens, totalTokens }
      latencyMs: res.metrics?.latencyMs ?? Date.now() - started,
    };
  } catch (err) {
    throw toBedrockError(err, { modelId });
  }
}

/**
 * Quick startup check that AWS credentials resolve (no model call, no cost).
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function checkCredentials() {
  try {
    await getBedrockClient().config.credentials();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: toBedrockError(err).message };
  }
}
