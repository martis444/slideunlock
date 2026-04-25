"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import WasmUnlockZone from "../../components/WasmUnlockZone";

// ── Types ──────────────────────────────────────────────────────────────────────

interface AnalysisResult {
  filename: string;
  total_slides: number;
  flat_image_slides: number[];
  pass_through_shape_counts: Record<string, number>;
  locked_elements_count: number;
  grouped_elements_count: number;
  has_animations: boolean;
  estimated_seconds: number;
}

interface JobStatusResponse {
  status: "queued" | "processing" | "done" | "failed";
  phase_label: string;
  ssim_scores: Record<string, number> | null;
  download_url: string | null;
  error: string | null;
}

interface HistoryEntry {
  id: string;
  filename: string;
  slides: number;
  status: "done" | "failed";
  ssim_scores: Record<string, number> | null;
  date: Date;
  download_url: string | null;
}

// ── Config ─────────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const supabase =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      )
    : null;

const PHASES = [
  "Queued",
  "Removing locks",
  "Flattening groups",
  "Classifying slides",
  "AI reconstruction",
  "Building shapes",
  "Fidelity check",
  "Repacking",
] as const;

const FREE_LIMIT = 3;

// ── Helpers ────────────────────────────────────────────────────────────────────

function avgSsim(scores: Record<string, number> | null): string {
  if (!scores) return "—";
  const vals = Object.values(scores);
  if (!vals.length) return "—";
  return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3);
}

function ssimChipClass(score: number): string {
  if (score >= 0.95) return "bg-green-50 text-green-700 border-green-200";
  if (score >= 0.80) return "bg-yellow-50 text-yellow-700 border-yellow-200";
  return "bg-red-50 text-red-700 border-red-200";
}

function fmtDate(d: Date): string {
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── TopNav ─────────────────────────────────────────────────────────────────────

function TopNav({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <nav className="sticky top-0 z-10 border-b border-gray-200 bg-white/90 backdrop-blur-sm px-6 py-3 flex items-center justify-between">
      <span className="font-bold text-gray-900 text-lg tracking-tight">SlideUnlock</span>
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-500 hidden sm:block">{email}</span>
        <button
          onClick={onSignOut}
          className="text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}

// ── UsageMeter ─────────────────────────────────────────────────────────────────

function UsageMeter({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(used / limit, 1);
  const full = used >= limit;
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-gray-600">Free unlocks this month</span>
        <span className={`text-xs font-semibold tabular-nums ${full ? "text-red-600" : "text-gray-700"}`}>
          {used} / {limit}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${full ? "bg-red-500" : "bg-blue-500"}`}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

// ── ServerUploadZone ───────────────────────────────────────────────────────────

function ServerUploadZone({
  onFile,
  disabled,
}: {
  onFile: (f: File) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => e.key === "Enter" && !disabled && inputRef.current?.click()}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!disabled) {
          const f = e.dataTransfer.files[0];
          if (f) onFile(f);
        }
      }}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      className={[
        "w-full rounded-2xl border-2 border-dashed px-8 py-14",
        "flex flex-col items-center gap-3 transition-colors duration-150 outline-none",
        disabled
          ? "opacity-60 cursor-default border-gray-200 bg-white"
          : dragging
            ? "border-blue-500 bg-blue-50 cursor-pointer"
            : "border-gray-300 bg-white cursor-pointer hover:border-blue-400 hover:bg-blue-50/50 focus-visible:border-blue-500",
      ].join(" ")}
    >
      <svg className="h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
      </svg>
      <p className="text-sm font-medium text-gray-700">
        {disabled ? "Processing…" : "Drop your .pptx here, or click to browse"}
      </p>
      <p className="text-xs text-gray-400">Max 100 MB · .pptx only</p>
      <input
        ref={inputRef}
        type="file"
        accept=".pptx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ── AnalysisReport ─────────────────────────────────────────────────────────────

function AnalysisReport({
  result,
  onUnlock,
  unlocking,
  isPro,
  freeExhausted,
}: {
  result: AnalysisResult;
  onUnlock: (mode: "basic" | "ai") => void;
  unlocking: boolean;
  isPro: boolean;
  freeExhausted: boolean;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <h2 className="font-semibold text-gray-900 truncate">{result.filename}</h2>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([
          ["Slides", result.total_slides],
          ["Locked elements", result.locked_elements_count.toLocaleString()],
          ["Grouped elements", result.grouped_elements_count.toLocaleString()],
          ["Flat-image slides", result.flat_image_slides.length],
        ] as [string, string | number][]).map(([label, value]) => (
          <div key={label} className="rounded-lg bg-gray-50 border border-gray-100 p-3 text-center">
            <div className="text-2xl font-bold text-gray-900">{value}</div>
            <div className="text-xs text-gray-500 mt-0.5 leading-tight">{label}</div>
          </div>
        ))}
      </div>

      {/* Callouts */}
      {result.flat_image_slides.length > 0 && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          Slides {result.flat_image_slides.join(", ")} are flat images —
          AI reconstruction will convert them to editable shapes.
        </p>
      )}
      {result.has_animations && (
        <p className="text-sm text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
          This file contains animations — they will be preserved.
        </p>
      )}
      {Object.keys(result.pass_through_shape_counts).length > 0 && (
        <p className="text-sm text-gray-600">
          Pass-through shapes:{" "}
          {Object.entries(result.pass_through_shape_counts)
            .map(([t, n]) => `${n} ${t}`)
            .join(", ")}
        </p>
      )}

      {/* CTA */}
      <div className="flex gap-3 pt-1">
        {/* Basic unlock */}
        <button
          onClick={() => onUnlock("basic")}
          disabled={unlocking || freeExhausted}
          className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {freeExhausted ? "Daily limit reached" : unlocking ? "Processing…" : "Unlock Free (basic)"}
        </button>

        {/* AI unlock */}
        <div className="relative flex-1 group">
          <button
            onClick={() => isPro && onUnlock("ai")}
            disabled={unlocking || !isPro}
            className={[
              "w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors",
              isPro
                ? "bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                : "bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed",
            ].join(" ")}
          >
            Unlock with AI (Pro)
          </button>
          {!isPro && (
            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20">
              <div className="bg-gray-900 text-white text-xs rounded-lg px-3 py-1.5 whitespace-nowrap shadow-lg">
                Upgrade to Pro to enable AI reconstruction
                <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── PhaseProgress ──────────────────────────────────────────────────────────────

function PhaseProgress({
  job,
  phaseIdx,
  estimatedSeconds,
}: {
  job: JobStatusResponse;
  phaseIdx: number;
  estimatedSeconds: number;
}) {
  const isDone = job.status === "done";
  const isFailed = job.status === "failed";
  const pct = isDone ? 100 : isFailed ? phaseIdx * (90 / PHASES.length) + 5 : phaseIdx * (90 / PHASES.length) + 5;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-800">
          {isFailed ? "Processing failed" : isDone ? "Complete" : PHASES[phaseIdx]}
        </span>
        <span className="text-xs text-gray-400 tabular-nums">{Math.round(isDone ? 100 : pct)}%</span>
      </div>

      {/* Bar */}
      <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
        <div
          className={[
            "h-full rounded-full transition-all duration-700",
            isFailed ? "bg-red-500" : isDone ? "bg-green-500" : "bg-blue-500",
          ].join(" ")}
          style={{ width: `${isDone ? 100 : pct}%` }}
        />
      </div>

      {/* Phase chips */}
      <div className="flex flex-wrap gap-1.5">
        {PHASES.map((phase, i) => {
          const past = isDone || i < phaseIdx;
          const active = !isDone && i === phaseIdx;
          return (
            <span
              key={phase}
              className={[
                "text-xs rounded-full px-2.5 py-0.5 border transition-colors",
                past
                  ? "border-blue-200 bg-blue-50 text-blue-700"
                  : active
                    ? "border-blue-400 bg-blue-100 text-blue-800 font-semibold"
                    : "border-gray-200 bg-gray-50 text-gray-400",
              ].join(" ")}
            >
              {phase}
            </span>
          );
        })}
      </div>

      {/* ETA */}
      {!isDone && !isFailed && estimatedSeconds > 0 && (
        <p className="text-xs text-gray-400">
          Estimated: ~{Math.ceil(estimatedSeconds / 60)} min
        </p>
      )}

      {/* Error */}
      {isFailed && job.error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {job.error}
        </p>
      )}

      {/* SSIM badges */}
      {isDone && job.ssim_scores && Object.keys(job.ssim_scores).length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Fidelity per slide</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(job.ssim_scores).map(([slide, score]) => (
              <span
                key={slide}
                className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${ssimChipClass(score)}`}
              >
                Slide {slide}: {score.toFixed(3)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Download */}
      {isDone && job.download_url && (
        <a
          href={job.download_url}
          download
          className="inline-flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download unlocked file
        </a>
      )}
    </div>
  );
}

// ── JobHistoryTable ────────────────────────────────────────────────────────────

function JobHistoryTable({ entries }: { entries: HistoryEntry[] }) {
  if (!entries.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-800">History</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-400 uppercase tracking-wider">
              {["Filename", "Slides", "Status", "SSIM", "Date", "Download"].map((h, i) => (
                <th
                  key={h}
                  className={`px-5 py-3 font-medium ${i === 0 ? "text-left" : i === 5 ? "text-right" : "text-center"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition-colors">
                <td className="px-5 py-3 font-medium text-gray-800 max-w-[180px] truncate">{e.filename}</td>
                <td className="px-5 py-3 text-center text-gray-600">{e.slides}</td>
                <td className="px-5 py-3 text-center">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${e.status === "done" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                    {e.status}
                  </span>
                </td>
                <td className="px-5 py-3 text-center text-gray-500 tabular-nums">{avgSsim(e.ssim_scores)}</td>
                <td className="px-5 py-3 text-right text-gray-400 whitespace-nowrap text-xs">{fmtDate(e.date)}</td>
                <td className="px-5 py-3 text-right">
                  {e.download_url ? (
                    <a href={e.download_url} download className="text-blue-600 hover:text-blue-800 font-medium">
                      Download
                    </a>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function AppPage() {
  const router = useRouter();

  // auth
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const isPro = true; // TODO: read from users table once Supabase is wired

  // mode
  const [localMode, setLocalMode] = useState(false);

  // server pipeline state
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // job polling
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatusResponse | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [phaseIdx, setPhaseIdx] = useState(0);

  // history & usage
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [freeUsed, setFreeUsed] = useState(0);

  // local mode wasm progress
  const [wasmPct, setWasmPct] = useState(0);
  const [wasmMsg, setWasmMsg] = useState("Drop a .pptx — processed entirely on-device");

  // ── Auth ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false); // local dev without Supabase
      return;
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) router.push("/login");
      else setUser(session.user);
      setAuthLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) router.push("/login");
      else setUser(session.user);
    });

    return () => subscription.unsubscribe();
  }, [router]);

  const handleSignOut = useCallback(async () => {
    await supabase?.auth.signOut();
    router.push("/login");
  }, [router]);

  // ── Analyze ───────────────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pptx")) {
      setServerError("Only .pptx files are supported");
      return;
    }
    setUploadedFile(file);
    setAnalysis(null);
    setServerError(null);
    setJobId(null);
    setJobStatus(null);
    setPhaseIdx(0);
    setAnalyzing(true);

    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_URL}/api/analyze`, { method: "POST", body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { detail?: string };
        throw new Error(body.detail ?? `Server error ${res.status}`);
      }
      setAnalysis(await res.json() as AnalysisResult);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  }, []);

  // ── Unlock ────────────────────────────────────────────────────────────────

  const handleUnlock = useCallback(async (mode: "basic" | "ai") => {
    if (!uploadedFile) return;
    setUnlocking(true);
    setJobId(null);
    setJobStatus(null);
    setPhaseIdx(0);
    setServerError(null);

    try {
      const headers: Record<string, string> = {};
      if (supabase) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          headers["Authorization"] = `Bearer ${session.access_token}`;
        }
      }

      const fd = new FormData();
      fd.append("file", uploadedFile);
      fd.append("basic_only", mode === "basic" ? "true" : "false");
      fd.append("reconstruct_flat", mode === "ai" ? "true" : "false");

      const res = await fetch(`${API_URL}/api/unlock`, { method: "POST", headers, body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { detail?: string };
        throw new Error(body.detail ?? `Server error ${res.status}`);
      }

      const { job_id } = await res.json() as { job_id: string };
      setJobId(job_id);
      if (mode === "basic") setFreeUsed((n) => Math.min(n + 1, FREE_LIMIT));
    } catch (e) {
      setServerError(e instanceof Error ? e.message : String(e));
      setUnlocking(false);
    }
  }, [uploadedFile]);

  // ── Poll ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!jobId) return;
    let active = true;

    const tick = async () => {
      try {
        const res = await fetch(`${API_URL}/api/job/${jobId}`);
        if (!res.ok || !active) return;
        const data = await res.json() as JobStatusResponse;
        setJobStatus(data);

        if (data.status === "done" || data.status === "failed") {
          active = false;
          setUnlocking(false);
          if (uploadedFile && analysis) {
            setHistory((prev) => {
              if (prev.some((e) => e.id === jobId)) return prev;
              return [
                {
                  id: jobId,
                  filename: uploadedFile.name,
                  slides: analysis.total_slides,
                  status: data.status as "done" | "failed",
                  ssim_scores: data.ssim_scores,
                  date: new Date(),
                  download_url: data.download_url,
                },
                ...prev,
              ];
            });
          }
        }
      } catch {
        // keep polling on transient network errors
      }
    };

    tick();
    const iv = setInterval(tick, 2000);
    return () => { active = false; clearInterval(iv); };
  }, [jobId, uploadedFile, analysis]);

  // Advance phase chips while processing
  useEffect(() => {
    if (jobStatus?.status !== "processing") return;
    const secsPerPhase = Math.max(2, (analysis?.estimated_seconds ?? 30) / (PHASES.length - 1));
    const iv = setInterval(
      () => setPhaseIdx((i) => Math.min(i + 1, PHASES.length - 2)),
      secsPerPhase * 1000,
    );
    return () => clearInterval(iv);
  }, [jobStatus?.status, analysis?.estimated_seconds]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  const jobActive = !!jobId && jobStatus?.status !== "done" && jobStatus?.status !== "failed";

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      <TopNav email={user?.email ?? "Guest"} onSignOut={handleSignOut} />

      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-8 space-y-5">

        {/* Usage meter + mode toggle */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <UsageMeter used={freeUsed} limit={FREE_LIMIT} />
          </div>
          <button
            onClick={() => {
              setLocalMode((m) => !m);
              setAnalysis(null);
              setJobId(null);
              setJobStatus(null);
              setServerError(null);
            }}
            className={[
              "flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap",
              localMode
                ? "border-green-300 bg-green-50 text-green-700"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
            ].join(" ")}
          >
            <span className={`h-2 w-2 rounded-full ${localMode ? "bg-green-500" : "bg-gray-300"}`} />
            Local mode {localMode ? "(on)" : "(off)"}
          </button>
        </div>

        {/* Upload zone */}
        {localMode ? (
          <div className="space-y-3">
            <WasmUnlockZone
              onResult={() => {}}
              onProgress={(pct, msg) => { setWasmPct(pct); setWasmMsg(msg); }}
            />
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500 truncate">{wasmMsg}</span>
                <span className="text-xs text-gray-400 tabular-nums ml-2">{wasmPct}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${wasmPct}%` }}
                />
              </div>
            </div>
          </div>
        ) : (
          <ServerUploadZone onFile={handleFile} disabled={analyzing || jobActive} />
        )}

        {/* Server error */}
        {serverError && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        {/* Analysis report */}
        {analysis && !localMode && (
          <AnalysisReport
            result={analysis}
            onUnlock={handleUnlock}
            unlocking={unlocking}
            isPro={isPro}
            freeExhausted={freeUsed >= FREE_LIMIT}
          />
        )}

        {/* Job progress */}
        {jobStatus && !localMode && (
          <PhaseProgress
            job={jobStatus}
            phaseIdx={phaseIdx}
            estimatedSeconds={analysis?.estimated_seconds ?? 0}
          />
        )}

        {/* Job history */}
        <JobHistoryTable entries={history} />
      </main>
    </div>
  );
}
