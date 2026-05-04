import { readFileSync } from 'node:fs';

export interface ProxyConfig {
  listenHost: string;
  listenPort: number;
  upstreamBaseUrl: URL;
  clientCert: Buffer;
  clientKey: Buffer;
  caCert?: Buffer;
  localAuthToken?: string;
  forwardAuthorization: boolean;
  translationMode: TranslationMode;
  upstreamTlsVerify: boolean;
  upstreamTimeoutMs: number;
}

export type TranslationMode = 'passthrough' | 'openai-gigachat';

type Env = Record<string, string | undefined>;

export interface LoadConfigOptions {
  envFilePath?: string | false;
}

export function loadConfig(env: Env = process.env, options: LoadConfigOptions = {}): ProxyConfig {
  const mergedEnv = mergeEnvFile(env, options.envFilePath ?? '.env');
  const upstreamBaseUrl = parseHttpsUrl(requireEnv(mergedEnv, 'UPSTREAM_BASE_URL'), 'UPSTREAM_BASE_URL');
  const clientCert = readSecretFile(requireEnv(mergedEnv, 'CLIENT_CERT_PATH'), 'CLIENT_CERT_PATH');
  const clientKey = readSecretFile(requireEnv(mergedEnv, 'CLIENT_KEY_PATH'), 'CLIENT_KEY_PATH');
  const caCert = mergedEnv.CA_CERT_PATH ? readSecretFile(mergedEnv.CA_CERT_PATH, 'CA_CERT_PATH') : undefined;

  return {
    listenHost: mergedEnv.LISTEN_HOST || '127.0.0.1',
    listenPort: parsePort(mergedEnv.LISTEN_PORT || '8787', 'LISTEN_PORT'),
    upstreamBaseUrl,
    clientCert,
    clientKey,
    caCert,
    localAuthToken: mergedEnv.LOCAL_AUTH_TOKEN || undefined,
    forwardAuthorization: parseBoolean(mergedEnv.FORWARD_AUTHORIZATION || 'false', 'FORWARD_AUTHORIZATION'),
    translationMode: parseTranslationMode(mergedEnv.TRANSLATION_MODE || 'passthrough'),
    upstreamTlsVerify: parseBoolean(mergedEnv.UPSTREAM_TLS_VERIFY || 'true', 'UPSTREAM_TLS_VERIFY'),
    upstreamTimeoutMs: parsePositiveInteger(mergedEnv.UPSTREAM_TIMEOUT_MS || '120000', 'UPSTREAM_TIMEOUT_MS')
  };
}

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function mergeEnvFile(env: Env, envFilePath: string | false): Env {
  if (envFilePath === false) {
    return { ...env };
  }

  return { ...env, ...readEnvFile(envFilePath) };
}

function readEnvFile(path: string): Env {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Unable to read .env file at ${path}`);
  }

  return parseEnvFile(contents);
}

function parseEnvFile(contents: string): Env {
  const values: Env = {};
  const lines = contents.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid .env file line ${index + 1}: expected KEY=value`);
    }

    values[match[1]] = parseEnvValue(match[2]);
  }

  return values;
}

function parseEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  const commentIndex = value.indexOf(' #');
  if (commentIndex === -1) {
    return value;
  }

  return value.slice(0, commentIndex).trimEnd();
}

function parseHttpsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use https:`);
  }

  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  return url;
}

function parsePort(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseTranslationMode(value: string): TranslationMode {
  if (value === 'passthrough' || value === 'openai-gigachat') {
    return value;
  }
  throw new Error('TRANSLATION_MODE must be passthrough or openai-gigachat');
}

function readSecretFile(path: string, envName: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new Error(`Unable to read ${envName}`);
  }
}
