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
  upstreamTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): ProxyConfig {
  const upstreamBaseUrl = parseHttpsUrl(requireEnv(env, 'UPSTREAM_BASE_URL'), 'UPSTREAM_BASE_URL');
  const clientCert = readSecretFile(requireEnv(env, 'CLIENT_CERT_PATH'), 'CLIENT_CERT_PATH');
  const clientKey = readSecretFile(requireEnv(env, 'CLIENT_KEY_PATH'), 'CLIENT_KEY_PATH');
  const caCert = env.CA_CERT_PATH ? readSecretFile(env.CA_CERT_PATH, 'CA_CERT_PATH') : undefined;

  return {
    listenHost: env.LISTEN_HOST || '127.0.0.1',
    listenPort: parsePort(env.LISTEN_PORT || '8787', 'LISTEN_PORT'),
    upstreamBaseUrl,
    clientCert,
    clientKey,
    caCert,
    localAuthToken: env.LOCAL_AUTH_TOKEN || undefined,
    forwardAuthorization: parseBoolean(env.FORWARD_AUTHORIZATION || 'false', 'FORWARD_AUTHORIZATION'),
    upstreamTimeoutMs: parsePositiveInteger(env.UPSTREAM_TIMEOUT_MS || '120000', 'UPSTREAM_TIMEOUT_MS')
  };
}

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
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

function readSecretFile(path: string, envName: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new Error(`Unable to read ${envName}`);
  }
}
