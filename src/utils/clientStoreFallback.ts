import type { StoreSearchResult } from '../types/store';

export interface SafeJsonResult<T> {
  isJson: boolean;
  data?: T;
  rawText: string;
}

/**
 * Safely reads a fetch Response as JSON without throwing a cryptic
 * `SyntaxError: Unexpected token 'T', "The page c"... is not valid JSON`
 * when a reverse proxy, CDN, or static host returns plain text or HTML.
 */
export async function safeReadJson<T = unknown>(res: Response): Promise<SafeJsonResult<T>> {
  const rawText = await res.text();
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { isJson: false, rawText: '' };
  }
  try {
    const parsed = JSON.parse(trimmed) as T;
    return { isJson: true, data: parsed, rawText };
  } catch {
    return { isJson: false, rawText };
  }
}

/**
 * Formats a human-readable error message when an API endpoint returns
 * non-JSON (such as a 404 "The page could not be found" or 502 HTML gateway page).
 */
export function formatApiFailureMessage(
  res: Response,
  rawText: string,
  fallbackMessage: string
): string {
  const snippet = rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (
    res.status === 404 ||
    /page could not be found|cannot get \/api\//i.test(snippet) ||
    snippet.startsWith('<!DOCTYPE') ||
    snippet.startsWith('<html')
  ) {
    return 'Backend package API (/api/packages) was not found on this deployment host (HTTP 404). Ensure the Node server (`npm start`) or `/api` serverless functions are deployed.';
  }
  if (snippet.length > 0 && snippet.length <= 180) {
    return `${fallbackMessage} (HTTP ${res.status}: ${snippet})`;
  }
  return `${fallbackMessage} (HTTP ${res.status})`;
}

/**
 * Direct browser fallback for Microsoft Store search using the CORS-enabled
 * DisplayCatalog Autosuggest endpoint (`displaycatalog.mp.microsoft.com`).
 */
export async function searchMicrosoftStoreClientFallback(
  query: string,
  market = 'US'
): Promise<StoreSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const url = `https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest?market=${encodeURIComponent(
    market
  )}&languages=en-US&productFamilyNames=apps,games&query=${encodeURIComponent(trimmed)}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return [];

  const parsed = await safeReadJson<{
    Results?: Array<{
      ProductFamilyName?: string;
      Products?: Array<{
        ProductId?: string;
        Title?: string;
        PublisherName?: string;
        AverageRating?: number;
        RatingCount?: number;
        DisplayPrice?: string;
        Images?: Array<{ ImagePurpose?: string; Uri?: string; Url?: string }>;
      }>;
    }>;
  }>(res);

  if (!parsed.isJson || !parsed.data) return [];

  const items: StoreSearchResult[] = [];
  for (const group of parsed.data.Results ?? []) {
    for (const p of group.Products ?? []) {
      const id = String(p.ProductId ?? '').trim().toUpperCase();
      if (!/^[0-9][A-Z0-9]{11}$/.test(id)) continue;
      if (items.some((existing) => existing.productId === id)) continue;

      const imgs = Array.isArray(p.Images) ? p.Images : [];
      const preferred =
        imgs.find((img) => img.ImagePurpose === 'Logo' || img.ImagePurpose === 'Tile') ??
        imgs.find((img) => img.ImagePurpose === 'BoxArt' || img.ImagePurpose === 'Poster') ??
        imgs[0];
      let iconUrl: string | null = preferred?.Uri ?? preferred?.Url ?? null;
      if (iconUrl && iconUrl.startsWith('//')) {
        iconUrl = `https:${iconUrl}`;
      }

      items.push({
        productId: id,
        title: String(p.Title ?? id),
        publisher: p.PublisherName ?? null,
        category: group.ProductFamilyName ?? null,
        iconUrl,
        rating:
          typeof p.AverageRating === 'number' && p.AverageRating > 0
            ? Number(p.AverageRating.toFixed(1))
            : null,
        ratingsCount: typeof p.RatingCount === 'number' ? p.RatingCount : null,
        price: typeof p.DisplayPrice === 'string' ? p.DisplayPrice : null,
      });
    }
  }

  return items.slice(0, 16);
}
