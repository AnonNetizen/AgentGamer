import { clone, type CompanionDisplay, type PlatformSnapshot } from "./sdk.js";
import {
  CompanionError,
  type CompanionAdapter,
  type CompanionLease,
} from "./companion.js";

/** A renewable game-only lease. Losing ownership never silently acquires another lock. */
export class CompanionFocus {
  #target: CompanionDisplay | null = null;
  #held: { ref: CompanionDisplay; lease: CompanionLease } | null = null;
  #epoch = 0;
  #tail: Promise<void> = Promise.resolve();
  #abort: AbortController | null = null;
  #heartbeat: ReturnType<typeof setTimeout> | undefined;
  #finish: ReturnType<typeof setTimeout> | undefined;
  #state: NonNullable<PlatformSnapshot["companionFocus"]> = {
    state: "idle",
    message: "",
  };
  constructor(
    private adapter: CompanionAdapter,
    private changed: () => void,
    private timing = { renewMs: 3000, finishMs: 1500 },
  ) {}
  snapshot() {
    return clone(this.#state);
  }
  wanted(ref: CompanionDisplay) {
    return this.#target?.key === ref.key;
  }
  lease(ref: CompanionDisplay) {
    return this.#held?.ref.key === ref.key &&
      this.#held.lease.expiresAt > Date.now()
      ? this.#held.lease
      : undefined;
  }
  #update(state: NonNullable<PlatformSnapshot["companionFocus"]>) {
    this.#state = state;
    this.changed();
  }
  #enqueue(job: () => Promise<void>) {
    this.#tail = this.#tail.then(job).catch(() => {});
    return this.#tail;
  }
  #clear() {
    clearTimeout(this.#heartbeat);
    clearTimeout(this.#finish);
    this.#heartbeat = undefined;
    this.#finish = undefined;
    this.#abort?.abort();
    this.#abort = null;
  }
  async #release() {
    const held = this.#held;
    this.#held = null;
    if (held)
      await this.adapter.releaseFocus?.(held.ref, held.lease).catch(() => {});
  }
  async start(ref: CompanionDisplay, reduceMotion: boolean) {
    const epoch = ++this.#epoch;
    this.#clear();
    this.#target = clone(ref);
    this.#update({ state: "starting", message: "正在准备专心陪玩…" });
    await this.#enqueue(async () => {
      await this.#release();
      if (epoch !== this.#epoch) return;
      if (!this.adapter.focus || !this.adapter.releaseFocus) {
        this.#target = null;
        this.#update({
          state: "error",
          message: "当前伙伴适配器尚未支持专心陪玩。",
        });
        return;
      }
      const abort = (this.#abort = new AbortController());
      try {
        const lease = await this.adapter.focus(
          ref,
          undefined,
          reduceMotion,
          abort.signal,
        );
        if (epoch !== this.#epoch) {
          await this.adapter.releaseFocus(ref, lease).catch(() => {});
          return;
        }
        this.#held = { ref: clone(ref), lease };
        this.#update({
          state: "focused",
          message: "正在专心陪玩，日常动作已暂停",
        });
        this.#schedule(epoch, reduceMotion);
      } catch (e) {
        if (epoch === this.#epoch) await this.#failed(e, epoch);
      } finally {
        if (this.#abort === abort) this.#abort = null;
      }
    });
  }
  #schedule(epoch: number, reduceMotion: boolean) {
    this.#heartbeat = setTimeout(() => {
      this.#heartbeat = undefined;
      void this.#enqueue(async () => {
        const held = this.#held;
        if (!held || epoch !== this.#epoch) return;
        const abort = (this.#abort = new AbortController());
        try {
          const lease = await this.adapter.focus!(
            held.ref,
            held.lease.lockId,
            reduceMotion,
            abort.signal,
          );
          if (epoch !== this.#epoch) return;
          this.#held = { ref: held.ref, lease };
          this.#schedule(epoch, reduceMotion);
        } catch (e) {
          if (epoch === this.#epoch) await this.#failed(e, epoch);
        } finally {
          if (this.#abort === abort) this.#abort = null;
        }
      });
    }, this.timing.renewMs);
    this.#heartbeat.unref?.();
  }
  async #failed(e: unknown, epoch: number) {
    clearTimeout(this.#heartbeat);
    this.#heartbeat = undefined;
    await this.#release();
    if (epoch !== this.#epoch) return;
    const interrupted =
      e instanceof CompanionError &&
      [
        "lock-lost",
        "locked",
        "lock-required",
        "pet-not-displayed",
        "unknown-pet",
      ].includes(e.reason ?? "");
    this.#update({
      state: interrupted ? "interrupted" : "error",
      message: interrupted
        ? "桌宠已被接管或不可用；点击恢复专心陪玩"
        : "专心陪玩同步中断；点击恢复",
    });
  }
  interrupted(e: unknown) {
    const epoch = this.#epoch;
    return this.#enqueue(async () => {
      if (epoch === this.#epoch) await this.#failed(e, epoch);
    });
  }
  finishSoon() {
    clearTimeout(this.#finish);
    const epoch = this.#epoch;
    this.#finish = setTimeout(() => {
      if (epoch === this.#epoch) void this.stop();
    }, this.timing.finishMs);
    this.#finish.unref?.();
  }
  stop() {
    ++this.#epoch;
    this.#clear();
    this.#target = null;
    this.#update({ state: "idle", message: "" });
    return this.#enqueue(() => this.#release());
  }
  async ready() {
    await this.#tail;
  }
}
