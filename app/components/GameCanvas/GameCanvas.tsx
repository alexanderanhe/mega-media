import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Application, Assets, Container, Sprite, Text, TextStyle, Texture } from "pixi.js";
import type { Camera, GridMediaItem, Tile } from "./types";
import { pickLod } from "./lod-policy";
import { TextureCache } from "./texture-cache";
import { FetchScheduler } from "./fetch-scheduler";
import { VideoOverlay } from "./VideoOverlay";
import { getVideoPlayback } from "~/shared/client-api";

type OverlayState = {
  id: string;
  playbackUrl: string;
  posterUrl: string | null;
  rect: { left: number; top: number; width: number; height: number };
};

type CameraAnimation = {
  start: number;
  duration: number;
  from: Camera;
  to: Camera;
};

const TILE_BASE = 180;
const GAP = 12;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;

export type GameCanvasHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  getZoom: () => number;
};

export const GameCanvas = forwardRef<
  GameCanvasHandle,
  { items: GridMediaItem[]; onZoomChange?: (zoom: number) => void }
>(function GameCanvas({ items, onZoomChange }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const schedulerRef = useRef(new FetchScheduler());
  const texturesRef = useRef(new TextureCache(600));
  const spritesRef = useRef(new Map<string, Sprite>());
  const lodRef = useRef(new Map<string, 0 | 1 | 2 | 3 | 4>());
  const urlRef = useRef(new Map<string, string>());
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const focusedIdRef = useRef<string | null>(null);
  const drawVisibleRef = useRef<() => void>(() => undefined);
  const activeAnimationRef = useRef<CameraAnimation | null>(null);

  const tiles = useMemo(() => layoutTiles(items), [items]);
  const bounds = useMemo(() => contentBounds(tiles), [tiles]);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => nudgeZoom(1.15),
      zoomOut: () => nudgeZoom(0.85),
      getZoom: () => cameraRef.current.zoom,
    }),
    [],
  );

  useEffect(() => {
    let mounted = true;
    const hostMaybe = hostRef.current;
    if (!hostMaybe) return;
    const host: HTMLDivElement = hostMaybe;

    const app = new Application();
    const world = new Container();
    let appInitialized = false;

    async function init() {
      await app.init({ resizeTo: host as HTMLElement, antialias: true, backgroundAlpha: 1, backgroundColor: 0x000000 });
      appInitialized = true;
      if (!mounted) return;
      host.appendChild(app.canvas);
      app.stage.addChild(world);
      appRef.current = app;
      worldRef.current = world;

      centerContent(host.clientWidth, host.clientHeight);
      drawVisible();
      onZoomChange?.(cameraRef.current.zoom);

      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const pointers = new Map<number, { x: number; y: number }>();
      let pinchDistance = 0;
      let pinchWorldCenter = { x: 0, y: 0 };
      let pinchScreenCenter = { x: 0, y: 0 };

      const onPointerDown = (event: PointerEvent) => {
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        host.setPointerCapture(event.pointerId);
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        if (pointers.size === 2) {
          const [a, b] = Array.from(pointers.values());
          pinchDistance = distance(a, b);
          pinchScreenCenter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          pinchWorldCenter = {
            x: (pinchScreenCenter.x - host.getBoundingClientRect().left - cameraRef.current.x) / cameraRef.current.zoom,
            y: (pinchScreenCenter.y - host.getBoundingClientRect().top - cameraRef.current.y) / cameraRef.current.zoom,
          };
        }
      };

      const onPointerMove = (event: PointerEvent) => {
        if (pointers.has(event.pointerId)) {
          pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }
        if (pointers.size === 2) {
          const [a, b] = Array.from(pointers.values());
          const nextDistance = distance(a, b);
          if (pinchDistance > 0) {
            const ratio = nextDistance / pinchDistance;
            const nextZoom = clamp(cameraRef.current.zoom * ratio, MIN_ZOOM, MAX_ZOOM);
            cameraRef.current.zoom = nextZoom;
            const hostRect = host.getBoundingClientRect();
            const cx = (a.x + b.x) / 2 - hostRect.left;
            const cy = (a.y + b.y) / 2 - hostRect.top;
            cameraRef.current.x = cx - pinchWorldCenter.x * nextZoom;
            cameraRef.current.y = cy - pinchWorldCenter.y * nextZoom;
            pinchDistance = nextDistance;
            drawVisible();
            onZoomChange?.(cameraRef.current.zoom);
          }
          return;
        }
        if (!dragging) return;
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        cameraRef.current.x += dx;
        cameraRef.current.y += dy;
        drawVisible();
        onZoomChange?.(cameraRef.current.zoom);
      };

      const onPointerUp = (event: PointerEvent) => {
        pointers.delete(event.pointerId);
        if (pointers.size < 2) pinchDistance = 0;
        dragging = pointers.size > 0;
      };

      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        const hostRect = host.getBoundingClientRect();
        const pointerX = event.clientX - hostRect.left;
        const pointerY = event.clientY - hostRect.top;

        const prevZoom = cameraRef.current.zoom;
        const delta = event.deltaY > 0 ? 0.9 : 1.1;
        const nextZoom = clamp(prevZoom * delta, MIN_ZOOM, MAX_ZOOM);
        const worldX = (pointerX - cameraRef.current.x) / prevZoom;
        const worldY = (pointerY - cameraRef.current.y) / prevZoom;

        cameraRef.current.zoom = nextZoom;
        cameraRef.current.x = pointerX - worldX * nextZoom;
        cameraRef.current.y = pointerY - worldY * nextZoom;

        drawVisible();
        onZoomChange?.(cameraRef.current.zoom);
      };

      const onClick = async (event: MouseEvent) => {
        if (event.detail > 1) return;
        const tile = hitTest(tiles, event.clientX, event.clientY, host.getBoundingClientRect(), cameraRef.current);
        if (!tile || tile.item.type !== "video") return;
        const pixelSize = tile.w * cameraRef.current.zoom;
        if (pixelSize < 140) return;

        try {
          const data = await getVideoPlayback(tile.item.id);
          setOverlay({
            id: tile.item.id,
            playbackUrl: data.playbackUrl,
            posterUrl: data.posterUrl,
            rect: tileToScreenRect(tile, cameraRef.current),
          });
        } catch {
          // no-op
        }
      };

      const onDoubleClick = async (event: MouseEvent) => {
        const tile = hitTest(tiles, event.clientX, event.clientY, host.getBoundingClientRect(), cameraRef.current);
        if (!tile) {
          clearFocus();
          return;
        }

        if (focusedIdRef.current === tile.item.id) {
          clearFocus();
          return;
        }

        focusOnTile(tile);

        if (tile.item.type === "video") {
          try {
            const data = await getVideoPlayback(tile.item.id);
            setOverlay({
              id: tile.item.id,
              playbackUrl: data.playbackUrl,
              posterUrl: data.posterUrl,
              rect: tileToScreenRect(tile, cameraRef.current),
            });
          } catch {
            // no-op
          }
        } else {
          setOverlay(null);
        }
      };

      const onResize = () => {
        if (!host) return;
        if (!overlay && !focusedIdRef.current) centerContent(host.clientWidth, host.clientHeight);
        drawVisible();
        onZoomChange?.(cameraRef.current.zoom);
      };

      host.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      host.addEventListener("wheel", onWheel, { passive: false });
      host.addEventListener("click", onClick);
      host.addEventListener("dblclick", onDoubleClick);
      window.addEventListener("resize", onResize);

      const ticker = () => {
        if (activeAnimationRef.current) {
          const animation = activeAnimationRef.current;
          const now = performance.now();
          const t = Math.min(1, (now - animation.start) / animation.duration);
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          cameraRef.current.zoom = animation.from.zoom + (animation.to.zoom - animation.from.zoom) * eased;
          cameraRef.current.x = animation.from.x + (animation.to.x - animation.from.x) * eased;
          cameraRef.current.y = animation.from.y + (animation.to.y - animation.from.y) * eased;
          drawVisible();
          onZoomChange?.(cameraRef.current.zoom);
          if (t >= 1) activeAnimationRef.current = null;
        }
        if (overlay) {
          const tile = tiles.find((value) => value.item.id === overlay.id);
          if (tile && host) {
            const rect = tileToScreenRect(tile, cameraRef.current);
            setOverlay((prev) => (prev ? { ...prev, rect } : prev));
          }
        }
      };
      app.ticker.add(ticker);

      return () => {
        app.ticker.remove(ticker);
        host.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        host.removeEventListener("wheel", onWheel);
        host.removeEventListener("click", onClick);
        host.removeEventListener("dblclick", onDoubleClick);
        window.removeEventListener("resize", onResize);
      };
    }

    let cleanup: (() => void) | undefined;
    init().then((dispose) => {
      cleanup = dispose;
    });

    return () => {
      mounted = false;
      cleanup?.();
      texturesRef.current.clear();
      spritesRef.current.clear();
      if (appInitialized) {
        world.removeChildren();
        app.destroy(true, { children: true });
      }
      appRef.current = null;
      worldRef.current = null;
    };

    function centerContent(width: number, height: number) {
      const camera = cameraRef.current;
      if (tiles.length < 30) {
        camera.zoom = 1;
        camera.x = width / 2 - (bounds.minX + bounds.maxX) / 2;
        camera.y = height / 2 - (bounds.minY + bounds.maxY) / 2;
      }
    }

    async function drawVisible() {
      const app = appRef.current;
      const world = worldRef.current;
      if (!app || !world || !host) return;

      world.position.set(cameraRef.current.x, cameraRef.current.y);
      world.scale.set(cameraRef.current.zoom);

      const hostRect = host.getBoundingClientRect();
      const visible = visibleTiles(tiles, hostRect.width, hostRect.height, cameraRef.current);
      const visibleSet = new Set(visible.map((tile) => tile.item.id));

      for (const [id, sprite] of spritesRef.current.entries()) {
        if (!visibleSet.has(id)) {
          world.removeChild(sprite);
          spritesRef.current.delete(id);
        }
      }

      const requests: Array<{ id: string; lod: 0 | 1 | 2 | 3 | 4; priority: number }> = [];

      for (const tile of visible) {
        const px = tile.w * cameraRef.current.zoom;
        const prev = lodRef.current.get(tile.item.id) ?? null;
        const lod = pickLod(px, prev);
        lodRef.current.set(tile.item.id, lod);
        const key = `${tile.item.id}:${lod}`;
        const texture = texturesRef.current.get(key);

        let sprite = spritesRef.current.get(tile.item.id);
        if (!sprite) {
          sprite = new Sprite(Texture.WHITE);
          sprite.x = tile.x;
          sprite.y = tile.y;
          sprite.width = tile.w;
          sprite.height = tile.h;
          spritesRef.current.set(tile.item.id, sprite);
          world.addChild(sprite);

          const label = new Text({
            text: tile.item.type === "video" ? "▶" : "",
            style: new TextStyle({ fill: "#f8fafc", fontSize: 28 }),
          });
          label.anchor.set(0.5);
          label.position.set(tile.w / 2, tile.h / 2);
          sprite.addChild(label);
        }

        if (texture) {
          sprite.texture = texture;
          sprite.alpha = isFullyVisible(tile, hostRect, cameraRef.current) ? 1 : 0.35;
          continue;
        }

        sprite.tint = tile.item.type === "video" ? 0x1f2937 : 0x334155;
        if (!urlRef.current.has(key)) {
          requests.push({
            id: tile.item.id,
            lod,
            priority: distanceToCenter(tile, hostRect.width, hostRect.height, cameraRef.current),
          });
        }
      }

      const loaded = await schedulerRef.current.fetchUrls(requests);
      for (const item of loaded) {
        if (!item.url) continue;
        const key = `${item.id}:${item.lod}`;
        if (urlRef.current.get(key) === item.url) continue;
        urlRef.current.set(key, item.url);
        const texture = await Assets.load<Texture>(item.url);
        texturesRef.current.set(key, texture);
      }

      for (const tile of visible) {
        const lod = lodRef.current.get(tile.item.id);
        if (lod === undefined) continue;
        const key = `${tile.item.id}:${lod}`;
        const texture = texturesRef.current.get(key);
        const sprite = spritesRef.current.get(tile.item.id);
        if (sprite && texture) {
          sprite.texture = texture;
          sprite.tint = 0xffffff;
          sprite.alpha = isFullyVisible(tile, hostRect, cameraRef.current) ? 1 : 0.35;
        }
      }
    }

    drawVisibleRef.current = () => {
      void drawVisible();
    };
  }, [tiles, bounds]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <div ref={hostRef} className="h-full w-full touch-none" />
      {overlay ? (
        <VideoOverlay
          playbackUrl={overlay.playbackUrl}
          posterUrl={overlay.posterUrl}
          rect={overlay.rect}
          onClose={() => setOverlay(null)}
        />
      ) : null}
    </div>
  );

  function nudgeZoom(multiplier: number) {
    const host = hostRef.current;
    if (!host) return;
    const centerX = host.clientWidth / 2;
    const centerY = host.clientHeight / 2;
    const prevZoom = cameraRef.current.zoom;
    const nextZoom = clamp(prevZoom * multiplier, MIN_ZOOM, MAX_ZOOM);

    const worldX = (centerX - cameraRef.current.x) / prevZoom;
    const worldY = (centerY - cameraRef.current.y) / prevZoom;
    cameraRef.current.zoom = nextZoom;
    cameraRef.current.x = centerX - worldX * nextZoom;
    cameraRef.current.y = centerY - worldY * nextZoom;

    if (worldRef.current) {
      worldRef.current.position.set(cameraRef.current.x, cameraRef.current.y);
      worldRef.current.scale.set(cameraRef.current.zoom);
    }
    drawVisibleRef.current();
    onZoomChange?.(cameraRef.current.zoom);
  }

  function focusOnTile(tile: Tile) {
    const host = hostRef.current;
    if (!host) return;
    const targetZoom = clamp(
      Math.min((host.clientWidth * 0.8) / tile.w, (host.clientHeight * 0.8) / tile.h),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    const targetX = host.clientWidth / 2 - (tile.x + tile.w / 2) * targetZoom;
    const targetY = host.clientHeight / 2 - (tile.y + tile.h / 2) * targetZoom;
    activeAnimationRef.current = {
      start: performance.now(),
      duration: 260,
      from: { ...cameraRef.current },
      to: { x: targetX, y: targetY, zoom: targetZoom },
    };
    focusedIdRef.current = tile.item.id;
  }

  function clearFocus() {
    focusedIdRef.current = null;
    setOverlay(null);
    drawVisibleRef.current();
  }
});

function layoutTiles(items: GridMediaItem[]): Tile[] {
  const colWidth = TILE_BASE;
  const columns = Math.max(8, Math.ceil(Math.sqrt(items.length)));
  const heights = new Array(columns).fill(0);
  const tiles: Tile[] = [];

  for (const item of items) {
    const col = heights.indexOf(Math.min(...heights));
    const w = colWidth;
    const h = Math.round(colWidth / clamp(item.aspect || 1, 0.5, 2));
    const x = col * (colWidth + GAP);
    const y = heights[col];

    heights[col] += h + GAP;
    tiles.push({ item, x, y, w, h });
  }

  return tiles;
}

function contentBounds(tiles: Tile[]) {
  if (!tiles.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const minX = Math.min(...tiles.map((tile) => tile.x));
  const minY = Math.min(...tiles.map((tile) => tile.y));
  const maxX = Math.max(...tiles.map((tile) => tile.x + tile.w));
  const maxY = Math.max(...tiles.map((tile) => tile.y + tile.h));
  return { minX, minY, maxX, maxY };
}

function visibleTiles(tiles: Tile[], width: number, height: number, camera: Camera) {
  const left = (-camera.x - 200) / camera.zoom;
  const top = (-camera.y - 200) / camera.zoom;
  const right = (width - camera.x + 200) / camera.zoom;
  const bottom = (height - camera.y + 200) / camera.zoom;

  return tiles.filter((tile) => tile.x < right && tile.x + tile.w > left && tile.y < bottom && tile.y + tile.h > top);
}

function hitTest(tiles: Tile[], clientX: number, clientY: number, hostRect: DOMRect, camera: Camera) {
  const x = (clientX - hostRect.left - camera.x) / camera.zoom;
  const y = (clientY - hostRect.top - camera.y) / camera.zoom;
  for (let i = tiles.length - 1; i >= 0; i -= 1) {
    const tile = tiles[i];
    if (x >= tile.x && x <= tile.x + tile.w && y >= tile.y && y <= tile.y + tile.h) {
      return tile;
    }
  }
  return null;
}

function tileToScreenRect(tile: Tile, camera: Camera) {
  return {
    left: camera.x + tile.x * camera.zoom,
    top: camera.y + tile.y * camera.zoom,
    width: tile.w * camera.zoom,
    height: tile.h * camera.zoom,
  };
}

function isFullyVisible(tile: Tile, hostRect: DOMRect, camera: Camera) {
  const rect = tileToScreenRect(tile, camera);
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  return rect.left >= 0 && rect.top >= 0 && right <= hostRect.width && bottom <= hostRect.height;
}

function distanceToCenter(tile: Tile, width: number, height: number, camera: Camera) {
  const cx = camera.x + (tile.x + tile.w / 2) * camera.zoom;
  const cy = camera.y + (tile.y + tile.h / 2) * camera.zoom;
  const dx = cx - width / 2;
  const dy = cy - height / 2;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
