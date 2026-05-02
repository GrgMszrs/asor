"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Payload = Record<string, unknown>;

type Event = {
  run_id: string;
  seq: number;
  kind: string;
  payload?: Payload;
  at: string;
};

type Run = {
  id: string;
  task_id: string;
  status: string;
  started_at?: string | null;
  finished_at?: string | null;
  final_text?: string | null;
  invocation: { model?: string | null };
};

type ChatMsg =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string; streaming: boolean }
  | { kind: "tool"; toolName: string; args: string; result?: string }
  | { kind: "error"; content: string };

type Todo = { content: string; status: string };

const EVENT_KINDS = [
  "init",
  "message",
  "tool_use",
  "tool_result",
  "error",
  "result",
  "status",
] as const;

function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function getStr(p: Payload | undefined, ...keys: string[]): string | undefined {
  if (!p) return undefined;
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function getObj(p: Payload | undefined, ...keys: string[]): Payload | undefined {
  if (!p) return undefined;
  for (const k of keys) {
    const v = p[k];
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Payload;
  }
  return undefined;
}

function deriveChat(events: Event[], runFinished: boolean): ChatMsg[] {
  const msgs: ChatMsg[] = [];
  const toolCallsByName: Record<string, ChatMsg & { kind: "tool" }> = {};

  for (const e of events) {
    if (e.kind === "message") {
      const role = getStr(e.payload, "role") ?? "assistant";
      const content = getStr(e.payload, "content") ?? "";
      const isDelta = e.payload?.delta === true;

      if (role === "user") {
        msgs.push({ kind: "user", content });
        continue;
      }

      const last = msgs[msgs.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        last.content += content;
        if (!isDelta) last.streaming = false;
      } else {
        msgs.push({ kind: "assistant", content, streaming: isDelta });
      }
    } else if (e.kind === "tool_use") {
      const toolName =
        getStr(e.payload, "name", "tool", "tool_name") ?? "tool";
      const argsObj =
        getObj(e.payload, "args", "input", "arguments", "params") ?? e.payload ?? {};
      const args = JSON.stringify(argsObj, null, 2);
      const tool: ChatMsg & { kind: "tool" } = { kind: "tool", toolName, args };
      msgs.push(tool);
      const toolId = getStr(e.payload, "id", "call_id", "tool_call_id");
      if (toolId) toolCallsByName[toolId] = tool;
    } else if (e.kind === "tool_result") {
      const toolId = getStr(e.payload, "id", "call_id", "tool_call_id");
      const result =
        getStr(e.payload, "output", "result", "content") ??
        asString(e.payload?.output ?? e.payload?.result ?? e.payload);
      if (toolId && toolCallsByName[toolId]) {
        toolCallsByName[toolId].result = result;
      } else {
        const lastTool = [...msgs].reverse().find((m) => m.kind === "tool") as
          | (ChatMsg & { kind: "tool" })
          | undefined;
        if (lastTool && !lastTool.result) lastTool.result = result;
      }
    } else if (e.kind === "error") {
      const msg =
        getStr(e.payload, "message", "error") ?? asString(e.payload);
      msgs.push({ kind: "error", content: msg });
    }
  }

  if (runFinished) {
    const last = msgs[msgs.length - 1];
    if (last && last.kind === "assistant") last.streaming = false;
  }

  return msgs;
}

function deriveTodos(events: Event[]): Todo[] {
  let latest: Todo[] = [];
  for (const e of events) {
    if (e.kind !== "tool_use") continue;
    const name = (getStr(e.payload, "name", "tool", "tool_name") ?? "").toLowerCase();
    if (!name.includes("todo")) continue;
    const args = getObj(e.payload, "args", "input", "arguments", "params") ?? e.payload;
    const items =
      (args?.todos as unknown) ??
      (args?.items as unknown) ??
      (args?.tasks as unknown);
    if (Array.isArray(items)) {
      latest = items.map((t: unknown) => {
        if (typeof t === "string") return { content: t, status: "pending" };
        const obj = t as Record<string, unknown>;
        return {
          content:
            (obj.content as string) ??
            (obj.text as string) ??
            (obj.task as string) ??
            JSON.stringify(t),
          status: (obj.status as string) ?? "pending",
        };
      });
    }
  }
  return latest;
}

function deriveStats(events: Event[]) {
  const init = events.find((e) => e.kind === "init")?.payload;
  const result = events.find((e) => e.kind === "result")?.payload;
  const lastStatus = [...events].reverse().find((e) => e.kind === "status")?.payload;
  const stats = (getObj(result, "stats") ?? {}) as Record<string, unknown>;

  return {
    model:
      getStr(init, "model") ??
      getStr(lastStatus, "model") ??
      undefined,
    sessionId: getStr(init, "session_id"),
    status: getStr(lastStatus, "status"),
    exitCode:
      typeof lastStatus?.exit_code === "number"
        ? (lastStatus.exit_code as number)
        : undefined,
    totalTokens:
      typeof stats.total_tokens === "number"
        ? (stats.total_tokens as number)
        : undefined,
    inputTokens:
      typeof stats.input_tokens === "number"
        ? (stats.input_tokens as number)
        : undefined,
    outputTokens:
      typeof stats.output_tokens === "number"
        ? (stats.output_tokens as number)
        : undefined,
    durationMs:
      typeof stats.duration_ms === "number"
        ? (stats.duration_ms as number)
        : undefined,
    toolCalls:
      typeof stats.tool_calls === "number"
        ? (stats.tool_calls as number)
        : undefined,
  };
}

function relTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return d.toLocaleString();
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      const r = await fetch("/api/runs", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as Run[];
      data.sort((a, b) =>
        (b.started_at ?? "").localeCompare(a.started_at ?? "")
      );
      setRuns(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const loadRun = useCallback(
    async (id: string) => {
      closeStream();
      setBusy(false);
      setActiveRunId(id);
      setEvents([]);
      try {
        const [runRes, evRes] = await Promise.all([
          fetch(`/api/runs/${id}`, { cache: "no-store" }),
          fetch(`/api/runs/${id}/events.json`, { cache: "no-store" }),
        ]);
        if (runRes.ok) setActiveRun((await runRes.json()) as Run);
        if (evRes.ok) setEvents((await evRes.json()) as Event[]);
      } catch {
        // ignore
      }
    },
    [closeStream]
  );

  const submit = useCallback(async () => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setEvents([]);
    setActiveRun(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: p }),
      });
      const { run_id } = (await res.json()) as { run_id: string };
      setActiveRunId(run_id);
      void refreshRuns();

      closeStream();
      const es = new EventSource(`/api/runs/${run_id}/events`);
      esRef.current = es;
      const onEvent = (e: MessageEvent) => {
        try {
          const ev = JSON.parse(e.data) as Event;
          setEvents((prev) => [...prev, ev]);
          const status =
            ev.kind === "status" ? (ev.payload?.status as string) : undefined;
          if (status === "succeeded" || status === "failed") {
            es.close();
            setBusy(false);
            void refreshRuns();
            void fetch(`/api/runs/${run_id}`, { cache: "no-store" }).then(
              async (r) => {
                if (r.ok) setActiveRun((await r.json()) as Run);
              }
            );
          }
        } catch {
          // ignore parse errors
        }
      };
      EVENT_KINDS.forEach((k) =>
        es.addEventListener(k, onEvent as EventListener)
      );
      es.onerror = () => {
        es.close();
        setBusy(false);
      };
    } catch {
      setBusy(false);
    }
  }, [prompt, busy, closeStream, refreshRuns]);

  const runFinished = useMemo(() => {
    const s = activeRun?.status;
    return s === "succeeded" || s === "failed" || s === "cancelled";
  }, [activeRun?.status]);

  const chat = useMemo(
    () => deriveChat(events, runFinished),
    [events, runFinished]
  );
  const todos = useMemo(() => deriveTodos(events), [events]);
  const stats = useMemo(() => deriveStats(events), [events]);

  return (
    <main className="grid grid-cols-12 gap-3 p-3 h-screen max-h-screen overflow-hidden">
      <aside className="col-span-3 bg-neutral-900 border border-neutral-800 rounded-lg flex flex-col overflow-hidden">
        <div className="p-3 border-b border-neutral-800 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold leading-tight">asor</h1>
            <p className="text-[10px] text-neutral-500 uppercase tracking-wide">
              Gemini CLI orchestrator
            </p>
          </div>
          <button
            onClick={() => void refreshRuns()}
            className="text-[11px] text-neutral-400 hover:text-neutral-100"
          >
            ↻ refresh
          </button>
        </div>
        <div className="p-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
            Runs ({runs.length})
          </h2>
        </div>
        <ul className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
          {runs.length === 0 && (
            <li className="text-[11px] text-neutral-500 px-2">no runs yet</li>
          )}
          {runs.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => void loadRun(r.id)}
                className={`w-full text-left text-[11px] px-2 py-1.5 rounded transition-colors ${
                  activeRunId === r.id
                    ? "bg-indigo-700/25 border border-indigo-700/60"
                    : "hover:bg-neutral-800 border border-transparent"
                }`}
              >
                <div className="flex items-center gap-2">
                  <StatusDot status={r.status} />
                  <span className="font-mono text-neutral-300">
                    {r.id.slice(0, 8)}
                  </span>
                  <span className="ml-auto text-neutral-500 text-[10px] truncate">
                    {r.invocation?.model?.replace(/^gemini-/, "g-") ?? "—"}
                  </span>
                </div>
                <div className="text-neutral-500 mt-0.5">
                  {relTime(r.started_at)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="col-span-6 flex flex-col gap-3 overflow-hidden">
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3">
          <textarea
            className="w-full h-20 rounded-md bg-neutral-950 border border-neutral-800 p-2 text-sm focus:outline-none focus:border-indigo-500 resize-none"
            placeholder="Describe a task — ⌘/Ctrl + Enter to submit"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={() => void submit()}
              disabled={busy || !prompt.trim()}
              className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium"
            >
              {busy ? "Running…" : "Run"}
            </button>
            {activeRunId && (
              <span className="text-[11px] text-neutral-500 font-mono">
                run {activeRunId.slice(0, 8)} · {activeRun?.status ?? "—"}
              </span>
            )}
          </div>
        </div>

        <div
          ref={chatScrollRef}
          className="flex-1 bg-neutral-900 border border-neutral-800 rounded-lg p-4 overflow-y-auto"
        >
          {chat.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-xs text-neutral-500">
                Submit a prompt or pick a past run.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {chat.map((m, i) => (
                <ChatBubble key={i} msg={m} />
              ))}
              {busy &&
                chat[chat.length - 1]?.kind !== "assistant" && <TypingDots />}
            </div>
          )}
        </div>
      </section>

      <aside className="col-span-3 flex flex-col gap-3 overflow-hidden">
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
            Run details
          </h2>
          <Stat
            label="Status"
            value={stats.status ?? activeRun?.status ?? "—"}
          />
          <Stat
            label="Model"
            value={stats.model ?? activeRun?.invocation?.model ?? "—"}
            mono
          />
          <Stat
            label="Session"
            value={stats.sessionId?.slice(0, 8) ?? "—"}
            mono
          />
          <Stat
            label="Tokens"
            value={
              stats.totalTokens != null
                ? `${stats.totalTokens} (in ${stats.inputTokens ?? "?"}, out ${
                    stats.outputTokens ?? "?"
                  })`
                : "—"
            }
          />
          <Stat
            label="Duration"
            value={
              stats.durationMs != null
                ? `${(stats.durationMs / 1000).toFixed(1)}s`
                : "—"
            }
          />
          <Stat label="Tool calls" value={stats.toolCalls ?? 0} />
          <Stat
            label="Exit code"
            value={stats.exitCode == null ? "—" : stats.exitCode}
          />
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 overflow-y-auto">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
            Agent todos {todos.length > 0 && `(${todos.length})`}
          </h2>
          {todos.length === 0 ? (
            <p className="text-[11px] text-neutral-500">
              The agent hasn&apos;t planned any sub-tasks yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {todos.map((t, i) => (
                <li key={i} className="flex items-start gap-2 text-[12px]">
                  <TodoIcon status={t.status} />
                  <span
                    className={
                      t.status === "completed"
                        ? "line-through text-neutral-500"
                        : "text-neutral-200"
                    }
                  >
                    {t.content}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 overflow-y-auto flex-1 min-h-0">
          <button
            onClick={() => setShowRaw((s) => !s)}
            className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-2 flex items-center gap-1.5 hover:text-neutral-300"
          >
            {showRaw ? "▼" : "▶"} Raw events ({events.length})
          </button>
          {showRaw && (
            <ol className="space-y-1 text-[10px] font-mono">
              {events.map((e, i) => (
                <li
                  key={i}
                  className="border border-neutral-800 rounded px-1.5 py-1 bg-neutral-950"
                >
                  <span className="text-indigo-400">{e.kind}</span>{" "}
                  <span className="text-neutral-400 break-all">
                    {asString(e.payload).slice(0, 140)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </aside>
    </main>
  );
}

function ChatBubble({ msg }: { msg: ChatMsg }) {
  if (msg.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-indigo-600 px-3 py-2 text-sm whitespace-pre-wrap">
          {msg.content}
        </div>
      </div>
    );
  }
  if (msg.kind === "tool") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-amber-500/80 mb-1 font-semibold">
            tool call · {msg.toolName}
          </div>
          <pre className="text-[11px] text-amber-100/80 whitespace-pre-wrap font-mono leading-snug">
            {msg.args.length > 600 ? msg.args.slice(0, 600) + "…" : msg.args}
          </pre>
          {msg.result && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-emerald-500/80 mt-2 mb-1 font-semibold">
                result
              </div>
              <pre className="text-[11px] text-emerald-100/70 whitespace-pre-wrap font-mono leading-snug">
                {msg.result.length > 600
                  ? msg.result.slice(0, 600) + "…"
                  : msg.result}
              </pre>
            </>
          )}
        </div>
      </div>
    );
  }
  if (msg.kind === "error") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-[12px] text-red-200 whitespace-pre-wrap">
          {msg.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-neutral-800 px-3 py-2 text-sm whitespace-pre-wrap">
        {msg.content}
        {msg.streaming && (
          <span className="inline-block w-1.5 h-3.5 bg-neutral-300 ml-1 align-middle animate-pulse" />
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between text-[11px] py-0.5 gap-2">
      <span className="text-neutral-500 shrink-0">{label}</span>
      <span
        className={`text-neutral-200 truncate text-right ${mono ? "font-mono" : ""}`}
      >
        {value === undefined || value === null || value === "" ? "—" : value}
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "succeeded"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "running"
          ? "bg-indigo-500 animate-pulse"
          : "bg-neutral-500";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />;
}

function TodoIcon({ status }: { status: string }) {
  if (status === "completed")
    return <span className="text-emerald-500 leading-none">✓</span>;
  if (status === "in_progress")
    return <span className="text-indigo-400 leading-none">●</span>;
  return <span className="text-neutral-500 leading-none">○</span>;
}

function TypingDots() {
  return (
    <div className="flex justify-start">
      <div className="rounded-2xl rounded-tl-sm bg-neutral-800 px-3 py-2">
        <span className="inline-flex gap-1 items-center">
          <span
            className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-bounce"
            style={{ animationDelay: "0ms" }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-bounce"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-bounce"
            style={{ animationDelay: "300ms" }}
          />
        </span>
      </div>
    </div>
  );
}
