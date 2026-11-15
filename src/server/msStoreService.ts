import https from 'node:https';
import crypto from 'node:crypto';
import type {
  PackageFile,
  ProductPackageResponse,
  StoreRing,
  StoreSearchResult,
} from '../types/store.js';
import { normalizeSha256 } from '../utils/hash.js';
import {
  buildProxyDownloadUrl,
  decodeHtmlEntities,
  formatBytes,
  sanitizeFileName,
  sanitizePackageUrl,
} from '../utils/urlSanitizer.js';

const FE3_ENDPOINT = 'https://fe3cr.delivery.mp.microsoft.com/ClientWebService/client.asmx';
const FE3_SECURED_ENDPOINT = `${FE3_ENDPOINT}/secured`;

// Scoped TLS agent strictly for Microsoft's FE3 SOAP server (whose chain can omit an intermediate CA in container environments)
const fe3TlsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
});

interface CacheEntry {
  expiresAt: number;
  data: ProductPackageResponse;
}

const packageCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function postSoapXml(urlStr: string, xmlBody: string): Promise<string> {
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
          'User-Agent': 'Windows-Update-Agent/10.0.10011.16384 Client-Protocol/1.81',
        },
        timeout: 20000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`FE3 SOAP HTTP ${res.statusCode}: ${text.slice(0, 220)}`));
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

function buildSoapHeader(action: string, toUrl: string, now: Date): string {
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

function normalizeImageUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return trimmed.replace(/^http:\/\//i, 'https://');
  return trimmed;
}

function pickBestIcon(images: Array<{ ImagePurpose?: string; Uri?: string; Width?: number }> | undefined): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const preferredPurposes = ['Tile', 'Logo', 'Poster', 'BoxArt', 'SuperHeroArt'];
  for (const purpose of preferredPurposes) {
    const matches = images.filter(
      (img) => img.ImagePurpose?.toLowerCase() === purpose.toLowerCase() && img.Uri
    );
    if (matches.length > 0) {
      matches.sort((a, b) => (b.Width ?? 0) - (a.Width ?? 0));
      return normalizeImageUrl(matches[0].Uri);
    }
  }
  return normalizeImageUrl(images[0]?.Uri);
}

export async function searchMicrosoftStore(
  query: string,
  market = 'US'
): Promise<StoreSearchResult[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const url = new URL('https://apps.microsoft.com/api/products/search');
  url.searchParams.set('query', cleanQuery);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', market.toUpperCase());

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
  });

  if (!res.ok) {
    throw new Error(`Microsoft Store search failed (HTTP ${res.status})`);
  }

  const json = (await res.json()) as {
    productsList?: Array<{
      productId?: string;
      title?: string;
      publisherName?: string;
      iconUrl?: string;
      averageRating?: number;
      ratingCount?: number;
      displayPrice?: string;
      price?: number;
      categories?: string[];
    }>;
  };

  const list = Array.isArray(json.productsList) ? json.productsList : [];
  return list
    .filter((item) => item.productId && item.title)
    .slice(0, 20)
    .map((item) => ({
      productId: String(item.productId).toUpperCase(),
      title: String(item.title),
      publisher: item.publisherName ?? null,
      iconUrl: normalizeImageUrl(item.iconUrl),
      rating: typeof item.averageRating === 'number' && item.averageRating > 0 ? item.averageRating : null,
      ratingsCount: typeof item.ratingCount === 'number' && item.ratingCount > 0 ? item.ratingCount : null,
      price: item.displayPrice ?? (item.price === 0 ? 'Free' : null),
      category: Array.isArray(item.categories) && item.categories[0] ? item.categories[0] : null,
    }));
}

interface ProductMetadata {
  productId: string;
  title: string;
  publisher: string | null;
  iconUrl: string | null;
  description: string | null;
  wuCategoryId: string | null;
  packageFamilyName: string | null;
}

async function resolveProductMetadata(input: string): Promise<ProductMetadata> {
  const trimmed = input.trim();

  // Handle SaaS marketplace links via search fallback if no 12-char ProductId
  let lookupId = trimmed;
  if (/marketplace\.microsoft\.com/i.test(trimmed)) {
    const slugMatch = trimmed.match(/\/saas\/([^/?#]+)/i);
    const idMatch = trimmed.match(/\b([0-9][A-Z0-9]{11,13})\b/i);
    if (idMatch) {
      lookupId = idMatch[1].toUpperCase();
    } else if (slugMatch) {
      const slugQuery = slugMatch[1].split('.').pop() || slugMatch[1];
      const results = await searchMicrosoftStore(slugQuery.replace(/[-_]+/g, ' '));
      if (results.length > 0) {
        lookupId = results[0].productId;
      }
    }
  }

  // Handle PackageFamilyName lookup
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

  const dcJson = (await dcRes.json()) as {
    Products?: Array<{
      ProductId?: string;
      LocalizedProperties?: Array<{
        ProductTitle?: string;
        PublisherName?: string;
        ShortDescription?: string;
        ProductDescription?: string;
        Images?: Array<{ ImagePurpose?: string; Uri?: string; Width?: number }>;
      }>;
      DisplaySkuAvailabilities?: Array<{
        Sku?: {
          Properties?: {
            FulfillmentData?: {
              WuCategoryId?: string;
              PackageFamilyName?: string;
            };
          };
        };
      }>;
    }>;
  };

  const product = dcJson.Products?.[0];
  if (!product) {
    throw new Error(`Product "${input}" was not found in the Microsoft Store catalog.`);
  }

  const loc = product.LocalizedProperties?.[0];
  const skuProps = product.DisplaySkuAvailabilities
    ?.map((a) => a.Sku?.Properties?.FulfillmentData)
    .find((fd) => fd?.WuCategoryId);

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

function detectPackageType(fileName: string): PackageFile['type'] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.msixbundle')) return 'MSIX Bundle';
  if (lower.endsWith('.appxbundle')) return 'APPX Bundle';
  if (lower.endsWith('.msix')) return 'MSIX';
  if (lower.endsWith('.appx')) return 'APPX';
  if (/\.e(msix|appx)(bundle)?$/.test(lower)) return 'Encrypted';
  return 'Package';
}

function detectArch(fileName: string): PackageFile['arch'] {
  const lower = fileName.toLowerCase();
  if (/_arm64[_.]/.test(lower)) return 'arm64';
  if (/_x64[_.]/.test(lower)) return 'x64';
  if (/_x86[_.]/.test(lower)) return 'x86';
  if (/_arm[_.]/.test(lower)) return 'arm';
  if (/_neutral[_.]/.test(lower)) return 'neutral';
  return 'any';
}

function extractVersion(fileName: string): string | null {
  const m = fileName.match(/_(\d+\.\d+\.\d+\.\d+)_/);
  return m ? m[1] : null;
}

function compareVersionsDesc(a: string | null, b: string | null): number {
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

function mapRingToFlight(ring: StoreRing): { flightRing: string; branchReadiness: string } {
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

interface ParsedFe3File {
  updateId: string;
  revisionNumber: string;
  fileName: string;
  digest: string;
  sha256: string | null;
  sizeBytes: number;
  modifiedAt: string | null;
  isFramework: boolean;
}

const VALID_PACKAGE_EXT_RE = /\.(msixbundle|appxbundle|msix|appx|emsixbundle|eappxbundle|emsix|eappx)$/i;

export async function fetchProductPackages(
  input: string,
  ring: StoreRing = 'Retail'
): Promise<ProductPackageResponse> {
  const cacheKey = `${input.trim().toUpperCase()}::${ring}`;
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

  // Step 1: Map numeric UpdateInfo <ID> -> { updateId, revisionNumber, isFramework } from <NewUpdates>
  const numIdMap = new Map<
    string,
    { updateId: string; revisionNumber: string; isFramework: boolean }
  >();
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

  // Step 2: Parse <File> blocks from both <UpdateInfo> (inline) and <ExtendedUpdateInfo> (<Update><ID>...)
  const parsedFiles: ParsedFe3File[] = [];
  const updateIdentityMap = new Map<string, { id: string; rev: string }>();

  const extUpdateSection = unescaped.split('<ExtendedUpdateInfo>')[1] || '';
  const extBlocks = extUpdateSection.split(/<Update><ID>/i);

  const collectFilesFromBlock = (
    block: string,
    identity: { updateId: string; revisionNumber: string; isFramework: boolean }
  ) => {
    const isFw = identity.isFramework || /IsAppxFramework="true"/i.test(block);
    const fileMatches = [...block.matchAll(/<File\s+([^>]+?)(?:\/>|>([\s\S]*?)<\/File>)/gi)];

    for (const fm of fileMatches) {
      const attrs = fm[1];
      const inner = fm[2] || '';
      const rawFileName = attrs.match(/FileName="([^"]+)"/i)?.[1] || '';
      const identifier = attrs.match(/InstallerSpecificIdentifier="([^"]+)"/i)?.[1] || '';
      const digest = attrs.match(/Digest="([^"]+)"/i)?.[1] || '';
      const digestAlg = attrs.match(/DigestAlgorithm="([^"]+)"/i)?.[1] || '';
      const sizeStr = attrs.match(/Size="(\d+)"/i)?.[1] || '0';
      const modified = attrs.match(/Modified="([^"]+)"/i)?.[1] || null;
      const rawSha256 =
        inner.match(/<AdditionalDigest[^>]*Algorithm="SHA256"[^>]*>([^<]+)<\/AdditionalDigest>/i)?.[1] ||
        (digestAlg.toUpperCase() === 'SHA256' ? digest : null);
      const sha256 = normalizeSha256(rawSha256);

      const extMatch = rawFileName.match(/(\.[a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : '';
      const canonicalName = identifier && ext ? `${identifier}${ext}` : rawFileName;

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

  // Batch GetExtendedUpdateInfo2 in groups of 25
  const identities = Array.from(updateIdentityMap.values());
  const digestToUrl = new Map<string, string>();
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

  const seenNames = new Set<string>();
  const files: PackageFile[] = [];
  const runtimes: PackageFile[] = [];

  for (const pf of parsedFiles) {
    const rawUrl = digestToUrl.get(pf.digest);
    if (!rawUrl) continue;

    const sanitized = sanitizePackageUrl(rawUrl);
    if (!sanitized.ok) continue;

    // Deduplicate identical filename + size combinations
    const dedupKey = `${pf.fileName.toLowerCase()}::${pf.sizeBytes}`;
    if (seenNames.has(dedupKey)) continue;
    seenNames.add(dedupKey);

    const pkgType = detectPackageType(pf.fileName);
    const arch = detectArch(pf.fileName);
    const version = extractVersion(pf.fileName);

    const item: PackageFile = {
      id: crypto.createHash('sha1').update(`${pf.fileName}:${pf.digest}`).digest('hex').slice(0, 16),
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

    if (looksLikeRuntime && (!meta.packageFamilyName || !pf.fileName.toLowerCase().startsWith(meta.packageFamilyName.split('_')[0].toLowerCase()))) {
      runtimes.push(item);
    } else {
      files.push(item);
    }
  }

  files.sort((a, b) => compareVersionsDesc(a.version, b.version));
  runtimes.sort((a, b) => a.fileName.localeCompare(b.fileName));

  const response: ProductPackageResponse = {
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
