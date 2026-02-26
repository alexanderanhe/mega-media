import { useEffect, useMemo, useState } from "react";
import type { Route } from "./+types/admin.jobs";
import { requireAdminPage } from "~/server/guards";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdminPage(request);
  return null;
}

type JobsSnapshot = {
  updatedAt: string;
  mediaProcessing: Array<{
    id: string;
    title: string;
    type: "image" | "video";
    createdAt: string;
    r2KeyOriginal: string;
    mergedFrom: { baseName: string; totalParts: number; mergedAt: string } | null;
  }>;
  mergeJobs: Array<{
    groupKey: string;
    baseName: string;
    extension: string;
    status: "pending" | "merging" | "error";
    receivedParts: number;
    maxPart: number;
    contiguous: boolean;
    progress: number;
    lastSeenAt: string | null;
    errorMessage: string | null;
  }>;
};

const emptySnapshot: JobsSnapshot = {
  updatedAt: new Date(0).toISOString(),
  mediaProcessing: [],
  mergeJobs: [],
};

export default function AdminJobsRoute() {
  const [snapshot, setSnapshot] = useState<JobsSnapshot>(emptySnapshot);
  const [mode, setMode] = useState<"sse" | "poll">("sse");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;

    const applySnapshot = (payload: JobsSnapshot) => {
      if (cancelled) return;
      setSnapshot(payload);
      setLoading(false);
    };

    const startPolling = () => {
      if (cancelled) return;
      setMode("poll");
      const poll = async () => {
        try {
          const res = await fetch("/api/admin/jobs", { headers: { accept: "application/json" } });
          if (!res.ok) throw new Error(`Failed to load jobs (${res.status})`);
          const data = (await res.json()) as JobsSnapshot;
          applySnapshot(data);
          setError(null);
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Failed to load jobs");
          }
        } finally {
          pollTimer = window.setTimeout(poll, 5000);
        }
      };
      pollTimer = window.setTimeout(poll, 0);
    };

    if (mode === "sse" && typeof EventSource !== "undefined") {
      const es = new EventSource("/api/admin/jobs?stream=1");
      es.addEventListener("jobs", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as JobsSnapshot;
          applySnapshot(payload);
          setError(null);
        } catch {
          // ignore invalid payloads
        }
      });
      es.addEventListener("error", () => {
        es.close();
        startPolling();
      });
      return () => {
        cancelled = true;
        es.close();
        if (pollTimer) window.clearTimeout(pollTimer);
      };
    }

    startPolling();
    return () => {
      cancelled = true;
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [mode]);

  const mergeCounts = useMemo(() => {
    const counts = { pending: 0, merging: 0, error: 0 };
    for (const job of snapshot.mergeJobs) {
      counts[job.status] += 1;
    }
    return counts;
  }, [snapshot.mergeJobs]);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Jobs</h2>
            <p className="text-sm text-slate-400">
              {loading ? "Loading..." : `Last update: ${new Date(snapshot.updatedAt).toLocaleString()}`}
              {" · "}
              {mode === "sse" ? "Live" : "Polling"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <span className="rounded-full border border-white/10 px-2 py-1">Media: {snapshot.mediaProcessing.length}</span>
            <span className="rounded-full border border-white/10 px-2 py-1">Merging: {mergeCounts.merging}</span>
            <span className="rounded-full border border-white/10 px-2 py-1">Pending: {mergeCounts.pending}</span>
            <span className="rounded-full border border-white/10 px-2 py-1">Errors: {mergeCounts.error}</span>
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
      </section>

      <section className="rounded-xl border border-white/10 bg-slate-900 p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-300">Media Processing</h3>
        {snapshot.mediaProcessing.length === 0 ? (
          <p className="text-sm text-slate-400">No media jobs currently processing.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="py-2">Title</th>
                  <th>Type</th>
                  <th>Created</th>
                  <th>Origin</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.mediaProcessing.map((item) => (
                  <tr key={item.id} className="border-t border-white/10">
                    <td className="py-2">{item.title}</td>
                    <td className="capitalize">{item.type}</td>
                    <td>{new Date(item.createdAt).toLocaleString()}</td>
                    <td className="text-slate-300">
                      {item.mergedFrom
                        ? `${item.mergedFrom.baseName} (${item.mergedFrom.totalParts} parts)`
                        : "Upload"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-slate-900 p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-300">Merge Queue</h3>
        {snapshot.mergeJobs.length === 0 ? (
          <p className="text-sm text-slate-400">No merge jobs.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {snapshot.mergeJobs.map((job) => (
              <div key={job.groupKey} className="rounded-lg border border-white/10 bg-slate-950/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{job.baseName}.{job.extension}</p>
                    <p className="text-xs text-slate-400">{job.groupKey}</p>
                  </div>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      job.status === "merging"
                        ? "border-emerald-400/50 text-emerald-200"
                        : job.status === "error"
                          ? "border-rose-400/50 text-rose-200"
                          : "border-white/20 text-slate-200"
                    }`}
                  >
                    {job.status}
                  </span>
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
                    <span>
                      Parts {job.receivedParts}/{job.maxPart || "?"}
                    </span>
                    <span>{job.progress}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-emerald-400/70" style={{ width: `${job.progress}%` }} />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span>Contiguous: {job.contiguous ? "yes" : "no"}</span>
                  {job.lastSeenAt ? <span>Last: {new Date(job.lastSeenAt).toLocaleString()}</span> : null}
                </div>
                {job.errorMessage ? (
                  <p className="mt-2 text-xs text-rose-300">{job.errorMessage}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
