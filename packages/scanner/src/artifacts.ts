import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** Where binary/large artifacts (screenshots, snapshots) go. Server mode will add an S3 store. */
export interface ArtifactStore {
  write(key: string, data: Uint8Array | string): Promise<void>;
  read(key: string): Promise<Uint8Array>;
}

export class FsArtifactStore implements ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`artifact key escapes the store: ${key}`);
    }
    return full;
  }

  async write(key: string, data: Uint8Array | string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async read(key: string): Promise<Uint8Array> {
    return readFile(this.pathFor(key));
  }
}
