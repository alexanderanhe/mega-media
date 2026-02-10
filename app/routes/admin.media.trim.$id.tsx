import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import type { Route } from "./+types/admin.media.trim.$id";
import { requireAdminPage } from "~/server/guards";
import { FiCamera, FiMinus, FiRefreshCw, FiScissors, FiVideo } from "react-icons/fi";
import { getAdminMediaById, getVideoPlayback, setVideoPreviewImage, splitMediaVideo, trimMediaVideo } from "~/shared/client-api";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdminPage(request);
  return null;
}

export default function AdminMediaTrimRoute() {
  const { id } = useParams();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [startSeconds, setStartSeconds] = useState(0);
  const [endSeconds, setEndSeconds] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [dragging, setDragging] = useState<"start" | "end" | "playhead" | null>(null);
  const [hasSplits, setHasSplits] = useState(false);
  const [splits, setSplits] = useState<Array<{ startSeconds: number; endSeconds: number }>>([]);
  const [splitting, setSplitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const minGap = 0.1;

  async function loadMedia({ bustCache }: { bustCache: boolean }) {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [media, playback] = await Promise.all([getAdminMediaById(id), getVideoPlayback(id)]);
      if (media.type !== "video") {
        throw new Error("Only videos can be trimmed.");
      }
      if (media.status !== "ready") {
        throw new Error("Video must be ready to trim.");
      }
      setTitle(media.title ?? "Untitled");
      setHasSplits(Boolean(media.hasSplits));
      setPlaybackUrl(bustCache ? withCacheBuster(playback.playbackUrl) : playback.playbackUrl);
      setPosterUrl(playback.posterUrl ? (bustCache ? withCacheBuster(playback.posterUrl) : playback.posterUrl) : null);
      if (media.durationSeconds && media.durationSeconds > 0) {
        setDuration(media.durationSeconds);
        setStartSeconds(0);
        setEndSeconds(media.durationSeconds);
        setCurrentTime(0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load video");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMedia({ bustCache: false });
  }, [id]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onLoaded = () => {
      if (!Number.isFinite(video.duration)) return;
      setDuration(video.duration);
      setStartSeconds(0);
      setEndSeconds(video.duration);
    };
    video.addEventListener("loadedmetadata", onLoaded);
    return () => video.removeEventListener("loadedmetadata", onLoaded);
  }, [playbackUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!Number.isFinite(startSeconds)) return;
    video.currentTime = Math.max(0, startSeconds);
    video.pause();
    setCurrentTime(Math.max(0, startSeconds));
  }, [startSeconds, endSeconds]);

  const trimmedLength = Math.max(0, endSeconds - startSeconds);
  const canTrim = trimmedLength >= 6 && startSeconds >= 0 && endSeconds > startSeconds;
  const durationSafe = duration ?? 0;
  const startPercent = durationSafe > 0 ? (startSeconds / durationSafe) * 100 : 0;
  const endPercent = durationSafe > 0 ? (endSeconds / durationSafe) * 100 : 100;
  const currentPercent = durationSafe > 0 ? (currentTime / durationSafe) * 100 : 0;

  useEffect(() => {
    if (!durationSafe) return;
    const clamped = clampSeconds(currentTime, startSeconds, endSeconds);
    if (clamped === currentTime) return;
    setCurrentTime(clamped);
    const video = videoRef.current;
    if (video) video.currentTime = clamped;
  }, [currentTime, startSeconds, endSeconds, durationSafe]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [playbackUrl]);

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (event: PointerEvent) => {
      const next = secondsFromClientX(event.clientX, timelineRef.current, durationSafe);
      if (!Number.isFinite(next)) return;
      if (dragging === "start") {
        setStartSeconds(Math.min(next, endSeconds - minGap));
      } else if (dragging === "end") {
        setEndSeconds(Math.max(next, startSeconds + minGap));
      } else {
        const clamped = clampSeconds(next, startSeconds, endSeconds);
        setCurrentTime(clamped);
        const video = videoRef.current;
        if (video) video.currentTime = clamped;
      }
    };
    const handleUp = () => setDragging(null);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragging, durationSafe, endSeconds, startSeconds]);

  async function handleTrim() {
    if (!id) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await trimMediaVideo(id, { startSeconds, endSeconds });
      setSuccess(res.reencoded ? "Trim saved (re-encoded to reduce size)." : "Trim saved.");
      await loadMedia({ bustCache: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trim failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreatePreview() {
    if (!id) return;
    setPreviewing(true);
    setError(null);
    setSuccess(null);
    try {
      await setVideoPreviewImage(id, { atSeconds: currentTime });
      await loadMedia({ bustCache: true });
      setSuccess("Preview image updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update preview image");
    } finally {
      setPreviewing(false);
    }
  }

  function handleAddSplit() {
    if (!canTrim) return;
    const next = { startSeconds, endSeconds };
    setSplits((prev) => {
      const exists = prev.some(
        (split) =>
          Math.abs(split.startSeconds - next.startSeconds) < 0.01 &&
          Math.abs(split.endSeconds - next.endSeconds) < 0.01,
      );
      if (exists) return prev;
      return [...prev, next];
    });
  }

  async function handleFinalizeSplits() {
    if (!id || !splits.length) return;
    setSplitting(true);
    setError(null);
    setSuccess(null);
    try {
      await splitMediaVideo(id, { segments: splits });
      window.location.assign("/admin/media");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to split video");
    } finally {
      setSplitting(false);
    }
  }

  return (
    <div className="flex h-[100dvh] flex-col gap-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div>
          <div className="text-sm text-slate-400">Video trim</div>
          <h2 className="max-w-[70vw] truncate text-xl font-semibold">{title || "Untitled"}</h2>
        </div>
        <a href="/admin/media" className="rounded border border-white/10 px-3 py-2 text-sm">
          Back to media
        </a>
      </div>

      {error ? <div className="rounded border border-rose-400/40 bg-rose-900/30 px-3 py-2 text-sm text-rose-200">{error}</div> : null}
      {success ? (
        <div className="rounded border border-emerald-400/40 bg-emerald-900/30 px-3 py-2 text-sm text-emerald-200">{success}</div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-h-0 flex-col rounded-xl border border-white/10 bg-black/60 p-3">
          {loading ? (
            <div className="skeleton h-80 w-full" />
          ) : playbackUrl ? (
            <video
              ref={videoRef}
              controls
              playsInline
              muted
              autoPlay
              className="max-h-[45dvh] w-full rounded-lg bg-black"
              poster={posterUrl ?? undefined}
              src={playbackUrl}
            />
          ) : (
            <div className="text-sm text-slate-400">Video not available.</div>
          )}
          {!loading && duration ? (
            <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/60 p-3 text-sm text-slate-200">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Trim range</span>
                <span>{formatSeconds(trimmedLength)} (min 6s)</span>
              </div>
              <div className="mt-3 space-y-3">
                <div ref={timelineRef} className="relative">
                  <div className="flex gap-2 overflow-hidden rounded border border-white/10 bg-black/40">
                    {Array.from({ length: 12 }).map((_, idx) => (
                      <div
                        key={`thumb-${idx}`}
                        className="h-14 flex-1 bg-cover bg-center"
                        style={{ backgroundImage: posterUrl ? `url(${posterUrl})` : "none" }}
                      />
                    ))}
                  </div>
                  <div
                    className="pointer-events-none absolute inset-0 rounded border border-emerald-400/70"
                    style={{
                      clipPath: `inset(0 ${100 - endPercent}% 0 ${startPercent}%)`,
                      boxShadow: "0 0 0 2px rgba(16, 185, 129, 0.6) inset",
                    }}
                  />
                  <div
                    className="pointer-events-none absolute inset-y-1 left-0 bg-black/60"
                    style={{ width: `${startPercent}%` }}
                  />
                  <div
                    className="pointer-events-none absolute inset-y-1 right-0 bg-black/60"
                    style={{ width: `${100 - endPercent}%` }}
                  />
                  <div
                    className="absolute inset-0 z-10 cursor-pointer"
                    onPointerDown={(event) => {
                      const next = secondsFromClientX(event.clientX, timelineRef.current, durationSafe);
                      if (!Number.isFinite(next)) return;
                      const clamped = clampSeconds(next, startSeconds, endSeconds);
                      setCurrentTime(clamped);
                      const video = videoRef.current;
                      if (video) video.currentTime = clamped;
                      setDragging("playhead");
                    }}
                  />
                  <div className="absolute inset-0 z-20">
                    <button
                      type="button"
                      aria-label="Adjust start"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        setDragging("start");
                      }}
                      className="absolute top-1/2 h-10 w-3 rounded-full bg-emerald-300 shadow-[0_0_0_2px_rgba(15,23,42,0.9)]"
                      style={{ left: `${startPercent}%`, transform: "translate(-50%, -50%)" }}
                    />
                    <button
                      type="button"
                      aria-label="Adjust end"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        setDragging("end");
                      }}
                      className="absolute top-1/2 h-10 w-3 rounded-full bg-emerald-300 shadow-[0_0_0_2px_rgba(15,23,42,0.9)]"
                      style={{ left: `${endPercent}%`, transform: "translate(-50%, -50%)" }}
                    />
                    <div
                      className="pointer-events-none absolute inset-y-1 border-x border-emerald-300/70"
                      style={{ left: `${startPercent}%`, right: `${100 - endPercent}%` }}
                    />
                    <div
                      className="pointer-events-none absolute inset-y-1 w-0.5 bg-cyan-300/80"
                      style={{ left: `${currentPercent}%` }}
                    />
                    <button
                      type="button"
                      aria-label="Scrub playhead"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        setDragging("playhead");
                      }}
                      className="absolute top-0 h-full w-4 -translate-x-1/2 cursor-ew-resize"
                      style={{ left: `${currentPercent}%` }}
                    >
                      <span className="absolute -top-2 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-cyan-300 shadow-[0_0_0_2px_rgba(15,23,42,0.9)]" />
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-slate-200">
                  {[4, 6, 10].map((seconds) => (
                    <button
                      key={`trim-start-${seconds}`}
                      type="button"
                      onClick={() => {
                        const next = Math.min(startSeconds + seconds, endSeconds - minGap);
                        setStartSeconds(Math.max(0, next));
                      }}
                      className="inline-flex items-center gap-1 rounded border border-white/10 bg-black/40 px-2 py-1 hover:border-cyan-400/60"
                    >
                      <FiMinus className="h-3 w-3" />
                      Remove first {seconds}s
                    </button>
                  ))}
                  {[4, 6, 10].map((seconds) => (
                    <button
                      key={`trim-end-${seconds}`}
                      type="button"
                      onClick={() => {
                        const next = Math.max(endSeconds - seconds, startSeconds + minGap);
                        setEndSeconds(Math.min(durationSafe, next));
                      }}
                      className="inline-flex items-center gap-1 rounded border border-white/10 bg-black/40 px-2 py-1 hover:border-cyan-400/60"
                    >
                      <FiMinus className="h-3 w-3" />
                      Remove last {seconds}s
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setStartSeconds(0);
                      setEndSeconds(durationSafe);
                      setCurrentTime(0);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-slate-400 hover:border-cyan-400/60"
                  >
                    <FiRefreshCw className="h-3 w-3" />
                    Reset trim
                  </button>
                </div>
                <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                  <div className="rounded border border-white/10 bg-black/40 px-2 py-1">
                    {formatSeconds(startSeconds)}
                  </div>
                  <div className="rounded border border-white/10 bg-black/40 px-2 py-1">
                    {formatSeconds(endSeconds)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!canTrim || saving}
                  onClick={handleTrim}
                  className="inline-flex w-full items-center justify-center gap-2 rounded bg-cyan-600 px-3 py-2 font-semibold text-white disabled:opacity-60"
                >
                  <FiScissors className="h-4 w-4" />
                  {saving ? "Trimming..." : "Trim & replace"}
                </button>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={saving || previewing || hasSplits || splits.length > 0}
                    onClick={handleCreatePreview}
                    className="inline-flex items-center gap-2 rounded border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <FiCamera className="h-4 w-4" />
                    {previewing ? "Updating preview..." : "New preview image"}
                  </button>
                  <button
                    type="button"
                    disabled={!canTrim || saving || splitting}
                    onClick={handleAddSplit}
                    className="inline-flex items-center gap-2 rounded border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <FiScissors className="h-4 w-4" />
                    Add split
                  </button>
                </div>
                {splits.length ? (
                  <div className="rounded border border-white/10 bg-black/30 p-2 text-xs text-slate-200">
                    <div className="flex items-center justify-between text-[11px] uppercase text-slate-400">
                      <span>Queued splits</span>
                      <button
                        type="button"
                        onClick={() => setSplits([])}
                        className="text-slate-400 hover:text-slate-200"
                      >
                        Clear
                      </button>
                    </div>
                    <div className="mt-2 grid gap-2">
                      {splits.map((split, index) => (
                        <div key={`${split.startSeconds}-${split.endSeconds}-${index}`} className="flex items-center justify-between gap-2 rounded border border-white/10 bg-black/40 px-2 py-1">
                          <span>
                            Split {index + 1}: {formatSeconds(split.startSeconds)} → {formatSeconds(split.endSeconds)}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setSplits((prev) => prev.filter((_, idx) => idx !== index))
                            }
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      disabled={splitting}
                      onClick={handleFinalizeSplits}
                      className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      <FiVideo className="h-4 w-4" />
                      {splitting ? "Splitting..." : "Finalize splits"}
                    </button>
                  </div>
                ) : null}
                {hasSplits ? (
                  <div className="text-xs text-amber-300/80">
                    Preview image is disabled because this video already has splits.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <div className="rounded-xl border border-white/10 bg-slate-900 p-4 text-sm text-slate-200">
          <div className="text-xs uppercase text-slate-400">Details</div>
          <div className="mt-3 space-y-2 text-xs text-slate-400">
            <div>Duration: {duration ? formatSeconds(duration) : "--"}</div>
            <div>Trim length: {formatSeconds(trimmedLength)} (min 6s)</div>
            <div>Tip: drag the trim handles or scrub the playhead to preview.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatSeconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0s";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function clampSeconds(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function secondsFromClientX(clientX: number, container: HTMLDivElement | null, duration: number) {
  if (!container || !duration) return 0;
  const rect = container.getBoundingClientRect();
  if (!rect.width) return 0;
  const percent = clampSeconds((clientX - rect.left) / rect.width, 0, 1);
  return percent * duration;
}

function withCacheBuster(url: string) {
  const joiner = url.includes("?") ? "&" : "?";
  return `${url}${joiner}t=${Date.now()}`;
}
