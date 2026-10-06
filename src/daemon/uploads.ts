// Pasted/dropped images: stored content-addressed under the (0700) data dir.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export class Uploads {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "uploads");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  save(bytes: Uint8Array, contentType: string): { path: string; sha256: string; bytes: number } {
    const ext = TYPES[contentType.split(";")[0].trim().toLowerCase()];
    if (!ext) throw new Error(`unsupported image type ${contentType}`);
    if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) throw new Error(`image must be 1 byte to ${MAX_UPLOAD_BYTES >> 20} MB`);
    if (!sniff(bytes, ext)) throw new Error("file content does not match its image type");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(this.dir, `${sha256}.${ext}`);
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 });
    return { path, sha256, bytes: bytes.length };
  }

  /** Is this one of ours? Messages may only reference stored uploads. */
  owns(path: string): boolean {
    return path.startsWith(this.dir + "/") && /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/.test(path.slice(this.dir.length + 1)) && existsSync(path);
  }

  prune(maxAgeMs: number) {
    const cutoff = Date.now() - maxAgeMs;
    for (const f of readdirSync(this.dir)) {
      const p = join(this.dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {}
    }
  }
}

function sniff(b: Uint8Array, ext: string): boolean {
  const hex = Buffer.from(b.subarray(0, 12)).toString("hex");
  if (ext === "png") return hex.startsWith("89504e470d0a1a0a");
  if (ext === "jpg") return hex.startsWith("ffd8ff");
  if (ext === "gif") return hex.startsWith("47494638");
  if (ext === "webp") return hex.startsWith("52494646") && hex.slice(16, 24) === "57454250";
  return false;
}
