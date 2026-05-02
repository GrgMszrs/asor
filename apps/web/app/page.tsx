"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  parent_run_id?: string | null;
  status: string;
  session_id?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  final_text?: string | null;
  invocation: { model?: string | null };
};

type ChatItem =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string; streaming: boolean }
  | { kind: "tool"; toolName: string; args: string; result?: string }
  | { kind: "error"; content: string }
  | { kind: "event"; eventKind: string; summary: string };

type Todo = { content: string; status: string };

type RightTab = "details" | "events";

const EVENT_KINDS = [
  "init",
  "message",
  "tool_use",
  "tool_result",
  "error",
  "result",
  "status",
] as const;

const EVENT_KIND_COLORS: Record<string, string> = {
  init: "text-sky-400 border-sky-900/60 bg-sky-950/30",
  message: "text-neutral-200 border-neutral-700 bg-neutral-900/60",
  tool_use: "text-amber-300 border-amber-900/60 bg-amber-950/30",
  tool_result: "text-emerald-300 border-emerald-900/60 bg-emerald-950/30",
  error: "text-red-300 border-red-900/60 bg-red-950/30",
  result: "text-violet-300 border-violet-900/60 bg-violet-950/30",
  status: "text-indigo-300 border-indigo-900/60 bg-indigo-950/30",
};

const STORAGE_KEY_RUN = "asor.activeRunId";
const STORAGE_KEY_SIDEBAR = "asor.sidebarWidth";

function apiEventUrl(runId: string): string {
  if (typeof window === "undefined") return `/api/runs/${runId}/events`;
  return `${window.location.protocol}//${window.location.hostname}:8000/runs/${runId}/events`;
}

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

function deriveChat(events: Event[], runFinished: boolean): ChatItem[] {
  const items: ChatItem[] = [];
  const toolCallsByName: Record<string, ChatItem & { kind: "tool" }> = {};
  const userMessages = new Set<string>();

  const pushOrMergeAssistant = (content: string, isDelta: boolean) => {
    const last = items[items.length - 1];
    if (last && last.kind === "assistant" && last.streaming) {
      last.content += content;
      if (!isDelta) last.streaming = false;
    } else if (last && last.kind === "assistant" && !last.streaming && isDelta) {
      last.content += content;
      last.streaming = true;
    } else {
      items.push({ kind: "assistant", content, streaming: isDelta });
    }
  };

  for (const e of events) {
    if (e.kind === "message") {
      const role = getStr(e.payload, "role") ?? "assistant";
      const content = getStr(e.payload, "content", "text") ?? "";
      const isDelta = e.payload?.delta === true;

      if (role === "user") {
        if (e.payload?.type === "message" && e.payload?.source !== "asor") {
          continue;
        }
        if (userMessages.has(content)) continue;
        userMessages.add(content);
        items.push({ kind: "user", content });
        continue;
      }
      pushOrMergeAssistant(content, isDelta);
    } else if (e.kind === "tool_use") {
      const toolName =
        getStr(e.payload, "name", "tool", "tool_name") ?? "tool";
      const argsObj =
        getObj(e.payload, "args", "input", "arguments", "params") ?? e.payload ?? {};
      const args = JSON.stringify(argsObj, null, 2);
      const tool: ChatItem & { kind: "tool" } = { kind: "tool", toolName, args };
      items.push(tool);
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
        const lastTool = [...items].reverse().find((m) => m.kind === "tool") as
          | (ChatItem & { kind: "tool" })
          | undefined;
        if (lastTool && !lastTool.result) lastTool.result = result;
      }
    } else if (e.kind === "error") {
      const msg =
        getStr(e.payload, "message", "error") ?? asString(e.payload);
      items.push({ kind: "error", content: msg });
    } else if (e.kind === "init" || e.kind === "status" || e.kind === "result") {
      const summary = (() => {
        if (e.kind === "status") {
          return getStr(e.payload, "status") ?? "status";
        }
        if (e.kind === "init") {
          return `session ${getStr(e.payload, "session_id")?.slice(0, 8) ?? "?"} · ${getStr(e.payload, "model") ?? "model?"}`;
        }
        if (e.kind === "result") {
          const stats = getObj(e.payload, "stats");
          const tokens =
            stats && typeof stats.total_tokens === "number"
              ? `${stats.total_tokens} tokens`
              : null;
          return tokens ? `result · ${tokens}` : "result";
        }
        return "";
      })();
      items.push({ kind: "event", eventKind: e.kind, summary });
    }
  }

  if (runFinished) {
    const lastAssistant = [...items].reverse().find((m) => m.kind === "assistant");
    if (lastAssistant?.kind === "assistant") lastAssistant.streaming = false;
  }

  return items;
}

function mergeEvents(prev: Event[], incoming: Event | Event[]): Event[] {
  const events = Array.isArray(incoming) ? incoming : [incoming];
  const byKey = new Map(prev.map((e) => [`${e.run_id}:${e.seq}`, e]));
  for (const event of events) {
    byKey.set(`${event.run_id}:${event.seq}`, event);
  }
  return [...byKey.values()].sort((a, b) => {
    const byTime = new Date(a.at).getTime() - new Date(b.at).getTime();
    if (byTime !== 0) return byTime;
    if (a.run_id !== b.run_id) return a.run_id.localeCompare(b.run_id);
    return a.seq - b.seq;
  });
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
  const [rightTab, setRightTab] = useState<RightTab>("details");
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(280);
  const [hydrated, setHydrated] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

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
    const t = setInterval(() => void refreshRuns(), 4000);
    return () => clearInterval(t);
  }, [refreshRuns]);

  useEffect(() => {
    if (!activeRunId) return;
    const isTerminal =
      activeRun?.status === "succeeded" ||
      activeRun?.status === "failed" ||
      activeRun?.status === "cancelled";
    if (isTerminal) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/runs/${activeRunId}`, { cache: "no-store" });
        if (r.ok) setActiveRun((await r.json()) as Run);
      } catch {
        // ignore
      }
    }, 4000);
    return () => clearInterval(t);
  }, [activeRunId, activeRun?.status]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const attachStream = useCallback(
    (run_id: string) => {
      closeStream();
      const es = new EventSource(apiEventUrl(run_id));
      esRef.current = es;
      const onEvent = (e: MessageEvent) => {
        try {
          const ev = JSON.parse(e.data) as Event;
          setEvents((prev) => mergeEvents(prev, ev));
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
          // ignore
        }
      };
      EVENT_KINDS.forEach((k) =>
        es.addEventListener(k, onEvent as EventListener)
      );
      es.onerror = () => {
        es.close();
      };
    },
    [closeStream, refreshRuns]
  );

  const loadRun = useCallback(
    async (id: string) => {
      closeStream();
      setBusy(false);
      setActiveRunId(id);
      setEvents([]);
      setExpandedEvent(null);
      try {
        const [runRes, evRes] = await Promise.all([
          fetch(`/api/runs/${id}`, { cache: "no-store" }),
          fetch(`/api/runs/${id}/conversation.json`, { cache: "no-store" }),
        ]);
        let run: Run | null = null;
        if (runRes.ok) {
          run = (await runRes.json()) as Run;
          setActiveRun(run);
        } else if (runRes.status === 404) {
          if (typeof window !== "undefined")
            window.localStorage.removeItem(STORAGE_KEY_RUN);
          setActiveRunId(null);
          setActiveRun(null);
          return;
        }
        if (evRes.ok) {
          const loadedEvents = (await evRes.json()) as Event[];
          setEvents((prev) => mergeEvents(prev, loadedEvents));
        }

        const isTerminal =
          run?.status === "succeeded" ||
          run?.status === "failed" ||
          run?.status === "cancelled";
        if (run && !isTerminal) {
          setBusy(true);
          attachStream(id);
        }
      } catch {
        // ignore
      }
    },
    [closeStream, attachStream]
  );

  // Restore activeRunId + sidebar width from localStorage on first mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedRun = window.localStorage.getItem(STORAGE_KEY_RUN);
    const savedW = window.localStorage.getItem(STORAGE_KEY_SIDEBAR);
    if (savedW) {
      const n = parseInt(savedW, 10);
      if (!Number.isNaN(n) && n >= 180 && n <= 600) setSidebarWidth(n);
    }
    setHydrated(true);
    if (savedRun) void loadRun(savedRun);
    // run only on first mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist activeRunId
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    if (activeRunId) {
      window.localStorage.setItem(STORAGE_KEY_RUN, activeRunId);
    } else {
      window.localStorage.removeItem(STORAGE_KEY_RUN);
    }
  }, [activeRunId, hydrated]);

  // Persist sidebar width
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY_SIDEBAR, String(sidebarWidth));
  }, [sidebarWidth, hydrated]);

  const newChat = useCallback(() => {
    closeStream();
    setBusy(false);
    setActiveRunId(null);
    setActiveRun(null);
    setEvents([]);
    setExpandedEvent(null);
    setPrompt("");
    if (typeof window !== "undefined")
      window.localStorage.removeItem(STORAGE_KEY_RUN);
  }, [closeStream]);

  const submit = useCallback(async () => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    const parentRunId =
      activeRunId &&
      activeRun?.status !== "running" &&
      activeRun?.status !== "pending"
        ? activeRunId
        : null;
    if (!parentRunId) setEvents([]);
    setActiveRun(null);
    setExpandedEvent(null);
    setPrompt("");
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: p, parent_run_id: parentRunId }),
      });
      const { run_id } = (await res.json()) as { run_id: string };
      setActiveRunId(run_id);
      void refreshRuns();
      void fetch(`/api/runs/${run_id}`, { cache: "no-store" }).then(
        async (r) => {
          if (r.ok) setActiveRun((await r.json()) as Run);
        }
      );
      attachStream(run_id);
    } catch {
      setBusy(false);
    }
  }, [prompt, busy, activeRunId, activeRun?.status, refreshRuns, attachStream]);

  // Sidebar drag-resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const next = Math.min(
        600,
        Math.max(180, dragRef.current.startW + dx)
      );
      setSidebarWidth(next);
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = { startX: e.clientX, startW: sidebarWidth };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth]
  );

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
    <main className="flex gap-3 p-3 h-screen max-h-screen overflow-hidden">
      <aside
        className="bg-neutral-900 border border-neutral-800 rounded-lg flex flex-col overflow-hidden shrink-0"
        style={{ width: sidebarWidth }}
      >
        <div className="p-3 border-b border-neutral-800 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-tight">asor</h1>
            <p className="text-[10px] text-neutral-500 uppercase tracking-wide truncate">
              Gemini CLI orchestrator
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={newChat}
              className="text-[11px] px-2 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-medium"
              title="Start a new chat"
            >
              + New
            </button>
            <button
              onClick={() => void refreshRuns()}
              className="text-[11px] px-2 py-1 rounded-md border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600"
              title="Auto-refreshing every 4s"
            >
              Refresh
            </button>
          </div>
        </div>
        <div className="px-3 pt-3 flex items-center gap-2">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Runs ({runs.length})
          </h2>
          <span className="inline-flex items-center gap-1 text-[9px] text-neutral-600">
            <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
            live
          </span>
        </div>
        <ul className="flex-1 overflow-y-auto p-2 space-y-1">
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

      <div
        onMouseDown={startDrag}
        className="w-1 hover:bg-indigo-600/60 active:bg-indigo-500 cursor-col-resize rounded transition-colors shrink-0"
        title="Drag to resize"
      />

      <section className="flex-1 flex flex-col gap-3 overflow-hidden min-w-0">
        <div
          ref={chatScrollRef}
          className="flex-1 bg-neutral-900 border border-neutral-800 rounded-lg p-4 overflow-y-auto"
        >
          {chat.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-xs text-neutral-500">
                Submit a prompt below to start a run.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {chat.map((m, i) => (
                <ChatBubble key={i} item={m} />
              ))}
              {busy &&
                chat[chat.length - 1]?.kind !== "assistant" && <TypingDots />}
            </div>
          )}
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-2 shadow-lg">
          <div className="flex items-end gap-2">
            <textarea
              className="flex-1 rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 resize-none min-h-[44px] max-h-40"
              placeholder="Message asor — Enter to send, Shift+Enter for newline"
              rows={1}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                e.currentTarget.style.height = "auto";
                e.currentTarget.style.height =
                  Math.min(e.currentTarget.scrollHeight, 160) + "px";
              }}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              onClick={() => void submit()}
              disabled={busy || !prompt.trim()}
              className="h-11 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-colors"
            >
              {busy ? "..." : "Send"}
            </button>
          </div>
          {activeRunId && (
            <div className="px-3 pt-1.5 text-[10px] text-neutral-500 font-mono">
              run {activeRunId.slice(0, 8)} · {activeRun?.status ?? "—"}
              {busy && (
                <span className="ml-2 inline-flex items-center gap-1 text-emerald-500">
                  <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                  streaming
                </span>
              )}
            </div>
          )}
        </div>
      </section>

      <aside className="w-80 bg-neutral-900 border border-neutral-800 rounded-lg flex flex-col overflow-hidden shrink-0">
        <div className="flex border-b border-neutral-800">
          <TabButton
            active={rightTab === "details"}
            onClick={() => setRightTab("details")}
          >
            Details
          </TabButton>
          <TabButton
            active={rightTab === "events"}
            onClick={() => setRightTab("events")}
          >
            Events
            <span className="ml-1.5 text-[9px] text-neutral-500">
              {events.length}
            </span>
          </TabButton>
        </div>

        {rightTab === "details" && (
          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                Run
              </h3>
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
            </section>

            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                Agent todos {todos.length > 0 && `(${todos.length})`}
              </h3>
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
            </section>
          </div>
        )}

        {rightTab === "events" && (
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {events.length === 0 ? (
              <p className="text-[11px] text-neutral-500 p-2">
                No events yet.
              </p>
            ) : (
              events.map((e, i) => {
                const expanded = expandedEvent === i;
                const cls =
                  EVENT_KIND_COLORS[e.kind] ??
                  "text-neutral-300 border-neutral-700 bg-neutral-900/60";
                const full = JSON.stringify(e, null, 2);
                const summary = JSON.stringify(e.payload ?? {});
                return (
                  <div
                    key={i}
                    className={`rounded-md border ${cls} transition-colors`}
                  >
                    <button
                      onClick={() =>
                        setExpandedEvent(expanded ? null : i)
                      }
                      className="w-full text-left px-2 py-1.5 flex items-center gap-2"
                    >
                      <span className="text-[9px] text-neutral-500 font-mono w-6 shrink-0">
                        #{e.seq}
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-wider shrink-0">
                        {e.kind}
                      </span>
                      <span className="text-[10px] text-neutral-400 truncate flex-1 font-mono">
                        {summary.length > 80
                          ? summary.slice(0, 80) + "…"
                          : summary}
                      </span>
                      <span className="text-[9px] text-neutral-600 shrink-0">
                        {expanded ? "▼" : "▶"}
                      </span>
                    </button>
                    {expanded && (
                      <pre className="px-2 pb-2 text-[10px] font-mono text-neutral-300 whitespace-pre-wrap break-all border-t border-neutral-800/60 pt-2">
                        {full}
                      </pre>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </aside>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
        active
          ? "text-neutral-100 border-b-2 border-indigo-500 bg-neutral-900"
          : "text-neutral-500 hover:text-neutral-300 border-b-2 border-transparent"
      }`}
    >
      {children}
    </button>
  );
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="mb-2 last:mb-0 whitespace-pre-wrap">{children}</p>
          ),
          h1: ({ children }) => (
            <h1 className="text-lg font-bold mt-3 mb-2">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-bold mt-3 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-bold mt-2 mb-1">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="list-disc ml-5 mb-2 space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal ml-5 mb-2 space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="text-sm">{children}</li>,
          code: ({ className, children }) => {
            const isBlock = (className ?? "").includes("language-");
            if (isBlock) {
              return <code className="block">{children}</code>;
            }
            return (
              <code className="px-1 py-0.5 rounded bg-neutral-950 border border-neutral-800 text-[12px] font-mono text-amber-200">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="bg-neutral-950 border border-neutral-800 rounded-md p-2 my-2 overflow-x-auto text-[12px] font-mono text-neutral-200">
              {children}
            </pre>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-400 underline hover:text-indigo-300"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-neutral-700 pl-3 text-neutral-400 italic my-2">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="text-[12px] border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-neutral-700 px-2 py-1 bg-neutral-950 text-left">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-neutral-800 px-2 py-1">{children}</td>
          ),
          hr: () => <hr className="border-neutral-800 my-3" />,
          strong: ({ children }) => (
            <strong className="font-semibold text-neutral-100">{children}</strong>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function ChatBubble({ item }: { item: ChatItem }) {
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-indigo-600 px-3 py-2 text-sm whitespace-pre-wrap">
          {item.content}
        </div>
      </div>
    );
  }
  if (item.kind === "tool") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-amber-500/80 mb-1 font-semibold">
            tool call · {item.toolName}
          </div>
          <pre className="text-[11px] text-amber-100/80 whitespace-pre-wrap font-mono leading-snug">
            {item.args.length > 600 ? item.args.slice(0, 600) + "…" : item.args}
          </pre>
          {item.result && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-emerald-500/80 mt-2 mb-1 font-semibold">
                result
              </div>
              <pre className="text-[11px] text-emerald-100/70 whitespace-pre-wrap font-mono leading-snug">
                {item.result.length > 600
                  ? item.result.slice(0, 600) + "…"
                  : item.result}
              </pre>
            </>
          )}
        </div>
      </div>
    );
  }
  if (item.kind === "error") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-[12px] text-red-200 whitespace-pre-wrap">
          {item.content}
        </div>
      </div>
    );
  }
  if (item.kind === "event") {
    const color =
      item.eventKind === "status"
        ? "text-indigo-400 border-indigo-900/50"
        : item.eventKind === "init"
          ? "text-sky-400 border-sky-900/50"
          : "text-violet-400 border-violet-900/50";
    return (
      <div className="flex justify-center">
        <div
          className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border bg-neutral-950 ${color}`}
        >
          {item.eventKind} · {item.summary}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-tl-sm bg-neutral-800 px-3 py-2 text-neutral-100">
        <Markdown>{item.content}</Markdown>
        {item.streaming && (
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
