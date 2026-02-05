import { useEffect, useRef } from "react";

type OverlayRect = { left: number; top: number; width: number; height: number };

export function VideoOverlay({
  playbackUrl,
  posterUrl,
  rect,
  onClose,
}: {
  playbackUrl: string;
  posterUrl: string | null;
  rect: OverlayRect;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.play().catch(() => undefined);
    return () => {
      video.pause();
      video.currentTime = 0;
    };
  }, [playbackUrl]);

  return (
    <>
      <video
        ref={videoRef}
        controls
        poster={posterUrl ?? undefined}
        src={playbackUrl}
        style={{
          position: "absolute",
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          objectFit: "cover",
          borderRadius: 10,
          background: "black",
          zIndex: 20,
        }}
      />
      <button
        onClick={onClose}
        style={{
          position: "absolute",
          right: 20,
          top: 20,
          zIndex: 25,
          borderRadius: 8,
          background: "rgba(0,0,0,0.75)",
          color: "white",
          padding: "8px 12px",
        }}
      >
        Close video
      </button>
    </>
  );
}
