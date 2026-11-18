import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where uploaded files live. Local disk for now; a cloud bucket (S3/GCS/Azure Blob) would
 * implement the same interface. Files sit OUTSIDE any static web root and are only served
 * through the API, which sets safe headers on every response.
 */
export interface ImageStorage {
  readonly root: string;
  save(key: string, data: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
}

export class LocalImageStorage implements ImageStorage {
  readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
  }

  async save(key: string, data: Buffer) {
    await mkdir(this.root, { recursive: true });
    // `wx` fails if the file exists, so a key collision can never overwrite another image.
    await writeFile(this.safePath(key), data, { flag: 'wx', mode: 0o640 });
  }

  async remove(key: string) {
    await unlink(this.safePath(key)).catch(() => undefined);
  }

  /** Keys are server-generated UUIDs, but double-check nothing can escape the root. */
  private safePath(key: string) {
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return path.join(this.root, key);
  }
}

const SIGNATURES: { type: ImageType; ext: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/png',
    ext: 'png',
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    type: 'image/webp',
    ext: 'webp',
    test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * Detects the real file type from its first bytes ("magic numbers"). The filename and the
 * Content-Type header are chosen by the client and can lie (evil.html renamed photo.png).
 */
export function sniffImageType(data: Buffer): { type: ImageType; ext: string } | null {
  const match = SIGNATURES.find((s) => s.test(data));
  return match ? { type: match.type, ext: match.ext } : null;
}
