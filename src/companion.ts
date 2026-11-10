import {
  clone,
  type CompanionDisplay,
  type CompanionPreview,
  type CompanionRef,
  type CompanionTurn,
} from "./sdk.js";

export const PERSONA_BYTES = 8 * 1024;
export const COMPANION_MEMORY_BYTES = 4 * 1024;
export const companionKey = (ref: CompanionRef) =>
  JSON.stringify(["dsh_pet", ref.entry, ref.petId]);
export class CompanionError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
    readonly reason?: string,
  ) {
    super(message);
  }
}
export interface PetReply {
  text: string;
}
export interface CompanionReaction {
  kind: "connected" | "chat" | "win" | "loss" | "draw";
  text: string;
  reduceMotion: boolean;
}
/** Host-only credential; never include in SDK observations or model messages. */
export interface CompanionLease {
  lockId: string;
  expiresAt: number;
}
export interface CompanionAdapter {
  list(): Promise<CompanionDisplay[]>;
  preview(ref: CompanionRef): Promise<CompanionPreview>;
  send(
    ref: CompanionRef,
    text: string,
    signal?: AbortSignal,
  ): Promise<PetReply>;
  findReceipt(ref: CompanionRef, text: string): Promise<PetReply | null>;
  present?(
    ref: CompanionRef,
    reaction: CompanionReaction,
    signal: AbortSignal,
    lease?: CompanionLease,
  ): Promise<{ animation: string | null }>;
  focus?(
    ref: CompanionRef,
    lockId: string | undefined,
    reduceMotion: boolean,
    signal: AbortSignal,
  ): Promise<CompanionLease>;
  releaseFocus?(ref: CompanionRef, lease: CompanionLease): Promise<void>;
}
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/** Only the current Host supplies the origin. No client URL, credential or filesystem access. */
export class DshPetAdapter implements CompanionAdapter {
  constructor(private readonly origin: () => string) {}
  async #request(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    let base: URL;
    try {
      base = new URL(this.origin());
    } catch {
      throw new CompanionError("同一 DSH Host 的桌宠服务尚未就绪。");
    }
    if (
      !["http:", "https:"].includes(base.protocol) ||
      !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)
    )
      throw new CompanionError("伙伴联动需要本机 DSH 服务。");
    const deadline = AbortSignal.timeout(method === "POST" ? 90000 : 10000);
    let response: Response;
    try {
      response = await fetch(new URL("/dsh-pet-7340/" + path, base), {
        method,
        redirect: "error",
        headers:
          body === undefined
            ? undefined
            : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
      });
    } catch {
      throw new CompanionError(
        "桌宠服务连接中断，请检查 dsh-pet 是否在同一 Host 启用。",
        method === "POST",
      );
    }
    if (!response.ok)
      throw new CompanionError(
        response.status === 404
          ? "未找到 dsh-pet 接口，请启用兼容版本的插件。"
          : `桌宠接口返回 HTTP ${response.status}。`,
        method === "POST",
      );
    let raw = "";
    try {
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let size = 0;
      const responseLimit = path.startsWith("chat?")
        ? 8 * 1024 * 1024
        : 1024 * 1024;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > responseLimit) {
          await reader.cancel();
          throw Error();
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      const value = JSON.parse(raw);
      if (!record(value)) throw Error();
      if (value.ok === false) {
        const labels: Record<string, string> = {
          "unknown-pet": "所选桌宠已不存在。",
          "provider-missing": "桌宠聊天模型不可用。",
          "surface-unavailable": "桌宠当前未显示，请在 dsh-pet 中启用显示。",
          "pet-not-displayed": "桌宠当前未显示，请在 dsh-pet 中启用显示。",
          "generate-error": "桌宠生成或保存回复失败。",
          "pet-hidden": "桌宠当前未显示，请在 dsh-pet 中启用显示。",
          locked: "桌宠正被其他互动占用，稍后可测试反应。",
          "lock-required": "桌宠正被其他互动占用，稍后可测试反应。",
          "lock-lost": "桌宠互动已被用户接管，本次表现已停止。",
          "unknown-animation": "桌宠当前动画配置不可用。",
        };
        throw new CompanionError(
          labels[value.reason] ?? "桌宠拒绝了本次操作，请检查其状态。",
          false,
          typeof value.reason === "string" ? value.reason : undefined,
        );
      }
      return value;
    } catch (e) {
      if (e instanceof CompanionError) throw e;
      throw new CompanionError(
        "桌宠接口响应不完整或不兼容。",
        method === "POST",
      );
    }
  }
  async #config(signal?: AbortSignal) {
    const cfg = await this.#request("config", "GET", undefined, signal);
    if (!Object.values(cfg).some((v) => record(v) && Array.isArray(v.pets)))
      throw new CompanionError("dsh-pet 配置接口不兼容。");
    return cfg as Record<string, Record<string, any>>;
  }
  #resolve(cfg: Record<string, Record<string, any>>, ref: CompanionRef) {
    if (
      !record(ref) ||
      typeof ref.entry !== "string" ||
      typeof ref.petId !== "string" ||
      !ref.petId
    )
      throw new CompanionError("请选择具体桌宠。");
    const conf = cfg[ref.entry],
      pet = Array.isArray(conf?.pets)
        ? conf.pets.find((p: any) => record(p) && p.id === ref.petId)
        : undefined;
    if (!pet) throw new CompanionError("所选桌宠已不存在，请重新选择。");
    return {
      conf,
      pet,
      display: {
        ...ref,
        key: companionKey(ref),
        name:
          typeof pet.name === "string" && pet.name.trim()
            ? pet.name
            : ref.petId,
        kind: "dsh_pet" as const,
      },
    };
  }
  async list() {
    const cfg = await this.#config(),
      out: CompanionDisplay[] = [];
    for (const [entry, conf] of Object.entries(cfg))
      for (const p of Array.isArray(conf.pets) ? conf.pets : []) {
        if (record(p) && typeof p.id === "string" && p.id)
          out.push(this.#resolve(cfg, { entry, petId: p.id }).display);
      }
    return clone(out);
  }
  async preview(ref: CompanionRef): Promise<CompanionPreview> {
    const { conf, pet, display } = this.#resolve(await this.#config(), ref);
    const persona =
      typeof pet.whisperPrompt === "string" && pet.whisperPrompt.trim()
        ? pet.whisperPrompt
        : typeof conf.whisperPrompt === "string"
          ? conf.whisperPrompt
          : "";
    const configuredRounds =
      Number.isFinite(conf.chatMemoryRounds) && conf.chatMemoryRounds >= 0
        ? Math.floor(conf.chatMemoryRounds)
        : 5;
    const rounds = Math.min(10, configuredRounds);
    const data =
      rounds === 0
        ? { messages: [] }
        : await this.#request(
            `chat?pet=${encodeURIComponent(ref.petId)}&rounds=${rounds}`,
          );
    if (!Array.isArray(data.messages))
      throw new CompanionError("桌宠聊天记忆接口不兼容。");
    const turns: CompanionTurn[] = [];
    for (let i = 0; i + 1 < data.messages.length; i++) {
      const a = data.messages[i],
        b = data.messages[i + 1];
      if (
        record(a) &&
        record(b) &&
        a.role === "user" &&
        b.role === "assistant" &&
        typeof a.content === "string" &&
        typeof b.content === "string" &&
        Number.isFinite(a.ts) &&
        a.ts === b.ts
      ) {
        turns.push(
          { role: "user", content: a.content, ts: a.ts },
          { role: "assistant", content: b.content, ts: b.ts },
        );
        i++;
      }
    }
    while (turns.length > rounds * 2 || bytes(turns) > COMPANION_MEMORY_BYTES)
      turns.splice(0, 2);
    return {
      display,
      persona,
      turns,
      configuredRounds,
      loadedRounds: turns.length / 2,
      omitted: configuredRounds > 10 || turns.length < data.messages.length,
      personaBytes: Buffer.byteLength(persona, "utf8"),
      memoryBytes: bytes(turns),
    };
  }
  async send(
    ref: CompanionRef,
    text: string,
    signal?: AbortSignal,
  ): Promise<PetReply> {
    this.#resolve(await this.#config(), ref);
    const reply = await this.#request(
      `chat?pet=${encodeURIComponent(ref.petId)}&surface=any`,
      "POST",
      { text },
      signal,
    );
    if (reply.ok !== true || typeof reply.text !== "string")
      throw new CompanionError("桌宠回执不完整，请核对记录。", true);
    return { text: reply.text };
  }
  async findReceipt(ref: CompanionRef, text: string): Promise<PetReply | null> {
    this.#resolve(await this.#config(), ref);
    const data = await this.#request(
      `chat?pet=${encodeURIComponent(ref.petId)}&rounds=200`,
    );
    if (!Array.isArray(data.messages))
      throw new CompanionError("桌宠记忆接口不兼容。");
    for (let i = 0; i + 1 < data.messages.length; i++) {
      const a = data.messages[i],
        b = data.messages[i + 1];
      if (
        a?.role === "user" &&
        a.content === text &&
        b?.role === "assistant" &&
        typeof b.content === "string" &&
        a.ts === b.ts
      )
        return { text: b.content };
    }
    return null;
  }
  async present(
    ref: CompanionRef,
    reaction: CompanionReaction,
    signal: AbortSignal,
    borrowedLease?: CompanionLease,
  ) {
    // No model calls, native chat writes, asset URLs or arbitrary animation names.
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
    const { conf } = this.#resolve(await this.#config(timeout), ref);
    const state = await this.#request("state", "GET", undefined, timeout);
    if (!record(state.pets)) throw new CompanionError("桌宠状态接口不兼容。");
    if (state.pets[ref.petId]?.sleep?.data?.sleeping === true)
      throw new CompanionError("桌宠正在休息；唤醒后可测试反应。");
    timeout.throwIfAborted();
    const pet = encodeURIComponent(ref.petId);
    const lease =
      borrowedLease ??
      (await this.#request(
        `lock?pet=${pet}&surface=any`,
        "POST",
        { ttl: 4000 },
        timeout,
      ));
    if (typeof lease.lockId !== "string" || !lease.lockId)
      throw new CompanionError("桌宠互动占用接口不兼容。");
    const suffix = `pet=${pet}&surface=any&lock=${encodeURIComponent(lease.lockId)}`;
    try {
      await this.#request(
        `broadcast?${suffix}`,
        "POST",
        { text: reaction.text, duration: 10000, anim: false, speak: false },
        timeout,
      );
      let animation: string | null = null;
      if (!reaction.reduceMotion && reaction.kind !== "chat") {
        const a = record(conf.animations) ? conf.animations : {};
        const strings = (v: unknown): string[] =>
          Array.isArray(v)
            ? v.filter((s): s is string => typeof s === "string" && !!s)
            : typeof v === "string" && v
              ? [v]
              : [];
        const clicks = strings(a.clicks);
        const event =
          record(a.events) && Array.isArray(a.events.workStatus)
            ? a.events.workStatus
            : [];
        animation =
          (reaction.kind === "win"
            ? strings(event[4])[0]
            : reaction.kind === "loss"
              ? strings(event[5])[0]
              : undefined) ??
          clicks.find((n) => /挥手|招手|greet|wave/i.test(n)) ??
          clicks[0] ??
          null;
        if (animation)
          await this.#request(
            `anim?${suffix}`,
            "POST",
            { name: animation },
            timeout,
          );
      }
      return { animation };
    } finally {
      // Release only our lease, including cancellation; never clear another owner's bubble.
      if (!borrowedLease)
        await this.#request(
          `lock/release?pet=${pet}`,
          "POST",
          { lockId: lease.lockId },
          AbortSignal.timeout(2000),
        ).catch(() => {});
    }
  }
  async focus(
    ref: CompanionRef,
    lockId: string | undefined,
    reduceMotion: boolean,
    signal: AbortSignal,
  ): Promise<CompanionLease> {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
    const { conf } = this.#resolve(await this.#config(timeout), ref);
    if (!lockId) {
      const state = await this.#request("state", "GET", undefined, timeout);
      if (!record(state.pets)) throw new CompanionError("桌宠状态接口不兼容。");
      if (state.pets[ref.petId]?.sleep?.data?.sleeping === true)
        throw new CompanionError("桌宠正在休息；唤醒后可恢复专心陪玩。");
    }
    const pet = encodeURIComponent(ref.petId);
    const lease = await this.#request(
      `lock?pet=${pet}&surface=any`,
      "POST",
      { ttl: 15000, ...(lockId ? { lockId } : {}) },
      timeout,
    );
    if (
      typeof lease.lockId !== "string" ||
      !lease.lockId ||
      !Number.isFinite(lease.expiresAt) ||
      lease.expiresAt <= Date.now()
    )
      throw new CompanionError("桌宠专心陪玩接口不兼容。");
    // Start from a quiet pose instead of freezing a random snack/walk frame.
    try {
      const idle =
        record(conf.animations) && Array.isArray(conf.animations.idle)
          ? conf.animations.idle.find(
              (v: unknown) => typeof v === "string" && !!v,
            )
          : null;
      if (!lockId && !reduceMotion && idle)
        await this.#request(
          `anim?pet=${pet}&surface=any&lock=${encodeURIComponent(lease.lockId)}`,
          "POST",
          { name: idle },
          timeout,
        );
    } catch (e) {
      await this.releaseFocus(ref, lease).catch(() => {});
      throw e;
    }
    return { lockId: lease.lockId, expiresAt: lease.expiresAt };
  }
  async releaseFocus(ref: CompanionRef, lease: CompanionLease) {
    await this.#request(
      `lock/release?pet=${encodeURIComponent(ref.petId)}`,
      "POST",
      { lockId: lease.lockId },
      AbortSignal.timeout(2000),
    );
  }
}
