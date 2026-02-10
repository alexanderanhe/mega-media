import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import type { Route } from "./+types/admin.media.trim.$id";
import { requireAdminPage } from "~/server/guards";
import { getAdminMediaById, getVideoPlayback, trimMediaVideo } from "~/shared/client-api";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdminPage(request);
  return null;
}

export default function AdminMediaTrimRoute() {
  const { id } = useParams();
  const videoRef = useRef<HTMLVideoElement | null>(null);
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

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    Promise.all([getAdminMediaById(id), getVideoPlayback(id)])
      .then(([media, playback]) => {
        if (media.type !== "video") {
          throw new Error("Only videos can be trimmed.");
        }
        if (media.status !== "ready") {
          throw new Error("Video must be ready to trim.");
        }
        setTitle(media.title ?? "Untitled");
        setPlaybackUrl(playback.playbackUrl);
        setPosterUrl(playback.posterUrl);
        if (media.durationSeconds && media.durationSeconds > 0) {
          setDuration(media.durationSeconds);
          setStartSeconds(0);
          setEndSeconds(media.durationSeconds);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load video"))
      .finally(() => setLoading(false));
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
  }, [startSeconds, endSeconds]);

  const trimmedLength = Math.max(0, endSeconds - startSeconds);
  const canTrim = trimmedLength >= 6 && startSeconds >= 0 && endSeconds > startSeconds;
  const durationSafe = duration ?? 0;
  const startPercent = durationSafe > 0 ? (startSeconds / durationSafe) * 100 : 0;
  const endPercent = durationSafe > 0 ? (endSeconds / durationSafe) * 100 : 100;

  async function handleTrim() {
    if (!id) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await trimMediaVideo(id, { startSeconds, endSeconds });
      setSuccess(res.reencoded ? "Trim saved (re-encoded to reduce size)." : "Trim saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trim failed");
    } finally {
      setSaving(false);
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
                <div className="relative">
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
                  <div className="absolute inset-0 flex items-center">
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, duration)}
                      step={0.1}
                      value={startSeconds}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setStartSeconds(Math.min(next, endSeconds - 0.1));
                      }}
                      className="absolute z-20 h-14 w-full cursor-pointer appearance-none bg-transparent"
                      style={{
                        WebkitAppearance: "none",
                      }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, duration)}
                      step={0.1}
                      value={endSeconds}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setEndSeconds(Math.max(next, startSeconds + 0.1));
                      }}
                      className="absolute z-10 h-14 w-full cursor-pointer appearance-none bg-transparent"
                      style={{
                        WebkitAppearance: "none",
                      }}
                    />
                  </div>
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
                  className="w-full rounded bg-cyan-600 px-3 py-2 font-semibold text-white disabled:opacity-60"
                >
                  {saving ? "Trimming..." : "Trim & replace"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="rounded-xl border border-white/10 bg-slate-900 p-4 text-sm text-slate-200">
          <div className="text-xs uppercase text-slate-400">Details</div>
          <div className="mt-3 space-y-2 text-xs text-slate-400">
            <div>Duration: {duration ? formatSeconds(duration) : "--"}</div>
            <div>Trim length: {formatSeconds(trimmedLength)} (min 6s)</div>
            <div>Tip: move the sliders and the video will reset to the start.</div>
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
