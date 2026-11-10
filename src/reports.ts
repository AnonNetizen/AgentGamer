import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  clone,
  type CompanionDisplay,
  type GameMetadata,
  type Observation,
  type PublicReport,
  type ReportJob,
} from "./sdk.js";
import { CompanionError, type CompanionAdapter } from "./companion.js";

/** Only allowlisted public result fields enter a report, never an arbitrary game observation. */
export function makeReport(
  game: GameMetadata,
  observation: Observation,
  companion: CompanionDisplay,
): PublicReport | null {
  if (observation.phase !== "finished") return null;
  const id =
    "AG-" +
    createHash("sha256")
      .update(JSON.stringify([companion.key, observation.matchId]))
      .digest("hex")
      .slice(0, 24);
  const result =
    { win: "伙伴获胜", loss: "玩家获胜", draw: "平局" }[observation.outcome] ??
    "比赛完成";
  let details = "";
  const safeNumber = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v);
  if (game.id === "liars_dice") {
    const score = observation.score as { human?: number; agent?: number };
    if (safeNumber(score?.human) && safeNumber(score?.agent))
      details = `比分：玩家 ${score.human}，伙伴 ${score.agent}。`;
  } else if (game.id === "blackjack") {
    const self = observation.self as { balance?: number },
      opponent = observation.opponent as { balance?: number };
    if (safeNumber(self?.balance) && safeNumber(opponent?.balance))
      details = `最终筹码：伙伴 ${self.balance}（变化 ${self.balance! - 1000}），玩家 ${opponent.balance}（变化 ${opponent.balance! - 1000}）。`;
  }
  const createdAt = new Date().toISOString();
  const text = `AgentGamer 公开战报（${id}）\n游戏：${game.name.slice(0, 100)} v${game.version.slice(0, 32)}。${result}。${details}\n这是我们刚完成的比赛经历，请记住结果并简短回应。`;
  return {
    id,
    matchId: observation.matchId,
    gameId: game.id,
    gameName: game.name,
    companion: clone(companion),
    text,
    createdAt,
  };
}

/** Durable outbox. Only an explicit enqueue/retry may issue POST; startup never resends. */
export class ReportStore {
  #jobs = new Map<string, ReportJob>();
  #active = new Map<string, AbortController>();
  #writes: Promise<void> = Promise.resolve();
  #ready: Promise<void> | null = null;
  #closed = false;
  error = "";
  constructor(
    private readonly file: string,
    private readonly adapter: CompanionAdapter,
    private readonly changed: () => void,
    private readonly written: (job: ReportJob) => void,
    private readonly legacyFile?: string,
  ) {}
  list() {
    return clone([...this.#jobs.values()].reverse());
  }
  async ready() {
    this.#ready ??= this.#load();
    await this.#ready;
  }
  async #load() {
    try {
      let raw: string;
      let migrated = false;
      try {
        raw = await readFile(this.file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !this.legacyFile)
          throw e;
        raw = await readFile(this.legacyFile, "utf8");
        migrated = true;
      }
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.jobs)) throw Error();
      for (const job of data.jobs) {
        if (
          !job ||
          typeof job.id !== "string" ||
          typeof job.text !== "string" ||
          job.text.length > 2000 ||
          typeof job.companion?.key !== "string" ||
          !["queued", "sending", "written", "failed", "unknown"].includes(
            job.status,
          )
        )
          throw Error();
        if (job.status === "sending" || job.status === "queued") {
          job.status = "unknown";
          job.error = "上次发送未确认，请核对桌宠记录。";
        }
        this.#jobs.set(job.id, job);
      }
      // Copy acknowledged tasks exactly. Their text and IDs are native-chat receipt keys.
      if (migrated) await this.#save();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#jobs.clear();
        this.error =
          "战报队列无法读取；为避免重复发送，已停止写入，请保留原文件并检查。";
      }
    }
    this.changed();
  }
  async #save() {
    if (this.error) throw new Error(this.error);
    const data = JSON.stringify(
      { version: 1, jobs: [...this.#jobs.values()] },
      null,
      2,
    );
    const run = this.#writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + "." + randomUUID() + ".tmp";
      await writeFile(temp, data, "utf8");
      await rename(temp, this.file);
    });
    this.#writes = run.catch(() => {});
    await run;
  }
  async enqueue(report: PublicReport) {
    await this.ready();
    if (this.#closed) throw Error("战报服务已停止。");
    const old = this.#jobs.get(report.id);
    if (old) return clone(old);
    const job: ReportJob = { ...clone(report), status: "queued", error: "" };
    this.#jobs.set(job.id, job);
    try {
      await this.#save();
    } catch (e) {
      this.#jobs.delete(job.id);
      throw e;
    }
    this.changed();
    void this.#run(job);
    return clone(job);
  }
  async retry(id: string) {
    await this.ready();
    const job = this.#jobs.get(id);
    if (!job || job.status !== "failed" || this.#active.has(id))
      throw Error("这条战报当前不能重试；结果未知时请先核对记录。");
    job.status = "queued";
    job.error = "";
    await this.#save();
    this.changed();
    void this.#run(job);
    return clone(job);
  }
  async check(id: string) {
    await this.ready();
    const job = this.#jobs.get(id);
    if (!job) throw Error("没有这条战报。");
    if (job.status === "written" || this.#active.has(id)) return clone(job);
    try {
      const found = await this.adapter.findReceipt(job.companion, job.text);
      if (found) await this.#confirm(job, found.text);
      else {
        job.error =
          "近期桌宠记录中未找到确认；可稍后核对或复制战报，结果未知时不自动补发。";
        await this.#save();
        this.changed();
      }
    } catch (e) {
      job.error = e instanceof Error ? e.message : "核对失败。";
      await this.#save();
      this.changed();
    }
    return clone(job);
  }
  async #confirm(job: ReportJob, reply: string) {
    if (job.status === "written") return;
    job.status = "written";
    job.error = "";
    job.reply = reply;
    await this.#save();
    this.changed();
    if (!this.#closed) this.written(clone(job));
  }
  async #run(job: ReportJob) {
    if (this.#closed || this.#active.has(job.id)) return;
    const abort = new AbortController();
    this.#active.set(job.id, abort);
    try {
      // A failed response may still have followed a successful commit. Check before every retry.
      const receipt = await this.adapter.findReceipt(job.companion, job.text);
      if (this.#closed) return;
      if (receipt) {
        await this.#confirm(job, receipt.text);
        return;
      }
      job.status = "sending";
      await this.#save();
      this.changed();
      if (this.#closed) return;
      const reply = await this.adapter.send(
        job.companion,
        job.text,
        abort.signal,
      );
      await this.#confirm(job, reply.text);
    } catch (e) {
      if (job.status === "written") {
        this.error = "战报确认状态无法保存，请核对桌宠记录。";
        this.changed();
        return;
      }
      let found = null;
      if (!this.#closed && job.status === "sending") {
        try {
          found = await this.adapter.findReceipt(job.companion, job.text);
        } catch {}
      }
      if (found) {
        try {
          await this.#confirm(job, found.text);
        } catch {
          this.error = "战报确认状态无法保存，请保留队列文件。";
        }
      } else {
        job.status =
          this.#closed || (e instanceof CompanionError && e.uncertain)
            ? "unknown"
            : "failed";
        job.error = e instanceof Error ? e.message : "战报发送失败。";
        try {
          await this.#save();
        } catch {
          this.error = "战报队列保存失败，请核对桌宠记录，勿重复发送。";
        }
        this.changed();
      }
    } finally {
      this.#active.delete(job.id);
    }
  }
  async settled() {
    while (this.#active.size) await new Promise((r) => setTimeout(r, 2));
    await this.#writes;
  }
  async dispose() {
    this.#closed = true;
    for (const a of this.#active.values()) a.abort();
    await this.#writes;
  }
}
