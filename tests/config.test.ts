import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

function withCertFiles(run: (paths: { cert: string; key: string; ca: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-mtls-proxy-'));
  try {
    const cert = join(dir, 'client.crt');
    const key = join(dir, 'client.key');
    const ca = join(dir, 'ca.crt');

    writeFileSync(cert, 'test cert');
    writeFileSync(key, 'test key');
    writeFileSync(ca, 'test ca');

    run({ cert, key, ca });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig reads required mTLS files and applies safe defaults', () => {
  withCertFiles(({ cert, key, ca }) => {
    const config = loadConfig({
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
    assert.equal(config.upstreamTimeoutMs, 120000);
  });
});

test('loadConfig rejects missing required environment variables', () => {
  assert.throws(
    () => loadConfig({}),
    /UPSTREAM_BASE_URL is required/
  );
});

test('loadConfig rejects missing client certificate path', () => {
  withCertFiles(({ key }) => {
    assert.throws(
      () => loadConfig({
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
      () => loadConfig({
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
      () => loadConfig({
        UPSTREAM_BASE_URL: 'http://llm-provider.example.com/v1',
        CLIENT_CERT_PATH: cert,
        CLIENT_KEY_PATH: key
      }),
      /UPSTREAM_BASE_URL must use https:/
    );
  });
});

test('loadConfig parses explicit port, local auth, auth forwarding, and timeout', () => {
  withCertFiles(({ cert, key }) => {
    const config = loadConfig({
      LISTEN_HOST: '127.0.0.1',
      LISTEN_PORT: '9999',
      UPSTREAM_BASE_URL: 'https://llm-provider.example.com/v1',
      CLIENT_CERT_PATH: cert,
      CLIENT_KEY_PATH: key,
      LOCAL_AUTH_TOKEN: 'local-secret',
      FORWARD_AUTHORIZATION: 'true',
      UPSTREAM_TIMEOUT_MS: '5000'
    });

    assert.equal(config.listenHost, '127.0.0.1');
    assert.equal(config.listenPort, 9999);
    assert.equal(config.localAuthToken, 'local-secret');
    assert.equal(config.forwardAuthorization, true);
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
      () => loadConfig({ ...baseEnv, LISTEN_PORT: '70000' }),
      /LISTEN_PORT must be an integer between 1 and 65535/
    );

    assert.throws(
      () => loadConfig({ ...baseEnv, FORWARD_AUTHORIZATION: 'yes' }),
      /FORWARD_AUTHORIZATION must be true or false/
    );

    assert.throws(
      () => loadConfig({ ...baseEnv, UPSTREAM_TIMEOUT_MS: '0' }),
      /UPSTREAM_TIMEOUT_MS must be a positive integer/
    );
  });
});

test('loadConfig reports unreadable certificate files by environment variable name', () => {
  withCertFiles(({ key }) => {
    assert.throws(
      () => loadConfig({
        UPSTREAM_BASE_URL: 'https://llm-provider.example.com/v1',
        CLIENT_CERT_PATH: '/path/that/does/not/exist/client.crt',
        CLIENT_KEY_PATH: key
      }),
      /Unable to read CLIENT_CERT_PATH/
    );
  });
});
