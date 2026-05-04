import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProxyConfig } from '../src/config.js';
import {
  buildUpstreamUrl,
  classifyUpstreamError,
  isLocalRequestAuthorized,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  UPSTREAM_TIMEOUT_MESSAGE
} from '../src/request-utils.js';

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    listenHost: '127.0.0.1',
    listenPort: 8787,
    upstreamBaseUrl: new URL('https://llm-provider.example.com/openai'),
    clientCert: Buffer.from('cert'),
    clientKey: Buffer.from('key'),
    forwardAuthorization: false,
    translationMode: 'passthrough',
    upstreamTlsVerify: true,
    upstreamTimeoutMs: 120000,
    ...overrides
  };
}

test('buildUpstreamUrl appends incoming path and query to upstream base path', () => {
  const target = buildUpstreamUrl(
    new URL('https://llm-provider.example.com/api/openai'),
    '/v1/chat/completions?stream=true'
  );

  assert.equal(target.href, 'https://llm-provider.example.com/api/openai/v1/chat/completions?stream=true');
});

test('buildUpstreamUrl handles provider root URLs', () => {
  const target = buildUpstreamUrl(
    new URL('https://llm-provider.example.com/'),
    '/v1/models'
  );

  assert.equal(target.href, 'https://llm-provider.example.com/v1/models');
});

test('sanitizeRequestHeaders strips hop-by-hop headers and local authorization by default', () => {
  const headers = sanitizeRequestHeaders({
    host: '127.0.0.1:8787',
    connection: 'keep-alive',
    authorization: 'Bearer dummy',
    'content-type': 'application/json',
    'x-custom': 'kept'
  }, config());

  assert.equal(headers.host, undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-custom'], 'kept');
});

test('sanitizeRequestHeaders forwards authorization only when explicitly enabled', () => {
  const headers = sanitizeRequestHeaders({
    authorization: 'Bearer upstream-token'
  }, config({ forwardAuthorization: true }));

  assert.equal(headers.authorization, 'Bearer upstream-token');
});

test('sanitizeRequestHeaders strips custom hop-by-hop headers named by connection', () => {
  const headers = sanitizeRequestHeaders({
    connection: 'x-debug-hop, keep-alive',
    'x-debug-hop': 'remove me',
    'x-custom': 'kept'
  }, config());

  assert.equal(headers.connection, undefined);
  assert.equal(headers['x-debug-hop'], undefined);
  assert.equal(headers['x-custom'], 'kept');
});

test('sanitizeResponseHeaders strips hop-by-hop response headers', () => {
  const headers = sanitizeResponseHeaders({
    connection: 'close',
    'transfer-encoding': 'chunked',
    'content-type': 'text/event-stream'
  });

  assert.equal(headers.connection, undefined);
  assert.equal(headers['transfer-encoding'], undefined);
  assert.equal(headers['content-type'], 'text/event-stream');
});

test('sanitizeResponseHeaders strips custom hop-by-hop headers named by connection', () => {
  const headers = sanitizeResponseHeaders({
    connection: 'x-upstream-hop, keep-alive',
    'x-upstream-hop': 'remove me',
    'content-type': 'application/json'
  });

  assert.equal(headers.connection, undefined);
  assert.equal(headers['x-upstream-hop'], undefined);
  assert.equal(headers['content-type'], 'application/json');
});

test('isLocalRequestAuthorized allows requests when local auth is disabled', () => {
  assert.equal(isLocalRequestAuthorized(undefined, config()), true);
});

test('isLocalRequestAuthorized requires exact bearer token when local auth is enabled', () => {
  const protectedConfig = config({ localAuthToken: 'local-secret' });

  assert.equal(isLocalRequestAuthorized('Bearer local-secret', protectedConfig), true);
  assert.equal(isLocalRequestAuthorized('Bearer wrong', protectedConfig), false);
  assert.equal(isLocalRequestAuthorized(undefined, protectedConfig), false);
});

test('classifyUpstreamError maps timeout and TLS failures to safe client messages', () => {
  assert.deepEqual(classifyUpstreamError(new Error(UPSTREAM_TIMEOUT_MESSAGE)), {
    statusCode: 504,
    message: 'Upstream request timed out'
  });

  const tlsError = new Error('certificate rejected') as NodeJS.ErrnoException;
  tlsError.code = 'CERT_SIGNATURE_FAILURE';

  assert.deepEqual(classifyUpstreamError(tlsError), {
    statusCode: 502,
    message: 'Upstream mTLS handshake failed'
  });

  assert.deepEqual(classifyUpstreamError(new Error('socket closed')), {
    statusCode: 502,
    message: 'Upstream request failed'
  });
});

test('classifyUpstreamError maps common Node and OpenSSL TLS codes to mTLS failures', () => {
  const tlsCodes = [
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
    'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
    'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED'
  ];

  for (const code of tlsCodes) {
    const tlsError = new Error(code) as NodeJS.ErrnoException;
    tlsError.code = code;

    assert.deepEqual(classifyUpstreamError(tlsError), {
      statusCode: 502,
      message: 'Upstream mTLS handshake failed'
    });
  }
});
