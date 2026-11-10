// Port of MaxGodotFrame 0.3.0 RandomStream.cs (AnonNetizen, MIT).
// Algorithm: xoshiro256starstar-splitmix64-v1. See THIRD_PARTY_NOTICES.md.
const MASK = (1n << 64n) - 1n;
const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (64n - k))) & MASK;
export class RandomStream {
  #a: bigint;
  #b: bigint;
  #c: bigint;
  #d: bigint;
  constructor(seed: bigint) {
    const split = () => {
      seed = (seed + 0x9e3779b97f4a7c15n) & MASK;
      let z = seed;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
      return (z ^ (z >> 31n)) & MASK;
    };
    this.#a = split();
    this.#b = split();
    this.#c = split();
    this.#d = split();
  }
  nextUInt64(): bigint {
    const result = (rotl((this.#b * 5n) & MASK, 7n) * 9n) & MASK;
    const shift = (this.#b << 17n) & MASK;
    this.#c ^= this.#a;
    this.#d ^= this.#b;
    this.#b ^= this.#c;
    this.#a ^= this.#d;
    this.#c ^= shift;
    this.#d = rotl(this.#d, 45n);
    return result;
  }
  nextInt(bound: number): number {
    if (!Number.isSafeInteger(bound) || bound <= 0)
      throw new Error("random_bound");
    const b = BigInt(bound),
      threshold = (-b & MASK) % b;
    let sample: bigint;
    do {
      sample = this.nextUInt64();
    } while (sample < threshold);
    return Number(sample % b);
  }
}
