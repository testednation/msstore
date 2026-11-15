export type StoreRing = 'Retail' | 'RP' | 'WIS' | 'WIF';

export type PackageTypeFilter =
  | 'All'
  | 'MSIX Bundle'
  | 'APPX Bundle'
  | 'MSIX'
  | 'APPX';

export type ArchFilter = 'All' | 'x64' | 'arm64' | 'x86' | 'arm';

export interface StoreSearchResult {
  productId: string;
  title: string;
  publisher: string | null;
  iconUrl: string | null;
  rating: number | null;
  ratingsCount: number | null;
  price: string | null;
  category: string | null;
}

export interface PackageFile {
  id: string;
  fileName: string;
  rawUrl: string;
  url: string;
  proxyUrl: string;
  type: Exclude<PackageTypeFilter, 'All'> | 'Encrypted' | 'Package';
  arch: 'x64' | 'arm64' | 'x86' | 'arm' | 'neutral' | 'any';
  version: string | null;
  sizeBytes: number;
  sizeLabel: string | null;
  digest: string | null;
  sha256: string | null;
  isFramework: boolean;
  isSigned: boolean;
  sanitizationNotes: string[];
  modifiedAt: string | null;
}

export interface ProductPackageResponse {
  productId: string;
  title: string;
  publisher: string | null;
  iconUrl: string | null;
  description: string | null;
  packageFamilyName: string | null;
  ring: StoreRing;
  fetchedAt: number;
  files: PackageFile[];
  runtimes: PackageFile[];
}

export type TransferStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'error';

export type TransferMode = 'resumable' | 'bgfetch' | 'native';

export type HashVerificationStatus =
  | 'unverified'
  | 'verifying'
  | 'verified'
  | 'mismatch'
  | 'computed'
  | 'error';

export interface TransferItem {
  id: string;
  productId: string;
  appTitle: string;
  iconUrl: string | null;
  fileName: string;
  sanitizedUrl: string;
  rawUrl: string;
  type: string;
  arch: string;
  version: string | null;
  sizeBytes: number;
  bytesDownloaded: number;
  status: TransferStatus;
  mode: TransferMode;
  speedBps: number;
  etaSeconds: number | null;
  error: string | null;
  bgFetchId: string | null;
  expectedSha256?: string | null;
  computedSha256?: string | null;
  verificationStatus?: HashVerificationStatus;
  verifiedAt?: number | null;
  verificationError?: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ExportedQueueItem {
  id: string;
  productId: string;
  appTitle: string;
  iconUrl: string | null;
  fileName: string;
  type: string;
  arch: string;
  version: string | null;
  status: TransferStatus;
  mode: TransferMode;
  progressPercent: number;
  bytesDownloaded: number;
  sizeBytes: number;
  sanitizedUrl: string;
  rawUrl: string;
  proxyPath: string;
  expectedSha256: string | null;
  computedSha256: string | null;
  verificationStatus: HashVerificationStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface QueueExportPayload {
  schema: 'sideload-queue-v1';
  exportedAt: string;
  exportedAtMs: number;
  sourceOrigin: string;
  holdQueue: boolean;
  summary: {
    total: number;
    downloading: number;
    queued: number;
    paused: number;
    interrupted: number;
    completed: number;
    error: number;
  };
  transfers: ExportedQueueItem[];
}
