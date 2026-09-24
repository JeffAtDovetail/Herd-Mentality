// Load an optional .env file (repo root) into process.env using Node's built-in loader.
// Import this first so AWS_PROFILE / AWS_REGION / BEDROCK_MODEL_ID are set before anything reads them.
// Variables already set in the shell win over .env.

import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));

try {
  process.loadEnvFile?.(envPath);
} catch (err) {
  if (err.code !== 'ENOENT') console.warn(`Could not read .env: ${err.message}`);
}
