import { clone, type CompanionDisplay, type PlatformSnapshot } from "./sdk.js";
import type { CompanionAdapter, CompanionReaction } from "./companion.js";
import { CompanionError } from "./companion.js";
import { CompanionFocus } from "./companion-focus.js";

/** Best-effort presentation, deliberately separate from rules, model scheduling and durable chat. */
export class CompanionEffects {
  #selected: CompanionDisplay | null = null;
  #queue: {
    ref: CompanionDisplay;
    reaction: CompanionReaction;
    generation: number;
  }[] = [];
  #generation = 0;
  #running: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #state: NonNullable<PlatformSnapshot["companionFeedback"]> = {
    state: "idle",
    message: "",
  };
  readonly focus: CompanionFocus;
  constructor(
    private adapter: CompanionAdapter,
    private changed: () => void,
  ) {
    this.focus = new CompanionFocus(adapter, changed);
  }
  snapshot() {
    return clone(this.#state);
  }
  #update(state: NonNullable<PlatformSnapshot["companionFeedback"]>) {
    this.#state = state;
    this.changed();
  }
  async select(ref: CompanionDisplay | null) {
    this.#generation++;
    this.#abort?.abort();
    this.#queue = [];
    this.#selected = clone(ref);
    this.#update({ state: "idle", message: "" });
    // A lobby bubble may still own its short lease. Finish that cleanup before
    // the next game acquires a persistent lease for the same pet.
    await Promise.all([this.focus.stop(), this.settled()]);
  }
  emit(ref: CompanionDisplay, reaction: CompanionReaction) {
    if (ref.key !== this.#selected?.key) return;
    if (!this.adapter.present) {
      this.#update({
        state: "error",
        message: "当前伙伴适配器尚未支持桌宠表现同步。",
      });
      if (["win", "loss", "draw"].includes(reaction.kind))
        this.focus.finishSoon();
      return;
    }
    // Rapid chat updates coalesce in the bubble; connection/results keep their own gesture.
    if (reaction.kind === "chat")
      this.#queue = this.#queue.filter((j) => j.reaction.kind !== "chat");
    if (this.#queue.length >= 8) this.#queue.shift();
    this.#queue.push({
      ref: clone(ref),
      reaction: clone(reaction),
      generation: this.#generation,
    });
    this.#update({ state: "pending", message: "正在同步桌宠反应…" });
    this.#pump();
  }
  #pump() {
    if (this.#running) return;
    this.#running = this.#drain().finally(() => {
      this.#running = null;
      if (this.#queue.length) this.#pump();
    });
  }
  async #drain() {
    while (this.#queue.length) {
      const job = this.#queue.shift()!;
      const abort = (this.#abort = new AbortController());
      try {
        await this.focus.ready();
        if (job.generation !== this.#generation) continue;
        const lease = this.focus.lease(job.ref);
        if (this.focus.wanted(job.ref) && !lease)
          throw new CompanionError(
            "专心陪玩已暂停，请点击恢复。",
            false,
            "lock-lost",
          );
        const result = await this.adapter.present!(
          job.ref,
          job.reaction,
          abort.signal,
          lease,
        );
        if (job.generation === this.#generation)
          this.#update({
            state: "sent",
            message: result.animation
              ? "气泡已同步，动作已请求"
              : "气泡已同步到桌宠",
            animation: result.animation,
          });
      } catch (e) {
        if (
          job.generation === this.#generation &&
          this.focus.wanted(job.ref) &&
          e instanceof CompanionError &&
          [
            "lock-lost",
            "lock-required",
            "unknown-pet",
            "pet-not-displayed",
          ].includes(e.reason ?? "")
        )
          await this.focus.interrupted(e);
        if (job.generation === this.#generation)
          this.#update({
            state: "error",
            message:
              e instanceof Error
                ? e.message
                : "桌宠表现同步失败，可测试反应重试。",
          });
      } finally {
        if (this.#abort === abort) this.#abort = null;
        if (
          job.generation === this.#generation &&
          ["win", "loss", "draw"].includes(job.reaction.kind)
        )
          this.focus.finishSoon();
      }
    }
  }
  async settled() {
    while (this.#running) await this.#running;
  }
  async dispose() {
    await this.select(null);
    await this.settled();
  }
}
