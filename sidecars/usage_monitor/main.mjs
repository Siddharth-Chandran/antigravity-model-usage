/**
 * Antigravity Model Usage sidecar HTTP backend.
 *
 * Uses `sidecar_sdk` when launched by the Antigravity Language Server, with a
 * built-in `node:http` fallback so it can also run standalone in tests or browser development.
 * Read-only: writes no files and triggers zero LLM calls.
 */

import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUsageCollector } from './usage_collector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ROUTES = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

class FallbackResponse {
  constructor(body, { contentType = 'text/plain; charset=utf-8', status = 200, headers = {} } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

class StandaloneSidecarApp {
  #port;
  #server = null;
  #pages = new Map();
  #apis = new Map();
  #defaultConversationId;

  constructor({ port, defaultConversationId = '' } = {}) {
    this.#port = port ?? Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
    this.#defaultConversationId = defaultConversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
  }

  get config() {
    return {
      projectId: process.env.ANTIGRAVITY_PROJECT_ID || '',
      conversationId: this.#defaultConversationId,
    };
  }

  page(path, handler) {
    this.#pages.set(path, handler);
  }

  api(path, handler, method = 'POST') {
    if (!this.#apis.has(path)) this.#apis.set(path, new Map());
    this.#apis.get(path).set(method.toUpperCase(), handler);
  }

  run() {
    if (!this.#pages.has('/preload.js')) {
      this.#pages.set(
        '/preload.js',
        () => `window.sidecar = window.sidecar || { conversationId: ${JSON.stringify(this.#defaultConversationId)} };`
      );
    }

    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');

        if (req.method === 'GET' && this.#pages.has(url.pathname)) {
          const content = await this.#pages.get(url.pathname)();
          if (content && typeof content === 'object' && content.body !== undefined) {
            res.writeHead(content.status || 200, {
              'Content-Type': content.contentType || 'text/html; charset=utf-8',
              ...content.headers,
            });
            res.end(content.body);
            return;
          }
          const isJS = url.pathname.endsWith('.js');
          res.writeHead(200, {
            'Content-Type': isJS ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(content);
          return;
        }

        if (this.#apis.has(url.pathname)) {
          const methodMap = this.#apis.get(url.pathname);
          if (!methodMap.has(req.method)) {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          const handler = methodMap.get(req.method);
          const data = {};
          for (const [k, v] of url.searchParams.entries()) {
            if (k.toLowerCase() !== 'token') data[k] = v;
          }
          const result = await handler(data);
          if (result && typeof result === 'object' && result.contentType && result.body !== undefined) {
            res.writeHead(result.status || 200, {
              'Content-Type': result.contentType,
              ...result.headers,
            });
            res.end(result.body);
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(result));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
      }
    });

    return new Promise((resolve, reject) => {
      server.on('error', reject);
      this.#server = server.listen(this.#port, '127.0.0.1', () => {
        resolve(server);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
      this.#server.closeAllConnections?.();
    });
  }
}

async function resolveSidecarSdk(forceStandaloneHttp = false) {
  if (!forceStandaloneHttp) {
    try {
      const sdk = await import('sidecar_sdk');
      if (sdk?.SidecarApp && sdk?.Response) {
        return { SidecarApp: sdk.SidecarApp, Response: sdk.Response, isNativeSdk: true };
      }
    } catch {
      // Fallback to standalone node:http server
    }
  }
  return { SidecarApp: StandaloneSidecarApp, Response: FallbackResponse, isNativeSdk: false };
}

/**
 * Starts the Model Usage sidecar server.
 */
export async function startUsageSidecarServer({
  collector = createUsageCollector(),
  port = undefined,
  defaultConversationId = '',
  forceStandaloneHttp = false,
} = {}) {
  const { SidecarApp, Response, isNativeSdk } = await resolveSidecarSdk(forceStandaloneHttp);
  const app = isNativeSdk
    ? new SidecarApp()
    : new SidecarApp({ port, defaultConversationId });

  app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

  for (const [route, [file, contentType]] of Object.entries(STATIC_ROUTES)) {
    app.api(
      route,
      () =>
        new Response(readFileSync(join(__dirname, file), 'utf-8'), {
          contentType,
          headers: { 'Cache-Control': 'no-store' },
        }),
      'GET'
    );
  }

  app.api(
    '/api/usage',
    async (data = {}) => {
      const convId =
        (typeof data.conversationId === 'string' && data.conversationId.trim()) ||
        defaultConversationId ||
        app.config?.conversationId ||
        '';
      const etag = typeof data.etag === 'string' ? data.etag : '';
      return await collector.getSnapshot({
        conversationId: convId,
        etag,
        nowMs: Date.now(),
      });
    },
    'GET'
  );

  const server = await app.run();
  const boundPort = server?.address?.()?.port ?? Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);

  return {
    app,
    server,
    port: boundPort,
    close: () => app.close(),
  };
}

/**
 * Checks whether this module is the main entrypoint, resolving symlinks and relative paths.
 */
export function checkIsMainModule(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1));
  } catch {
    return fileURLToPath(metaUrl) === resolve(argv1);
  }
}

// Auto-start when executed directly as `node main.mjs`
if (checkIsMainModule()) {
  startUsageSidecarServer().catch((err) => {
    console.error('[model-usage] Failed to start sidecar server:', err);
    process.exit(1);
  });
}
