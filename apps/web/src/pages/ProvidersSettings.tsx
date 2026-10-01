import { CheckCircle2, KeyRound, Play, RefreshCw, Square, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LogPane, type LogLine } from "@/components/LogPane.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Field, Input, Select, Textarea } from "@/components/ui/input.tsx";
import { ErrorNote } from "@/components/ui/misc.tsx";
import { ProviderApi, type ProviderInfo, type SecretStatus } from "@/lib/api.ts";
import { useServerMessages } from "@/lib/socket.ts";

const SECRETS = [
  { name: "anthropic-api-key", label: "Anthropic API key", placeholder: "sk-ant-…" },
  { name: "openai-api-key", label: "OpenAI API key", placeholder: "sk-…" },
];

export function ProvidersSettings() {
  const [providers, setProviders] = useState<ProviderInfo[]>();
  const [secrets, setSecrets] = useState<Record<string, SecretStatus>>({});
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setRefreshing(true);
    try {
      const [p, s] = await Promise.all([ProviderApi.list(refresh), ProviderApi.secrets()]);
      setProviders(p);
      setSecrets(s);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-muted-foreground">Subscriptions run through the vendors' own CLIs (sign in once in a terminal). API keys are stored in your OS keychain.</p>
        <Button variant="outline" onClick={() => void load(true)} disabled={refreshing}>
          <RefreshCw className={refreshing ? "animate-spin" : ""} /> Re-check
        </Button>
      </div>
      <ErrorNote error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {providers?.map((p) => (
          <Card key={p.id} data-testid={`provider-${p.id}`}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {p.status?.ok ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-destructive" />}
                {p.label}
              </CardTitle>
              <CardDescription>{p.status?.detail ?? "Checking…"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex gap-1.5">
                <Badge tone={p.authKind === "subscription" ? "primary" : "info"}>{p.authKind === "subscription" ? "subscription CLI" : "API key"}</Badge>
                <Badge>{p.vendor}</Badge>
              </div>
              {!p.status?.ok && p.status?.hint && <p className="rounded bg-muted px-2 py-1.5 text-xs">{p.status.hint}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-[13px] font-medium">
          <KeyRound className="size-4" /> API keys
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {SECRETS.map((s) => (
            <SecretCard key={s.name} {...s} status={secrets[s.name]} onChange={() => void load(true)} />
          ))}
        </div>
      </section>

      {providers && <Playground providers={providers} />}
    </div>
  );
}

function SecretCard({ name, label, placeholder, status, onChange }: { name: string; label: string; placeholder: string; status?: SecretStatus; onChange: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const save = async () => {
    try {
      await ProviderApi.setSecret(name, value);
      setValue("");
      setError(undefined);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{label}</CardTitle>
        <CardDescription>
          {status?.present ? (status.source === "env" ? "Using the environment variable" : "Stored in the OS keychain") : "Not set"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          <Input type="password" autoComplete="off" placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} aria-label={label} />
          <Button onClick={() => void save()} disabled={!value.trim()}>
            Save
          </Button>
          {status?.present && status.source === "keychain" && (
            <Button variant="outline" onClick={() => void ProviderApi.deleteSecret(name).then(onChange)}>
              Remove
            </Button>
          )}
        </div>
        {status?.keychainError && <p className="text-xs text-muted-foreground">Keychain unavailable here: {status.keychainError}</p>}
        <ErrorNote error={error} />
      </CardContent>
    </Card>
  );
}

function Playground({ providers }: { providers: ProviderInfo[] }) {
  const [provider, setProvider] = useState(providers.find((p) => p.status?.ok)?.id ?? providers[0]?.id ?? "");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("Say hello and list the files in the current folder.");
  const [runId, setRunId] = useState<string>();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string>();
  const selected = providers.find((p) => p.id === provider);

  useServerMessages((msg) => {
    if (msg.kind !== "playground-event" || msg.playgroundId !== runId) return;
    setLines((l) => [...l, { event: msg.payload }]);
    if (msg.payload.type === "session-end") setRunId(undefined);
  });

  const run = async () => {
    setLines([]);
    setError(undefined);
    try {
      const res = await ProviderApi.playground({ provider, prompt, ...(model ? { model } : {}) });
      setRunId(res.id);
      setLines([{ event: { type: "log", level: "info", message: `Running in ${res.cwd}` } }]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section>
      <h2 className="mb-1 text-[13px] font-medium">Try a prompt</h2>
      <p className="mb-3 text-sm text-muted-foreground">Sends one prompt through a provider in a scratch folder and streams the result.</p>
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider">
              <Select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Playground provider">
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.status?.ok ? "" : " (not ready)"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model">
              <Input list="pg-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={selected?.defaultModel ?? "provider default"} />
              <datalist id="pg-models">{selected?.models.map((m) => <option key={m} value={m} />)}</datalist>
            </Field>
          </div>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} aria-label="Prompt" />
          <div className="flex gap-2">
            <Button onClick={() => void run()} disabled={!!runId || !prompt.trim()}>
              <Play /> Run
            </Button>
            {runId && (
              <Button variant="outline" onClick={() => void ProviderApi.stopPlayground(runId)}>
                <Square /> Stop
              </Button>
            )}
          </div>
          <ErrorNote error={error} />
          <LogPane lines={lines} className="h-72" />
        </CardContent>
      </Card>
    </section>
  );
}
