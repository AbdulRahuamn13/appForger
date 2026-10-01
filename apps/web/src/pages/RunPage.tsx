import { ArrowLeft, Check, FileText, FileDiff as FileDiffIcon, MessageSquare, Pause, Play, RotateCcw, Send, Square, Trash2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { AgentEvent, Approval, FileDiff, RunLogEvent, Task, TaskStatus, TestReport, UsageSummary } from "@appforge/core";
import { PageHeader } from "@/components/Layout.tsx";
import { LogPane, type LogLine } from "@/components/LogPane.tsx";
import { MODES } from "@/components/RunsPanel.tsx";
import { Badge, statusTone } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Empty, ErrorNote, Tabs } from "@/components/ui/misc.tsx";
import { KnowledgeApi, RunApi, type RunDetail } from "@/lib/api.ts";
import { href, navigate } from "@/lib/router.ts";
import { useServerMessages } from "@/lib/socket.ts";
import { cn, timeAgo } from "@/lib/utils.ts";

const DiffViewer = lazy(() => import("@/components/DiffViewer.tsx"));

const COLUMNS: { title: string; statuses: TaskStatus[] }[] = [
  { title: "To do", statuses: ["todo"] },
  { title: "Coding", statuses: ["in-progress", "changes-requested"] },
  { title: "Review", statuses: ["review"] },
  { title: "Testing", statuses: ["testing"] },
  { title: "Approval", statuses: ["awaiting-approval", "ready-to-merge"] },
  { title: "Merged", statuses: ["merged"] },
  { title: "Stopped", statuses: ["failed", "cancelled"] },
];

const ACTIVE = new Set(["pending", "running", "awaiting-approval", "awaiting-input", "paused"]);

export function RunPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  // Agent events and orchestrator logs in arrival order (sorted once on load), so the log pane only ever appends.
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [liveReports, setLiveReports] = useState<{ taskId?: string; report: TestReport }[]>([]);
  const [error, setError] = useState<string>();
  const [agentFilter, setAgentFilter] = useState("all");
  const [selectedTask, setSelectedTask] = useState<string>();
  const [diff, setDiff] = useState<{ title: string; files: FileDiff[] }>();
  const [tab, setTab] = useState<"logs" | "tests" | "usage">("logs");

  const load = useCallback(async () => {
    try {
      const [d, ev] = await Promise.all([RunApi.get(id), RunApi.events(id)]);
      setDetail(d);
      const evs = ev.map((e) => e.event);
      setEvents(evs);
      setTimeline(
        [...evs.map((event): TimelineItem => ({ ts: event.ts, event })), ...d.logs.map((log): TimelineItem => ({ ts: log.ts, log }))].sort((a, b) => a.ts.localeCompare(b.ts)),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  useServerMessages((msg) => {
    switch (msg.kind) {
      case "run-updated":
        if (msg.run.id === id) setDetail((d) => d && { ...d, run: msg.run, active: ACTIVE.has(msg.run.status) });
        break;
      case "task-updated":
        if (msg.task.runId === id)
          setDetail((d) => d && { ...d, tasks: upsert(d.tasks, msg.task).sort((a, b) => a.order - b.order) });
        break;
      case "approval-updated":
        if (msg.approval.runId === id) setDetail((d) => d && { ...d, approvals: upsert(d.approvals, msg.approval) });
        break;
      case "run-log":
        if (msg.log.runId === id) {
          setDetail((d) => d && { ...d, logs: [...d.logs, msg.log] });
          setTimeline((t) => [...t, { ts: msg.log.ts, log: msg.log }]);
        }
        break;
      case "agent-event":
        if (msg.event.runId === id) {
          setEvents((e) => [...e, msg.event]);
          setTimeline((t) => [...t, { ts: msg.event.ts, event: msg.event }]);
        }
        break;
      case "test-report":
        if (msg.runId === id) setLiveReports((r) => [...r, { ...(msg.taskId ? { taskId: msg.taskId } : {}), report: msg.report }]);
        break;
      default:
        break;
    }
  });

  const agents = useMemo(() => [...new Set(events.map((e) => e.agentId))], [events]);
  const lines = useMemo(() => buildLines(timeline, agentFilter, selectedTask), [timeline, agentFilter, selectedTask]);
  const usage = useMemo(() => summariseUsage(events), [events]);
  const working = useMemo(() => {
    // Agents whose current turn has started but not ended.
    const live = new Map<string, boolean>();
    for (const e of events) {
      if (e.type === "session-start") live.set(e.agentId, true);
      else if (e.type === "session-end") live.set(e.agentId, false);
    }
    return [...live].filter(([, on]) => on).map(([id]) => id);
  }, [events]);

  if (error) return <div className="p-6"><ErrorNote error={error} /></div>;
  if (!detail) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  const { run, project, tasks, approvals } = detail;
  const pending = approvals.filter((a) => a.status === "pending");
  const isActive = ACTIVE.has(run.status);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError(undefined);
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const showDiff = async (title: string, load: () => Promise<FileDiff[]>) => act(async () => setDiff({ title, files: await load() }));
  const totalCost = usage.reduce((s, u) => s + u.costUsd, 0);

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 px-8 py-8">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <a
              href={href(run.storyId ? { page: "project", id: project.id, tab: "stories", item: run.storyId } : { page: "project", id: project.id, tab: "runs" })}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Back to project"
            >
              <ArrowLeft className="size-5" />
            </a>
            <span className="truncate">{run.brief.split("\n")[0]}</span>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(run.status)} dot data-testid="run-status">
              {run.status}
            </Badge>
            <span>{MODES.find((m) => m.value === run.mode)?.label}</span>·<span>{project.name}</span>·<span>started {timeAgo(run.createdAt)}</span>
            {totalCost > 0 && <span>· ${totalCost.toFixed(2)} reported</span>}
            {isActive && (
              <span data-testid="agents-working">
                · {working.length} agent{working.length === 1 ? "" : "s"} working
                {run.mode === "swarm" ? ` (cap ${project.settings.concurrency})` : ""}
                {working.length ? `: ${working.join(", ")}` : ""}
              </span>
            )}
          </span>
        }
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() =>
                void act(async () => {
                  const { name } = await KnowledgeApi.saveRunLog(run.id);
                  navigate({ page: "project", id: project.id, tab: "logs", item: name });
                })
              }
            >
              <FileText /> Log file
            </Button>
            {(run.status === "paused" || run.status === "interrupted" || run.status === "failed") && (
              <Button onClick={() => void act(() => RunApi.resume(run.id))}>
                {run.status === "failed" ? <RotateCcw /> : <Play />} {run.status === "failed" ? "Retry" : "Resume"}
              </Button>
            )}
            {isActive && (
              <Button variant="destructive" onClick={() => void act(() => RunApi.stop(run.id))}>
                <Square /> Stop
              </Button>
            )}
          </>
        }
      />
      <ErrorNote error={error} />
      {run.status === "paused" && (
        <div className="flex items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <Pause className="size-4 shrink-0" /> {run.error ?? "Paused"}
        </div>
      )}
      {run.status === "failed" && run.error && <ErrorNote error={run.error} />}
      {run.status === "interrupted" && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">AppForge restarted while this run was active. Resume continues from the saved tasks.</div>
      )}

      {run.mode === "single" && run.status === "awaiting-input" && <SingleControls runId={run.id} onError={setError} />}

      {pending.map((a) => (
        <ApprovalCard
          key={a.id}
          approval={a}
          task={tasks.find((t) => t.id === a.taskId)}
          onDiff={() => void showDiff(`${a.title} — ${a.branch} → ${a.baseBranch}`, () => RunApi.approvalDiff(a.id))}
          onDecide={(approved, comment) => void act(() => RunApi.decide(a.id, approved, comment))}
        />
      ))}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Task board</h2>
        {tasks.length === 0 ? (
          <Empty>{run.mode === "pipeline" || run.mode === "swarm" ? "The Architect is planning…" : "Starting…"}</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7" data-testid="task-board">
            {COLUMNS.map((col) => {
              const items = tasks.filter((t) => col.statuses.includes(t.status));
              return (
                <div key={col.title} className="min-h-24 rounded-md bg-muted/60 p-2">
                  <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                    {col.title}
                    <span>{items.length}</span>
                  </div>
                  <div className="space-y-2">
                    {items.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        selected={selectedTask === t.id}
                        onSelect={() => setSelectedTask(selectedTask === t.id ? undefined : t.id)}
                        onDiff={() => void showDiff(`${t.title} — ${t.branch}`, () => RunApi.taskDiff(t.id))}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "logs", label: "Live logs" },
              { value: "tests", label: "Tests" },
              { value: "usage", label: "Usage" },
            ]}
          />
          {tab === "logs" && (
            <div className="flex flex-wrap gap-1" aria-label="Filter logs by agent">
              {["all", ...agents].map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAgentFilter(a)}
                  className={cn("rounded-full border px-2.5 py-0.5 text-xs", agentFilter === a ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")}
                >
                  {a}
                </button>
              ))}
              {selectedTask && (
                <Badge tone="primary" className="cursor-pointer" onClick={() => setSelectedTask(undefined)}>
                  task: {tasks.find((t) => t.id === selectedTask)?.key} <X className="size-3" />
                </Badge>
              )}
            </div>
          )}
        </div>
        {tab === "logs" && <LogPane key={`${agentFilter}-${selectedTask ?? ""}`} lines={lines} className="h-[28rem]" />}
        {tab === "tests" && <TestsPanel tasks={tasks} live={liveReports} />}
        {tab === "usage" && <UsagePanel usage={usage} />}
      </section>

      <Dialog open={!!diff} onClose={() => setDiff(undefined)} title={diff?.title ?? ""} className="max-w-[90vw]">
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading diff viewer…</p>}>{diff && <DiffViewer files={diff.files} />}</Suspense>
      </Dialog>
    </div>
  );
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = [...list];
  next[i] = item;
  return next;
}

type TimelineItem = { ts: string; event: AgentEvent; log?: undefined } | { ts: string; log: RunLogEvent; event?: undefined };

function buildLines(timeline: TimelineItem[], agent: string, taskId: string | undefined): LogLine[] {
  const out: LogLine[] = [];
  for (const item of timeline) {
    if (item.event) {
      const e = item.event;
      if ((agent !== "all" && e.agentId !== agent) || (taskId && e.taskId !== taskId)) continue;
      out.push({ label: e.agentId, event: e });
    } else {
      const l = item.log;
      if (agent !== "all" || (taskId && l.taskId !== taskId)) continue;
      out.push({ label: "appforge", event: { type: "log", level: l.level, message: l.message } });
    }
  }
  return out;
}

function summariseUsage(events: AgentEvent[]): UsageSummary[] {
  const map = new Map<string, UsageSummary>();
  for (const e of events) {
    if (e.type !== "usage") continue;
    const u = map.get(e.agentId) ?? { agentId: e.agentId, role: e.role, provider: e.provider, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    u.inputTokens += e.inputTokens;
    u.outputTokens += e.outputTokens;
    u.costUsd += e.costUsd ?? 0;
    map.set(e.agentId, u);
  }
  return [...map.values()];
}

function TaskCard({ task, selected, onSelect, onDiff }: { task: Task; selected: boolean; onSelect: () => void; onDiff: () => void }) {
  const failedTests = (task.testReports ?? []).reduce((n, r) => n + r.failed, 0);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      className={cn("cursor-pointer rounded-md border bg-card p-2 text-xs shadow-xs hover:border-primary/40", selected && "border-primary ring-1 ring-primary/30")}
      data-testid={`task-${task.key}`}
    >
      <div className="font-medium leading-snug">{task.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Badge>{task.area}</Badge>
        {task.status === "changes-requested" && <Badge tone="warning">fixing</Badge>}
        {task.attempts > 0 && <Badge tone="warning">loop {task.attempts}</Badge>}
        {task.review && <Badge tone={task.review.verdict === "approve" ? "success" : "danger"}>{task.review.verdict === "approve" ? "approved" : "changes"}</Badge>}
        {task.testReports?.length ? <Badge tone={failedTests ? "danger" : "success"}>{failedTests ? `${failedTests} failing` : "tests ✓"}</Badge> : null}
      </div>
      {task.branch && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDiff();
          }}
          className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
        >
          <FileDiffIcon className="size-3" /> diff
        </button>
      )}
    </div>
  );
}

function ApprovalCard({ approval, task, onDiff, onDecide }: { approval: Approval; task?: Task; onDiff: () => void; onDecide: (approved: boolean, comment?: string) => void }) {
  const [comment, setComment] = useState("");
  const [asking, setAsking] = useState(false);
  const review = task?.review;
  return (
    <Card className="border-primary/40 bg-primary/5" data-testid="approval-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Approve merge: {approval.title}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal">
            {approval.branch} → {approval.baseBranch}
          </code>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {review && (
          <div className="text-sm">
            <span className="font-medium">Reviewer:</span> <Badge tone={review.verdict === "approve" ? "success" : "danger"}>{review.verdict}</Badge>{" "}
            {review.summary}
            {review.issues.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                {review.issues.map((i, n) => (
                  <li key={n}>
                    [{i.severity}] {i.file ? `${i.file}${i.line ? `:${i.line}` : ""} — ` : ""}
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {task?.testReports?.map((r, i) => (
          <div key={i} className="text-sm">
            <span className="font-medium">{r.framework}:</span> {r.passed}/{r.total} passed{r.failed ? `, ${r.failed} failed` : ""}
            {r.error ? ` — ${r.error}` : ""}
          </div>
        ))}
        {asking && <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="What should change? The coder gets this as feedback." aria-label="Change request" />}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onDiff}>
            <FileDiffIcon /> View diff
          </Button>
          <Button variant="success" onClick={() => onDecide(true)}>
            <Check /> Approve &amp; merge
          </Button>
          {asking ? (
            <Button variant="secondary" disabled={!comment.trim()} onClick={() => onDecide(false, comment)}>
              <Send /> Send back to coder
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setAsking(true)}>
              <MessageSquare /> Request changes
            </Button>
          )}
          <Button variant="ghost" onClick={() => onDecide(false)}>
            <X /> Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SingleControls({ runId, onError }: { runId: string; onError: (e: string) => void }) {
  const [text, setText] = useState("");
  const run = (fn: () => Promise<unknown>) => fn().then(() => setText(""), (e: Error) => onError(e.message));
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <p className="text-sm font-medium">The agent finished its turn. Steer it, or finish to review and merge.</p>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Next instruction…" aria-label="Next instruction" />
        <div className="flex flex-wrap gap-2">
          <Button disabled={!text.trim()} onClick={() => void run(() => RunApi.message(runId, text))}>
            <Send /> Send
          </Button>
          <Button variant="success" onClick={() => void run(() => RunApi.finish(runId))}>
            <Check /> Finish: review &amp; merge
          </Button>
          <Button variant="ghost" onClick={() => void run(() => RunApi.discard(runId))}>
            <Trash2 /> Discard
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TestsPanel({ tasks, live }: { tasks: Task[]; live: { taskId?: string; report: TestReport }[] }) {
  const fromTasks = tasks.flatMap((t) => (t.testReports ?? []).map((report) => ({ taskId: t.id, report })));
  const runLevel = live.filter((l) => !l.taskId);
  const all = [...fromTasks, ...runLevel];
  if (!all.length) return <Empty>No test results yet. Tests run after each task's review and again on the merged code.</Empty>;
  return (
    <div className="space-y-2">
      {all.map(({ taskId, report }, i) => (
        <Card key={i}>
          <CardContent className="p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={report.failed || report.error ? "danger" : "success"}>{report.failed || report.error ? "failing" : "passing"}</Badge>
              <span className="font-medium">
                {report.framework} · {report.layer}
              </span>
              <span className="text-muted-foreground">
                {taskId ? `task ${tasks.find((t) => t.id === taskId)?.key}` : "merged code"} · {report.cwd} · {report.passed}/{report.total} passed · {(report.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
            {report.error && <p className="mt-1 text-xs text-destructive">{report.error}</p>}
            {report.cases.some((c) => c.status === "failed") && (
              <ul className="mt-2 space-y-1 text-xs">
                {report.cases
                  .filter((c) => c.status === "failed")
                  .slice(0, 20)
                  .map((c, n) => (
                    <li key={n} className="rounded bg-destructive/5 px-2 py-1">
                      <span className="font-medium">{c.suite ? `${c.suite} › ` : ""}{c.name}</span>
                      {c.error && <pre className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{c.error.message.slice(0, 600)}</pre>}
                      {c.attachments?.length ? <div className="text-muted-foreground">attachments: {c.attachments.join(", ")}</div> : null}
                    </li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function UsagePanel({ usage }: { usage: UsageSummary[] }) {
  if (!usage.length) return <Empty>No usage reported yet.</Empty>;
  const total = usage.reduce((acc, u) => ({ i: acc.i + u.inputTokens, o: acc.o + u.outputTokens, c: acc.c + u.costUsd }), { i: 0, o: 0, c: 0 });
  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Agent</th>
            <th className="px-3 py-2">Provider</th>
            <th className="px-3 py-2 text-right">Input tokens</th>
            <th className="px-3 py-2 text-right">Output tokens</th>
            <th className="px-3 py-2 text-right">Reported cost</th>
          </tr>
        </thead>
        <tbody>
          {usage.map((u) => (
            <tr key={u.agentId} className="border-t">
              <td className="px-3 py-1.5 font-medium">{u.agentId}</td>
              <td className="px-3 py-1.5">{u.provider}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{u.inputTokens.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{u.outputTokens.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{u.costUsd ? `$${u.costUsd.toFixed(4)}` : "—"}</td>
            </tr>
          ))}
          <tr className="border-t bg-muted/40 font-medium">
            <td className="px-3 py-1.5" colSpan={2}>
              Total
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums">{total.i.toLocaleString()}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{total.o.toLocaleString()}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{total.c ? `$${total.c.toFixed(4)}` : "—"}</td>
          </tr>
        </tbody>
      </table>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">Subscription CLIs report notional cost; your plan's limits are what actually apply.</p>
    </div>
  );
}
