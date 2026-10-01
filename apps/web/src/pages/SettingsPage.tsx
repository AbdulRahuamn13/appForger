import { CheckCircle2, Cloud, HardDrive, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { StorageSettings } from "@appforge/core";
import { Page, PageHeader } from "@/components/Layout.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Section } from "@/components/ui/card.tsx";
import { Field, Input, Toggle } from "@/components/ui/input.tsx";
import { ErrorNote, Spinner } from "@/components/ui/misc.tsx";
import { toast } from "@/components/ui/toast.tsx";
import { SettingsApi, type StorageInfo } from "@/lib/api.ts";
import type { DoctorCheckDto } from "@/lib/api-types.ts";
import { notificationsEnabled, setNotificationsEnabled } from "@/lib/notify.ts";
import { href } from "@/lib/router.ts";
import type { ThemeChoice } from "@/lib/theme.ts";
import { cn } from "@/lib/utils.ts";
import { ProvidersSettings } from "./ProvidersSettings.tsx";

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "storage", label: "Storage" },
  { id: "providers", label: "Providers & keys" },
  { id: "doctor", label: "Environment" },
] as const;

export function SettingsPage({ section, theme, setTheme }: { section?: string; theme: ThemeChoice; setTheme: (t: ThemeChoice) => void }) {
  const active = SECTIONS.find((s) => s.id === section)?.id ?? "general";
  return (
    <Page wide>
      <PageHeader title="Settings" />
      <div className="grid grid-cols-[12rem_1fr] gap-10">
        <nav className="flex flex-col gap-0.5">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={href({ page: "settings", section: s.id })}
              className={cn("rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground", active === s.id && "bg-muted text-foreground")}
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="min-w-0 max-w-3xl">
          {active === "general" && <GeneralSettings theme={theme} setTheme={setTheme} />}
          {active === "storage" && <StorageSettingsPanel />}
          {active === "providers" && <ProvidersSettings />}
          {active === "doctor" && <DoctorPanel />}
        </div>
      </div>
    </Page>
  );
}

function GeneralSettings({ theme, setTheme }: { theme: ThemeChoice; setTheme: (t: ThemeChoice) => void }) {
  const [notify, setNotify] = useState(notificationsEnabled());
  return (
    <div className="space-y-10">
      <Section title="Appearance">
        <div className="flex gap-2">
          {(["system", "light", "dark"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTheme(t)} className={cn("rounded-md border px-3 py-1.5 text-[13px] capitalize", theme === t ? "border-foreground" : "text-muted-foreground")}>
              {t}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Notifications">
        <Toggle
          checked={notify}
          onChange={(on) => {
            setNotify(on);
            void setNotificationsEnabled(on);
          }}
          label="Desktop notifications"
          description="When AppForge is in the background: a plan is ready, a merge needs approval, a run finished or paused."
        />
      </Section>
      <Section title="Keyboard">
        <p className="text-[13px] text-muted-foreground">⌘K / Ctrl+K opens the command palette from anywhere.</p>
      </Section>
    </div>
  );
}

function StorageSettingsPanel() {
  const [info, setInfo] = useState<StorageInfo>();
  const [draft, setDraft] = useState<StorageSettings>();
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [copy, setCopy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    SettingsApi.storage().then(
      (i) => {
        setInfo(i);
        setDraft(i.settings);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  if (!draft || !info) return <Spinner />;

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await SettingsApi.setStorage({
        settings: draft,
        copy,
        ...(keyId || secret ? { credentials: { ...(keyId ? { accessKeyId: keyId } : {}), ...(secret ? { secretAccessKey: secret } : {}) } } : {}),
      });
      setInfo(res);
      setDraft(res.settings);
      setKeyId("");
      setSecret("");
      toast(`Storage: ${res.location}${res.copied ? ` (copied ${res.copied} file(s))` : ""}`, "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cloud = draft.cloud;
  return (
    <div className="space-y-8">
      <p className="text-[13px] text-muted-foreground">
        Where skills, run logs, project memory and reference images live. Projects, runs and settings stay in the local database; code always stays in your project folders.
      </p>
      <p className="text-[13px]">
        Active: <span className="font-mono text-xs">{info.location}</span>
      </p>
      <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Storage location">
        {(
          [
            ["local", HardDrive, "Local", "A folder on this machine."],
            ["cloud", Cloud, "Cloud", "Any S3-compatible bucket: AWS S3, Cloudflare R2, MinIO, Backblaze B2."],
          ] as const
        ).map(([mode, Icon, label, desc]) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={draft.mode === mode}
            onClick={() => setDraft({ ...draft, mode })}
            className={cn("rounded-lg border p-4 text-left hover:bg-muted", draft.mode === mode && "border-foreground")}
          >
            <Icon className="mb-2 size-4" />
            <div className="text-[13px] font-medium">{label}</div>
            <div className="text-xs text-muted-foreground">{desc}</div>
          </button>
        ))}
      </div>
      {draft.mode === "local" ? (
        <Field label="Folder" hint="Absolute path. Created if missing.">
          <Input value={draft.local.path} onChange={(e) => setDraft({ ...draft, local: { path: e.target.value } })} className="font-mono text-xs" aria-label="Local storage folder" />
        </Field>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Endpoint" hint="Leave empty for AWS S3.">
            <Input value={cloud.endpoint ?? ""} onChange={(e) => setDraft({ ...draft, cloud: { ...cloud, endpoint: e.target.value } })} placeholder="https://<account>.r2.cloudflarestorage.com" className="font-mono text-xs" />
          </Field>
          <Field label="Region">
            <Input value={cloud.region} onChange={(e) => setDraft({ ...draft, cloud: { ...cloud, region: e.target.value } })} placeholder="auto / us-east-1" />
          </Field>
          <Field label="Bucket">
            <Input value={cloud.bucket} onChange={(e) => setDraft({ ...draft, cloud: { ...cloud, bucket: e.target.value } })} aria-label="Bucket" />
          </Field>
          <Field label="Prefix">
            <Input value={cloud.prefix} onChange={(e) => setDraft({ ...draft, cloud: { ...cloud, prefix: e.target.value } })} placeholder="appforge" />
          </Field>
          <Field label="Access key id" hint={info.credentials.accessKeyId.present ? `Stored (${info.credentials.accessKeyId.source})` : "Stored in the OS keychain"}>
            <Input type="password" autoComplete="off" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder={info.credentials.accessKeyId.present ? "•••• (unchanged)" : ""} />
          </Field>
          <Field label="Secret access key" hint={info.credentials.secretAccessKey.present ? `Stored (${info.credentials.secretAccessKey.source})` : "Stored in the OS keychain"}>
            <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={info.credentials.secretAccessKey.present ? "•••• (unchanged)" : ""} />
          </Field>
          <div className="col-span-2">
            <Toggle checked={cloud.forcePathStyle} onChange={(v) => setDraft({ ...draft, cloud: { ...cloud, forcePathStyle: v } })} label="Path-style URLs" description="Needed for MinIO and most self-hosted S3; fine for R2." />
          </div>
        </div>
      )}
      <Toggle checked={copy} onChange={setCopy} label="Copy existing data to the new location" description="Skills, logs, memory and images move with you." />
      <ErrorNote error={error} />
      <div className="flex justify-end">
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner className="text-primary-foreground" /> : null} Test &amp; switch
        </Button>
      </div>
    </div>
  );
}

function DoctorPanel() {
  const [checks, setChecks] = useState<DoctorCheckDto[]>();
  const run = () => {
    setChecks(undefined);
    void SettingsApi.doctor().then(setChecks, () => setChecks([]));
  };
  useEffect(run, []);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-muted-foreground">Everything AppForge and the generated stacks need on this machine.</p>
        <Button variant="outline" onClick={run}>
          <RefreshCw /> Re-check
        </Button>
      </div>
      {!checks ? (
        <Spinner />
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="doctor">
          {checks.map((c) => (
            <li key={c.name} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
              {c.ok ? <CheckCircle2 className="mt-0.5 size-4 text-success" /> : <XCircle className={cn("mt-0.5 size-4", c.optional ? "text-muted-foreground" : "text-destructive")} />}
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {c.name} {c.optional && !c.ok && <span className="text-xs font-normal text-muted-foreground">(optional)</span>}
                </div>
                <div className="text-xs text-muted-foreground">{c.detail}</div>
                {!c.ok && c.hint && <div className="mt-0.5 text-xs">{c.hint}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
