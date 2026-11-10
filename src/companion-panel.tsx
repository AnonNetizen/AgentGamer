import React, { useEffect, useRef, useState } from "react";
import type { ClientStore } from "./client.js";
import type {
  CompanionDisplay,
  CompanionPreview,
  CompanionRef,
  PublicReport,
  ReportJob,
} from "./sdk.js";
const textBytes = (s: string) => new TextEncoder().encode(s).length;
const failure = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试。";

export function CompanionControls({
  store,
  petMode,
  setPetMode,
  busy,
  canConnect,
  connect,
}: {
  store: ClientStore;
  petMode: boolean;
  setPetMode(v: boolean): void;
  busy: boolean;
  canConnect: boolean;
  connect(ref: CompanionRef | null, override?: string): Promise<void>;
}) {
  const [pets, setPets] = useState<CompanionDisplay[]>([]),
    [selected, setSelected] = useState(store.snapshot?.companion?.key ?? "");
  const [preview, setPreview] = useState<CompanionPreview | null>(null),
    [persona, setPersona] = useState("");
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const guard = useRef(false);
  const refresh = async () => {
    if (guard.current) return;
    guard.current = true;
    setLoading(true);
    try {
      setPets(await store.request("companions"));
      setError("");
    } catch (e) {
      setPets([]);
      setError(failure(e));
    } finally {
      guard.current = false;
      setLoading(false);
    }
  };
  useEffect(() => {
    if (petMode) void refresh();
  }, [petMode]);
  useEffect(() => {
    void store
      .request("reports")
      .then(() => store.refresh())
      .catch((e) => setError(failure(e)));
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
      if (e.key !== "Tab") return;
      const controls = document.querySelectorAll<HTMLElement>(
        ".ag-companion-dialog button:not(:disabled),.ag-companion-dialog textarea",
      );
      const first = controls[0],
        last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  const pet = pets.find((p) => p.key === selected);
  const edited =
    preview?.display.key === selected && persona !== preview.persona;
  const tooLong =
    preview?.display.key === selected && textBytes(persona) > 8192;
  const showPreview = async () => {
    if (!pet || guard.current) return;
    guard.current = true;
    setLoading(true);
    try {
      const value = await store.request("companionPreview", {
        entry: pet.entry,
        petId: pet.petId,
      });
      setPreview(value);
      setPersona(value.persona);
      setOpen(true);
      setError("");
    } catch (e) {
      setError(failure(e));
    } finally {
      guard.current = false;
      setLoading(false);
    }
  };
  return (
    <section className="ag-companions" aria-label="陪玩伙伴">
      <div className="ag-companion-head">
        <strong>陪玩伙伴</strong>
        <div role="group" aria-label="对手类型">
          <button
            disabled={busy}
            aria-pressed={!petMode}
            onClick={() => setPetMode(false)}
          >
            普通对手
          </button>
          <button
            disabled={busy}
            aria-pressed={petMode}
            onClick={() => setPetMode(true)}
          >
            我的桌宠
          </button>
        </div>
        <small>当前：{store.snapshot?.companion?.name ?? "普通对手"}</small>
      </div>
      {petMode ? (
        <>
          <div className="ag-companion-select">
            <select
              aria-label="选择桌宠"
              value={selected}
              disabled={loading || busy}
              onChange={(e) => {
                setSelected(e.target.value);
                setPreview(null);
                setPersona("");
              }}
            >
              <option value="">请选择具体桌宠</option>
              {pets.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} · {p.entry} / {p.petId}
                </option>
              ))}
            </select>
            <button disabled={loading || busy} onClick={() => void refresh()}>
              {loading ? "正在读取…" : "刷新桌宠"}
            </button>
            <button
              disabled={!pet || loading || busy}
              onClick={() => void showPreview()}
            >
              预览接入资料
            </button>
            <button
              className="ag-primary"
              disabled={!pet || loading || busy || !canConnect || !!tooLong}
              onClick={() =>
                pet &&
                void connect(
                  { entry: pet.entry, petId: pet.petId },
                  edited ? persona : undefined,
                )
              }
            >
              连接桌宠
            </button>
          </div>
          <p className="ag-hint">
            使用上方对战模型与思考设置，载入所选桌宠的人设和近期聊天。资料会进入专用对战会话历史；每场开始重新读取。
          </p>
          {!!tooLong && (
            <p role="alert" className="ag-companion-error">
              人设超过 8 KiB，请在预览中精简陪玩副本后连接。
            </p>
          )}
          {error && (
            <p role="alert" className="ag-companion-error">
              {error}
            </p>
          )}
          {!loading && !error && !pets.length && (
            <p className="ag-hint">
              没有找到桌宠，请在同一 DSH Host 启用 dsh-pet 0.4.7。
            </p>
          )}
        </>
      ) : (
        store.snapshot?.companion && (
          <button
            disabled={!canConnect || busy}
            onClick={() => void connect(null)}
          >
            连接普通对手
          </button>
        )
      )}
      {open && preview && (
        <div className="ag-modal-mask">
          <section
            className="ag-modal ag-companion-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="伙伴接入资料"
          >
            <div className="ag-modal-title">
              <h2>{preview.display.name} · 接入资料</h2>
              <button
                autoFocus
                aria-label="关闭伙伴预览"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            <p className="ag-hint">
              只调整本次陪玩的副本，原桌宠配置保持原样。
            </p>
            <label>
              陪玩人设副本
              <textarea
                aria-label="陪玩人设副本"
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
              />
            </label>
            <div className="ag-persona-meta">
              <small className={tooLong ? "ag-companion-error" : ""}>
                {textBytes(persona).toLocaleString()} / 8,192 字节
              </small>
              <button
                className="ag-link"
                onClick={() => setPersona(preview.persona)}
              >
                使用桌宠原人设
              </button>
            </div>
            <h2>载入近聊 · {preview.loadedRounds} 轮</h2>
            <p className="ag-hint">
              桌宠配置 {preview.configuredRounds} 轮，本次最多 10 轮／4 KiB。
              {preview.omitted
                ? "部分较早或过长的完整问答已省略。"
                : preview.loadedRounds
                  ? ""
                  : "本次未载入聊天历史。"}
            </p>
            <div className="ag-companion-memory">
              {preview.turns.map((m, i) => (
                <p key={i}>
                  <strong>
                    {m.role === "user" ? "你" : preview.display.name}：
                  </strong>
                  {m.content}
                </p>
              ))}
            </div>
            <p className="ag-hint">
              这些近聊与近期游戏聊天、跨场摘要共享 12 KiB
              检查点；超限时按时间移除最旧的完整条目。
            </p>
            <button className="ag-primary" onClick={() => setOpen(false)}>
              完成预览
            </button>
          </section>
        </div>
      )}
    </section>
  );
}

const statusText: Record<ReportJob["status"], string> = {
  queued: "等待发送",
  sending: "发送中，等待桌宠确认",
  written: "已写入桌宠聊天记忆",
  failed: "发送失败，可重试",
  unknown: "结果未知，请核对记录",
};
export function ReportPanel({ store }: { store: ClientStore }) {
  const s = store.snapshot!,
    report = s.report,
    jobs = s.reportJobs ?? [];
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [copied, setCopied] = useState(false);
  const guard = useRef(false);
  const run = async (operation: string, id: string) => {
    if (guard.current) return;
    guard.current = true;
    setPending(true);
    try {
      await store.request(operation, { id });
      setError("");
      await store.refresh();
    } catch (e) {
      setError(failure(e));
    } finally {
      guard.current = false;
      setPending(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("复制失败，可在战报预览中选择文字复制。");
    }
  };
  const view = (r: PublicReport, job?: ReportJob) => (
    <article className="ag-report" key={r.id}>
      <div className="ag-report-title">
        <strong>告诉桌宠 · {r.companion.name}</strong>
        <small>{job ? statusText[job.status] : "尚未发送"}</small>
      </div>
      <small>
        目标：{r.companion.entry} / {r.companion.petId}
      </small>
      <details>
        <summary>公开战报预览</summary>
        <pre>{r.text}</pre>
      </details>
      <div className="ag-report-actions">
        {!job && (
          <button
            className="ag-primary"
            aria-label="告诉桌宠"
            disabled={pending}
            onClick={() => void run("shareResult", r.id)}
          >
            告诉桌宠
          </button>
        )}
        {job?.status === "failed" && (
          <button
            disabled={pending}
            onClick={() => void run("retryReport", r.id)}
          >
            重试发送
          </button>
        )}
        {job?.status === "unknown" && (
          <button
            disabled={pending}
            onClick={() => void run("checkReport", r.id)}
          >
            核对桌宠记录
          </button>
        )}
        {job?.status === "written" && (
          <span className="ag-badge">✓ 已确认</span>
        )}
        <button disabled={pending} onClick={() => void copy(r.text)}>
          {copied ? "已复制" : "复制战报"}
        </button>
      </div>
      <small>
        {job?.status === "unknown"
          ? "可能已经送达，请核对或复制战报，平台不会自动补发。"
          : "点击发送才会调用桌宠聊天模型，并将战报及回复保存到它的记忆。"}
      </small>
      {job?.error && <p className="ag-companion-error">{job.error}</p>}
      {job?.reply && (
        <details>
          <summary>桌宠的公开回复</summary>
          <pre>{job.reply}</pre>
        </details>
      )}
    </article>
  );
  if (!report && !jobs.length && !s.reportError) return null;
  return (
    <section className="ag-reports" aria-label="桌宠战报">
      {report &&
        view(
          report,
          jobs.find((j) => j.id === report.id),
        )}
      {jobs.some((j) => j.id !== report?.id) && (
        <details>
          <summary>
            战报任务（{jobs.filter((j) => j.id !== report?.id).length}）
          </summary>
          {jobs.filter((j) => j.id !== report?.id).map((j) => view(j, j))}
        </details>
      )}
      {(error || s.reportError) && (
        <p role="alert" className="ag-companion-error">
          {error || s.reportError}
        </p>
      )}
    </section>
  );
}
