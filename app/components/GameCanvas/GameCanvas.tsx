import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
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
const DEFAULT_SIDE_PADDING = 0;
const MIN_ZOOM = 0.10;
const MAX_ZOOM = 3;
const HIGH_ZOOM_RESET = 2.2;
const AUTO_INFO_ZOOM = 2.0;
const AUTO_INFO_VISIBLE = 0.12;
const MAX_INFO_ZOOM = 6.0;

export type GameCanvasHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  getZoom: () => number;
  resetView: () => void;
};

export const GameCanvas = forwardRef<
  GameCanvasHandle,
  {
    items: GridMediaItem[];
    onZoomChange?: (zoom: number) => void;
    hasBackground?: boolean;
    hasMore?: boolean;
    onEndReached?: () => void;
    onToggleLike?: (id: string) => void;
  }
>(function GameCanvas({ items, onZoomChange, hasBackground, hasMore, onEndReached, onToggleLike }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<any>(null);
  const worldRef = useRef<any>(null);
  const schedulerRef = useRef(new FetchScheduler());
  const texturesRef = useRef(new TextureCache(600));
  const spritesRef = useRef(new Map<string, any>());
  const lodRef = useRef(new Map<string, 0 | 1 | 2 | 3 | 4>());
  const urlRef = useRef(new Map<string, string>());
  const loadingIdsRef = useRef(new Set<string>());
  const tilesRef = useRef<Tile[]>([]);
  const boundsRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number }>({
    minX: 0,
    minY: 0,
    maxX: 1,
    maxY: 1,
  });
  const pendingDrawRef = useRef(false);
  const appReadyRef = useRef(false);
  const hasUserInteractedRef = useRef(false);
  const sizeReadyRef = useRef(false);
  const playTextureRef = useRef<any>(null);
  const videoIconTextureRef = useRef<any>(null);
  const lockTextureRef = useRef<any>(null);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusedRect, setFocusedRect] = useState<OverlayState["rect"] | null>(null);
  const [hoveredRect, setHoveredRect] = useState<OverlayState["rect"] | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const focusedRectRef = useRef<OverlayState["rect"] | null>(null);
  const focusedIdRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const didAutoCenterRef = useRef(false);
  const focusInterruptedRef = useRef(false);
  const drawVisibleRef = useRef<() => void>(() => undefined);
  const activeAnimationRef = useRef<CameraAnimation | null>(null);
  const overlayRef = useRef<OverlayState | null>(null);
  const onZoomChangeRef = useRef<typeof onZoomChange>(onZoomChange);
  const onEndReachedRef = useRef<typeof onEndReached>(onEndReached);
  const hasMoreRef = useRef<boolean | undefined>(hasMore);
  const lastEndTriggerRef = useRef(0);
  const layoutKey = useMemo(
    () => items.map((item) => `${item.id}:${item.type}:${item.aspect}:${item.hidden ? 1 : 0}`).join("|"),
    [items],
  );
  const tiles = useMemo(() => layoutTiles(items), [layoutKey]);
  const bounds = useMemo(() => contentBounds(tiles), [tiles]);

  const centerContent = useCallback((width: number, height: number) => {
    const camera = cameraRef.current;
    const tiles = tilesRef.current;
    const bounds = boundsRef.current;
    if (!tiles.length) return;
    const contentWidth = bounds.maxX - bounds.minX;
    const contentHeight = bounds.maxY - bounds.minY;
    const availableWidth = Math.max(1, width - DEFAULT_SIDE_PADDING * 2);
    const fitZoomY = contentHeight > 0 ? height / contentHeight : 1;
    const targetZoom = Math.min(1, fitZoomY);
    camera.zoom = targetZoom;
    camera.x =
      DEFAULT_SIDE_PADDING +
      (availableWidth - contentWidth * targetZoom) / 2 -
      bounds.minX * targetZoom;
    camera.y = height / 2 - (bounds.minY + bounds.maxY) / 2 * targetZoom;
  }, [tiles, bounds
  ]);

  useEffect(() => {
    overlayRef.current = overlay;
    if (overlay) {
      hoveredIdRef.current = null;
      setHoveredId(null);
      setHoveredRect(null);
    }
  }, [overlay]);

  useEffect(() => {
    tilesRef.current = tiles;
    boundsRef.current = bounds;
    if (
      appReadyRef.current &&
      !hasUserInteractedRef.current &&
      !focusedIdRef.current &&
      !overlayRef.current &&
      !didAutoCenterRef.current
    ) {
      const host = hostRef.current;
      if (host) {
        const rect = host.getBoundingClientRect();
        const width = rect.width || host.clientWidth || window.innerWidth;
        const height = rect.height || host.clientHeight || window.innerHeight;
        if (!width || !height) return;
        sizeReadyRef.current = true;
        centerContent(width, height);
        if (worldRef.current) {
          worldRef.current.position.set(cameraRef.current.x, cameraRef.current.y);
          worldRef.current.scale.set(cameraRef.current.zoom);
        }
        didAutoCenterRef.current = true;
      }
    }
    if (appReadyRef.current && sizeReadyRef.current) {
      requestAnimationFrame(() => drawVisibleRef.current());
    } else {
      pendingDrawRef.current = true;
    }
  }, [tiles, bounds]);

  useEffect(() => {
    if (items.length === 0) {
      didAutoCenterRef.current = false;
    }
  }, [items.length]);

  useEffect(() => {
    if (!focusedIdRef.current) return;
    const stillThere = items.find((item) => item.id === focusedIdRef.current);
    if (!stillThere) {
      clearFocus();
    }
  }, [items]);


  useEffect(() => {
    onZoomChangeRef.current = onZoomChange;
  }, [onZoomChange]);

  useEffect(() => {
    onEndReachedRef.current = onEndReached;
    hasMoreRef.current = hasMore;
  }, [onEndReached, hasMore]);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => nudgeZoom(1.15),
      zoomOut: () => nudgeZoom(0.85),
      getZoom: () => cameraRef.current.zoom,
      resetView: () => resetView(),
    }),
    [],
  );

  useEffect(() => {
    let mounted = true;
    const hostMaybe = hostRef.current;
    if (!hostMaybe) return;
    const host: HTMLDivElement = hostMaybe;

  let ApplicationCtor: any;
  let ContainerCtor: any;
  let SpriteCtor: any;
  let GraphicsCtor: any;
  let TextCtor: any;
  let TextureCtor: any;
  let AssetsModule: any;
    let app: any = null;
    let world: any = null;
    let appInitialized = false;

    async function init() {
      if (typeof window === "undefined") return;
    const pixi = await import("pixi.js");
    ApplicationCtor = pixi.Application;
    ContainerCtor = pixi.Container;
    SpriteCtor = pixi.Sprite;
    GraphicsCtor = pixi.Graphics;
    TextCtor = pixi.Text;
    TextureCtor = pixi.Texture;
    AssetsModule = pixi.Assets;

      app = new ApplicationCtor();
      world = new ContainerCtor();
      world.sortableChildren = true;

      await app.init({
        resizeTo: host as HTMLElement,
        antialias: true,
        backgroundAlpha: hasBackground ? 0 : 1,
        backgroundColor: 0x000000,
      });
      appInitialized = true;
      if (!mounted) return;
      host.appendChild(app.canvas);
      app.stage.addChild(world);
      appRef.current = app;
      worldRef.current = world;
      appReadyRef.current = true;
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        sizeReadyRef.current = true;
      }

      const scheduleLayout = () => {
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const width = rect.width || host.clientWidth || window.innerWidth;
        const height = rect.height || host.clientHeight || window.innerHeight;
        if (!width || !height) return;
        sizeReadyRef.current = true;
        centerContent(width, height);
        if (worldRef.current) {
          worldRef.current.position.set(cameraRef.current.x, cameraRef.current.y);
          worldRef.current.scale.set(cameraRef.current.zoom);
        }
        void drawVisible();
      };
      const ensureSized = () => {
        if (!host) return;
        const rect = host.getBoundingClientRect();
        if ((rect.width || host.clientWidth) === 0 || (rect.height || host.clientHeight) === 0) {
          requestAnimationFrame(ensureSized);
          return;
        }
        scheduleLayout();
      };
      requestAnimationFrame(() => requestAnimationFrame(ensureSized));
      onZoomChangeRef.current?.(cameraRef.current.zoom);

      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const pointers = new Map<number, { x: number; y: number }>();
      let pinchDistance = 0;
      let pinchWorldCenter = { x: 0, y: 0 };
      let pinchScreenCenter = { x: 0, y: 0 };

      const onPointerDown = (event: PointerEvent) => {
        hasUserInteractedRef.current = true;
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
          hasUserInteractedRef.current = true;
          if (overlayRef.current) {
            closeVideoOverlay();
          }
          interruptFocus();
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
            clampCamera(hostRect.width, hostRect.height);
            pinchDistance = nextDistance;
            drawVisible();
            onZoomChangeRef.current?.(cameraRef.current.zoom);
          }
          return;
        }
        if (!dragging) {
          if (event.pointerType === "mouse" && !overlayRef.current) {
            const tile = hitTest(tilesRef.current, event.clientX, event.clientY, host.getBoundingClientRect(), cameraRef.current);
            if (!tile || tile.item.hidden) {
              if (hoveredIdRef.current) {
                hoveredIdRef.current = null;
                setHoveredId(null);
                setHoveredRect(null);
              }
              return;
            }
            const pixelSize = tile.w * cameraRef.current.zoom;
            if (pixelSize < 120) {
              if (hoveredIdRef.current) {
                hoveredIdRef.current = null;
                setHoveredId(null);
                setHoveredRect(null);
              }
              return;
            }
            if (hoveredIdRef.current !== tile.item.id) {
              hoveredIdRef.current = tile.item.id;
              setHoveredId(tile.item.id);
            }
            setHoveredRect(tileToScreenRect(tile, cameraRef.current));
          }
          return;
        }
        if (overlayRef.current) {
          closeVideoOverlay();
        }
        hasUserInteractedRef.current = true;
        interruptFocus();
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        cameraRef.current.x += dx;
        cameraRef.current.y += dy;
        clampCamera(host.clientWidth, host.clientHeight);
        drawVisible();
        onZoomChangeRef.current?.(cameraRef.current.zoom);
      };

      const onPointerUp = (event: PointerEvent) => {
        pointers.delete(event.pointerId);
        if (pointers.size < 2) pinchDistance = 0;
        dragging = pointers.size > 0;
      };

      const onMouseLeave = () => {
        hoveredIdRef.current = null;
        setHoveredId(null);
        setHoveredRect(null);
      };

      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        hasUserInteractedRef.current = true;
        if (overlayRef.current) {
          closeVideoOverlay();
        }
        interruptFocus();
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
        clampCamera(hostRect.width, hostRect.height);

        drawVisible();
        onZoomChangeRef.current?.(cameraRef.current.zoom);
      };

      const onClick = async (event: MouseEvent) => {
        if (event.detail > 1) return;
        const tile = hitTest(tilesRef.current, event.clientX, event.clientY, host.getBoundingClientRect(), cameraRef.current);
        if (!tile || tile.item.hidden) return;
        if (tile.item.type !== "video") return;
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
        hasUserInteractedRef.current = true;
        if (focusInterruptedRef.current) {
          resetView();
          return;
        }
        if (!focusedIdRef.current && cameraRef.current.zoom >= HIGH_ZOOM_RESET) {
          resetView();
          return;
        }
        const tile = hitTest(tilesRef.current, event.clientX, event.clientY, host.getBoundingClientRect(), cameraRef.current);
        if (!tile || tile.item.hidden) {
          clearFocus();
          return;
        }

        if (focusedIdRef.current === tile.item.id) {
          resetView();
          return;
        }

        goToTile(tile);
      };

      const onResize = () => {
        if (!host) return;
        if (!overlayRef.current && !focusedIdRef.current && !didAutoCenterRef.current) {
          centerContent(host.clientWidth, host.clientHeight);
          didAutoCenterRef.current = true;
        }
        drawVisible();
        onZoomChangeRef.current?.(cameraRef.current.zoom);
      };

      host.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      host.addEventListener("wheel", onWheel, { passive: false });
      host.addEventListener("click", onClick);
      host.addEventListener("dblclick", onDoubleClick);
      host.addEventListener("mouseleave", onMouseLeave);
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
          onZoomChangeRef.current?.(cameraRef.current.zoom);
          if (t >= 1) activeAnimationRef.current = null;
        }
        if (overlayRef.current) {
          const tile = tilesRef.current.find((value) => value.item.id === overlayRef.current?.id);
          if (tile && host) {
            const rect = tileToScreenRect(tile, cameraRef.current);
            setOverlay((prev) => (prev ? { ...prev, rect } : prev));
          }
        }
        if (loadingIdsRef.current.size > 0) {
          const now = performance.now();
          for (const id of loadingIdsRef.current) {
            const sprite = spritesRef.current.get(id);
            if (sprite) sprite.alpha = loadingAlpha(now);
          }
        }
        if (spritesRef.current.size > 0) {
          const now = performance.now();
          for (const sprite of spritesRef.current.values()) {
            const border = (sprite as any).__border;
            if (border) {
              const pulse = 0.35 + 0.25 * Math.sin(now / 900);
              border.alpha = (sprite.alpha ?? 1) * pulse;
            }
          }
        }
      };
      app.ticker.add(ticker);

      const resizeObserver = new ResizeObserver(() => {
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const width = rect.width || host.clientWidth || window.innerWidth;
        const height = rect.height || host.clientHeight || window.innerHeight;
        if (!width || !height) return;
        sizeReadyRef.current = true;
        if (!hasUserInteractedRef.current && !focusedIdRef.current && !overlayRef.current && !didAutoCenterRef.current) {
          centerContent(width, height);
          didAutoCenterRef.current = true;
        }
        if (worldRef.current) {
          worldRef.current.position.set(cameraRef.current.x, cameraRef.current.y);
          worldRef.current.scale.set(cameraRef.current.zoom);
        }
        if (pendingDrawRef.current) {
          pendingDrawRef.current = false;
        }
        requestAnimationFrame(() => drawVisible());
      });
      resizeObserver.observe(host);

      return () => {
        app.ticker.remove(ticker);
        resizeObserver.disconnect();
        host.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        host.removeEventListener("wheel", onWheel);
        host.removeEventListener("click", onClick);
        host.removeEventListener("dblclick", onDoubleClick);
        host.removeEventListener("mouseleave", onMouseLeave);
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
      appReadyRef.current = false;
      sizeReadyRef.current = false;
    };

    async function drawVisible() {
      const app = appRef.current;
      const world = worldRef.current;
      if (!app || !world || !host) return;

      world.position.set(cameraRef.current.x, cameraRef.current.y);
      world.scale.set(cameraRef.current.zoom);

      const hostRect = host.getBoundingClientRect();
      const visible = visibleTiles(tilesRef.current, hostRect.width, hostRect.height, cameraRef.current);
      const visibleSet = new Set(visible.map((tile) => tile.item.id));

      for (const [id, sprite] of spritesRef.current.entries()) {
        if (!visibleSet.has(id)) {
          const playSprite = (sprite as any).__play;
          if (playSprite) world.removeChild(playSprite);
          const info = (sprite as any).__info;
          if (info?.group) world.removeChild(info.group);
          world.removeChild(sprite);
          spritesRef.current.delete(id);
        }
      }

      const requests: Array<{ id: string; lod: 0 | 1 | 2 | 3 | 4; kind?: "lod" | "blur"; priority: number }> = [];

      for (const tile of visible) {
        const isHidden = tile.item.hidden === true;
        const px = tile.w * cameraRef.current.zoom;
        const prev = lodRef.current.get(tile.item.id) ?? null;
        const lod = isHidden ? 0 : pickLod(px, prev);
        const kind: "lod" | "blur" = isHidden ? "blur" : "lod";
        lodRef.current.set(tile.item.id, lod);
        const key = `${tile.item.id}:${kind}:${lod}`;
        const texture = texturesRef.current.get(key);

        let sprite = spritesRef.current.get(tile.item.id);
        if (!sprite) {
          sprite = new SpriteCtor(TextureCtor.WHITE);
          sprite.x = tile.x;
          sprite.y = tile.y;
          sprite.width = tile.w;
          sprite.height = tile.h;
          sprite.zIndex = 1;
          sprite.sortableChildren = true;
          spritesRef.current.set(tile.item.id, sprite);
          world.addChild(sprite);
          if (tile.item.type === "video") {
            if (!playTextureRef.current) {
              const svg = encodeURIComponent(
                `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
                  `<circle cx="32" cy="32" r="28" fill="rgba(15,23,42,0.75)"/>` +
                  `<path d="M26 20l20 12-20 12z" fill="#f8fafc"/>` +
                `</svg>`,
              );
              playTextureRef.current = TextureCtor.from(`data:image/svg+xml,${svg}`);
            }
            if (!videoIconTextureRef.current) {
              const svg = encodeURIComponent(
                `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
                  `<rect x="3" y="6" width="12" height="12" rx="2" fill="rgba(148,163,184,0.75)"/>` +
                  `<path d="M15 10l6-3v10l-6-3z" fill="rgba(226,232,240,0.9)"/>` +
                `</svg>`,
              );
              videoIconTextureRef.current = TextureCtor.from(`data:image/svg+xml,${svg}`);
            }
            const playSprite = new SpriteCtor(playTextureRef.current);
            playSprite.anchor.set(0.5);
            playSprite.zIndex = 3;
            world.addChild(playSprite);
            (sprite as any).__play = playSprite;
            const border = new GraphicsCtor();
            border.zIndex = 4;
            sprite.addChild(border);
            (sprite as any).__border = border;
            const icon = new SpriteCtor(videoIconTextureRef.current);
            icon.anchor.set(0, 0);
            icon.zIndex = 5;
            sprite.addChild(icon);
            (sprite as any).__videoIcon = icon;
          }
        }
        positionPlaySprite(sprite, tile);
        positionVideoExtras(sprite, tile, isHidden);
        positionLockSprite(sprite, tile, isHidden, cameraRef.current, SpriteCtor, TextureCtor, lockTextureRef);
        (sprite as any).__focused = focusedIdRef.current === tile.item.id;
        const infoOverlay = ensureInfoOverlay(sprite, TextCtor, GraphicsCtor, ContainerCtor);
        if (infoOverlay && !(sprite as any).__infoAdded) {
          world.addChild(infoOverlay.group);
          (sprite as any).__infoAdded = true;
        }

        if (isHidden && !texture) {
          sprite.texture = TextureCtor.WHITE;
          sprite.tint = 0x1f2937;
        } else if (texture) {
          sprite.texture = texture;
          sprite.x = tile.x;
          sprite.y = tile.y;
          sprite.width = tile.w;
          sprite.height = tile.h;
          positionPlaySprite(sprite, tile);
          positionVideoExtras(sprite, tile, isHidden);
          positionLockSprite(sprite, tile, isHidden, cameraRef.current, SpriteCtor, TextureCtor, lockTextureRef);
          sprite.alpha = computeSpriteAlpha(tile, hostRect, cameraRef.current);
          updateInfoOverlay({
            sprite,
            tile,
            camera: cameraRef.current,
            hostRect,
            TextCtor,
            GraphicsCtor,
            ContainerCtor,
          });
          const playSprite = (sprite as any).__play;
          if (playSprite) playSprite.alpha = sprite.alpha;
          const border = (sprite as any).__border;
          if (border) border.alpha = sprite.alpha;
          const icon = (sprite as any).__videoIcon;
          if (icon) icon.alpha = sprite.alpha;
          loadingIdsRef.current.delete(tile.item.id);
          continue;
        }

        sprite.x = tile.x;
        sprite.y = tile.y;
          sprite.width = tile.w;
          sprite.height = tile.h;
          sprite.tint = tile.item.type === "video" ? 0x1f2937 : 0x334155;
          sprite.alpha = loadingAlpha(performance.now());
          positionVideoExtras(sprite, tile, isHidden);
          positionLockSprite(sprite, tile, isHidden, cameraRef.current, SpriteCtor, TextureCtor, lockTextureRef);
          updateInfoOverlay({
            sprite,
            tile,
            camera: cameraRef.current,
            hostRect,
            TextCtor,
            GraphicsCtor,
            ContainerCtor,
          });
        loadingIdsRef.current.add(tile.item.id);
        if (!urlRef.current.has(key)) {
          requests.push({
            id: tile.item.id,
            lod,
            kind,
            priority: distanceToCenter(tile, hostRect.width, hostRect.height, cameraRef.current),
          });
        }
      }

      const loaded = await schedulerRef.current.fetchUrls(requests);
      for (const item of loaded) {
        if (!item.url) continue;
        const key = `${item.id}:${item.kind ?? "lod"}:${item.lod}`;
        if (urlRef.current.get(key) === item.url) continue;
        urlRef.current.set(key, item.url);
        const texture = await AssetsModule.load(item.url);
        texturesRef.current.set(key, texture);
      }

      for (const tile of visible) {
        const isHidden = tile.item.hidden === true;
        const lod = lodRef.current.get(tile.item.id);
        if (lod === undefined) continue;
        const kind: "lod" | "blur" = isHidden ? "blur" : "lod";
        const key = `${tile.item.id}:${kind}:${lod}`;
        const texture = texturesRef.current.get(key);
        const sprite = spritesRef.current.get(tile.item.id);
        if (sprite && isHidden && !texture) {
          sprite.texture = TextureCtor.WHITE;
          sprite.tint = 0x1f2937;
          positionLockSprite(sprite, tile, true, cameraRef.current, SpriteCtor, TextureCtor, lockTextureRef);
        } else if (sprite && texture) {
          sprite.texture = texture;
          sprite.tint = 0xffffff;
          sprite.x = tile.x;
          sprite.y = tile.y;
          sprite.width = tile.w;
          sprite.height = tile.h;
          positionPlaySprite(sprite, tile);
          positionVideoExtras(sprite, tile, isHidden);
          positionLockSprite(sprite, tile, isHidden, cameraRef.current, SpriteCtor, TextureCtor, lockTextureRef);
          sprite.alpha = computeSpriteAlpha(tile, hostRect, cameraRef.current);
          updateInfoOverlay({
            sprite,
            tile,
            camera: cameraRef.current,
            hostRect,
            TextCtor,
            GraphicsCtor,
            ContainerCtor,
          });
          const playSprite = (sprite as any).__play;
          if (playSprite) playSprite.alpha = sprite.alpha;
          const border = (sprite as any).__border;
          if (border) border.alpha = sprite.alpha;
          const icon = (sprite as any).__videoIcon;
          if (icon) icon.alpha = sprite.alpha;
          const lock = (sprite as any).__lock;
          if (lock) lock.alpha = sprite.alpha;
          loadingIdsRef.current.delete(tile.item.id);
        }
      }

      updateFocusedRect(hostRect);
      maybeTriggerEndReached(hostRect);
    }

    drawVisibleRef.current = () => {
      void drawVisible();
    };
    if (pendingDrawRef.current) {
      pendingDrawRef.current = false;
      requestAnimationFrame(() => drawVisible());
    }
  }, [centerContent]);

  const focusedIndex = useMemo(() => {
    if (!focusedId) return -1;
    return tiles.findIndex((tile) => tile.item.id === focusedId);
  }, [tiles, focusedId]);

  const prevTile = useMemo(() => findAdjacentTile(-1), [tiles, focusedIndex]);
  const nextTile = useMemo(() => findAdjacentTile(1), [tiles, focusedIndex]);

  const likeTarget = useMemo(() => {
    if (overlay) return { id: overlay.id, rect: overlay.rect };
    if (focusedRect && focusedId) return { id: focusedId, rect: focusedRect };
    if (hoveredRect && hoveredId) return { id: hoveredId, rect: hoveredRect };
    return null;
  }, [overlay, focusedRect, focusedId, hoveredRect, hoveredId]);
  const likeItem = useMemo(
    () => (likeTarget ? items.find((item) => item.id === likeTarget.id) ?? null : null),
    [items, likeTarget],
  );

  return (
    <div className={`relative h-full w-full overflow-hidden ${hasBackground ? "bg-transparent" : "bg-black"}`}>
      <div ref={hostRef} className="h-full w-full touch-none" />
      {overlay ? (
        <VideoOverlay
          playbackUrl={overlay.playbackUrl}
          posterUrl={overlay.posterUrl}
          rect={overlay.rect}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {likeTarget && likeItem && !likeItem.hidden ? (
        <div
          style={{
            position: "absolute",
            left: likeTarget.rect.left + likeTarget.rect.width - 46,
            top: likeTarget.rect.top + 10,
            zIndex: 26,
          }}
          className="pointer-events-auto flex items-center gap-2"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onPointerUp={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            aria-pressed={Boolean(likeItem.liked)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              hasUserInteractedRef.current = true;
              onToggleLike?.(likeItem.id);
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              hasUserInteractedRef.current = true;
            }}
            onPointerUp={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            className={`flex h-9 w-9 items-center justify-center rounded-full border text-sm shadow-lg backdrop-blur ${
              likeItem.liked
                ? "border-rose-400/70 bg-rose-500/30 text-rose-200"
                : "border-white/20 bg-black/70 text-white"
            }`}
            aria-label={likeItem.liked ? "Unlike" : "Like"}
          >
            ♥
          </button>
          <div className="rounded-full border border-white/10 bg-black/70 px-2 py-1 text-xs text-slate-100 shadow-lg backdrop-blur">
            {formatLikeCount(likeItem.likesCount ?? 0)}
          </div>
        </div>
      ) : null}
      {focusedRect && prevTile ? (
        <button
          className="pointer-events-auto absolute z-30 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white shadow-lg backdrop-blur transition hover:bg-black/80"
          style={navButtonStyle(focusedRect, "prev")}
          onClick={() => goToTile(prevTile)}
          aria-label="Previous"
        >
          ‹
        </button>
      ) : null}
      {focusedRect && nextTile ? (
        <button
          className="pointer-events-auto absolute z-30 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white shadow-lg backdrop-blur transition hover:bg-black/80"
          style={navButtonStyle(focusedRect, "next")}
          onClick={() => goToTile(nextTile)}
          aria-label="Next"
        >
          ›
        </button>
      ) : null}
      {null}
    </div>
  );

  function nudgeZoom(multiplier: number) {
    const host = hostRef.current;
    if (!host) return;
    if (overlayRef.current) closeVideoOverlay();
    interruptFocus();
    const centerX = host.clientWidth / 2;
    const centerY = host.clientHeight / 2;
    const prevZoom = cameraRef.current.zoom;
    const nextZoom = clamp(prevZoom * multiplier, MIN_ZOOM, MAX_ZOOM);

    const worldX = (centerX - cameraRef.current.x) / prevZoom;
    const worldY = (centerY - cameraRef.current.y) / prevZoom;
    cameraRef.current.zoom = nextZoom;
    cameraRef.current.x = centerX - worldX * nextZoom;
    cameraRef.current.y = centerY - worldY * nextZoom;
    clampCamera(host.clientWidth, host.clientHeight);

    if (worldRef.current) {
      worldRef.current.position.set(cameraRef.current.x, cameraRef.current.y);
      worldRef.current.scale.set(cameraRef.current.zoom);
    }
    drawVisibleRef.current();
    onZoomChangeRef.current?.(cameraRef.current.zoom);
  }

  function resetView() {
    const host = hostRef.current;
    if (!host) return;
    if (overlayRef.current) closeVideoOverlay();
    clearFocus();
    focusInterruptedRef.current = false;
    centerContent(host.clientWidth, host.clientHeight);
    clampCamera(host.clientWidth, host.clientHeight);
    if (worldRef.current) {
      worldRef.current.position.set(cameraRef.current.x, cameraRef.current.y);
      worldRef.current.scale.set(cameraRef.current.zoom);
    }
    drawVisibleRef.current();
    onZoomChangeRef.current?.(cameraRef.current.zoom);
  }

  function focusOnTile(tile: Tile) {
    const host = hostRef.current;
    if (!host) return;
    focusInterruptedRef.current = false;
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
    setFocusedId(tile.item.id);
  }

  function clearFocus() {
    focusedIdRef.current = null;
    setFocusedId(null);
    focusedRectRef.current = null;
    setFocusedRect(null);
    setOverlay(null);
    drawVisibleRef.current();
  }

  function closeVideoOverlay() {
    setOverlay(null);
  }

  function interruptFocus() {
    if (!focusedIdRef.current) return;
    focusInterruptedRef.current = true;
    clearFocus();
  }

  function maybeTriggerEndReached(hostRect: DOMRect) {
    if (!hasMoreRef.current || !onEndReachedRef.current) return;
    const now = performance.now();
    if (now - lastEndTriggerRef.current < 800) return;
    const bounds = boundsRef.current;
    const viewBottomWorld = (-cameraRef.current.y + hostRect.height) / cameraRef.current.zoom;
    if (bounds.maxY - viewBottomWorld < 420) {
      lastEndTriggerRef.current = now;
      onEndReachedRef.current?.();
    }
  }

  function clampCamera(width: number, height: number) {
    const bounds = boundsRef.current;
    const zoom = cameraRef.current.zoom;
    const padding = 80;
    const minX = width - padding - bounds.maxX * zoom;
    const maxX = padding - bounds.minX * zoom;
    const minY = height - padding - bounds.maxY * zoom;
    const maxY = padding - bounds.minY * zoom;

    if (minX > maxX) {
      cameraRef.current.x = (minX + maxX) / 2;
    } else {
      cameraRef.current.x = clamp(cameraRef.current.x, minX, maxX);
    }
    if (minY > maxY) {
      cameraRef.current.y = (minY + maxY) / 2;
    } else {
      cameraRef.current.y = clamp(cameraRef.current.y, minY, maxY);
    }
  }

  function updateFocusedRect(hostRect: DOMRect) {
    const activeId = focusedIdRef.current;
    if (!activeId) {
      if (focusedRectRef.current) {
        focusedRectRef.current = null;
        setFocusedRect(null);
      }
      return;
    }
    const tile = tilesRef.current.find((value) => value.item.id === activeId);
    if (!tile) return;
    const rect = tileToScreenRect(tile, cameraRef.current);
    const prev = focusedRectRef.current;
    if (!prev || rectDiff(prev, rect) > 0.5) {
      focusedRectRef.current = rect;
      setFocusedRect(rect);
    }
  }

  function rectDiff(a: OverlayState["rect"], b: OverlayState["rect"]) {
    return Math.max(
      Math.abs(a.left - b.left),
      Math.abs(a.top - b.top),
      Math.abs(a.width - b.width),
      Math.abs(a.height - b.height),
    );
  }

  function goToTile(tile: Tile) {
    if (overlayRef.current) closeVideoOverlay();
    focusOnTile(tile);
    if (tile.item.type === "video") {
      getVideoPlayback(tile.item.id)
        .then((data) => {
          setOverlay({
            id: tile.item.id,
            playbackUrl: data.playbackUrl,
            posterUrl: data.posterUrl,
            rect: tileToScreenRect(tile, cameraRef.current),
          });
        })
        .catch(() => undefined);
    } else {
      setOverlay(null);
    }
  }

  function findAdjacentTile(direction: -1 | 1) {
    if (focusedIndex < 0) return null;
    for (let i = focusedIndex + direction; i >= 0 && i < tiles.length; i += direction) {
      const candidate = tiles[i];
      if (!candidate.item.hidden) return candidate;
    }
    return null;
  }

  function navButtonStyle(rect: OverlayState["rect"], side: "prev" | "next") {
    const host = hostRef.current;
    const hostWidth = host?.clientWidth ?? 0;
    const hostHeight = host?.clientHeight ?? 0;
    const size = 44;
    const offset = 10;
    const rawLeft = side === "prev" ? rect.left - size - offset : rect.left + rect.width + offset;
    const left = hostWidth ? clamp(rawLeft, 8, hostWidth - size - 8) : rawLeft;
    const rawTop = rect.top + rect.height / 2 - size / 2;
    const top = hostHeight ? clamp(rawTop, 8, hostHeight - size - 8) : rawTop;
    return { left, top };
  }

  function computeSpriteAlpha(tile: Tile, hostRect: DOMRect, camera: Camera) {
    const base = 1;
    const focusedId = focusedIdRef.current;
    if (!focusedId) return base;
    if (tile.item.id === focusedId) return 1;
    return Math.min(base, 0.22);
  }
});

function layoutTiles(items: GridMediaItem[]): Tile[] {
  const colWidth = TILE_BASE;
  const columns = Math.max(8, Math.ceil(estimateColumnsForSquare(items, colWidth, GAP)));
  const heights = new Array(columns).fill(0);
  const tiles: Tile[] = [];

  for (const item of items) {
    const col = heights.indexOf(Math.min(...heights));
    const w = colWidth;
    const aspect = item.aspect ?? 1;
    const safeAspect = aspect > 0 ? aspect : 1;
    const h = Math.round(colWidth / safeAspect);
    const x = col * (colWidth + GAP);
    const y = heights[col];

    heights[col] += h + GAP;
    tiles.push({ item, x, y, w, h });
  }

  return tiles;
}

function estimateColumnsForSquare(items: GridMediaItem[], colWidth: number, gap: number) {
  const count = items.length;
  if (!count) return 1;
  const invAspectSum = items.reduce((sum, item) => {
    const aspect = item.aspect ?? 1;
    const safeAspect = aspect > 0 ? aspect : 1;
    return sum + 1 / safeAspect;
  }, 0);
  const totalHeights = colWidth * invAspectSum + gap * count;
  const unitWidth = colWidth + gap;
  const estimate = Math.sqrt(totalHeights / unitWidth);
  return clampNumber(estimate, 6, 80);
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
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

function positionPlaySprite(sprite: any, tile: Tile) {
  const playSprite = (sprite as any).__play;
  if (!playSprite) return;
  const size = Math.max(20, Math.min(tile.w, tile.h) * 0.28);
  playSprite.width = size;
  playSprite.height = size;
  playSprite.position.set(tile.x + tile.w / 2, tile.y + tile.h / 2);
}

function positionVideoExtras(sprite: any, tile: Tile, hidden: boolean) {
  const border = (sprite as any).__border;
  const icon = (sprite as any).__videoIcon;
  if (!border && !icon) return;
  if (hidden) {
    if (border) border.clear();
    if (icon) icon.visible = false;
    const play = (sprite as any).__play;
    if (play) play.visible = false;
    return;
  }
  if (border) {
    border.x = 0;
    border.y = 0;
    border.clear();
    border.lineStyle({ width: 3, color: 0x38bdf8, alpha: 0.9 });
    border.drawRoundedRect(0, 0, tile.w, tile.h, 12);
  }
  if (icon) {
    icon.visible = true;
    const size = Math.max(14, Math.min(tile.w, tile.h) * 0.14);
    icon.width = size;
    icon.height = size;
    icon.position.set(10, 10);
  }
}

function positionLockSprite(
  sprite: any,
  tile: Tile,
  hidden: boolean,
  camera: Camera,
  SpriteCtor: any,
  TextureCtor: any,
  lockTextureRef: { current: any },
) {
  let lock = (sprite as any).__lock;
  if (!lock) {
    if (!lockTextureRef.current) {
      const svg = encodeURIComponent(
        `<svg fill="#777" width="800px" height="800px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" enable-background="new 0 0 24 24">` +
          `<path d="M17,9V7c0-2.8-2.2-5-5-5S7,4.2,7,7v2c-1.7,0-3,1.3-3,3v7c0,1.7,1.3,3,3,3h10c1.7,0,3-1.3,3-3v-7C20,10.3,18.7,9,17,9z M9,7c0-1.7,1.3-3,3-3s3,1.3,3,3v2H9V7z M13.1,15.5c0,0-0.1,0.1-0.1,0.1V17c0,0.6-0.4,1-1,1s-1-0.4-1-1v-1.4c-0.6-0.6-0.7-1.5-0.1-2.1c0.6-0.6,1.5-0.7,2.1-0.1C13.6,13.9,13.7,14.9,13.1,15.5z"/>` +
        `</svg>`,
      );
      lockTextureRef.current = TextureCtor.from(`data:image/svg+xml,${svg}`);
    }
    lock = new SpriteCtor(lockTextureRef.current);
    lock.anchor.set(0.5);
    lock.zIndex = 10;
    sprite.addChild(lock);
    (sprite as any).__lock = lock;
  }

  lock.visible = hidden;
  if (!hidden) return;

  const baseScaleX = sprite.scale.x || 1;
  const baseScaleY = sprite.scale.y || 1;
  const maxWorld = Math.min(tile.w, tile.h) * 0.55;
  const sizeX = Math.min(36 / (camera.zoom * baseScaleX), maxWorld);
  const sizeY = Math.min(36 / (camera.zoom * baseScaleY), maxWorld);
  lock.width = sizeX;
  lock.height = sizeY;
  lock.position.set(tile.w / 2, tile.h / 2);
  lock.alpha = 1;
}

function ensureInfoOverlay(sprite: any, TextCtor: any, GraphicsCtor: any, ContainerCtor: any) {
  let overlay = (sprite as any).__info;
  if (overlay) return overlay;
  const group = new ContainerCtor();
  group.zIndex = 6;
  const bg = new GraphicsCtor();
  const baseTextStyle = {
    fontFamily: "\"Poppins\", \"Space Grotesk\", \"Inter\", sans-serif",
    fill: 0xffffff,
    fontWeight: "600",
    wordWrap: true,
    resolution: 3,
  };
  const title = new TextCtor("", {
    ...baseTextStyle,
    fontSize: 14,
  });
  const desc = new TextCtor("", {
    ...baseTextStyle,
    fontSize: 10,
    fill: 0xe2e8f0,
  });
  const date = new TextCtor("", {
    ...baseTextStyle,
    fontSize: 9,
    fill: 0xcbd5f5,
    wordWrap: false,
  });
  group.addChild(bg);
  group.addChild(title);
  group.addChild(desc);
  group.addChild(date);
  overlay = { group, bg, title, desc, date, mode: "none" };
  (sprite as any).__info = overlay;
  return overlay;
}

function updateInfoOverlay({
  sprite,
  tile,
  camera,
  hostRect,
  TextCtor,
  GraphicsCtor,
  ContainerCtor,
}: {
  sprite: any;
  tile: Tile;
  camera: Camera;
  hostRect: DOMRect;
  TextCtor: any;
  GraphicsCtor: any;
  ContainerCtor: any;
}) {
  const overlay = ensureInfoOverlay(sprite, TextCtor, GraphicsCtor, ContainerCtor);
  if (!overlay) return;
  if (tile.item.hidden) {
    overlay.group.visible = false;
    return;
  }
  const isFocused = (sprite as any).__focused === true;
  const withinZoomRange = camera.zoom <= MAX_INFO_ZOOM;
  const showAuto =
    !isFocused &&
    withinZoomRange &&
    camera.zoom >= AUTO_INFO_ZOOM &&
    visibleRatio(tile, hostRect, camera) >= AUTO_INFO_VISIBLE;

  if (!withinZoomRange || (!isFocused && !showAuto)) {
    overlay.group.visible = false;
    return;
  }

  overlay.group.visible = true;
  overlay.group.alpha = sprite.alpha ?? 1;
  overlay.group.x = tile.x;
  overlay.group.y = tile.y;

  const titleText = tile.item.title?.trim() || "Untitled";
  const descText = tile.item.description?.trim() || "";
  const dateText = formatDateLabel(tile.item);

  const paddingX = isFocused ? 12 : 10;
  const paddingY = isFocused ? 8 : 6;
  const maxWidth = Math.max(60, tile.w - paddingX * 2);

  overlay.title.style.fontSize = isFocused ? 11 : 10;
  overlay.desc.style.fontSize = isFocused ? 10 : 8;
  overlay.date.style.fontSize = isFocused ? 8 : 7;

  overlay.title.style.wordWrapWidth = maxWidth;
  overlay.desc.style.wordWrapWidth = maxWidth;

  overlay.title.text = titleText;
  overlay.desc.text = descText;
  overlay.date.text = dateText;

  const titleH = overlay.title.height;
  const descH = descText ? overlay.desc.height : 0;
  const dateH = overlay.date.height;
  const gap = descText ? (isFocused ? 4 : 3) : 0;
  const dateGap = isFocused ? 4 : 3;
  const totalHeight = paddingY + titleH + gap + descH + dateGap + dateH + paddingY;

  const bg = overlay.bg;
  bg.clear();
  bg.beginFill(0x000000, isFocused ? 0.65 : 0.5);
  bg.drawRect(0, tile.h - totalHeight, tile.w, totalHeight);
  bg.endFill();

  overlay.title.x = paddingX;
  overlay.title.y = tile.h - totalHeight + paddingY;
  if (descText) {
    overlay.desc.x = paddingX;
    overlay.desc.y = overlay.title.y + titleH + gap;
  }
  overlay.date.x = paddingX;
  overlay.date.y = tile.h - paddingY - dateH;
}

function isMostlyVisible(tile: Tile, hostRect: DOMRect, camera: Camera, threshold: number) {
  const rect = tileToScreenRect(tile, camera);
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const clampedRight = Math.min(right, hostRect.width);
  const clampedBottom = Math.min(bottom, hostRect.height);
  const visibleWidth = Math.max(0, clampedRight - left);
  const visibleHeight = Math.max(0, clampedBottom - top);
  const visibleArea = visibleWidth * visibleHeight;
  const area = rect.width * rect.height;
  if (area <= 0) return false;
  return visibleArea / area >= threshold;
}

function visibleRatio(tile: Tile, hostRect: DOMRect, camera: Camera) {
  const rect = tileToScreenRect(tile, camera);
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const clampedRight = Math.min(right, hostRect.width);
  const clampedBottom = Math.min(bottom, hostRect.height);
  const visibleWidth = Math.max(0, clampedRight - left);
  const visibleHeight = Math.max(0, clampedBottom - top);
  const visibleArea = visibleWidth * visibleHeight;
  const area = rect.width * rect.height;
  if (area <= 0) return 0;
  return visibleArea / area;
}

function loadingAlpha(now: number) {
  const phase = (now % 1200) / 1200;
  const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  return 0.75 + wave * 0.15;
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

function formatLikeCount(value: number) {
  if (!value) return "0";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatDateLabel(item: GridMediaItem) {
  const value = item.dateTaken ?? item.dateEffective ?? null;
  if (!value) return "Fecha desconocida";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha desconocida";
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}
