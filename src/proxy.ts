import http, { type ClientRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

import type { ProxyConfig } from './config.js';
import {
  buildGigaChatUpstreamUrl,
  getOpenAiGigaChatRoute,
  normalizeUpstreamError,
  openAiError,
  readIncomingBody,
  TranslationBufferLimitError,
  TRANSLATED_REQUEST_BODY_LIMIT_BYTES,
  TRANSLATED_SSE_EVENT_LIMIT_BYTES,
  TRANSLATED_UPSTREAM_BODY_LIMIT_BYTES,
  translateChatCompletionResponse,
  translateChatCompletionStreamChunk,
  translateModelResponse,
  translateModelsResponse,
  transformChatCompletionRequest,
  unsupportedEndpointError,
  type OpenAiErrorBody,
  type OpenAiGigaChatRoute
} from './openai-gigachat.js';
import {
  buildUpstreamUrl,
  classifyUpstreamError,
  isLocalRequestAuthorized,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  UPSTREAM_TIMEOUT_MESSAGE
} from './request-utils.js';

export type RequestFunction = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

export interface ProxyDependencies {
  request?: RequestFunction;
  logger?: (entry: Record<string, unknown>) => void;
  generateRequestId?: () => string;
}

export function createProxyHandler(config: ProxyConfig, dependencies: ProxyDependencies = {}): http.RequestListener {
  const agent = config.upstreamBaseUrl.protocol === 'https:'
    ? new https.Agent({
        cert: config.clientCert,
        key: config.clientKey,
        ca: config.caCert,
        rejectUnauthorized: config.upstreamTlsVerify,
        keepAlive: true
      })
    : undefined;

  const request = dependencies.request || ((options, callback) => https.request(options, callback));
  const logger = dependencies.logger || ((entry) => console.error(JSON.stringify(entry)));
  const generateRequestId = dependencies.generateRequestId || randomUUID;

  return (req, res) => {
    const requestId = generateRequestId();
    const startedAt = Date.now();
    const logPath = getLogPath(req.url);

    if (!isLocalRequestAuthorized(req.headers.authorization, config)) {
      sendJson(res, 401, 'Unauthorized');
      logger({ event: 'request_rejected', requestId, method: req.method, path: logPath, statusCode: 401, durationMs: Date.now() - startedAt });
      req.resume();
      return;
    }

    if (config.translationMode === 'openai-gigachat') {
      const translationRoute = getOpenAiGigaChatRoute(req.method, req.url);
      if (!translationRoute) {
        sendOpenAiError(res, 404, unsupportedEndpointError(req.method, req.url));
        logger({ event: 'request_rejected', requestId, method: req.method, path: logPath, statusCode: 404, durationMs: Date.now() - startedAt });
        req.resume();
        return;
      }

      void handleOpenAiGigaChatRequest({ req, res, config, route: translationRoute, request, logger, requestId, startedAt, logPath, agent }).catch((error: unknown) => {
        logger({ event: 'request_failed', requestId, method: req.method, path: logPath, statusCode: 500, reason: 'Translation request failed', durationMs: Date.now() - startedAt });
        if (!res.headersSent) {
          sendOpenAiError(res, 500, openAiError('Translation request failed', 'server_error', 'translation_failed'));
          return;
        }
        res.destroy(error instanceof Error ? error : undefined);
      });
      return;
    }

    const target = buildUpstreamUrl(config.upstreamBaseUrl, req.url);
    const headers = sanitizeRequestHeaders(req.headers, config);
    headers['x-request-id'] = requestId;

    const options: RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      agent
    };

    let upstreamEnded = false;
    let downstreamClosed = false;
    let requestFailed = false;
    let upstreamReq: ClientRequest | undefined;

    const handleUpstreamRequestError = (error: unknown) => {
      if (downstreamClosed && !upstreamEnded) {
        return;
      }

      requestFailed = true;
      const safeError = classifyUpstreamError(error);
      logger({ event: 'request_failed', requestId, method: req.method, path: logPath, statusCode: safeError.statusCode, reason: safeError.message, durationMs: Date.now() - startedAt });

      if (!res.headersSent) {
        sendJson(res, safeError.statusCode, safeError.message);
        return;
      }

      res.destroy(error instanceof Error ? error : undefined);
    };

    req.on('error', () => {
      if (requestFailed) {
        return;
      }

      downstreamClosed = true;
      logger({ event: 'incoming_request_failed', requestId, method: req.method, path: logPath, statusCode: 499, reason: 'Incoming request stream failed', durationMs: Date.now() - startedAt });
      upstreamReq?.destroy();
    });

    try {
      upstreamReq = request(options, (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 502;
        res.writeHead(statusCode, sanitizeResponseHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => {
          upstreamEnded = true;
          logger({ event: 'request_complete', requestId, method: req.method, path: logPath, upstreamStatusCode: statusCode, durationMs: Date.now() - startedAt });
        });
        upstreamRes.on('error', () => {
          logger({ event: 'response_stream_failed', requestId, method: req.method, path: logPath, statusCode: 502, reason: 'Upstream response stream failed', durationMs: Date.now() - startedAt });
          res.destroy();
        });
      });
    } catch (error) {
      handleUpstreamRequestError(error);
      req.resume();
      return;
    }

    res.on('close', () => {
      downstreamClosed = true;
      if (!upstreamEnded) {
        upstreamReq.destroy();
      }
    });

    upstreamReq.setTimeout(config.upstreamTimeoutMs, () => {
      upstreamReq.destroy(new Error(UPSTREAM_TIMEOUT_MESSAGE));
    });

    upstreamReq.on('error', handleUpstreamRequestError);

    req.pipe(upstreamReq);
  };
}

async function handleOpenAiGigaChatRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  config: ProxyConfig;
  route: OpenAiGigaChatRoute;
  request: RequestFunction;
  logger: (entry: Record<string, unknown>) => void;
  requestId: string;
  startedAt: number;
  logPath: string;
  agent: https.Agent | undefined;
}): Promise<void> {
  const { req, res, config, route, request, logger, requestId, startedAt, logPath, agent } = params;
  const target = buildGigaChatUpstreamUrl(config.upstreamBaseUrl, req.url, route);
  const headers = sanitizeRequestHeaders(req.headers, config);
  headers['x-request-id'] = requestId;
  headers['accept-encoding'] = 'identity';
  delete headers['content-length'];

  let body: string | undefined;
  let chatResponseContext: { originalModel: string; stream: boolean; structuredOutputFunctionName?: string } | undefined;

  if (route.kind === 'chat') {
    let rawBody: string;
    let parsedBody: unknown;
    try {
      rawBody = await readIncomingBody(req, TRANSLATED_REQUEST_BODY_LIMIT_BYTES);
    } catch (error) {
      if (error instanceof TranslationBufferLimitError) {
        sendOpenAiError(res, 413, openAiError(error.message, 'invalid_request_error', 'request_too_large'));
        logger({ event: 'request_rejected', requestId, method: req.method, path: logPath, statusCode: 413, durationMs: Date.now() - startedAt });
        return;
      }
      logger({ event: 'incoming_request_failed', requestId, method: req.method, path: logPath, statusCode: 499, reason: 'Incoming request stream failed', durationMs: Date.now() - startedAt });
      res.destroy();
      return;
    }

    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      sendOpenAiError(res, 400, openAiError('Malformed JSON request body', 'invalid_request_error', 'invalid_json'));
      logger({ event: 'request_rejected', requestId, method: req.method, path: logPath, statusCode: 400, durationMs: Date.now() - startedAt });
      return;
    }

    const transformed = transformChatCompletionRequest(parsedBody);
    if (!transformed.ok) {
      sendOpenAiError(res, transformed.statusCode, transformed.error);
      logger({ event: 'request_rejected', requestId, method: req.method, path: logPath, statusCode: transformed.statusCode, durationMs: Date.now() - startedAt });
      return;
    }

    body = JSON.stringify(transformed.body);
    chatResponseContext = { originalModel: transformed.originalModel, stream: transformed.stream, structuredOutputFunctionName: transformed.structuredOutputFunctionName };
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body).toString();
  }

  const options: RequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers,
    agent
  };

  let upstreamEnded = false;
  let downstreamClosed = false;
  let requestFailed = false;
  let upstreamReq: ClientRequest | undefined;

  const handleUpstreamRequestError = (error: unknown) => {
    if (downstreamClosed && !upstreamEnded) {
      return;
    }

    requestFailed = true;
    const safeError = classifyUpstreamError(error);
    logger({ event: 'request_failed', requestId, method: req.method, path: logPath, statusCode: safeError.statusCode, reason: safeError.message, durationMs: Date.now() - startedAt });

    if (!res.headersSent) {
      sendJson(res, safeError.statusCode, safeError.message);
      return;
    }

    res.destroy(error instanceof Error ? error : undefined);
  };

  req.on('error', () => {
    if (requestFailed) {
      return;
    }

    downstreamClosed = true;
    logger({ event: 'incoming_request_failed', requestId, method: req.method, path: logPath, statusCode: 499, reason: 'Incoming request stream failed', durationMs: Date.now() - startedAt });
    upstreamReq?.destroy();
  });

  try {
    upstreamReq = request(options, (upstreamRes) => {
      const statusCode = upstreamRes.statusCode || 502;
      if (route.kind === 'chat' && chatResponseContext && !chatResponseContext.stream) {
        handleTranslatedChatJsonResponse({ upstreamRes, res, statusCode, requestId, originalModel: chatResponseContext.originalModel, structuredOutputFunctionName: chatResponseContext.structuredOutputFunctionName, logger, method: req.method, logPath, startedAt, markUpstreamEnded: () => { upstreamEnded = true; } });
        return;
      }
      if (route.kind === 'chat' && chatResponseContext?.stream && statusCode >= 400) {
        handleTranslatedChatJsonResponse({ upstreamRes, res, statusCode, requestId, originalModel: chatResponseContext.originalModel, structuredOutputFunctionName: chatResponseContext.structuredOutputFunctionName, logger, method: req.method, logPath, startedAt, markUpstreamEnded: () => { upstreamEnded = true; } });
        return;
      }
      if (route.kind === 'chat' && chatResponseContext?.stream) {
        handleTranslatedChatSseResponse({ upstreamRes, res, statusCode, requestId, originalModel: chatResponseContext.originalModel, logger, method: req.method, logPath, startedAt, markUpstreamEnded: () => { upstreamEnded = true; } });
        return;
      }
      if (route.kind === 'models' || route.kind === 'model') {
        handleTranslatedJsonResponse({
          upstreamRes,
          res,
          statusCode,
          requestId,
          logger,
          method: req.method,
          logPath,
          startedAt,
          markUpstreamEnded: () => { upstreamEnded = true; },
          translate: route.kind === 'models' ? translateModelsResponse : translateModelResponse
        });
        return;
      }

      res.writeHead(statusCode, sanitizeResponseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => {
        upstreamEnded = true;
        logger({ event: 'request_complete', requestId, method: req.method, path: logPath, upstreamStatusCode: statusCode, durationMs: Date.now() - startedAt });
      });
      upstreamRes.on('error', () => {
        logger({ event: 'response_stream_failed', requestId, method: req.method, path: logPath, statusCode: 502, reason: 'Upstream response stream failed', durationMs: Date.now() - startedAt });
        res.destroy();
      });
    });
  } catch (error) {
    handleUpstreamRequestError(error);
    req.resume();
    return;
  }

  res.on('close', () => {
    downstreamClosed = true;
    if (!upstreamEnded) {
      upstreamReq.destroy();
    }
  });

  upstreamReq.setTimeout(config.upstreamTimeoutMs, () => {
    upstreamReq.destroy(new Error(UPSTREAM_TIMEOUT_MESSAGE));
  });

  upstreamReq.on('error', handleUpstreamRequestError);
  upstreamReq.end(body);
}

function handleTranslatedJsonResponse(params: {
  upstreamRes: IncomingMessage;
  res: ServerResponse;
  statusCode: number;
  requestId: string;
  logger: (entry: Record<string, unknown>) => void;
  method: string | undefined;
  logPath: string;
  startedAt: number;
  markUpstreamEnded: () => void;
  translate: (data: unknown) => Record<string, unknown>;
}): void {
  const { upstreamRes, res, statusCode, requestId, logger, method, logPath, startedAt, markUpstreamEnded, translate } = params;
  let body = '';
  let bytes = 0;
  let overLimit = false;
  upstreamRes.setEncoding('utf8');
  upstreamRes.on('data', (chunk: string) => {
    if (overLimit) {
      return;
    }
    bytes += Buffer.byteLength(chunk);
    if (bytes > TRANSLATED_UPSTREAM_BODY_LIMIT_BYTES) {
      overLimit = true;
      markUpstreamEnded();
      sendOpenAiError(res, 502, openAiError('Upstream response exceeds translation buffer limit', 'server_error', 'upstream_response_too_large'));
      logger({ event: 'request_failed', requestId, method, path: logPath, statusCode: 502, reason: 'Upstream response exceeds translation buffer limit', durationMs: Date.now() - startedAt });
      upstreamRes.destroy();
      return;
    }
    body += chunk;
  });
  upstreamRes.on('end', () => {
    if (overLimit) {
      return;
    }
    markUpstreamEnded();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      const diagnostics = buildUpstreamDiagnostics(statusCode, upstreamRes.headers, body);
      const downstreamStatusCode = statusCode >= 400 ? statusCode : 502;
      const reason = statusCode >= 400 ? 'Upstream returned non-JSON error response' : 'Malformed upstream JSON response';
      sendOpenAiError(res, downstreamStatusCode, statusCode >= 400 ? upstreamNonJsonError(statusCode, diagnostics) : malformedUpstreamJsonError(diagnostics));
      logger({ event: 'request_failed', requestId, method, path: logPath, statusCode: downstreamStatusCode, reason, ...upstreamDiagnosticLogFields(diagnostics), durationMs: Date.now() - startedAt });
      return;
    }

    if (statusCode >= 400) {
      sendOpenAiError(res, statusCode, normalizeUpstreamError(statusCode, parsed));
      logger({ event: 'request_complete', requestId, method, path: logPath, upstreamStatusCode: statusCode, durationMs: Date.now() - startedAt });
      return;
    }

    const translated = JSON.stringify(translate(parsed));
    const headers = sanitizeTranslatedResponseHeaders(upstreamRes.headers, 'application/json');
    headers['content-length'] = Buffer.byteLength(translated).toString();
    res.writeHead(statusCode, headers);
    res.end(translated);
    logger({ event: 'request_complete', requestId, method, path: logPath, upstreamStatusCode: statusCode, durationMs: Date.now() - startedAt });
  });
  upstreamRes.on('error', () => {
    if (overLimit) {
      return;
    }
    markUpstreamEnded();
    logger({ event: 'response_stream_failed', requestId, method, path: logPath, statusCode: 502, reason: 'Upstream response stream failed', durationMs: Date.now() - startedAt });
    res.destroy();
  });
}

function handleTranslatedChatJsonResponse(params: {
  upstreamRes: IncomingMessage;
  res: ServerResponse;
  statusCode: number;
  requestId: string;
  originalModel: string;
  structuredOutputFunctionName?: string;
  logger: (entry: Record<string, unknown>) => void;
  method: string | undefined;
  logPath: string;
  startedAt: number;
  markUpstreamEnded: () => void;
}): void {
  const { upstreamRes, res, statusCode, requestId, originalModel, structuredOutputFunctionName, logger, method, logPath, startedAt, markUpstreamEnded } = params;
  let body = '';
  let bytes = 0;
  let overLimit = false;
  upstreamRes.setEncoding('utf8');
  upstreamRes.on('data', (chunk: string) => {
    if (overLimit) {
      return;
    }
    bytes += Buffer.byteLength(chunk);
    if (bytes > TRANSLATED_UPSTREAM_BODY_LIMIT_BYTES) {
      overLimit = true;
      markUpstreamEnded();
      sendOpenAiError(res, 502, openAiError('Upstream response exceeds translation buffer limit', 'server_error', 'upstream_response_too_large'));
      logger({ event: 'request_failed', requestId, method, path: logPath, statusCode: 502, reason: 'Upstream response exceeds translation buffer limit', durationMs: Date.now() - startedAt });
      upstreamRes.destroy();
      return;
    }
    body += chunk;
  });
  upstreamRes.on('end', () => {
    if (overLimit) {
      return;
    }
    markUpstreamEnded();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      const diagnostics = buildUpstreamDiagnostics(statusCode, upstreamRes.headers, body);
      const downstreamStatusCode = statusCode >= 400 ? statusCode : 502;
      const reason = statusCode >= 400 ? 'Upstream returned non-JSON error response' : 'Malformed upstream JSON response';
      sendOpenAiError(res, downstreamStatusCode, statusCode >= 400 ? upstreamNonJsonError(statusCode, diagnostics) : malformedUpstreamJsonError(diagnostics));
      logger({ event: 'request_failed', requestId, method, path: logPath, statusCode: downstreamStatusCode, reason, ...upstreamDiagnosticLogFields(diagnostics), durationMs: Date.now() - startedAt });
      return;
    }

    if (statusCode >= 400) {
      sendOpenAiError(res, statusCode, normalizeUpstreamError(statusCode, parsed));
      logger({ event: 'request_complete', requestId, method, path: logPath, upstreamStatusCode: statusCode, durationMs: Date.now() - startedAt });
      return;
    }

    const translated = JSON.stringify(translateChatCompletionResponse(parsed, originalModel, requestId, { structuredOutputFunctionName }));
    const headers = sanitizeTranslatedResponseHeaders(upstreamRes.headers, 'application/json');
    headers['content-length'] = Buffer.byteLength(translated).toString();
    res.writeHead(statusCode, headers);
    res.end(translated);
    logger({ event: 'request_complete', requestId, method, path: logPath, upstreamStatusCode: statusCode, durationMs: Date.now() - startedAt });
  });
  upstreamRes.on('error', () => {
    if (overLimit) {
      return;
    }
    markUpstreamEnded();
    logger({ event: 'response_stream_failed', requestId, method, path: logPath, statusCode: 502, reason: 'Upstream response stream failed', durationMs: Date.now() - startedAt });
    res.destroy();
  });
}

function handleTranslatedChatSseResponse(params: {
  upstreamRes: IncomingMessage;
  res: ServerResponse;
  statusCode: number;
  requestId: string;
  originalModel: string;
  logger: (entry: Record<string, unknown>) => void;
  method: string | undefined;
  logPath: string;
  startedAt: number;
  markUpstreamEnded: () => void;
}): void {
  const { upstreamRes, res, statusCode, requestId, originalModel, logger, method, logPath, startedAt, markUpstreamEnded } = params;
  const headers = sanitizeTranslatedResponseHeaders(upstreamRes.headers, 'text/event-stream');

  let buffer = '';
  let done = false;

  const ensureSseHeaders = () => {
    if (!res.headersSent) {
      res.writeHead(statusCode, headers);
    }
  };

  const emitDone = () => {
    if (!done) {
      ensureSseHeaders();
      res.write('data: [DONE]\n\n');
      done = true;
    }
  };

  const emitError = (message: string) => {
    if (!done) {
      ensureSseHeaders();
      res.write(`data: ${JSON.stringify(openAiError(message, 'server_error', 'upstream_stream_error'))}\n\n`);
      emitDone();
    }
  };

  const emitOversizedEventError = () => {
    if (done) {
      return;
    }

    if (!res.headersSent) {
      sendOpenAiError(res, 502, openAiError('Upstream SSE event exceeds translation buffer limit', 'server_error', 'upstream_sse_event_too_large'));
      done = true;
      return;
    }

    emitError('Upstream SSE event exceeds translation buffer limit');
  };

  const processEvent = (event: string) => {
    if (done) {
      return;
    }

    if (Buffer.byteLength(event) > TRANSLATED_SSE_EVENT_LIMIT_BYTES) {
      emitOversizedEventError();
      return;
    }

    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');

    if (!data) {
      return;
    }
    if (data === '[DONE]') {
      emitDone();
      return;
    }

    try {
      const parsed = JSON.parse(data) as unknown;
      ensureSseHeaders();
      res.write(`data: ${JSON.stringify(translateChatCompletionStreamChunk(parsed, originalModel, requestId))}\n\n`);
    } catch {
      emitError('Malformed upstream SSE chunk');
    }
  };

  upstreamRes.setEncoding('utf8');
  upstreamRes.on('data', (chunk: string) => {
    if (done) {
      return;
    }
    buffer += chunk;
    if (Buffer.byteLength(buffer) > TRANSLATED_SSE_EVENT_LIMIT_BYTES && !nextSseEventBoundary(buffer)) {
      emitOversizedEventError();
      upstreamRes.destroy();
      return;
    }
    let eventBoundary = nextSseEventBoundary(buffer);
    while (eventBoundary) {
      const event = buffer.slice(0, eventBoundary.index);
      buffer = buffer.slice(eventBoundary.index + eventBoundary.length);
      processEvent(event);
      eventBoundary = nextSseEventBoundary(buffer);
    }
  });
  upstreamRes.on('end', () => {
    markUpstreamEnded();
    if (done) {
      res.end();
      logger({ event: 'request_complete', requestId, method, path: logPath, upstreamStatusCode: statusCode, durationMs: Date.now() - startedAt });
      return;
    }
    if (buffer.trim()) {
      processEvent(buffer);
    }
    if (done && !res.headersSent) {
      res.end();
      logger({ event: 'request_complete', requestId, method, path: logPath, upstreamStatusCode: statusCode, durationMs: Date.now() - startedAt });
      return;
    }
    emitDone();
    res.end();
    logger({ event: 'request_complete', requestId, method, path: logPath, upstreamStatusCode: statusCode, durationMs: Date.now() - startedAt });
  });
  upstreamRes.on('error', () => {
    markUpstreamEnded();
    logger({ event: 'response_stream_failed', requestId, method, path: logPath, statusCode: 502, reason: 'Upstream response stream failed', durationMs: Date.now() - startedAt });
    emitError('Upstream response stream failed');
    res.end();
  });
}

function nextSseEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const lfIndex = buffer.indexOf('\n\n');
  const crlfIndex = buffer.indexOf('\r\n\r\n');

  if (lfIndex === -1 && crlfIndex === -1) {
    return undefined;
  }
  if (lfIndex === -1) {
    return { index: crlfIndex, length: 4 };
  }
  if (crlfIndex === -1 || lfIndex < crlfIndex) {
    return { index: lfIndex, length: 2 };
  }
  return { index: crlfIndex, length: 4 };
}

function sendJson(res: ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

function sendOpenAiError(res: ServerResponse, statusCode: number, body: OpenAiErrorBody): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

interface UpstreamDiagnostics {
  statusCode: number;
  contentType: string | null;
  bodyBytes: number;
  bodyPreview?: string;
}

function malformedUpstreamJsonError(upstream: UpstreamDiagnostics): OpenAiErrorBody {
  return {
    error: {
      message: 'Malformed upstream JSON response',
      type: 'server_error',
      param: null,
      code: 'malformed_upstream_response',
      upstream
    }
  };
}

function upstreamNonJsonError(statusCode: number, upstream: UpstreamDiagnostics): OpenAiErrorBody {
  return {
    error: {
      message: 'Upstream returned non-JSON error response',
      type: defaultOpenAiErrorType(statusCode),
      param: null,
      code: 'upstream_non_json_error',
      upstream
    }
  };
}

function defaultOpenAiErrorType(statusCode: number): string {
  if (statusCode === 401) {
    return 'authentication_error';
  }
  if (statusCode === 403) {
    return 'permission_denied_error';
  }
  if (statusCode === 404) {
    return 'not_found_error';
  }
  if (statusCode === 429) {
    return 'rate_limit_error';
  }
  if (statusCode >= 500) {
    return 'server_error';
  }
  return 'invalid_request_error';
}

function buildUpstreamDiagnostics(statusCode: number, headers: IncomingMessage['headers'], body: string): UpstreamDiagnostics {
  const contentTypeHeader = headers['content-type'];
  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader.join(', ') : contentTypeHeader ?? null;
  const diagnostics: UpstreamDiagnostics = {
    statusCode,
    contentType,
    bodyBytes: Buffer.byteLength(body)
  };
  const preview = buildSafeBodyPreview(body, contentType);
  if (preview !== undefined) {
    diagnostics.bodyPreview = preview;
  }
  return diagnostics;
}

function buildSafeBodyPreview(body: string, contentType: string | null): string | undefined {
  if (body.length === 0) {
    return '';
  }

  const lowerContentType = (contentType || '').toLowerCase();
  const textLikeContentType = lowerContentType.startsWith('text/')
    || lowerContentType.includes('json')
    || lowerContentType.includes('xml')
    || lowerContentType.includes('html')
    || lowerContentType.includes('javascript');

  if (!textLikeContentType && hasManyControlCharacters(body)) {
    return undefined;
  }

  return body
    .slice(0, 200)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function hasManyControlCharacters(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  const controlCharacters = value.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g)?.length ?? 0;
  return controlCharacters / value.length > 0.1;
}

function upstreamDiagnosticLogFields(upstream: UpstreamDiagnostics): Record<string, unknown> {
  return {
    upstreamStatusCode: upstream.statusCode,
    upstreamContentType: upstream.contentType,
    upstreamBodyBytes: upstream.bodyBytes,
    ...(upstream.bodyPreview !== undefined ? { upstreamBodyPreview: upstream.bodyPreview } : {})
  };
}

function sanitizeTranslatedResponseHeaders(headers: IncomingMessage['headers'], contentType: string): ReturnType<typeof sanitizeResponseHeaders> {
  const sanitized = sanitizeResponseHeaders(headers);
  for (const headerName of ['content-encoding', 'content-length', 'etag', 'content-md5']) {
    delete sanitized[headerName];
  }
  sanitized['content-type'] = contentType;
  return sanitized;
}

function getLogPath(url: string | undefined): string {
  return new URL(url || '/', 'http://127.0.0.1').pathname;
}
