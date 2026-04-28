import http, { type ClientRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

import type { ProxyConfig } from './config.js';
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

function sendJson(res: ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

function getLogPath(url: string | undefined): string {
  return new URL(url || '/', 'http://127.0.0.1').pathname;
}
