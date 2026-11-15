const TRUSTED_HOST_SUFFIXES = [
  '.dl.delivery.mp.microsoft.com',
  '.delivery.mp.microsoft.com',
  '.windowsupdate.com',
  '.microsoft.com',
  '.azureedge.net',
  '.msecnd.net',
  '.s-microsoft.com',
];

export interface SanitizedUrlResult {
  ok: true;
  url: string;
  host: string;
  protocol: 'http:' | 'https:';
  isSigned: boolean;
  notes: string[];
}

export interface InvalidUrlResult {
  ok: false;
  error: string;
}

export function decodeHtmlEntities(input: string): string {
  let current = input;
  for (let i = 0; i < 4; i++) {
    const next = current
      .replace(/&amp;/gi, '&')
      .replace(/&#0*38;/g, '&')
      .replace(/&#x0*26;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*34;/g, '"')
      .replace(/&#x0*22;/gi, '"')
      .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
    if (next === current) break;
    current = next;
  }
  return current;
}

export function isTrustedMicrosoftHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return TRUSTED_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix)
  );
}

export function sanitizePackageUrl(rawInput: string): SanitizedUrlResult | InvalidUrlResult {
  if (!rawInput || typeof rawInput !== 'string') {
    return { ok: false, error: 'Empty URL' };
  }

  const notes: string[] = [];
  let cleaned = rawInput
    .replace(/[\u200B-\u200D\uFEFF\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/^[<"']+|[>"']+$/g, '')
    .trim();

  // Fix accidentally percent-encoded full URLs (e.g. http%3A%2F%2Ftlu.dl...)
  if (/^https?%3A%2F%2F/i.test(cleaned)) {
    try {
      cleaned = decodeURIComponent(cleaned);
      notes.push('Decoded percent-encoded URL wrapper');
    } catch {
      // ignore if malformed
    }
  }

  const beforeEntity = cleaned;
  cleaned = decodeHtmlEntities(cleaned);
  if (cleaned !== beforeEntity) {
    notes.push('Decoded XML/HTML entities (&amp; → &)');
  }

  // Collapse stray whitespace inside URLs without touching valid query tokens
  if (/\s/.test(cleaned)) {
    cleaned = cleaned.replace(/\s+/g, '');
    notes.push('Removed stray whitespace');
  }

  // Handle protocol-relative URLs
  if (cleaned.startsWith('//')) {
    cleaned = `https:${cleaned}`;
    notes.push('Normalized protocol-relative URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return { ok: false, error: 'Malformed download URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
  }

  if (!isTrustedMicrosoftHost(parsed.hostname)) {
    return {
      ok: false,
      error: `Untrusted host: ${parsed.hostname}`,
    };
  }

  // Preserve exact raw query string so signed HMAC tokens (P1, P2, P3, P4 with %2f/%2b/%3d) are never re-encoded or mangled!
  const qIndex = cleaned.indexOf('?');
  const rawQuery = qIndex >= 0 ? cleaned.slice(qIndex) : '';
  const safeBase = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const finalUrl = `${safeBase}${rawQuery}`;

  const isSigned =
    /[?&]P1=/.test(rawQuery) ||
    /[?&]sig=/i.test(rawQuery) ||
    /[?&]P4=/.test(rawQuery);

  return {
    ok: true,
    url: finalUrl,
    host: parsed.hostname,
    protocol: parsed.protocol,
    isSigned,
    notes,
  };
}

export function sanitizeFileName(rawName: string, fallback = 'package.msixbundle'): string {
  const decoded = decodeHtmlEntities(rawName || '').trim();
  const base = decoded
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .trim();

  if (!base) return fallback;
  // Limit length while preserving extension
  if (base.length <= 180) return base;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && base.length - dot <= 16) {
    return `${base.slice(0, 160)}${base.slice(dot)}`;
  }
  return base.slice(0, 180);
}

export function buildProxyDownloadUrl(sanitizedUrl: string, fileName?: string): string {
  const params = new URLSearchParams();
  params.set('url', sanitizedUrl);
  if (fileName) {
    params.set('filename', sanitizeFileName(fileName));
  }
  return `/api/download?${params.toString()}`;
}

const PRODUCT_ID_RE = /^[0-9][A-Z0-9]{11,13}$/i;
const PRODUCT_ID_INLINE_RE = /\b([0-9][A-Z0-9]{11,13})\b/i;
const URL_HINT_RE = /^https?:\/\/|microsoft\.com/i;
const STORE_PROTO_RE = /^(?:ms-(?:windows-)?store|web\+msstore):/i;
const SAAS_RE = /marketplace\.microsoft\.com\/(?:[a-z-]+\/)?product\/saas\//i;

export type ParsedStoreInput =
  | { kind: 'product'; productId: string }
  | { kind: 'search'; query: string };

export function parseStoreInput(raw: string): ParsedStoreInput {
  let trimmed = decodeHtmlEntities(raw).trim();

  // Unwrap web+msstore:// or ms-windows-store:// URLs if pasted or passed via protocol handler
  if (STORE_PROTO_RE.test(trimmed)) {
    const searchMatch = trimmed.match(/search[^?]*\?[^#]*query=([^&\s#]+)/i);
    if (searchMatch) {
      return { kind: 'search', query: decodeURIComponent(searchMatch[1]).replace(/\+/g, ' ') };
    }
    const pdpId = trimmed.match(/[?&]ProductId=([0-9][A-Z0-9]{11,13})/i);
    if (pdpId) {
      return { kind: 'product', productId: pdpId[1].toUpperCase() };
    }
    const pfnMatch = trimmed.match(/[?&]PFN=([^&\s#]+)/i);
    if (pfnMatch) {
      return { kind: 'product', productId: decodeURIComponent(pfnMatch[1]) };
    }
    // Strip protocol prefix and continue parsing remainder
    trimmed = trimmed.replace(STORE_PROTO_RE, '').replace(/^\/+/, '');
  }

  if (SAAS_RE.test(trimmed)) {
    return { kind: 'product', productId: trimmed };
  }

  if (PRODUCT_ID_RE.test(trimmed)) {
    return { kind: 'product', productId: trimmed.toUpperCase() };
  }

  const inline = trimmed.match(PRODUCT_ID_INLINE_RE);
  if (inline && (URL_HINT_RE.test(trimmed) || STORE_PROTO_RE.test(raw))) {
    return { kind: 'product', productId: inline[1].toUpperCase() };
  }

  // PackageFamilyName format e.g. Microsoft.WindowsCalculator_8wekyb3d8bbwe
  if (/^[A-Za-z0-9.\-]+_[a-z0-9]{13}$/i.test(trimmed)) {
    return { kind: 'product', productId: trimmed };
  }

  return { kind: 'search', query: trimmed };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export interface RenameableTransferLike {
  id: string;
  appTitle: string;
  fileName: string;
  version: string | null;
  arch: string;
  type: string;
  productId: string;
}

export const RENAME_PATTERN_PRESETS = [
  { label: '{appName}_{version}_{arch}.msix', pattern: '{appName}_{version}_{arch}.msix' },
  { label: '{appName}_{version}_{arch}.{ext}', pattern: '{appName}_{version}_{arch}.{ext}' },
  { label: '{appName}_{arch}_{index}.{ext}', pattern: '{appName}_{arch}_{index}.{ext}' },
] as const;

export const RENAME_PATTERN_TOKENS = [
  { token: '{appName}', desc: 'App title' },
  { token: '{version}', desc: 'Package version' },
  { token: '{arch}', desc: 'Architecture' },
  { token: '{type}', desc: 'Package format' },
  { token: '{productId}', desc: 'Store ID' },
  { token: '{ext}', desc: 'Original extension' },
  { token: '{name}', desc: 'Original base name' },
  { token: '{index}', desc: 'Sequence #' },
] as const;

export function splitFileName(fileName: string): { base: string; ext: string } {
  const clean = sanitizeFileName(fileName, 'package.msix');
  const dot = clean.lastIndexOf('.');
  if (dot > 0 && dot < clean.length - 1) {
    return {
      base: clean.slice(0, dot),
      ext: clean.slice(dot + 1),
    };
  }
  return { base: clean, ext: 'msix' };
}

function normalizeTokenValue(raw: string, fallback: string): string {
  const cleaned = decodeHtmlEntities(raw || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

export function formatTransferFileName(
  pattern: string,
  item: Omit<RenameableTransferLike, 'id'>,
  index = 0
): string {
  const { base: origBase, ext: origExt } = splitFileName(item.fileName);
  const rawPattern = (pattern || '').trim();
  if (!rawPattern) {
    return sanitizeFileName(item.fileName);
  }

  const replacements: Record<string, string> = {
    appname: normalizeTokenValue(item.appTitle, 'App'),
    version: normalizeTokenValue(item.version || '', 'latest'),
    arch: normalizeTokenValue(
      item.arch && item.arch !== 'any' ? item.arch : 'neutral',
      'neutral'
    ),
    type: normalizeTokenValue((item.type || 'package').toLowerCase(), 'package'),
    productid: normalizeTokenValue(item.productId, 'store'),
    ext: normalizeTokenValue(origExt, 'msix'),
    name: normalizeTokenValue(origBase, 'package'),
    original: normalizeTokenValue(origBase, 'package'),
    index: String(index + 1),
  };

  let formatted = rawPattern.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const lower = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(replacements, lower)
      ? replacements[lower]
      : match;
  });

  // Clean up accidental double separators around empty tokens while preserving intentional dots
  formatted = formatted
    .replace(/_+/g, '_')
    .replace(/^[._\-\s]+/, '')
    .replace(/[_\-\s]+\./g, '.')
    .trim();

  if (!formatted) {
    return sanitizeFileName(item.fileName);
  }

  // Ensure a valid extension exists if pattern omitted one
  if (!/\.[a-z0-9]{2,14}$/i.test(formatted)) {
    formatted = `${formatted}.${origExt}`;
  }

  return sanitizeFileName(formatted, item.fileName);
}

export interface BatchRenamePreviewItem {
  id: string;
  oldName: string;
  newName: string;
  changed: boolean;
}

export function buildBatchRenamePreview(
  items: RenameableTransferLike[],
  pattern: string,
  otherUsedNames: string[] = []
): BatchRenamePreviewItem[] {
  const usedLower = new Set<string>(otherUsedNames.map((n) => n.toLowerCase()));

  return items.map((item, idx) => {
    const candidate = formatTransferFileName(pattern, item, idx);
    const { base, ext } = splitFileName(candidate);

    let uniqueName = candidate;
    let suffix = 2;
    while (usedLower.has(uniqueName.toLowerCase())) {
      uniqueName = sanitizeFileName(`${base}_${suffix}.${ext}`, candidate);
      suffix++;
    }
    usedLower.add(uniqueName.toLowerCase());

    return {
      id: item.id,
      oldName: item.fileName,
      newName: uniqueName,
      changed: uniqueName !== item.fileName,
    };
  });
}
