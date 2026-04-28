import http, { type ClientRequest, type IncomingMessage, type RequestOptions, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProxyConfig } from '../src/config.js';
import { createProxyHandler, type RequestFunction } from '../src/proxy.js';

function configFor(upstreamBaseUrl: string, overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    listenHost: '127.0.0.1',
    listenPort: 8787,
    upstreamBaseUrl: new URL(upstreamBaseUrl),
    clientCert: Buffer.from('cert'),
    clientKey: Buffer.from('key'),
    forwardAuthorization: false,
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

function requestLocal(port: number, options: RequestOptions, body?: string): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      ...options
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          body: responseBody,
          headers: res.headers
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

function httpRequest(options: RequestOptions, callback: (response: http.IncomingMessage) => void): ClientRequest {
  return http.request(options, callback);
}

test('createProxyHandler forwards request path, query, method, body, and streams response', async () => {
  const received: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined; body: string }> = [];

  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body
      });

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => {
        res.end('data: [DONE]\n\n');
      }, 10);
    });
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}/openai`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-test'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions?stream=true',
      headers: {
        authorization: 'Bearer dummy',
        'content-type': 'application/json'
      }
    }, JSON.stringify({ stream: true }));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream');
    assert.equal(response.body, 'data: first\n\ndata: [DONE]\n\n');
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/openai/v1/chat/completions?stream=true');
    assert.equal(received[0].authorization, undefined);
    assert.equal(received[0].body, JSON.stringify({ stream: true }));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('createProxyHandler rejects missing local auth token before calling upstream', async () => {
  let upstreamCalled = false;
  const upstream = http.createServer((_req, res) => {
    upstreamCalled = true;
    res.writeHead(200).end('unexpected');
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`, {
    localAuthToken: 'local-secret'
  }), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-auth'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'GET',
      path: '/v1/models'
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.body, JSON.stringify({ error: { message: 'Unauthorized' } }));
    assert.equal(upstreamCalled, false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('createProxyHandler maps upstream request errors to safe JSON responses', async () => {
  const failingRequest: RequestFunction = (_options, _callback) => {
    const req = new http.ClientRequest('http://127.0.0.1');
    process.nextTick(() => {
      const error = new Error('certificate rejected') as NodeJS.ErrnoException;
      error.code = 'CERT_SIGNATURE_FAILURE';
      req.emit('error', error);
    });
    return req;
  };

  const proxy = http.createServer(createProxyHandler(configFor('http://127.0.0.1:1'), {
    request: failingRequest,
    logger: () => undefined,
    generateRequestId: () => 'req-error'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'GET',
      path: '/v1/models'
    });

    assert.equal(response.statusCode, 502);
    assert.equal(response.body, JSON.stringify({ error: { message: 'Upstream mTLS handshake failed' } }));
  } finally {
    await close(proxy);
  }
});

test('createProxyHandler maps upstream request timeouts to safe JSON responses', async () => {
  let upstreamDestroyed = false;
  const timeoutRequest: RequestFunction = (_options, _callback) => {
    const req = new PassThrough() as unknown as ClientRequest;
    const originalDestroy = req.destroy.bind(req);
    req.setTimeout = (_timeout, callback) => {
      if (callback) {
        process.nextTick(callback);
      }
      return req;
    };
    req.destroy = (error?: Error) => {
      upstreamDestroyed = true;
      return originalDestroy(error);
    };
    return req;
  };

  const proxy = http.createServer(createProxyHandler(configFor('http://127.0.0.1:1', {
    upstreamTimeoutMs: 1
  }), {
    request: timeoutRequest,
    logger: () => undefined,
    generateRequestId: () => 'req-timeout'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'GET',
      path: '/v1/models'
    });

    assert.equal(response.statusCode, 504);
    assert.equal(response.body, JSON.stringify({ error: { message: 'Upstream request timed out' } }));
    assert.equal(upstreamDestroyed, true);
  } finally {
    await close(proxy);
  }
});

test('createProxyHandler maps synchronous upstream request creation errors to safe JSON responses', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const throwingRequest: RequestFunction = (_options, _callback) => {
    const error = new Error('bad certificate material') as NodeJS.ErrnoException;
    error.code = 'CERT_SIGNATURE_FAILURE';
    throw error;
  };

  const proxy = http.createServer(createProxyHandler(configFor('http://127.0.0.1:1'), {
    request: throwingRequest,
    logger: (entry) => logs.push(entry),
    generateRequestId: () => 'req-sync-error'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions?api_key=secret-token',
      headers: {
        'content-type': 'application/json'
      }
    }, JSON.stringify({ prompt: 'do not log this' }));

    assert.equal(response.statusCode, 502);
    assert.equal(response.body, JSON.stringify({ error: { message: 'Upstream mTLS handshake failed' } }));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, 'request_failed');
    assert.equal(logs[0].path, '/v1/chat/completions');
    assert.equal(logs[0].reason, 'Upstream mTLS handshake failed');
    assert.equal(JSON.stringify(logs[0]).includes('secret-token'), false);
    assert.equal(JSON.stringify(logs[0]).includes('do not log this'), false);
  } finally {
    await close(proxy);
  }
});

test('createProxyHandler logs request path without query string', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200).end('ok');
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: (entry) => logs.push(entry),
    generateRequestId: () => 'req-log'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'GET',
      path: '/v1/models?api_key=secret-token&signature=sensitive'
    });

    assert.equal(response.statusCode, 200);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].path, '/v1/models');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('createProxyHandler destroys upstream request when downstream client closes early', async () => {
  let upstreamClosed: (() => void) | undefined;
  const upstreamClosedPromise = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });

  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    res.on('close', () => {
      upstreamClosed?.();
    });
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-close'
  }));

  const proxyPort = await listen(proxy);

  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: '/v1/chat/completions?stream=true'
      }, (res) => {
        res.on('data', () => {
          req.destroy();
          resolve();
        });
      });

      req.on('error', reject);
      req.end();
    });

    await Promise.race([
      upstreamClosedPromise,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('upstream request was not destroyed')), 100);
      })
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('createProxyHandler handles upstream response stream errors without uncaught exceptions', async () => {
  const logs: Array<Record<string, unknown>> = [];
  let uncaught: Error | undefined;
  const captureUncaught = (error: Error) => {
    uncaught = error;
  };
  process.once('uncaughtException', captureUncaught);

  const failingResponse = new PassThrough() as unknown as IncomingMessage;
  failingResponse.statusCode = 200;
  failingResponse.headers = { 'content-type': 'text/event-stream' };

  const failingRequest: RequestFunction = (_options, callback) => {
    const req = new http.ClientRequest('http://127.0.0.1');
    process.nextTick(() => {
      callback(failingResponse);
      failingResponse.emit('error', new Error('upstream stream failed'));
    });
    return req;
  };

  const proxy = http.createServer(createProxyHandler(configFor('http://127.0.0.1:1'), {
    request: failingRequest,
    logger: (entry) => logs.push(entry),
    generateRequestId: () => 'req-stream-error'
  }));

  const proxyPort = await listen(proxy);

  try {
    await Promise.race([
      requestLocal(proxyPort, {
        method: 'GET',
        path: '/v1/chat/completions?stream=true&api_key=secret-token'
      }).catch(() => undefined),
      new Promise((resolve) => {
        setTimeout(resolve, 50);
      })
    ]);

    assert.equal(logs.some((entry) => entry.event === 'response_stream_failed' && entry.path === '/v1/chat/completions'), true);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    assert.equal(uncaught, undefined);
  } finally {
    process.removeListener('uncaughtException', captureUncaught);
    await close(proxy);
  }
});

test('createProxyHandler handles incoming request stream errors and destroys upstream request', async () => {
  const logs: Array<Record<string, unknown>> = [];
  let upstreamDestroyed = false;
  let uncaught: Error | undefined;
  const captureUncaught = (error: Error) => {
    uncaught = error;
  };
  process.once('uncaughtException', captureUncaught);

  const upstreamReq = new PassThrough() as unknown as ClientRequest;
  upstreamReq.setTimeout = () => upstreamReq;
  const originalDestroy = upstreamReq.destroy.bind(upstreamReq);
  upstreamReq.destroy = (error?: Error) => {
    upstreamDestroyed = true;
    return originalDestroy(error);
  };

  const fakeRequest: RequestFunction = (_options, _callback) => upstreamReq;
  const incoming = new PassThrough() as unknown as IncomingMessage;
  incoming.headers = {};
  incoming.method = 'POST';
  incoming.url = '/v1/chat/completions?api_key=secret-token';

  const response = new http.ServerResponse(incoming);

  try {
    createProxyHandler(configFor('http://127.0.0.1:1'), {
      request: fakeRequest,
      logger: (entry) => logs.push(entry),
      generateRequestId: () => 'req-upload-error'
    })(incoming, response);

    const error = new Error('client reset') as NodeJS.ErrnoException;
    error.code = 'ECONNRESET';
    incoming.emit('error', error);

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    assert.equal(uncaught, undefined);
    assert.equal(upstreamDestroyed, true);
    assert.equal(logs.some((entry) => entry.event === 'incoming_request_failed' && entry.path === '/v1/chat/completions'), true);
  } finally {
    process.removeListener('uncaughtException', captureUncaught);
    response.destroy();
    upstreamReq.destroy();
  }
});
