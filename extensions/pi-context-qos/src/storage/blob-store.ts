import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

export interface BlobWriteResult {
  hash: string;
  bytes: number;
  deduplicated: boolean;
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export class BlobStore {
  readonly root: string;

  constructor(storageDirectory: string) {
    this.root = join(storageDirectory, "blobs");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
  }

  pathFor(hash: string): string {
    return join(this.root, hash.slice(0, 2), `${hash.slice(2)}.zst`);
  }

  put(content: string): BlobWriteResult {
    const raw = Buffer.from(content, "utf8");
    const hash = sha256(raw);
    const path = this.pathFor(hash);
    if (existsSync(path)) {
      return { hash, bytes: readFileSync(path).byteLength, deduplicated: true };
    }
    const compressed = zstdCompressSync(raw, {
      params: { [constants.ZSTD_c_compressionLevel]: 7 },
    });
    mkdirSync(join(this.root, hash.slice(0, 2)), {
      recursive: true,
      mode: 0o700,
    });
    try {
      writeFileSync(path, compressed, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return { hash, bytes: readFileSync(path).byteLength, deduplicated: true };
    }
    chmodSync(path, 0o600);
    return { hash, bytes: compressed.byteLength, deduplicated: false };
  }

  get(hash: string): string {
    const compressed = readFileSync(this.pathFor(hash));
    return zstdDecompressSync(compressed).toString("utf8");
  }

  has(hash: string): boolean {
    return existsSync(this.pathFor(hash));
  }
}
