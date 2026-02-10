export type SessionUser = { id: string; email: string; role: "ADMIN" | "VIEWER" } | null;

export type MediaListItem = {
  id: string;
  type: "image" | "video";
  aspect: number;
  width?: number | null;
  height?: number | null;
  title?: string;
  description?: string;
  dateTaken?: string | null;
  dateEffective: string;
  hasLocation: boolean;
  visibility: "PUBLIC" | "PRIVATE";
  status: "processing" | "ready" | "error";
  errorMessage?: string | null;
  hidden?: boolean;
  title?: string;
  description?: string;
  placeName?: string;
  dateTaken?: string | null;
  tags?: string[];
  category?: string | null;
  sizeBytes?: number | null;
  variantSizes?: Record<string, number> | null;
  durationSeconds?: number | null;
  liked?: boolean;
  likesCount?: number;
  originalBytes?: number | null;
};

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      if (json.detail) {
        message = json.detail;
      } else if (Array.isArray(json.issues) && json.issues.length) {
        message = json.issues
          .map((issue: { path?: string; message?: string }) => {
            const path = issue.path ? `${issue.path}: ` : "";
            return `${path}${issue.message ?? ""}`.trim();
          })
          .filter(Boolean)
          .join(", ");
      } else {
        message = json.error ?? message;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

export function getMe() {
  return request<{ user: SessionUser }>("/api/auth/me", { headers: {} });
}

export function getAuthConfig() {
  return request<{ enableSelfSignup: boolean }>("/api/auth/config", { headers: {} });
}

export function login(email: string, password: string) {
  return request<{ ok: boolean }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function requestAccess(payload: { name: string; email: string }) {
  return request<{ ok: boolean }>("/api/auth/request-access", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function verifyAccessCode(payload: { email: string; code: string }) {
  return request<{ ok: boolean }>("/api/auth/verify-access", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function completeSignup(payload: { email: string; password: string; requestMessage: string }) {
  return request<{ ok: boolean }>("/api/auth/complete-signup", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function logout() {
  return request<{ ok: boolean }>("/api/auth/logout", { method: "POST", headers: {} });
}

export function getMediaPages(query: URLSearchParams) {
  return request<{ page: number; pageSize: number; total: number; items: MediaListItem[] }>(
    `/api/media/pages?${query.toString()}`,
    { headers: {} },
  );
}

export function getMediaFacets(params?: {
  year?: string;
  month?: string;
  from?: string;
  to?: string;
  type?: "image" | "video";
  tag?: string;
  category?: string;
  liked?: boolean;
}) {
  const query = new URLSearchParams();
  if (params?.year) query.set("year", params.year);
  if (params?.month) query.set("month", params.month);
  if (params?.from) query.set("from", params.from);
  if (params?.to) query.set("to", params.to);
  if (params?.type) query.set("type", params.type);
  if (params?.tag) query.set("tag", params.tag);
  if (params?.category) query.set("category", params.category);
  if (params?.liked) query.set("liked", "true");
  const suffix = query.toString();
  return request<{
    years: Array<{ year: number; count: number }>;
    months: Array<{ month: number; count: number }>;
    tags: Array<{ tag: string; count: number }>;
    categories: Array<{ category: string; count: number }>;
  }>(`/api/media/facets${suffix ? `?${suffix}` : ""}`, { headers: {} });
}

export function getAdminMediaSummary(query: URLSearchParams) {
  return request<{
    totalCount: number;
    totalBytes: number;
    imageCount: number;
    videoCount: number;
    imageAverage: number;
    imageMedian: number;
    videoAverage: number;
    videoMedian: number;
    orientationCounts: {
      landscape: number;
      portrait: number;
      square: number;
      unknown: number;
    };
  }>(`/api/admin/media/summary?${query.toString()}`, { headers: {} });
}

export function getMediaTags(query?: string) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const suffix = params.toString();
  return request<{ items: string[] }>(`/api/media/tags${suffix ? `?${suffix}` : ""}`, { headers: {} });
}

export function getMediaCategories(query?: string) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const suffix = params.toString();
  return request<{ items: string[] }>(`/api/media/categories${suffix ? `?${suffix}` : ""}`, { headers: {} });
}

type UrlCacheEntry = { url: string | null; expiresAt: number | null };
const urlCache = new Map<string, UrlCacheEntry>();

function cacheKey(id: string, lod: number, kind: "lod" | "blur") {
  return `${id}:${kind}:${lod}`;
}

function loadUrlCache() {
  try {
    const raw = localStorage.getItem("media-url-cache");
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, UrlCacheEntry>;
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || !value.url) continue;
      if (value.expiresAt && value.expiresAt <= now) continue;
      urlCache.set(key, value);
    }
  } catch {
    // ignore
  }
}

function persistUrlCache() {
  try {
    const data: Record<string, UrlCacheEntry> = {};
    for (const [key, value] of urlCache.entries()) {
      data[key] = value;
    }
    localStorage.setItem("media-url-cache", JSON.stringify(data));
  } catch {
    // ignore
  }
}

let cacheLoaded = false;

export function clearMediaUrlCache() {
  urlCache.clear();
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem("media-url-cache");
    } catch {
      // ignore
    }
  }
}

export async function getBatchUrls(
  requests: Array<{ id: string; lod: 0 | 1 | 2 | 3 | 4; kind?: "lod" | "blur" }>,
) {
  if (typeof window !== "undefined" && !cacheLoaded) {
    cacheLoaded = true;
    loadUrlCache();
  }

  const now = Date.now();
  const cachedItems: Array<{ id: string; lod: number; kind: "lod" | "blur"; url: string | null; expiresAt?: number | null }> = [];
  const missing: Array<{ id: string; lod: 0 | 1 | 2 | 3 | 4; kind?: "lod" | "blur" }> = [];

  for (const req of requests) {
    const kind = req.kind ?? "lod";
    const entry = urlCache.get(cacheKey(req.id, req.lod, kind));
    if (entry && (!entry.expiresAt || entry.expiresAt > now)) {
      cachedItems.push({ id: req.id, lod: req.lod, kind, url: entry.url, expiresAt: entry.expiresAt });
    } else {
      missing.push(req);
    }
  }

  if (!missing.length) {
    return { items: cachedItems };
  }

  const res = await request<{
    items: Array<{ id: string; lod: number; kind: "lod" | "blur"; url: string | null; expiresAt?: number | null }>;
  }>("/api/media/urls", {
    method: "POST",
    body: JSON.stringify({ requests: missing }),
  });

  for (const item of res.items) {
    if (!item) continue;
    if (item.url) {
      const entry: UrlCacheEntry = {
        url: item.url,
        expiresAt: item.expiresAt ?? null,
      };
      urlCache.set(cacheKey(item.id, item.lod, item.kind), entry);
    }
  }
  if (typeof window !== "undefined") persistUrlCache();

  return { items: [...cachedItems, ...res.items] };
}

export function getVideoPlayback(id: string) {
  return request<{ id: string; playbackUrl: string; posterUrl: string | null; mime: string }>(`/api/media/${id}/play`, {
    headers: {},
  });
}

export function likeMedia(id: string) {
  return request<{ ok: boolean; liked: boolean }>(`/api/media/${id}/like`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function unlikeMedia(id: string) {
  return request<{ ok: boolean; liked: boolean }>(`/api/media/${id}/like`, {
    method: "DELETE",
  });
}

export function getAdminUsers() {
  return request<{
    items: Array<{
      id: string;
      email: string;
      role: "ADMIN" | "VIEWER";
      isActive: boolean;
      name?: string;
      approvalStatus?: "pending" | "approved" | "disabled";
      requestMessage?: string;
      requestedAt?: string | null;
      emailVerifiedAt?: string | null;
      createdAt: string;
    }>;
  }>("/api/admin/users", { headers: {} });
}

export function createAdminUser(payload: { email: string; password: string; role: "ADMIN" | "VIEWER" }) {
  return request<{ id: string }>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function patchAdminUser(
  id: string,
  payload: {
    role?: "ADMIN" | "VIEWER";
    isActive?: boolean;
    approvalStatus?: "pending" | "approved" | "disabled";
    password?: string;
    name?: string;
  },
) {
  return request<{ ok: boolean }>(`/api/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function patchMedia(id: string, payload: {
  visibility?: "PUBLIC" | "PRIVATE";
  title?: string;
  description?: string;
  tags?: string[];
  category?: string | null;
  dateTaken?: string | null;
  placeName?: string | null;
  location?: { lat: number; lng: number; source: "manual" | "exif" | "none" } | null;
  width?: number | null;
  height?: number | null;
}) {
  return request<{ ok: boolean }>(`/api/admin/media/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function getAdminMediaById(id: string) {
  return request<{
    id: string;
    type: "image" | "video";
    status: "processing" | "ready" | "error";
    title: string;
    description: string;
    r2KeyOriginal: string;
    durationSeconds: number | null;
    dateEffective: string;
    hasSplits: boolean;
  }>(`/api/admin/media/${id}`, { headers: {} });
}

export function trimMediaVideo(id: string, payload: { startSeconds: number; endSeconds: number }) {
  return request<{ ok: boolean; reencoded: boolean }>(`/api/admin/media/${id}/trim`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function splitMediaVideo(
  id: string,
  payload: { segments: Array<{ startSeconds: number; endSeconds: number }> },
) {
  return request<{ ok: boolean; items: Array<{ id: string; status: string }> }>(`/api/admin/media/${id}/split`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function setVideoPreviewImage(id: string, payload: { atSeconds: number }) {
  return request<{ ok: boolean }>(`/api/admin/media/${id}/preview`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function retryMediaProcessing(id: string) {
  return request<{ ok: boolean }>(`/api/admin/media/${id}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
