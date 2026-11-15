// SHA-256 verification and digest normalization utilities.
// Uses native WebCrypto when in a secure context for files <= 128 MB,
// and falls back to incremental streaming SHA-256 over chunks so large
// multi-GB MSIX bundles never exhaust RAM and work on any origin.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_H = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

export class IncrementalSha256 {
  private h = new Uint32Array(INITIAL_H);
  private w = new Int32Array(64);
  private block = new Uint8Array(64);
  private blockLen = 0;
  private bytesHashed = 0;

  private compress(chunk: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] =
        (chunk[j] << 24) |
        (chunk[j + 1] << 16) |
        (chunk[j + 2] << 8) |
        chunk[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
        ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
        (w[i - 15] >>> 3);
      const s1 =
        ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
        ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
        (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = this.h[0];
    let b = this.h[1];
    let c = this.h[2];
    let d = this.h[3];
    let e = this.h[4];
    let f = this.h[5];
    let g = this.h[6];
    let h = this.h[7];

    for (let i = 0; i < 64; i++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this.h[0] = (this.h[0] + a) | 0;
    this.h[1] = (this.h[1] + b) | 0;
    this.h[2] = (this.h[2] + c) | 0;
    this.h[3] = (this.h[3] + d) | 0;
    this.h[4] = (this.h[4] + e) | 0;
    this.h[5] = (this.h[5] + f) | 0;
    this.h[6] = (this.h[6] + g) | 0;
    this.h[7] = (this.h[7] + h) | 0;
  }

  update(data: Uint8Array): this {
    let pos = 0;
    let remaining = data.length;
    this.bytesHashed += remaining;

    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      if (remaining < need) {
        this.block.set(data, this.blockLen);
        this.blockLen += remaining;
        return this;
      }
      this.block.set(data.subarray(0, need), this.blockLen);
      this.compress(this.block, 0);
      this.blockLen = 0;
      pos += need;
      remaining -= need;
    }

    while (remaining >= 64) {
      this.compress(data, pos);
      pos += 64;
      remaining -= 64;
    }

    if (remaining > 0) {
      this.block.set(data.subarray(pos), 0);
      this.blockLen = remaining;
    }

    return this;
  }

  digestHex(): string {
    const padLen = this.blockLen < 56 ? 56 - this.blockLen : 120 - this.blockLen;
    const pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;

    // Total length in bits as 64-bit big-endian integer (safe up to 2^53 bytes)
    const totalBits = this.bytesHashed * 8;
    const highBits = Math.floor(totalBits / 0x100000000);
    const lowBits = totalBits >>> 0;
    const dv = new DataView(pad.buffer);
    dv.setUint32(padLen, highBits >>> 0, false);
    dv.setUint32(padLen + 4, lowBits, false);

    // Process final padding blocks directly without mutating bytesHashed
    let pos = 0;
    let rem = pad.length;
    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      this.block.set(pad.subarray(0, need), this.blockLen);
      this.compress(this.block, 0);
      this.blockLen = 0;
      pos += need;
      rem -= need;
    }
    while (rem >= 64) {
      this.compress(pad, pos);
      pos += 64;
      rem -= 64;
    }

    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += (this.h[i] >>> 0).toString(16).padStart(8, '0');
    }
    return hex;
  }
}

export function bufferToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Normalizes a SHA-256 digest from either 64-char hex (with optional sha256: prefix)
 * or 44-char Base64 (used in Microsoft FE3 XML) into lowercase 64-char hex.
 */
export function normalizeSha256(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let cleaned = raw.trim().replace(/^sha-?256[:=\s]*/i, '').trim();
  if (!cleaned) return null;

  if (/^[a-f0-9]{64}$/i.test(cleaned)) {
    return cleaned.toLowerCase();
  }

  // Handle Base64-encoded 32-byte SHA-256 digest (e.g. FE3 AdditionalDigest)
  if (/^[A-Za-z0-9+/=]{43,44}$/.test(cleaned)) {
    try {
      const binary =
        typeof atob === 'function'
          ? atob(cleaned)
          : Buffer.from(cleaned, 'base64').toString('binary');
      if (binary.length === 32) {
        let hex = '';
        for (let i = 0; i < binary.length; i++) {
          hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
        }
        return hex;
      }
    } catch {
      return null;
    }
  }

  return null;
}

export async function computeSha256FromChunks(
  chunks: ArrayBuffer[],
  onProgress?: (pct: number) => void
): Promise<string> {
  const totalBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  onProgress?.(0);

  // Fast native WebCrypto path for packages <= 128 MB when available
  if (
    typeof crypto !== 'undefined' &&
    crypto.subtle &&
    totalBytes <= 128 * 1024 * 1024
  ) {
    const blob = new Blob(chunks);
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    onProgress?.(100);
    return bufferToHex(digest);
  }

  // Streaming incremental SHA-256 for large files or non-secure contexts
  const hasher = new IncrementalSha256();
  let processed = 0;
  for (let i = 0; i < chunks.length; i++) {
    hasher.update(new Uint8Array(chunks[i]));
    processed += chunks[i].byteLength;
    if (totalBytes > 0) {
      onProgress?.(Math.min(99, Math.round((processed / totalBytes) * 100)));
    }
    // Yield periodically to keep UI responsive during multi-hundred-MB hashes
    if ((i + 1) % 4 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const hex = hasher.digestHex();
  onProgress?.(100);
  return hex;
}

export async function computeSha256FromBlob(
  blob: Blob,
  onProgress?: (pct: number) => void
): Promise<string> {
  onProgress?.(0);
  if (
    typeof crypto !== 'undefined' &&
    crypto.subtle &&
    blob.size <= 128 * 1024 * 1024
  ) {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    onProgress?.(100);
    return bufferToHex(digest);
  }

  const sliceSize = 2 * 1024 * 1024;
  const hasher = new IncrementalSha256();
  let offset = 0;
  let chunkIdx = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + sliceSize, blob.size);
    const buf = await blob.slice(offset, end).arrayBuffer();
    hasher.update(new Uint8Array(buf));
    offset = end;
    chunkIdx++;
    if (blob.size > 0) {
      onProgress?.(Math.min(99, Math.round((offset / blob.size) * 100)));
    }
    if (chunkIdx % 4 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const hex = hasher.digestHex();
  onProgress?.(100);
  return hex;
}
