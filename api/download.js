import {
  openWithProtocolFallback,
  sanitizeFileName,
  sanitizePackageUrl,
} from './_msStore.js';

export default async function handler(req, res) {
  const urlObj = new URL(req.url || '', 'http://localhost');
  const rawUrl = String(
    req.query?.url ?? urlObj.searchParams.get('url') ?? ''
  );
  const rawFileName = String(
    req.query?.filename ??
      urlObj.searchParams.get('filename') ??
      'package.msixbundle'
  );
  const sanitized = sanitizePackageUrl(rawUrl);

  if (!sanitized.ok) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: sanitized.error }));
    return;
  }

  const safeName = sanitizeFileName(rawFileName);
  const rangeHeader = req.headers?.range;
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

  try {
    const upstream = await openWithProtocolFallback(
      sanitized.url,
      method,
      rangeHeader
    );
    const status = upstream.statusCode;

    if (status >= 400) {
      upstream.stream.resume();
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: `Microsoft CDN returned HTTP ${status}. Signed package links expire after a few hours — regenerate links and try again.`,
        })
      );
      return;
    }

    res.statusCode = status;
    res.setHeader(
      'Content-Type',
      upstream.headers['content-type'] || 'application/octet-stream'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
    );
    res.setHeader(
      'Accept-Ranges',
      upstream.headers['accept-ranges'] || 'bytes'
    );
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
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: streamErr.message }));
      } else {
        res.destroy(streamErr);
      }
    });

    upstream.stream.pipe(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Download stream error';
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: msg }));
    }
  }
}
