import { searchMicrosoftStore } from './_msStore.js';

export default async function handler(req, res) {
  try {
    const urlObj = new URL(req.url || '', 'http://localhost');
    const q = String(req.query?.q ?? urlObj.searchParams.get('q') ?? '').trim();
    const market = String(
      req.query?.market ?? urlObj.searchParams.get('market') ?? 'US'
    ).trim();

    if (q.length < 2) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ results: [] }));
      return;
    }

    const results = await searchMicrosoftStore(q, market);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ results }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Store search failed';
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: msg }));
  }
}
