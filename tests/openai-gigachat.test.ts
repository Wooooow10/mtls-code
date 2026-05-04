import http, { type ClientRequest, type RequestOptions, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
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
    translationMode: 'openai-gigachat',
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

function requestLocal(port: number, options: RequestOptions, body?: string): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, ...options }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body: responseBody, headers: res.headers });
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

test('openai-gigachat mode rejects unsupported endpoints without calling upstream', async () => {
  let upstreamCalled = false;
  const upstream = http.createServer((_req, res) => {
    upstreamCalled = true;
    res.writeHead(200).end('unexpected');
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-unsupported'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/embeddings',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ input: 'hello' }));

    assert.equal(response.statusCode, 404);
    assert.equal(upstreamCalled, false);
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'Unsupported endpoint in openai-gigachat translation mode: POST /v1/embeddings',
        type: 'invalid_request_error',
        param: null,
        code: 'unsupported_endpoint'
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode translates chat request path, headers, messages, tools, and parameters', async () => {
  let received: { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders; body: string } | undefined;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}/gigachat`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-transform'
  }));

  const proxyPort = await listen(proxy);

  try {
    const requestBody = JSON.stringify({
      model: 'GigaChat-Pro',
      messages: [
        { role: 'developer', content: 'dev rules' },
        { role: 'system', content: 'later system' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] },
        { role: 'user', content: 'again' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"cats"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"results":[1]}' }
      ],
      max_output_tokens: 12,
      temperature: 0,
      top_p: 1,
      extra_body: { foo: 'bar' },
      additional_fields: { foo: 'kept', baz: true },
      reasoning: { effort: 'high', summary: 'drop me' },
      function_call: { name: 'web_search' },
      functions: [{ name: 'legacy_fn', description: 'legacy', parameters: { type: 'object' } }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'search the web',
            parameters: {
              type: 'object',
              $defs: { Term: { anyOf: [{ type: 'null' }, { type: 'string' }] } },
              properties: {
                query: { $ref: '#/$defs/Term' },
                maybe: { type: ['string', 'null'] },
                choice: { oneOf: [{ type: 'null' }, { type: 'integer' }] },
                nested: { type: 'object' }
              }
            }
          }
        },
        { type: 'function', function: { name: 'skip_no_params', description: 'skip me' } }
      ]
    });

    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions?trace=1',
      headers: {
        authorization: 'Bearer local-only',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(requestBody).toString()
      }
    }, requestBody);

    assert.equal(response.statusCode, 200);
    assert.ok(received);
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/gigachat/chat/completions?trace=1');
    assert.equal(received.headers.authorization, undefined);
    assert.equal(received.headers['content-type'], 'application/json');
    assert.equal(received.headers['content-length'], Buffer.byteLength(received.body).toString());

    const upstreamBody = JSON.parse(received.body);
    assert.equal(upstreamBody.model, 'GigaChat-Pro');
    assert.equal(upstreamBody.max_tokens, 12);
    assert.equal(upstreamBody.max_output_tokens, undefined);
    assert.equal(upstreamBody.temperature, undefined);
    assert.equal(upstreamBody.top_p, 0);
    assert.deepEqual(upstreamBody.additional_fields, { foo: 'kept', baz: true });
    assert.equal(upstreamBody.extra_body, undefined);
    assert.equal(upstreamBody.reasoning, undefined);
    assert.equal(upstreamBody.reasoning_effort, 'high');
    assert.equal(upstreamBody.tools, undefined);
    assert.deepEqual(upstreamBody.function_call, { name: '__gpt2giga_user_search_web' });
    assert.deepEqual(upstreamBody.messages, [
      { role: 'system', content: 'dev rules' },
      { role: 'user', content: 'later system\nhello\nworld\nagain' },
      { role: 'assistant', content: '', function_call: { name: '__gpt2giga_user_search_web', arguments: { query: 'cats' } } },
      { role: 'function', content: '{"results":[1]}', name: '__gpt2giga_user_search_web' }
    ]);

    const functions = upstreamBody.functions as Array<{ name: string; description?: string; parameters: Record<string, unknown> }>;
    assert.equal(functions.length, 2);
    assert.deepEqual(functions.find((fn) => fn.name === 'legacy_fn'), {
      name: 'legacy_fn',
      description: 'legacy',
      parameters: { type: 'object', properties: {} }
    });
    assert.deepEqual(functions.find((fn) => fn.name === '__gpt2giga_user_search_web'), {
      name: '__gpt2giga_user_search_web',
      description: 'search the web',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          maybe: { type: 'string' },
          choice: { type: 'integer' },
          nested: { type: 'object', properties: {} }
        }
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode translates non-streaming function-call chat responses to OpenAI shape', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            functions_state_id: 'internal-state',
            function_call: { name: '__gpt2giga_user_search_web', arguments: { query: 'cats' } }
          },
          finish_reason: 'function_call'
        }
      ],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
        precached_prompt_tokens: 2
      }
    }));
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-response'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ model: 'requested-model', messages: [{ role: 'user', content: 'search' }] }));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/json');
    const payload = JSON.parse(response.body);
    assert.equal(typeof payload.created, 'number');
    assert.equal(payload.choices[0].message.tool_calls[0].id.startsWith('call_'), true);
    payload.created = 0;
    payload.choices[0].message.tool_calls[0].id = 'call_normalized';

    assert.deepEqual(payload, {
      id: 'chatcmpl-req-response',
      object: 'chat.completion',
      created: 0,
      model: 'requested-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_normalized',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"cats"}' }
              }
            ]
          },
          finish_reason: 'tool_calls',
          logprobs: null
        }
      ],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 0 }
      },
      system_fingerprint: 'fp_req-response'
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode preserves upstream chat error status without translating it as success', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limited by upstream', type: 'rate_limit_error', code: 'rate_limit' } }));
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-chat-error'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ model: 'error-model', messages: [{ role: 'user', content: 'hi' }] }));

    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'rate limited by upstream',
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limit'
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode requests identity upstream encoding and strips stale translated response headers', async () => {
  let upstreamAcceptEncoding: string | undefined;
  const upstreamBody = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'decoded' }, finish_reason: 'stop' }] });
  const upstream = http.createServer((req, res) => {
    upstreamAcceptEncoding = req.headers['accept-encoding'];
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': Buffer.byteLength(upstreamBody).toString(),
      etag: 'stale-etag',
      'content-md5': 'stale-md5'
    });
    res.end(upstreamBody);
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-identity'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, br' }
    }, JSON.stringify({ model: 'identity-model', messages: [{ role: 'user', content: 'hi' }] }));

    assert.equal(response.statusCode, 200);
    assert.equal(upstreamAcceptEncoding, 'identity');
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers['content-md5'], undefined);
    assert.equal(response.headers['content-length'], Buffer.byteLength(response.body).toString());
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode converts json_schema response_format into a synthetic GigaChat function call', async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      upstreamBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-structured-request'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({
      model: 'structured-model',
      messages: [{ role: 'user', content: 'answer with json' }],
      functions: [{ name: 'existing', parameters: { type: 'object' } }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer_schema',
          schema: {
            type: 'object',
            $defs: { Value: { type: ['string', 'null'] } },
            properties: { answer: { $ref: '#/$defs/Value' } }
          }
        }
      }
    }));

    assert.equal(response.statusCode, 200);
    assert.ok(upstreamBody);
    assert.equal(upstreamBody.response_format, undefined);
    assert.deepEqual(upstreamBody.function_call, { name: 'answer_schema' });
    assert.deepEqual(upstreamBody.functions, [
      { name: 'existing', parameters: { type: 'object', properties: {} } },
      {
        name: 'answer_schema',
        description: 'Output response in structured format: answer_schema',
        parameters: { type: 'object', properties: { answer: { type: 'string' } } }
      }
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode rewrites structured-output function responses into assistant content', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            function_call: { name: 'answer_schema', arguments: { answer: '42' } }
          },
          finish_reason: 'function_call'
        }
      ]
    }));
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-structured-response'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({
      model: 'structured-model',
      messages: [{ role: 'user', content: 'answer' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer_schema', schema: { type: 'object', properties: { answer: { type: 'string' } } } }
      }
    }));

    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body);
    payload.created = 0;
    assert.deepEqual(payload, {
      id: 'chatcmpl-req-structured-response',
      object: 'chat.completion',
      created: 0,
      model: 'structured-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '{"answer":"42"}', refusal: null },
          finish_reason: 'stop',
          logprobs: null
        }
      ],
      usage: null,
      system_fingerprint: 'fp_req-structured-response'
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode converts simple function tool_choice to GigaChat function_call', async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      upstreamBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-tool-choice'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({
      model: 'tool-choice-model',
      messages: [{ role: 'user', content: 'search' }],
      tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'web_search' } }
    }));

    assert.equal(response.statusCode, 200);
    assert.ok(upstreamBody);
    assert.equal(upstreamBody.tool_choice, undefined);
    assert.deepEqual(upstreamBody.function_call, { name: '__gpt2giga_user_search_web' });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode removes OpenAI-only tool_choice strings from upstream payloads', async () => {
  const receivedBodies: Record<string, unknown>[] = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      receivedBodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-tool-choice-string'
  }));

  const proxyPort = await listen(proxy);

  try {
    for (const toolChoice of ['auto', 'required', 'none']) {
      const response = await requestLocal(proxyPort, {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' }
      }, JSON.stringify({
        model: 'tool-choice-model',
        messages: [{ role: 'user', content: 'search' }],
        tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
        tool_choice: toolChoice
      }));
      assert.equal(response.statusCode, 200);
    }

    assert.equal(receivedBodies.length, 3);
    assert.equal(receivedBodies[0].tool_choice, undefined);
    assert.equal(receivedBodies[0].functions instanceof Array, true);
    assert.equal(receivedBodies[1].tool_choice, undefined);
    assert.equal(receivedBodies[1].functions instanceof Array, true);
    assert.equal(receivedBodies[2].tool_choice, undefined);
    assert.equal(receivedBodies[2].functions, undefined);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode wraps non-object tool result content in JSON object strings', async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      upstreamBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-tool-result-wrap'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({
      model: 'tool-result-model',
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_text', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_text', content: 'plain result' },
        { role: 'tool', name: 'lookup', content: '[1,2]' }
      ]
    }));

    assert.equal(response.statusCode, 200);
    assert.ok(upstreamBody);
    assert.deepEqual((upstreamBody.messages as Array<Record<string, unknown>>).filter((message) => message.role === 'function'), [
      { role: 'function', content: '{"content":"plain result"}', name: 'lookup' },
      { role: 'function', content: '{"content":[1,2]}', name: 'lookup' }
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode translates streaming chat SSE chunks and tool-call deltas', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, precached_prompt_tokens: 1 }
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { function_call: { name: '__gpt2giga_user_search_web', arguments: { query: 'cats' } } }, finish_reason: 'function_call' }]
    })}\n\n`);
    res.end('data: [DONE]\n\n');
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-stream'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ model: 'stream-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream');
    const events = response.body.trimEnd().split('\n\n').map((event) => event.replace(/^data: /, ''));
    assert.deepEqual(events.map((event) => event === '[DONE]' ? event : JSON.parse(event)).map((event) => {
      if (typeof event === 'string') {
        return event;
      }
      event.created = 0;
      if (event.choices[0].delta.tool_calls) {
        event.choices[0].delta.tool_calls[0].id = 'call_normalized';
      }
      return event;
    }), [
      {
        id: 'chatcmpl-req-stream',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'stream-model',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null, logprobs: null }
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 0,
          total_tokens: 1,
          prompt_tokens_details: { cached_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 0 }
        },
        system_fingerprint: 'fp_req-stream'
      },
      {
        id: 'chatcmpl-req-stream',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'stream-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_normalized',
                  type: 'function',
                  function: { name: 'web_search', arguments: '{"query":"cats"}' }
                }
              ]
            },
            finish_reason: 'tool_calls',
            logprobs: null
          }
        ],
        usage: null,
        system_fingerprint: 'fp_req-stream'
      },
      '[DONE]'
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode preserves split streaming tool-call delta fields without fake arguments', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { function_call: { name: '__gpt2giga_user_search_web' } }, finish_reason: null }]
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { function_call: { arguments: '{"query"' } }, finish_reason: null }]
    })}\n\n`);
    res.end('data: [DONE]\n\n');
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-split-tool'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ model: 'stream-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    assert.equal(response.statusCode, 200);
    const events = response.body.trimEnd().split('\n\n').map((event) => event.replace(/^data: /, ''));
    const first = JSON.parse(events[0]);
    const second = JSON.parse(events[1]);
    first.choices[0].delta.tool_calls[0].id = 'call_normalized';
    second.choices[0].delta.tool_calls[0].id = 'call_normalized';

    assert.deepEqual(first.choices[0].delta.tool_calls[0], {
      index: 0,
      id: 'call_normalized',
      type: 'function',
      function: { name: 'web_search' }
    });
    assert.deepEqual(second.choices[0].delta.tool_calls[0], {
      index: 0,
      id: 'call_normalized',
      type: 'function',
      function: { arguments: '{"query"' }
    });
    assert.equal(events[2], '[DONE]');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode returns a clear JSON error for upstream streaming non-2xx responses', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'gigachat unavailable' }));
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-stream-status-error'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ model: 'stream-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    assert.equal(response.statusCode, 500);
    assert.equal(response.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'gigachat unavailable',
        type: 'server_error',
        param: null,
        code: null
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode maps models list endpoints to upstream models and normalizes responses', async () => {
  let receivedUrl: string | undefined;
  const upstream = http.createServer((req, res) => {
    receivedUrl = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'GigaChat', owned_by: 'sber' },
        { name: 'GigaChat-Pro' }
      ]
    }));
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}/gigachat`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-models'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'GET',
      path: '/v1/models?trace=1'
    });

    assert.equal(response.statusCode, 200);
    assert.equal(receivedUrl, '/gigachat/models?trace=1');
    const payload = JSON.parse(response.body);
    assert.equal(payload.data.every((model: { created: unknown }) => typeof model.created === 'number'), true);
    for (const model of payload.data) {
      model.created = 0;
    }
    assert.deepEqual(payload, {
      object: 'list',
      data: [
        { id: 'GigaChat', object: 'model', created: 0, owned_by: 'sber' },
        { id: 'GigaChat-Pro', object: 'model', created: 0, owned_by: 'gigachat' }
      ]
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode preserves upstream models error status without returning an empty model list', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'bad upstream token' }));
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-models-error'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, { method: 'GET', path: '/v1/models' });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'bad upstream token',
        type: 'authentication_error',
        param: null,
        code: null
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode maps single model endpoints when requested', async () => {
  let receivedUrl: string | undefined;
  const upstream = http.createServer((req, res) => {
    receivedUrl = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id_: 'GigaChat-Pro', created_at: '2024-01-01T00:00:00.000Z', owned_by: 'sber' }));
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}/gigachat`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-model'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'GET',
      path: '/v1/models/GigaChat-Pro'
    });

    assert.equal(response.statusCode, 200);
    assert.equal(receivedUrl, '/gigachat/models/GigaChat-Pro');
    assert.deepEqual(JSON.parse(response.body), {
      id: 'GigaChat-Pro',
      object: 'model',
      created: 1704067200,
      owned_by: 'sber'
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode preserves local auth checks and configured authorization forwarding', async () => {
  const upstreamAuthorizations: Array<string | undefined> = [];
  const upstream = http.createServer((req, res) => {
    upstreamAuthorizations.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'GigaChat' }] }));
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`, {
    localAuthToken: 'local-secret',
    forwardAuthorization: true
  }), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-auth-translation'
  }));

  const proxyPort = await listen(proxy);

  try {
    const unauthorized = await requestLocal(proxyPort, { method: 'GET', path: '/v1/models' });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(upstreamAuthorizations.length, 0);

    const authorized = await requestLocal(proxyPort, {
      method: 'GET',
      path: '/v1/models',
      headers: { authorization: 'Bearer local-secret' }
    });
    assert.equal(authorized.statusCode, 200);
    assert.equal(upstreamAuthorizations.length, 1);
    assert.equal(upstreamAuthorizations[0], 'Bearer local-secret');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode rejects invalid chat request JSON without calling upstream', async () => {
  let upstreamCalled = false;
  const upstream = http.createServer((_req, res) => {
    upstreamCalled = true;
    res.writeHead(200).end('unexpected');
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-invalid-json'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, '{not valid json');

    assert.equal(response.statusCode, 400);
    assert.equal(upstreamCalled, false);
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'Malformed JSON request body',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_json'
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode rejects oversized translated chat request bodies before calling upstream', async () => {
  let upstreamCalled = false;
  const upstream = http.createServer((_req, res) => {
    upstreamCalled = true;
    res.writeHead(200).end('unexpected');
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-too-large'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ model: 'large-model', messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] }));

    assert.equal(response.statusCode, 413);
    assert.equal(upstreamCalled, false);
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'Translated request body exceeds limit',
        type: 'invalid_request_error',
        param: null,
        code: 'request_too_large'
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode returns a safe error for malformed upstream chat JSON', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('not json');
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-bad-upstream'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ model: 'bad-json-model', messages: [{ role: 'user', content: 'hi' }] }));

    assert.equal(response.statusCode, 502);
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'Malformed upstream JSON response',
        type: 'server_error',
        param: null,
        code: 'malformed_upstream_response'
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode returns a safe error for oversized upstream JSON buffers', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x'.repeat(1024 * 1024) }, finish_reason: 'stop' }] }));
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-upstream-too-large'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ model: 'large-upstream-model', messages: [{ role: 'user', content: 'hi' }] }));

    assert.equal(response.statusCode, 502);
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'Upstream response exceeds translation buffer limit',
        type: 'server_error',
        param: null,
        code: 'upstream_response_too_large'
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode rejects image and file content arrays in the MVP', async () => {
  let upstreamCalled = false;
  const upstream = http.createServer((_req, res) => {
    upstreamCalled = true;
    res.writeHead(200).end('unexpected');
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-multimodal'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({
      model: 'vision-model',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }]
    }));

    assert.equal(response.statusCode, 400);
    assert.equal(upstreamCalled, false);
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'Unsupported chat message content part for openai-gigachat MVP: image_url',
        type: 'invalid_request_error',
        param: null,
        code: 'unsupported_content'
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode emits streaming upstream errors in-band with DONE', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: not-json\n\n');
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-stream-error'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ model: 'stream-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, [
      `data: ${JSON.stringify({ error: { message: 'Malformed upstream SSE chunk', type: 'server_error', param: null, code: 'upstream_stream_error' } })}`,
      '',
      'data: [DONE]',
      '',
      ''
    ].join('\n'));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('openai-gigachat mode returns a safe error for oversized upstream SSE event buffers before streaming starts', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(1024 * 1024) }, finish_reason: null }] })}\n\n`);
  });

  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createProxyHandler(configFor(`http://127.0.0.1:${upstreamPort}`), {
    request: httpRequest as RequestFunction,
    logger: () => undefined,
    generateRequestId: () => 'req-sse-too-large'
  }));

  const proxyPort = await listen(proxy);

  try {
    const response = await requestLocal(proxyPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ model: 'stream-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    assert.equal(response.statusCode, 502);
    assert.equal(response.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'Upstream SSE event exceeds translation buffer limit',
        type: 'server_error',
        param: null,
        code: 'upstream_sse_event_too_large'
      }
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
