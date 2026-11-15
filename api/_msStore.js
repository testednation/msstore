import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const TRUSTED_HOST_SUFFIXES = [
  '.dl.delivery.mp.microsoft.com',
  '.delivery.mp.microsoft.com',
  '.windowsupdate.com',
  '.microsoft.com',
  '.azureedge.net',
  '.msecnd.net',
  '.s-microsoft.com',
];

const FE3_ENDPOINT =
  'https://fe3cr.delivery.mp.microsoft.com/ClientWebService/client.asmx';
const FE3_SECURED_ENDPOINT = `${FE3_ENDPOINT}/secured`;

const fe3TlsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
});

const packageCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function decodeHtmlEntities(input) {
  let current = String(input || '');
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

export function isTrustedMicrosoftHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return TRUSTED_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix)
  );
}

export function sanitizePackageUrl(rawInput) {
  const notes = [];
  if (!rawInput || typeof rawInput !== 'string') {
    return { ok: false, error: 'Empty or missing package URL' };
  }

  let cleaned = rawInput.trim();
  const withoutControls = cleaned.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  if (withoutControls !== cleaned) {
    cleaned = withoutControls;
    notes.push('Stripped hidden control characters');
  }

  cleaned = cleaned.replace(/^['"<]+|[>'"\s]+$/g, '');

  const decoded = decodeHtmlEntities(cleaned);
  if (decoded !== cleaned) {
    cleaned = decoded;
    notes.push('Decoded XML/HTML entities (&amp; -> &)');
  }

  if (cleaned.startsWith('//')) {
    cleaned = `http:${cleaned}`;
    notes.push('Normalized scheme-relative URL');
  }

  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    return { ok: false, error: 'Malformed URL syntax' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
  }

  if (!isTrustedMicrosoftHost(parsed.hostname)) {
    return {
      ok: false,
      error: `Untrusted delivery host: ${parsed.hostname}`,
    };
  }

  const rawQueryMatch = cleaned.match(/\?([^#]*)/);
  const rawQuery = rawQueryMatch ? rawQueryMatch[1] : '';
  const isSigned = /(?:^|&)(?:P1|P2|P3|P4|sh|sig|se|st|sv)=/i.test(rawQuery);

  const normalizedOriginAndPath = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(
    /\/{2,}/g,
    '/'
  )}`;
  const finalUrl = rawQuery
    ? `${normalizedOriginAndPath}?${rawQuery}`
    : normalizedOriginAndPath;

  return {
    ok: true,
    url: finalUrl,
    host: parsed.hostname.toLowerCase(),
    protocol: parsed.protocol,
    isSigned,
    notes,
  };
}

export function sanitizeFileName(rawName, fallback = 'package.msixbundle') {
  const trimmed = (rawName || '').trim();
  if (!trimmed) return fallback;
  const cleaned = trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '');
  return cleaned || fallback;
}

export function buildProxyDownloadUrl(rawOrSanitizedUrl, fileName) {
  const sanitized = sanitizePackageUrl(rawOrSanitizedUrl);
  const target = sanitized.ok ? sanitized.url : rawOrSanitizedUrl;
  const safeName = sanitizeFileName(fileName);
  const params = new URLSearchParams({
    url: target,
    filename: safeName,
  });
  return `/api/download?${params.toString()}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const val = bytes / Math.pow(1024, idx);
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`;
}

function normalizeSha256(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^sha-?256\s*[:=]\s*/i, '').trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const compact = trimmed.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]{43}=$/.test(compact) || /^[A-Za-z0-9\-_]{43}=?$/.test(compact)) {
    try {
      const std = compact.replace(/-/g, '+').replace(/_/g, '/');
      const padded = std.length % 4 === 0 ? std : std + '='.repeat(4 - (std.length % 4));
      const buf = Buffer.from(padded, 'base64');
      if (buf.length === 32) {
        return buf.toString('hex').toLowerCase();
      }
    } catch {
      return null;
    }
  }
  return null;
}

function postSoapXml(urlStr, xmlBody) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'POST',
        agent: fe3TlsAgent,
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(xmlBody, 'utf8'),
          'User-Agent':
            'Windows-Update-Agent/10.0.10011.16384 Client-Protocol/1.81',
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(
              new Error(`FE3 SOAP HTTP ${res.statusCode}: ${text.slice(0, 220)}`)
            );
            return;
          }
          resolve(text);
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('FE3 SOAP request timed out'));
    });
    req.on('error', reject);
    req.write(xmlBody);
    req.end();
  });
}

function buildSoapHeader(action, toUrl, now) {
  const exp = new Date(now.getTime() + 5 * 60 * 1000);
  return `<s:Header>
    <a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/${action}</a:Action>
    <a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID>
    <a:To s:mustUnderstand="1">${toUrl}</a:To>
    <o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <u:Timestamp u:Id="_0">
        <u:Created>${now.toISOString()}</u:Created>
        <u:Expires>${exp.toISOString()}</u:Expires>
      </u:Timestamp>
      <wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization">
        <TicketType Name="MSA" Version="1.0" Policy="MBI_SSL"><user/></TicketType>
      </wuws:WindowsUpdateTicketsToken>
    </o:Security>
  </s:Header>`;
}

function normalizeImageUrl(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://'))
    return trimmed.replace(/^http:\/\//i, 'https://');
  return trimmed;
}

function pickBestIcon(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const preferredPurposes = ['Tile', 'Logo', 'Poster', 'BoxArt', 'SuperHeroArt'];
  for (const purpose of preferredPurposes) {
    const matches = images.filter(
      (img) =>
        img.ImagePurpose?.toLowerCase() === purpose.toLowerCase() && img.Uri
    );
    if (matches.length > 0) {
      matches.sort((a, b) => (b.Width ?? 0) - (a.Width ?? 0));
      return normalizeImageUrl(matches[0].Uri);
    }
  }
  return normalizeImageUrl(images[0]?.Uri);
}

export async function searchMicrosoftStore(query, market = 'US') {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  try {
    const url = new URL('https://apps.microsoft.com/api/products/search');
    url.searchParams.set('query', cleanQuery);
    url.searchParams.set('hl', 'en-US');
    url.searchParams.set('gl', String(market || 'US').toUpperCase());

    const res = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });

    if (res.ok) {
      const json = await res.json();
      const list = Array.isArray(json.productsList) ? json.productsList : [];
      if (list.length > 0) {
        return list
          .filter((item) => item.productId && item.title)
          .slice(0, 20)
          .map((item) => ({
            productId: String(item.productId).toUpperCase(),
            title: String(item.title),
            publisher: item.publisherName ?? null,
            iconUrl: normalizeImageUrl(item.iconUrl),
            rating:
              typeof item.averageRating === 'number' && item.averageRating > 0
                ? item.averageRating
                : null,
            ratingsCount:
              typeof item.ratingCount === 'number' && item.ratingCount > 0
                ? item.ratingCount
                : null,
            price: item.displayPrice ?? (item.price === 0 ? 'Free' : null),
            category:
              Array.isArray(item.categories) && item.categories[0]
                ? item.categories[0]
                : null,
          }));
      }
    }
  } catch {
    // Fall through to DisplayCatalog autosuggest
  }

  const fallbackUrl = new URL(
    'https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest'
  );
  fallbackUrl.searchParams.set('market', String(market || 'US').toUpperCase());
  fallbackUrl.searchParams.set('languages', 'en-US');
  fallbackUrl.searchParams.set('productFamilyNames', 'apps,games');
  fallbackUrl.searchParams.set('query', cleanQuery);

  const fbRes = await fetch(fallbackUrl.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!fbRes.ok) {
    throw new Error(`Microsoft Store search failed (HTTP ${fbRes.status})`);
  }

  const fbJson = await fbRes.json();
  const results = [];
  const seen = new Set();
  for (const group of fbJson.Results ?? []) {
    for (const prod of group.Products ?? []) {
      if (!prod.ProductId || !prod.Title) continue;
      const pid = String(prod.ProductId).toUpperCase();
      if (seen.has(pid)) continue;
      seen.add(pid);
      results.push({
        productId: pid,
        title: String(prod.Title),
        publisher: null,
        iconUrl: normalizeImageUrl(prod.Icon),
        rating: null,
        ratingsCount: null,
        price: null,
        category: prod.Type || group.ProductFamilyName || null,
      });
    }
  }
  return results.slice(0, 20);
}

async function resolveProductMetadata(input) {
  const trimmed = String(input || '').trim();
  let lookupId = trimmed;
  if (/marketplace\.microsoft\.com/i.test(trimmed)) {
    const slugMatch = trimmed.match(/\/saas\/([^/?#]+)/i);
    const idMatch = trimmed.match(/\b([0-9][A-Z0-9]{11,13})\b/i);
    if (idMatch) {
      lookupId = idMatch[1].toUpperCase();
    } else if (slugMatch) {
      const slugQuery = slugMatch[1].split('.').pop() || slugMatch[1];
      const results = await searchMicrosoftStore(
        slugQuery.replace(/[-_]+/g, ' ')
      );
      if (results.length > 0) {
        lookupId = results[0].productId;
      }
    }
  }

  const isPfn = /^[A-Za-z0-9.\-]+_[a-z0-9]{13}$/i.test(lookupId);
  const dcUrl = isPfn
    ? `https://displaycatalog.mp.microsoft.com/v7.0/products/lookup?alternateId=PackageFamilyName&Value=${encodeURIComponent(lookupId)}&market=US&languages=en-us&MS-CV=DGU1mcuYo0WMMp+F.1`
    : `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${encodeURIComponent(lookupId.toUpperCase())}&market=US&languages=en-us&MS-CV=DGU1mcuYo0WMMp+F.1`;

  const dcRes = await fetch(dcUrl, {
    headers: { Accept: 'application/json' },
  });

  if (!dcRes.ok) {
    throw new Error(`DisplayCatalog lookup failed (HTTP ${dcRes.status})`);
  }

  const dcJson = await dcRes.json();
  const product = dcJson.Products?.[0];
  if (!product) {
    throw new Error(
      `Product "${input}" was not found in the Microsoft Store catalog.`
    );
  }

  const loc = product.LocalizedProperties?.[0];
  const skuProps = product.DisplaySkuAvailabilities?.map(
    (a) => a.Sku?.Properties?.FulfillmentData
  ).find((fd) => fd?.WuCategoryId);

  return {
    productId: (product.ProductId || lookupId).toUpperCase(),
    title: loc?.ProductTitle || lookupId,
    publisher: loc?.PublisherName || null,
    iconUrl: pickBestIcon(loc?.Images),
    description: loc?.ShortDescription || loc?.ProductDescription || null,
    wuCategoryId: skuProps?.WuCategoryId || null,
    packageFamilyName: skuProps?.PackageFamilyName || null,
  };
}

function detectPackageType(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.msixbundle')) return 'MSIX Bundle';
  if (lower.endsWith('.appxbundle')) return 'APPX Bundle';
  if (lower.endsWith('.msix')) return 'MSIX';
  if (lower.endsWith('.appx')) return 'APPX';
  if (/\.e(msix|appx)(bundle)?$/.test(lower)) return 'Encrypted';
  return 'Package';
}

function detectArch(fileName) {
  const lower = fileName.toLowerCase();
  if (/_arm64[_.]/.test(lower)) return 'arm64';
  if (/_x64[_.]/.test(lower)) return 'x64';
  if (/_x86[_.]/.test(lower)) return 'x86';
  if (/_arm[_.]/.test(lower)) return 'arm';
  if (/_neutral[_.]/.test(lower)) return 'neutral';
  return 'any';
}

function extractVersion(fileName) {
  const m = fileName.match(/_(\d+\.\d+\.\d+\.\d+)_/);
  return m ? m[1] : null;
}

function compareVersionsDesc(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function mapRingToFlight(ring) {
  switch (ring) {
    case 'RP':
      return { flightRing: 'RP', branchReadiness: 'CB' };
    case 'WIS':
      return { flightRing: 'WIS', branchReadiness: 'CB' };
    case 'WIF':
      return { flightRing: 'WIF', branchReadiness: 'CB' };
    case 'Retail':
    default:
      return { flightRing: 'Retail', branchReadiness: 'CBB' };
  }
}

const VALID_PACKAGE_EXT_RE =
  /\.(msixbundle|appxbundle|msix|appx|emsixbundle|eappxbundle|emsix|eappx)$/i;

export async function fetchProductPackages(input, ring = 'Retail') {
  const cacheKey = `${String(input || '').trim().toUpperCase()}::${ring}`;
  const cached = packageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const meta = await resolveProductMetadata(input);
  if (!meta.wuCategoryId) {
    throw new Error(
      `No Windows Update category ID was published for ${meta.title} (${meta.productId}). Some web-only, paid, or Win32 installer apps do not distribute MSIX/APPX packages.`
    );
  }

  const now = new Date();
  const cookieSoap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
  ${buildSoapHeader('GetCookie', FE3_ENDPOINT, now)}
  <s:Body>
    <GetCookie xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">
      <oldCookie><Expiration>2019-01-01T00:00:00Z</Expiration></oldCookie>
      <lastChange>2015-01-01T00:00:00Z</lastChange>
      <currentTime>${now.toISOString()}</currentTime>
      <protocolVersion>1.81</protocolVersion>
    </GetCookie>
  </s:Body>
</s:Envelope>`;

  const cookieXml = await postSoapXml(FE3_ENDPOINT, cookieSoap);
  const encData = cookieXml.match(/<EncryptedData>([\s\S]*?)<\/EncryptedData>/)?.[1];
  const cookExp = cookieXml.match(/<Expiration>([\s\S]*?)<\/Expiration>/)?.[1];
  if (!encData || !cookExp) {
    throw new Error('Failed to acquire FE3 delivery session cookie from Microsoft.');
  }

  const { flightRing, branchReadiness } = mapRingToFlight(ring);
  const deviceAttrs = `E:BranchReadinessLevel=${branchReadiness}&amp;DchuNvidiaGrfxExists=1&amp;ProcessorIdentifier=Intel64%20Family%206%20Model%2063%20Stepping%202&amp;CurrentBranch=rs4_release&amp;DataVer_RS5=1942&amp;FlightRing=${flightRing}&amp;AttrDataVer=57&amp;InstallLanguage=en-US&amp;OSUpg=1&amp;InstallationType=Client&amp;FlightingBranchName=&amp;OSSkuId=48&amp;App=WU&amp;ProcessorManufacturer=GenuineIntel&amp;OEMName_Uncleaned=LENOVO&amp;AppVer=10.0.17134.471&amp;OSArchitecture=AMD64&amp;UpdateManagementGroup=2&amp;IsDeviceRetailDemo=0&amp;TelemetryLevel=3&amp;DefaultUserRegion=244&amp;DeferFeatureUpdatePeriodInDays=365&amp;Bios=LENOVO&amp;WuClientVer=10.0.17134.471&amp;PausedFeatureStatus=1&amp;Steam=1&amp;Free=gt64&amp;OSVersion=10.0.17134.471&amp;DeviceFamily=Windows.Desktop`;

  const syncSoap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
  ${buildSoapHeader('SyncUpdates', FE3_ENDPOINT, now)}
  <s:Body>
    <SyncUpdates xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">
      <cookie><Expiration>${cookExp}</Expiration><EncryptedData>${encData}</EncryptedData></cookie>
      <parameters>
        <ExpressQuery>false</ExpressQuery>
        <InstalledNonLeafUpdateIDs>
          <int>1</int><int>2</int><int>3</int><int>11</int><int>19</int>
          <int>2359974</int><int>5169044</int><int>8788830</int>
          <int>23110993</int><int>23110994</int>
          <int>59830006</int><int>59830007</int><int>59830008</int>
          <int>60484010</int><int>62450018</int><int>62450019</int><int>62450020</int>
          <int>98959022</int><int>98959023</int><int>98959024</int><int>98959025</int><int>98959026</int>
          <int>129905029</int><int>130040030</int><int>130040031</int><int>130040032</int><int>130040033</int>
          <int>138372035</int><int>138372036</int><int>139536037</int>
          <int>158941041</int><int>158941042</int><int>158941043</int><int>158941044</int>
        </InstalledNonLeafUpdateIDs>
        <OtherCachedUpdateIDs/>
        <SkipSoftwareSync>false</SkipSoftwareSync>
        <NeedTwoGroupOutOfScopeUpdates>true</NeedTwoGroupOutOfScopeUpdates>
        <FilterAppCategoryIds><CategoryIdentifier><Id>${meta.wuCategoryId}</Id></CategoryIdentifier></FilterAppCategoryIds>
        <TreatAppCategoryIdsAsInstalled>true</TreatAppCategoryIdsAsInstalled>
        <AlsoPerformRegularSync>false</AlsoPerformRegularSync>
        <ComputerSpec/>
        <ExtendedUpdateInfoParameters>
          <XmlUpdateFragmentTypes>
            <XmlUpdateFragmentType>Extended</XmlUpdateFragmentType>
            <XmlUpdateFragmentType>LocalizedProperties</XmlUpdateFragmentType>
            <XmlUpdateFragmentType>Eula</XmlUpdateFragmentType>
          </XmlUpdateFragmentTypes>
          <Locales><string>en-US</string><string>en</string></Locales>
        </ExtendedUpdateInfoParameters>
        <ClientPreferredLanguages><string>en-US</string></ClientPreferredLanguages>
        <ProductsParameters>
          <SyncCurrentVersionOnly>false</SyncCurrentVersionOnly>
          <DeviceAttributes>${deviceAttrs}</DeviceAttributes>
          <CallerAttributes>Interactive=1;IsSeeker=1;Acquisition=1;SheddingVerification=1;Id=Acquisition;</CallerAttributes>
          <Products/>
        </ProductsParameters>
      </parameters>
    </SyncUpdates>
  </s:Body>
</s:Envelope>`;

  const syncXml = await postSoapXml(FE3_ENDPOINT, syncSoap);
  const unescaped = decodeHtmlEntities(syncXml);

  const numIdMap = new Map();
  const newUpdatesPart = unescaped.split('<ExtendedUpdateInfo>')[0] || unescaped;
  const updateInfoBlocks = newUpdatesPart.split('<UpdateInfo>');

  for (const block of updateInfoBlocks) {
    const numId = block.match(/^<ID>(\d+)<\/ID>/i)?.[1];
    if (!numId) continue;
    const identityTag = block.match(/<UpdateIdentity\s+([^>]+?)\/?>/i)?.[1];
    if (!identityTag) continue;
    const updateId = identityTag.match(/UpdateID="([^"]+)"/i)?.[1];
    const revisionNumber = identityTag.match(/RevisionNumber="(\d+)"/i)?.[1];
    if (!updateId || !revisionNumber) continue;
    const isFramework = /IsAppxFramework="true"/i.test(block);
    numIdMap.set(numId, { updateId, revisionNumber, isFramework });
  }

  const parsedFiles = [];
  const updateIdentityMap = new Map();
  const extUpdateSection = unescaped.split('<ExtendedUpdateInfo>')[1] || '';
  const extBlocks = extUpdateSection.split(/<Update><ID>/i);

  const collectFilesFromBlock = (block, identity) => {
    const isFw = identity.isFramework || /IsAppxFramework="true"/i.test(block);
    const fileMatches = [
      ...block.matchAll(/<File\s+([^>]+?)(?:\/>|>([\s\S]*?)<\/File>)/gi),
    ];

    for (const fm of fileMatches) {
      const attrs = fm[1];
      const inner = fm[2] || '';
      const rawFileName = attrs.match(/FileName="([^"]+)"/i)?.[1] || '';
      const identifier =
        attrs.match(/InstallerSpecificIdentifier="([^"]+)"/i)?.[1] || '';
      const digest = attrs.match(/Digest="([^"]+)"/i)?.[1] || '';
      const digestAlg = attrs.match(/DigestAlgorithm="([^"]+)"/i)?.[1] || '';
      const sizeStr = attrs.match(/Size="(\d+)"/i)?.[1] || '0';
      const modified = attrs.match(/Modified="([^"]+)"/i)?.[1] || null;
      const rawSha256 =
        inner.match(
          /<AdditionalDigest[^>]*Algorithm="SHA256"[^>]*>([^<]+)<\/AdditionalDigest>/i
        )?.[1] || (digestAlg.toUpperCase() === 'SHA256' ? digest : null);
      const sha256 = normalizeSha256(rawSha256);

      const extMatch = rawFileName.match(/(\.[a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : '';
      const canonicalName =
        identifier && ext ? `${identifier}${ext}` : rawFileName;

      if (!VALID_PACKAGE_EXT_RE.test(canonicalName)) continue;
      if (!digest) continue;

      updateIdentityMap.set(`${identity.updateId}:${identity.revisionNumber}`, {
        id: identity.updateId,
        rev: identity.revisionNumber,
      });

      parsedFiles.push({
        updateId: identity.updateId,
        revisionNumber: identity.revisionNumber,
        fileName: sanitizeFileName(canonicalName),
        digest,
        sha256,
        sizeBytes: parseInt(sizeStr, 10) || 0,
        modifiedAt: modified,
        isFramework: isFw,
      });
    }
  };

  for (const block of updateInfoBlocks) {
    const numId = block.match(/^<ID>(\d+)<\/ID>/i)?.[1];
    if (!numId) continue;
    const identity = numIdMap.get(numId);
    if (identity && /<Files>/i.test(block)) {
      collectFilesFromBlock(block, identity);
    }
  }

  for (const block of extBlocks) {
    const numId = block.match(/^(\d+)<\/ID>/i)?.[1];
    if (!numId) continue;
    const identity = numIdMap.get(numId);
    if (identity && /<File\s+/i.test(block)) {
      collectFilesFromBlock(block, identity);
    }
  }

  const identities = Array.from(updateIdentityMap.values());
  const digestToUrl = new Map();
  const batchSize = 25;

  for (let i = 0; i < identities.length; i += batchSize) {
    const batch = identities.slice(i, i + batchSize);
    const revXml = batch
      .map(
        (u) =>
          `<UpdateIdentity><UpdateID>${u.id}</UpdateID><RevisionNumber>${u.rev}</RevisionNumber></UpdateIdentity>`
      )
      .join('');

    const extSoap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
  ${buildSoapHeader('GetExtendedUpdateInfo2', FE3_SECURED_ENDPOINT, now)}
  <s:Body>
    <GetExtendedUpdateInfo2 xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">
      <updateIDs>${revXml}</updateIDs>
      <infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType></infoTypes>
      <deviceAttributes>${deviceAttrs}</deviceAttributes>
    </GetExtendedUpdateInfo2>
  </s:Body>
</s:Envelope>`;

    try {
      const extXml = await postSoapXml(FE3_SECURED_ENDPOINT, extSoap);
      const locMatches = [
        ...extXml.matchAll(
          /<FileLocation>[\s\S]*?<FileDigest>([^<]+)<\/FileDigest>[\s\S]*?<Url>([^<]+)<\/Url>[\s\S]*?<\/FileLocation>/gi
        ),
      ];
      for (const lm of locMatches) {
        const fileDigest = lm[1].trim();
        const rawUrl = lm[2].trim();
        if (fileDigest && rawUrl) {
          digestToUrl.set(fileDigest, rawUrl);
        }
      }
    } catch (err) {
      console.error('GetExtendedUpdateInfo2 batch warning:', err);
    }
  }

  const seenNames = new Set();
  const files = [];
  const runtimes = [];

  for (const pf of parsedFiles) {
    const rawUrl = digestToUrl.get(pf.digest);
    if (!rawUrl) continue;

    const sanitized = sanitizePackageUrl(rawUrl);
    if (!sanitized.ok) continue;

    const dedupKey = `${pf.fileName.toLowerCase()}::${pf.sizeBytes}`;
    if (seenNames.has(dedupKey)) continue;
    seenNames.add(dedupKey);

    const pkgType = detectPackageType(pf.fileName);
    const arch = detectArch(pf.fileName);
    const version = extractVersion(pf.fileName);

    const item = {
      id: crypto
        .createHash('sha1')
        .update(`${pf.fileName}:${pf.digest}`)
        .digest('hex')
        .slice(0, 16),
      fileName: pf.fileName,
      rawUrl,
      url: sanitized.url,
      proxyUrl: buildProxyDownloadUrl(sanitized.url, pf.fileName),
      type: pkgType,
      arch,
      version,
      sizeBytes: pf.sizeBytes,
      sizeLabel: pf.sizeBytes > 0 ? formatBytes(pf.sizeBytes) : null,
      digest: pf.digest,
      sha256: pf.sha256,
      isFramework: pf.isFramework,
      isSigned: sanitized.isSigned,
      sanitizationNotes: sanitized.notes,
      modifiedAt: pf.modifiedAt,
    };

    const looksLikeRuntime =
      pf.isFramework ||
      /^Microsoft\.(VCLibs|NET\.Native|UI\.Xaml|DirectX|Services\.Store|Advertising)/i.test(
        pf.fileName
      );

    if (
      looksLikeRuntime &&
      (!meta.packageFamilyName ||
        !pf.fileName
          .toLowerCase()
          .startsWith(meta.packageFamilyName.split('_')[0].toLowerCase()))
    ) {
      runtimes.push(item);
    } else {
      files.push(item);
    }
  }

  files.sort((a, b) => compareVersionsDesc(a.version, b.version));
  runtimes.sort((a, b) => a.fileName.localeCompare(b.fileName));

  const response = {
    productId: meta.productId,
    title: meta.title,
    publisher: meta.publisher,
    iconUrl: meta.iconUrl,
    description: meta.description,
    packageFamilyName: meta.packageFamilyName,
    ring,
    fetchedAt: Date.now(),
    files,
    runtimes,
  };

  packageCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data: response,
  });

  return response;
}

export function openUpstreamStream(
  targetUrl,
  method,
  rangeHeader,
  redirectsLeft = 5
) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const reqHeaders = {
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
          openUpstreamStream(
            nextSanitized.url,
            method,
            rangeHeader,
            redirectsLeft - 1
          )
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

export async function openWithProtocolFallback(
  sanitizedUrl,
  method,
  rangeHeader
) {
  try {
    const primary = await openUpstreamStream(sanitizedUrl, method, rangeHeader);
    if (primary.statusCode < 400) return primary;
    primary.stream.resume();
    const altUrl = sanitizedUrl.startsWith('http://')
      ? sanitizedUrl.replace(/^http:\/\//i, 'https://')
      : sanitizedUrl.replace(/^https:\/\//i, 'http://');
    const alt = await openUpstreamStream(altUrl, method, rangeHeader);
    if (alt.statusCode < 400) return alt;
    alt.stream.resume();
    return await openUpstreamStream(sanitizedUrl, method, rangeHeader);
  } catch (err) {
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
