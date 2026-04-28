import http, { type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import { loadConfig, type ProxyConfig } from './config.js';
import { createProxyHandler, type ProxyDependencies } from './proxy.js';

export function createServer(config: ProxyConfig, dependencies: ProxyDependencies = {}): Server {
  return http.createServer(createProxyHandler(config, dependencies));
}

function sanitizeUpstreamBaseUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export function startServer(config: ProxyConfig = loadConfig()): Server {
  const server = createServer(config);

  const shutdown = (signal: NodeJS.Signals) => {
    console.error(JSON.stringify({ event: 'server_stopping', signal }));
    server.close((error) => {
      if (error) {
        console.error(JSON.stringify({ event: 'server_stop_failed', message: error.message }));
        process.exitCode = 1;
      }
      process.exit();
    });
  };

  const cleanupSignalHandlers = () => {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  };

  server.once('error', (error) => {
    cleanupSignalHandlers();
    console.error(JSON.stringify({ event: 'server_start_failed', message: error.message }));
    process.exitCode = 1;
  });

  server.once('close', cleanupSignalHandlers);

  server.listen(config.listenPort, config.listenHost, () => {
    console.error(JSON.stringify({
      event: 'server_started',
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      upstreamBaseUrl: sanitizeUpstreamBaseUrl(config.upstreamBaseUrl)
    }));
  });

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return server;
}

const entrypointUrl = pathToFileURL(process.argv[1] || '').href;
if (import.meta.url === entrypointUrl) {
  try {
    startServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    console.error(JSON.stringify({ event: 'server_start_failed', message }));
    process.exit(1);
  }
}
