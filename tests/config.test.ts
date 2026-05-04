import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

type Env = Record<string, string | undefined>;

function loadConfigFromEnv(env: Env) {
  return loadConfig(env, { envFilePath: false });
}

function withCertFiles(run: (paths: { dir: string; cert: string; key: string; ca: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-mtls-proxy-'));
  try {
    const cert = join(dir, 'client.crt');
    const key = join(dir, 'client.key');
    const ca = join(dir, 'ca.crt');

    writeFileSync(cert, 'test cert');
    writeFileSync(key, 'test key');
    writeFileSync(ca, 'test ca');

    run({ dir, cert, key, ca });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig reads required mTLS files and applies safe defaults', () => {
  withCertFiles(({ cert, key, ca }) => {
    const config = loadConfigFromEnv({
      UPSTREAM_BASE_URL: 'https://llm-provider.example.com/openai',
      CLIENT_CERT_PATH: cert,
      CLIENT_KEY_PATH: key,
      CA_CERT_PATH: ca
    });

    assert.equal(config.listenHost, '127.0.0.1');
    assert.equal(config.listenPort, 8787);
    assert.equal(config.upstreamBaseUrl.href, 'https://llm-provider.example.com/openai');
    assert.equal(config.clientCert.toString(), 'test cert');
    assert.equal(config.clientKey.toString(), 'test key');
    assert.equal(config.caCert?.toString(), 'test ca');
    assert.equal(config.forwardAuthorization, false);
    assert.equal(config.translationMode, 'passthrough');
    assert.equal(config.upstreamTlsVerify, true);
    assert.equal(config.upstreamTimeoutMs, 120000);
  });
});

test('loadConfig rejects missing required environment variables', () => {
  assert.throws(
    () => loadConfigFromEnv({}),
    /UPSTREAM_BASE_URL is required/
  );
});

test('loadConfig rejects missing client certificate path', () => {
  withCertFiles(({ key }) => {
    assert.throws(
      () => loadConfigFromEnv({
        UPSTREAM_BASE_URL: 'https://llm-provider.example.com/v1',
        CLIENT_KEY_PATH: key
      }),
      /CLIENT_CERT_PATH is required/
    );
  });
});

test('loadConfig rejects missing client key path', () => {
  withCertFiles(({ cert }) => {
    assert.throws(
      () => loadConfigFromEnv({
        UPSTREAM_BASE_URL: 'https://llm-provider.example.com/v1',
        CLIENT_CERT_PATH: cert
      }),
      /CLIENT_KEY_PATH is required/
    );
  });
});

test('loadConfig rejects non-HTTPS upstream URLs', () => {
  withCertFiles(({ cert, key }) => {
    assert.throws(
      () => loadConfigFromEnv({
        UPSTREAM_BASE_URL: 'http://llm-provider.example.com/v1',
        CLIENT_CERT_PATH: cert,
        CLIENT_KEY_PATH: key
      }),
      /UPSTREAM_BASE_URL must use https:/
    );
  });
});

test('loadConfig parses explicit port, local auth, auth forwarding, translation mode, TLS verification, and timeout', () => {
  withCertFiles(({ cert, key }) => {
    const config = loadConfigFromEnv({
      LISTEN_HOST: '127.0.0.1',
      LISTEN_PORT: '9999',
      UPSTREAM_BASE_URL: 'https://llm-provider.example.com/v1',
      CLIENT_CERT_PATH: cert,
      CLIENT_KEY_PATH: key,
      LOCAL_AUTH_TOKEN: 'local-secret',
      FORWARD_AUTHORIZATION: 'true',
      TRANSLATION_MODE: 'openai-gigachat',
      UPSTREAM_TLS_VERIFY: 'false',
      UPSTREAM_TIMEOUT_MS: '5000'
    });

    assert.equal(config.listenHost, '127.0.0.1');
    assert.equal(config.listenPort, 9999);
    assert.equal(config.localAuthToken, 'local-secret');
    assert.equal(config.forwardAuthorization, true);
    assert.equal(config.translationMode, 'openai-gigachat');
    assert.equal(config.upstreamTlsVerify, false);
    assert.equal(config.upstreamTimeoutMs, 5000);
  });
});

test('loadConfig rejects invalid numeric and boolean values', () => {
  withCertFiles(({ cert, key }) => {
    const baseEnv = {
      UPSTREAM_BASE_URL: 'https://llm-provider.example.com/v1',
      CLIENT_CERT_PATH: cert,
      CLIENT_KEY_PATH: key
    };

    assert.throws(
      () => loadConfigFromEnv({ ...baseEnv, LISTEN_PORT: '70000' }),
      /LISTEN_PORT must be an integer between 1 and 65535/
    );

    assert.throws(
      () => loadConfigFromEnv({ ...baseEnv, FORWARD_AUTHORIZATION: 'yes' }),
      /FORWARD_AUTHORIZATION must be true or false/
    );

    assert.throws(
      () => loadConfigFromEnv({ ...baseEnv, UPSTREAM_TLS_VERIFY: 'yes' }),
      /UPSTREAM_TLS_VERIFY must be true or false/
    );

    assert.throws(
      () => loadConfigFromEnv({ ...baseEnv, TRANSLATION_MODE: 'translate' }),
      /TRANSLATION_MODE must be passthrough or openai-gigachat/
    );

    assert.throws(
      () => loadConfigFromEnv({ ...baseEnv, UPSTREAM_TIMEOUT_MS: '0' }),
      /UPSTREAM_TIMEOUT_MS must be a positive integer/
    );
  });
});

test('loadConfig reports unreadable certificate files by environment variable name', () => {
  withCertFiles(({ key }) => {
    assert.throws(
      () => loadConfigFromEnv({
        UPSTREAM_BASE_URL: 'https://llm-provider.example.com/v1',
        CLIENT_CERT_PATH: '/path/that/does/not/exist/client.crt',
        CLIENT_KEY_PATH: key
      }),
      /Unable to read CLIENT_CERT_PATH/
    );
  });
});

test('loadConfig reads .env values and lets them override provided environment values', () => {
  withCertFiles(({ dir, cert, key, ca }) => {
    const envFilePath = join(dir, '.env');
    writeFileSync(envFilePath, [
      'UPSTREAM_BASE_URL=https://dotenv-provider.example.com/openai',
      `CLIENT_CERT_PATH=${cert}`,
      `CLIENT_KEY_PATH=${key}`,
      `CA_CERT_PATH=${ca}`,
      'LISTEN_HOST=0.0.0.0',
      'LISTEN_PORT=9876',
      'LOCAL_AUTH_TOKEN=dotenv-secret',
      'FORWARD_AUTHORIZATION=true',
      'UPSTREAM_TIMEOUT_MS=5000'
    ].join('\n'));

    const config = loadConfig({
      UPSTREAM_BASE_URL: 'https://env-provider.example.com/v1',
      CLIENT_CERT_PATH: '/missing/env-client.crt',
      CLIENT_KEY_PATH: '/missing/env-client.key',
      LISTEN_HOST: '127.0.0.1',
      LISTEN_PORT: '1234',
      LOCAL_AUTH_TOKEN: 'env-secret',
      FORWARD_AUTHORIZATION: 'false',
      UPSTREAM_TIMEOUT_MS: '120000'
    }, { envFilePath });

    assert.equal(config.listenHost, '0.0.0.0');
    assert.equal(config.listenPort, 9876);
    assert.equal(config.upstreamBaseUrl.href, 'https://dotenv-provider.example.com/openai');
    assert.equal(config.clientCert.toString(), 'test cert');
    assert.equal(config.clientKey.toString(), 'test key');
    assert.equal(config.caCert?.toString(), 'test ca');
    assert.equal(config.localAuthToken, 'dotenv-secret');
    assert.equal(config.forwardAuthorization, true);
    assert.equal(config.upstreamTimeoutMs, 5000);
  });
});

test('loadConfig reads .env from the current working directory by default', () => {
  withCertFiles(({ dir, cert, key }) => {
    const previousCwd = process.cwd();
    try {
      writeFileSync(join(dir, '.env'), [
        'UPSTREAM_BASE_URL=https://default-dotenv.example.com/v1',
        `CLIENT_CERT_PATH=${cert}`,
        `CLIENT_KEY_PATH=${key}`
      ].join('\n'));

      process.chdir(dir);
      const config = loadConfig({});

      assert.equal(config.upstreamBaseUrl.href, 'https://default-dotenv.example.com/v1');
      assert.equal(config.clientCert.toString(), 'test cert');
      assert.equal(config.clientKey.toString(), 'test key');
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('loadConfig ignores a missing .env file', () => {
  withCertFiles(({ dir, cert, key }) => {
    const config = loadConfig({
      UPSTREAM_BASE_URL: 'https://llm-provider.example.com/v1',
      CLIENT_CERT_PATH: cert,
      CLIENT_KEY_PATH: key
    }, { envFilePath: join(dir, '.env.missing') });

    assert.equal(config.listenHost, '127.0.0.1');
    assert.equal(config.listenPort, 8787);
    assert.equal(config.upstreamBaseUrl.href, 'https://llm-provider.example.com/v1');
  });
});

test('loadConfig rejects malformed .env lines with a line number', () => {
  withCertFiles(({ dir }) => {
    const envFilePath = join(dir, '.env');
    writeFileSync(envFilePath, 'UPSTREAM_BASE_URL\n');

    assert.throws(
      () => loadConfig({}, { envFilePath }),
      /Invalid .env file line 1: expected KEY=value/
    );
  });
});
