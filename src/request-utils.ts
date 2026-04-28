import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

import type { ProxyConfig } from './config.js';

export const UPSTREAM_TIMEOUT_MESSAGE = 'upstream timeout';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host'
]);

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_TLS_INVALID_PROTOCOL_VERSION',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'EPROTO'
]);

export interface SafeUpstreamError {
  statusCode: number;
  message: string;
}

export function buildUpstreamUrl(upstreamBaseUrl: URL, incomingUrl: string | undefined): URL {
  const incoming = new URL(incomingUrl || '/', 'http://127.0.0.1');
  const target = new URL(upstreamBaseUrl.href);
  const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');

  target.pathname = `${basePath}${incoming.pathname}`;
  target.search = incoming.search;

  return target;
}

export function sanitizeRequestHeaders(headers: IncomingHttpHeaders, config: ProxyConfig): OutgoingHttpHeaders {
  const sanitized: OutgoingHttpHeaders = {};
  const hopByHopHeaders = getHopByHopHeaders(headers);

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (hopByHopHeaders.has(lowerName)) {
      continue;
    }

    if (lowerName === 'authorization' && !config.forwardAuthorization) {
      continue;
    }

    sanitized[name] = value;
  }

  return sanitized;
}

export function sanitizeResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const sanitized: OutgoingHttpHeaders = {};
  const hopByHopHeaders = getHopByHopHeaders(headers);

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (hopByHopHeaders.has(name.toLowerCase())) {
      continue;
    }

    sanitized[name] = value;
  }

  return sanitized;
}

function getHopByHopHeaders(headers: IncomingHttpHeaders): Set<string> {
  const hopByHopHeaders = new Set(HOP_BY_HOP_HEADERS);
  const connection = headers.connection;
  const connectionValues = Array.isArray(connection) ? connection : [connection];

  for (const value of connectionValues) {
    if (!value) {
      continue;
    }

    for (const headerName of value.split(',')) {
      const lowerName = headerName.trim().toLowerCase();
      if (lowerName) {
        hopByHopHeaders.add(lowerName);
      }
    }
  }

  return hopByHopHeaders;
}

export function isLocalRequestAuthorized(authorization: string | undefined, config: ProxyConfig): boolean {
  if (!config.localAuthToken) {
    return true;
  }

  return authorization === `Bearer ${config.localAuthToken}`;
}

export function classifyUpstreamError(error: unknown): SafeUpstreamError {
  const err = error as NodeJS.ErrnoException;

  if (err.message === UPSTREAM_TIMEOUT_MESSAGE) {
    return {
      statusCode: 504,
      message: 'Upstream request timed out'
    };
  }

  if (err.code && TLS_ERROR_CODES.has(err.code)) {
    return {
      statusCode: 502,
      message: 'Upstream mTLS handshake failed'
    };
  }

  return {
    statusCode: 502,
    message: 'Upstream request failed'
  };
}
