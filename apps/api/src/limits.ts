import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Store } from "@webdoctor/storage";

/** Counts events per key inside a sliding window. In memory: a restart resets it, which is fine. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an event and returns true when it is within the limit. Refused events are not counted. */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(t);
    return true;
  }

  /** Seconds until `key` may try again (0 when it can now). */
  retryAfter(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (recent.length < this.max) return 0;
    return Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000));
  }

  private sweep(t: number): void {
    for (const [key, list] of this.hits) {
      if (list.every((x) => x <= t - this.windowMs)) this.hits.delete(key);
    }
  }
}

/**
 * Anonymous sessions for public mode. A token is `<random id>.<HMAC of the id>`: the server stores
 * nothing, and a token it did not issue (or that was altered) fails the signature check. The
 * owner of a run is a hash of the id, so the database never holds a usable token.
 */
export class SessionTokens {
  constructor(private readonly secret: Buffer) {}

  issue(): string {
    const id = randomBytes(16).toString("hex");
    return `${id}.${this.sign(id)}`;
  }

  /** The owner key for a valid token, otherwise undefined. */
  verify(token: unknown): string | undefined {
    if (typeof token !== "string" || token.length > 200) return undefined;
    const [id, sig, extra] = token.split(".");
    if (!id || !sig || extra !== undefined || !/^[0-9a-f]{32}$/.test(id)) return undefined;
    const expected = Buffer.from(this.sign(id));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    return createHash("sha256").update(id).digest("hex");
  }

  private sign(id: string): string {
    return createHmac("sha256", this.secret).update(id).digest("hex");
  }
}

/** Deletes runs older than `cutoffIso` from the database and their files from disk. */
export function sweepRetention(store: Store, dataDir: string, cutoffIso: string): string[] {
  const ids = store.deleteRunsOlderThan(cutoffIso);
  for (const id of ids) {
    if (!/^[\w-]{1,100}$/.test(id)) continue; // never build a path from anything unexpected
    rmSync(join(resolve(dataDir), "runs", id), { recursive: true, force: true });
  }
  return ids;
}
