/** A tiny deterministic PRNG whose complete state can be serialized. */
export interface RngSnapshot {
  readonly seed: string;
  readonly state: number;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class SeededRng {
  readonly seed: string;
  private state: number;

  constructor(seed: string, state = hashSeed(seed)) {
    this.seed = seed;
    this.state = state >>> 0;
  }

  /** Returns a value in [0, 1), deterministically. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError("maxExclusive must be a positive integer");
    }
    return Math.floor(this.next() * maxExclusive);
  }

  snapshot(): RngSnapshot {
    return { seed: this.seed, state: this.state };
  }

  static fromSnapshot(snapshot: RngSnapshot): SeededRng {
    return new SeededRng(snapshot.seed, snapshot.state);
  }

  /** Derives an independent stream from the original seed, not the current cursor. */
  derive(label: string): SeededRng {
    return new SeededRng(`${this.seed}:${label}`);
  }
}

export function createRng(seed: string): SeededRng {
  return new SeededRng(seed);
}

export function deriveRng(seed: string, stream: string): SeededRng {
  return new SeededRng(`${seed}:${stream}`);
}
