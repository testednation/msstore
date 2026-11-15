import { fetchProductPackages } from './_msStore.js';

export default async function handler(req, res) {
  try {
    const urlObj = new URL(req.url || '', 'http://localhost');
    const input = String(
      req.query?.input ?? urlObj.searchParams.get('input') ?? ''
    ).trim();
    const ringRaw = String(
      req.query?.ring ?? urlObj.searchParams.get('ring') ?? 'Retail'
    ).trim();
    const ring =
      ringRaw === 'RP' || ringRaw === 'WIS' || ringRaw === 'WIF'
        ? ringRaw
        : 'Retail';

    if (!input) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: 'Missing Microsoft Store Product ID or link.',
        })
      );
      return;
    }

    const data = await fetchProductPackages(input, ring);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Package lookup failed';
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: msg }));
  }
}
