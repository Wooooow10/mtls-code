import http, { type ClientRequest, type RequestOptions, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProxyConfig } from '../src/config.js';
import { createServer, startServer } from '../src/server.js';
import type { RequestFunction } from '../src/proxy.js';

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    listenHost: '127.0.0.1',
    listenPort: 8787,
    upstreamBaseUrl: new URL('http://127.0.0.1:1'),
    clientCert: Buffer.from('cert'),
    clientKey: Buffer.from('key'),
    forwardAuthorization: false,
    upstreamTlsVerify: true,
    upstreamTimeoutMs: 5000,
    ...overrides
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function requestLocal(port: number): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: '/v1/models'
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function signalListenerCounts(): { sigint: number; sigterm: number } {
  return {
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM')
  };
}

test('createServer wires the proxy handler with injected dependencies', async () => {
  let upstreamCalled = false;
  const request: RequestFunction = (_options: RequestOptions, _callback) => {
    upstreamCalled = true;
    return new http.ClientRequest('http://127.0.0.1');
  };

  const server = createServer(config({ localAuthToken: 'local-secret' }), {
    request,
    logger: () => undefined,
    generateRequestId: () => 'req-server'
  });
  const port = await listen(server);

  try {
    const response = await requestLocal(port);

    assert.equal(response.statusCode, 401);
    assert.equal(response.body, JSON.stringify({ error: { message: 'Unauthorized' } }));
    assert.equal(upstreamCalled, false);
  } finally {
    await close(server);
  }
});

test('startServer logs async startup failures from listen errors', async () => {
  const occupiedServer = createServer(config());
  const occupiedPort = await listen(occupiedServer);
  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  const originalExitCode = process.exitCode;
  const originalSignalCounts = signalListenerCounts();
  let server: Server | undefined;

  console.error = (message?: unknown) => {
    loggedErrors.push(String(message));
  };

  try {
    const errorHandled = new Promise<void>((resolve) => {
      server = startServer(config({ listenPort: occupiedPort }));
      server.once('error', () => {
        resolve();
      });
    });

    await errorHandled;

    assert.deepEqual(loggedErrors.map((message) => JSON.parse(message)), [
      { event: 'server_start_failed', message: `listen EADDRINUSE: address already in use 127.0.0.1:${occupiedPort}` }
    ]);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(signalListenerCounts(), originalSignalCounts);
  } finally {
    console.error = originalConsoleError;
    process.exitCode = originalExitCode;
    if (server?.listening) {
      await close(server);
    }
    await close(occupiedServer);
  }
});

test('startServer redacts sensitive upstream URL parts from startup logs', async () => {
  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  let server: Server | undefined;

  console.error = (message?: unknown) => {
    loggedErrors.push(String(message));
  };

  try {
    await new Promise<void>((resolve) => {
      server = startServer(config({
        listenPort: 0,
        upstreamBaseUrl: new URL('https://user:password@example.com/v1/provider?token=secret#fragment')
      }));
      server.once('listening', () => {
        resolve();
      });
    });

    assert.deepEqual(loggedErrors.map((message) => JSON.parse(message)), [
      {
        event: 'server_started',
        listenHost: '127.0.0.1',
        listenPort: 0,
        upstreamBaseUrl: 'https://example.com/v1/provider'
      }
    ]);
  } finally {
    console.error = originalConsoleError;
    if (server?.listening) {
      await close(server);
    }
  }
});

test('startServer cleans up signal listeners after a started server closes', async () => {
  const originalConsoleError = console.error;
  const originalSignalCounts = signalListenerCounts();
  let server: Server | undefined;

  console.error = () => undefined;

  try {
    await new Promise<void>((resolve) => {
      server = startServer(config({ listenPort: 0 }));
      server.once('listening', () => {
        resolve();
      });
    });

    assert.equal(signalListenerCounts().sigint, originalSignalCounts.sigint + 1);
    assert.equal(signalListenerCounts().sigterm, originalSignalCounts.sigterm + 1);

    const startedServer = server;
    assert.ok(startedServer);
    await close(startedServer);

    assert.deepEqual(signalListenerCounts(), originalSignalCounts);
  } finally {
    console.error = originalConsoleError;
    if (server?.listening) {
      await close(server);
    }
  }
});
