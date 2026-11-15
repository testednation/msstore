import express from 'express';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchProductPackages, searchMicrosoftStore } from './src/server/msStoreService.ts';
import type { StoreRing } from './src/types/store.ts';
import { sanitizeFileName, sanitizePackageUrl } from './src/utils/urlSanitizer.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

function openUpstreamStream(
  targetUrl: string,
  method: 'GET' | 'HEAD',
  rangeHeader?: string,
  redirectsLeft = 5
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
  resolvedUrl: string;
}> {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const reqHeaders: Record<string, string> = {
      'User-Agent': 'Microsoft-Delivery-Optimization/10.0',
    };
    if (rangeHeader) {
      reqHeaders['Range'] = rangeHeader;
    }

    const req = mod.request(
      targetUrl,
      {
        method,
        headers: reqHeaders,
        timeout: 30000,
      },
      (res) => {
        const status = res.statusCode ?? 500;
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          res.resume();
          const nextSanitized = sanitizePackageUrl(
            new URL(res.headers.location, targetUrl).toString()
          );
          if (!nextSanitized.ok) {
            reject(new Error(`Redirect blocked: ${nextSanitized.error}`));
            return;
          }
          openUpstreamStream(nextSanitized.url, method, rangeHeader, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        resolve({
          statusCode: status,
          headers: res.headers,
          stream: res,
          resolvedUrl: targetUrl,
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Upstream CDN request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function openWithProtocolFallback(
  sanitizedUrl: string,
  method: 'GET' | 'HEAD',
  rangeHeader?: string
) {
  try {
    const primary = await openUpstreamStream(sanitizedUrl, method, rangeHeader);
    if (primary.statusCode < 400) return primary;
    // If https fails with 403/400 on a token signed for http or vice versa, try alternate protocol
    primary.stream.resume();
    const altUrl = sanitizedUrl.startsWith('http://')
      ? sanitizedUrl.replace(/^http:\/\//i, 'https://')
      : sanitizedUrl.replace(/^https:\/\//i, 'http://');
    const alt = await openUpstreamStream(altUrl, method, rangeHeader);
    if (alt.statusCode < 400) return alt;
    alt.stream.resume();
    return await openUpstreamStream(sanitizedUrl, method, rangeHeader);
  } catch (err) {
    // Retry opposite protocol on TLS/socket error
    const altUrl = sanitizedUrl.startsWith('http://')
      ? sanitizedUrl.replace(/^http:\/\//i, 'https://')
      : sanitizedUrl.replace(/^https:\/\//i, 'http://');
    try {
      return await openUpstreamStream(altUrl, method, rangeHeader);
    } catch {
      throw err;
    }
  }
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const market = String(req.query.market || 'US').trim();
      if (q.length < 2) {
        res.json({ results: [] });
        return;
      }
      const results = await searchMicrosoftStore(q, market);
      res.json({ results });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Store search failed';
      res.status(502).json({ error: msg });
    }
  });

  app.get('/api/packages', async (req, res) => {
    try {
      const input = String(req.query.input || '').trim();
      const ringRaw = String(req.query.ring || 'Retail').trim();
      const ring: StoreRing =
        ringRaw === 'RP' || ringRaw === 'WIS' || ringRaw === 'WIF' ? ringRaw : 'Retail';

      if (!input) {
        res.status(400).json({ error: 'Missing Microsoft Store Product ID or link.' });
        return;
      }

      const data = await fetchProductPackages(input, ring);
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Package lookup failed';
      res.status(502).json({ error: msg });
    }
  });

  app.post('/api/sanitize', (req, res) => {
    const rawUrl = String(req.body?.url || '');
    const fileName = req.body?.fileName ? String(req.body.fileName) : undefined;
    const result = sanitizePackageUrl(rawUrl);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({
      ...result,
      fileName: fileName ? sanitizeFileName(fileName) : undefined,
    });
  });

  const handleDownload = async (req: express.Request, res: express.Response) => {
    const rawUrl = String(req.query.url || '');
    const rawFileName = String(req.query.filename || 'package.msixbundle');
    const sanitized = sanitizePackageUrl(rawUrl);

    if (!sanitized.ok) {
      res.status(400).json({ error: sanitized.error });
      return;
    }

    const safeName = sanitizeFileName(rawFileName);
    const rangeHeader = req.headers.range;
    const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

    try {
      const upstream = await openWithProtocolFallback(sanitized.url, method, rangeHeader);
      const status = upstream.statusCode;

      if (status >= 400) {
        upstream.stream.resume();
        res.status(status).json({
          error: `Microsoft CDN returned HTTP ${status}. Signed package links expire after a few hours — regenerate links and try again.`,
        });
        return;
      }

      res.status(status);
      const contentType =
        upstream.headers['content-type'] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
      );
      res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Sanitized-Host', sanitized.host);

      if (upstream.headers['content-length']) {
        res.setHeader('Content-Length', upstream.headers['content-length']);
      }
      if (upstream.headers['content-range']) {
        res.setHeader('Content-Range', upstream.headers['content-range']);
      }
      if (upstream.headers['etag']) {
        res.setHeader('ETag', upstream.headers['etag']);
      }

      if (method === 'HEAD') {
        upstream.stream.resume();
        res.end();
        return;
      }

      req.on('close', () => {
        if (!res.writableEnded) {
          upstream.stream.destroy();
        }
      });

      upstream.stream.on('error', (streamErr) => {
        if (!res.headersSent) {
          res.status(502).json({ error: streamErr.message });
        } else {
          res.destroy(streamErr);
        }
      });

      upstream.stream.pipe(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Download stream error';
      if (!res.headersSent) {
        res.status(502).json({ error: msg });
      }
    }
  };

  app.get('/api/download', handleDownload);
  app.head('/api/download', handleDownload);

  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  const httpServer = http.createServer(app);

  if (IS_PROD) {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      plugins: [
        {
          name: 'safe-vite-client-ws',
          enforce: 'post',
          transform(code, id) {
            const normalizedId = id.split('?')[0].replace(/\\/g, '/');
            if (
              normalizedId.endsWith('/@vite/client') ||
              normalizedId.endsWith('/vite/dist/client/client.mjs')
            ) {
              let next = code
                .replace(
                  'else throw new SendBeforeConnectError("send was called before connect");',
                  'else return;'
                )
                .replace(
                  'else throw new SendBeforeConnectError("invoke was called before connect");',
                  'else return;'
                )
                .replace(
                  'ws.send(JSON.stringify(data));',
                  'if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));'
                );

              if (disableHmr) {
                next = next.replace(
                  'async connect(handlers) {\n\t\t\ttry {\n\t\t\t\tawait wsTransport.connect(handlers);',
                  'async connect(handlers) {\n\t\t\tif (true) return;\n\t\t\ttry {\n\t\t\t\tawait wsTransport.connect(handlers);'
                );
              }

              next = next.replace(
                'transport.connect(createHMRHandler(handleMessage));',
                'transport.connect(createHMRHandler(handleMessage)).catch(() => {});'
              );

              return {
                code: next,
                map: null,
              };
            }
            return null;
          },
        },
      ],
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: { server: httpServer },
        hmr: disableHmr ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Sideload server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
