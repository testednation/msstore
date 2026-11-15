import { sanitizeFileName, sanitizePackageUrl } from './_msStore.js';

export default async function handler(req, res) {
  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      body = body ? JSON.parse(body) : {};
    } catch {
      body = {};
    }
  }
  const rawUrl = String(body?.url || '');
  const fileName = body?.fileName ? String(body.fileName) : undefined;
  const result = sanitizePackageUrl(rawUrl);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!result.ok) {
    res.statusCode = 400;
    res.end(JSON.stringify(result));
    return;
  }

  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ...result,
      fileName: fileName ? sanitizeFileName(fileName) : undefined,
    })
  );
}
