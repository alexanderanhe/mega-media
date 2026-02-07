import { useEffect, useMemo, useRef, useState } from "react";
import { FiFilter, FiImage, FiMoreHorizontal, FiUploadCloud, FiVideo } from "react-icons/fi";
import { Drawer } from "vaul";
import type { Route } from "./+types/admin.media";
import { requireAdminPage } from "~/server/guards";
import { getMediaCategories, getMediaPages, getMediaTags, patchMedia } from "~/shared/client-api";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdminPage(request);
  return null;
}

export default function AdminMediaRoute() {
  const [items, setItems] = useState<
    Array<{
      id: string;
      type: "image" | "video";
      aspect: number;
      width?: number | null;
      height?: number | null;
      visibility: "PUBLIC" | "PRIVATE";
      dateEffective: string;
      status: string;
      errorMessage?: string | null;
      title?: string;
      description?: string;
      placeName?: string | null;
      dateTaken?: string | null;
      sizeBytes?: number | null;
      durationSeconds?: number | null;
      tags?: string[];
      category?: string | null;
    }>
  >([]);
  const [editing, setEditing] = useState<{
    id: string;
    title: string;
    description: string;
    dateTaken: string;
    placeName: string;
    width: string;
    height: string;
    tags: string[];
    category: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [uploads, setUploads] = useState<
    Array<{
      key: string;
      name: string;
      size: number;
      progress: number;
      status: "queued" | "uploading" | "done" | "error";
      error?: string;
    }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [patchingIds, setPatchingIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | "image" | "video">("");
  const [sort, setSort] = useState("date_desc");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);

  const refresh = () => {
    setLoading(true);
    const query = new URLSearchParams({ page: "1", pageSize: "200" });
    if (search.trim()) query.set("q", search.trim());
    if (fromDate) query.set("from", new Date(fromDate).toISOString());
    if (toDate) query.set("to", new Date(toDate).toISOString());
    if (typeFilter) query.set("type", typeFilter);
    if (tagFilter.trim()) query.set("tag", tagFilter.trim());
    if (categoryFilter.trim()) query.set("category", categoryFilter.trim());
    if (sort) query.set("sort", sort);
    getMediaPages(query).then((res) => {
      setItems(
        res.items.map((item) => ({
          id: item.id,
          type: item.type,
          aspect: item.aspect,
          width: item.width ?? null,
          height: item.height ?? null,
          visibility: item.visibility,
          dateEffective: item.dateEffective,
          status: item.status,
          errorMessage: item.errorMessage,
          title: item.title,
          description: item.description,
          placeName: item.placeName ?? null,
          dateTaken: item.dateTaken ?? null,
          sizeBytes: item.sizeBytes ?? null,
          durationSeconds: item.durationSeconds ?? null,
          tags: item.tags ?? [],
          category: item.category ?? null,
        })),
      );
      setLoading(false);
    });
  };

  useEffect(() => {
    refresh();
  }, [search, fromDate, toDate, typeFilter, tagFilter, categoryFilter, sort]);

  useEffect(() => {
    void loadOptions();
  }, []);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      dragCounter.current += 1;
      setDragActive(true);
    };
    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragActive(false);
    };
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      dragCounter.current = 0;
      setDragActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) void handleUpload(files);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Media list</h2>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className="inline-flex items-center gap-2 rounded border border-white/10 bg-black/50 px-3 py-2 text-sm"
          >
            <FiFilter />
            Filters
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded border border-white/10 bg-black/50 px-3 py-2 text-sm"
          >
            <FiUploadCloud />
            Upload files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              if (files.length) void handleUpload(files);
            }}
          />
        </div>
      </div>
      {uploading ? <p className="text-sm text-slate-300">Uploading...</p> : null}
      {uploadWarning ? <p className="text-sm text-amber-300">{uploadWarning}</p> : null}
      {uploadMessage ? <p className="text-sm text-emerald-400">{uploadMessage}</p> : null}
      {uploadError ? <p className="text-sm text-rose-300">{uploadError}</p> : null}
      {uploads.length ? (
        <div className="overflow-x-auto rounded-xl border border-white/10 bg-slate-900 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Upload progress</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400">
                <th>File</th>
                <th>Size</th>
                <th>Status</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {uploads.map((item) => (
                <tr key={item.key} className="border-t border-white/10">
                  <td className="py-2">{item.name}</td>
                  <td>{formatBytes(item.size)}</td>
                  <td>{item.status === "error" ? item.error ?? "error" : item.status}</td>
                  <td>
                    <div className="h-2 w-full rounded bg-white/10">
                      <div
                        className="h-2 rounded bg-cyan-500"
                        style={{ width: `${Math.min(100, Math.max(0, item.progress))}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-300">{Math.round(item.progress)}%</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-slate-900 p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400">
              <th>Media</th>
              <th>Format</th>
              <th>Aspect</th>
              <th>Dimensions</th>
              <th>Duration</th>
              <th>Size</th>
              <th>Date</th>
              <th>Visibility</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, idx) => (
                  <tr key={`skeleton-${idx}`} className="border-t border-white/10">
                    <td className="py-3"><div className="skeleton h-4 w-56" /></td>
                    <td><div className="skeleton h-4 w-16" /></td>
                    <td><div className="skeleton h-4 w-12" /></td>
                    <td><div className="skeleton h-4 w-16" /></td>
                    <td><div className="skeleton h-4 w-20" /></td>
                    <td><div className="skeleton h-4 w-20" /></td>
                    <td><div className="skeleton h-4 w-28" /></td>
                    <td><div className="skeleton h-4 w-16" /></td>
                    <td><div className="skeleton h-8 w-8" /></td>
                  </tr>
                ))
              : items.map((item) => (
                  <tr key={item.id} className="border-t border-white/10">
                    <td className="py-2">
                      <div className="flex items-center gap-3">
                        <span className={`flex h-9 w-9 items-center justify-center rounded-full ${statusColor(item.status)}`}>
                          {item.type === "image" ? <FiImage /> : <FiVideo />}
                        </span>
                        <div>
                          <div className="max-w-xs truncate font-medium">{item.title ?? "-"}</div>
                          <div className="max-w-xs truncate text-xs text-slate-400">{item.description || item.placeName || ""}</div>
                        </div>
                      </div>
                    </td>
                    <td className="text-xs uppercase text-slate-300">{item.type}</td>
                    <td className="text-xs text-slate-300">{formatAspect(item.aspect)}</td>
                    <td className="text-xs text-slate-300">{formatDimensions(item.width, item.height)}</td>
                    <td className="text-xs text-slate-300">{item.type === "video" ? formatDuration(item.durationSeconds) : "-"}</td>
                    <td className="text-xs text-slate-300">{formatBytes(item.sizeBytes ?? 0)}</td>
                    <td className="text-sm text-slate-300">{new Date(item.dateEffective).toLocaleDateString()}</td>
                    <td>
                      <VisibilityToggle
                        checked={item.visibility === "PUBLIC"}
                        disabled={patchingIds.has(item.id) || item.status !== "ready"}
                        compact
                        onChange={() => toggleVisibility(item.id)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 text-slate-300 hover:text-white"
                        onClick={() => {
                          setEditing({
                            id: item.id,
                            title: item.title ?? "",
                            description: item.description ?? "",
                            dateTaken: item.dateTaken ? toLocalInputValue(new Date(item.dateTaken)) : "",
                            placeName: item.placeName ?? "",
                            width: item.width ? String(item.width) : "",
                            height: item.height ? String(item.height) : "",
                            tags: item.tags ?? [],
                            category: item.category ?? "",
                          });
                        }}
                      >
                        <FiMoreHorizontal />
                      </button>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      <Drawer.Root open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)} direction="right">
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-black/70" />
          <Drawer.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-black/95 p-6 text-slate-100 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <Drawer.Title className="text-lg font-semibold">Edit media</Drawer.Title>
              <button type="button" onClick={() => setEditing(null)} className="text-slate-400 hover:text-white">
                Close
              </button>
            </div>
            {editing ? (
              <EditDrawerContent
                value={editing}
                saving={saving}
                deleting={deleting}
                tagOptions={tagOptions}
                categoryOptions={categoryOptions}
                onSave={async (next) => {
                  setSaving(true);
                  try {
                    const width = parseDimensionInput(next.width);
                    const height = parseDimensionInput(next.height);
                    await patchMedia(next.id, {
                      title: next.title.trim() || "Untitled",
                      description: next.description,
                      tags: next.tags,
                      category: next.category ? next.category.trim() : null,
                      dateTaken: next.dateTaken ? new Date(next.dateTaken).toISOString() : null,
                      placeName: next.placeName.trim() || null,
                      width,
                      height,
                    });
                    setItems((prev) =>
                      prev.map((item) =>
                        item.id === next.id
                          ? {
                              ...item,
                              title: next.title.trim() || "Untitled",
                              description: next.description,
                              dateTaken: next.dateTaken ? new Date(next.dateTaken).toISOString() : null,
                              placeName: next.placeName.trim() || null,
                              tags: next.tags,
                              category: next.category.trim() || null,
                              width,
                              height,
                              aspect: resolveAspect(width, height, item.aspect),
                            }
                          : item,
                      ),
                    );
                    void loadOptions();
                    setEditing(null);
                  } finally {
                    setSaving(false);
                  }
                }}
                onDelete={async (id) => {
                  const confirmed = window.confirm("Delete this media? This cannot be undone.");
                  if (!confirmed) return;
                  setDeleting(true);
                  try {
                    const res = await fetch(`/api/admin/media/${id}`, {
                      method: "DELETE",
                      credentials: "include",
                    });
                    if (!res.ok) {
                      const payload = await res.json();
                      throw new Error(payload.error ?? "Delete failed");
                    }
                    setItems((prev) => prev.filter((item) => item.id !== id));
                    setEditing(null);
                  } finally {
                    setDeleting(false);
                  }
                }}
                onCancel={() => setEditing(null)}
              />
            ) : null}
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
      {dragActive ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
          <div className="flex h-72 w-4/5 max-w-3xl flex-col items-center justify-center rounded-2xl border border-dashed border-white/20 bg-black/70 text-center">
            <p className="text-2xl font-semibold text-slate-100">Drop files to upload</p>
            <p className="mt-2 text-sm text-slate-400">Max 20 files per batch</p>
          </div>
        </div>
      ) : null}
      <Drawer.Root open={filtersOpen} onOpenChange={setFiltersOpen} direction="right">
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-black/70" />
          <Drawer.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-white/10 bg-black/95 p-6 text-slate-100 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <Drawer.Title className="text-lg font-semibold">Filters</Drawer.Title>
              <button type="button" onClick={() => setFiltersOpen(false)} className="text-slate-400 hover:text-white">
                Close
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs uppercase text-slate-400">Search</label>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Title, description, place..."
                  className="mt-2 w-full rounded border border-white/10 bg-black/50 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs uppercase text-slate-400">Type</label>
                <div className="mt-2 flex gap-2">
                  {["", "image", "video"].map((value) => (
                    <button
                      key={value || "all"}
                      type="button"
                      onClick={() => setTypeFilter(value as "" | "image" | "video")}
                      className={`rounded-full border px-3 py-1 text-xs ${
                        typeFilter === value ? "border-cyan-400 bg-cyan-500/20 text-cyan-200" : "border-white/10 text-slate-300"
                      }`}
                    >
                      {value ? value : "all"}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs uppercase text-slate-400">Category</label>
                <input
                  list="media-category-options"
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                  placeholder="Category"
                  className="mt-2 w-full rounded border border-white/10 bg-black/50 px-3 py-2 text-sm"
                />
                <datalist id="media-category-options">
                  {categoryOptions.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="text-xs uppercase text-slate-400">Tag</label>
                <input
                  list="media-tag-options"
                  value={tagFilter}
                  onChange={(event) => setTagFilter(event.target.value)}
                  placeholder="Tag"
                  className="mt-2 w-full rounded border border-white/10 bg-black/50 px-3 py-2 text-sm"
                />
                <datalist id="media-tag-options">
                  {tagOptions.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="text-xs uppercase text-slate-400">Date range</label>
                <div className="mt-2 grid gap-2">
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                    className="w-full rounded border border-white/10 bg-black/50 px-3 py-2 text-sm"
                  />
                  <input
                    type="date"
                    value={toDate}
                    onChange={(event) => setToDate(event.target.value)}
                    className="w-full rounded border border-white/10 bg-black/50 px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs uppercase text-slate-400">Sort</label>
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                  className="mt-2 w-full rounded border border-white/10 bg-black/50 px-3 py-2 text-sm"
                >
                  <option value="date_desc">Date: newest</option>
                  <option value="date_asc">Date: oldest</option>
                  <option value="size_desc">Size: largest</option>
                  <option value="size_asc">Size: smallest</option>
                  <option value="title_asc">Title: A-Z</option>
                  <option value="title_desc">Title: Z-A</option>
                </select>
              </div>
            </div>
            <div className="mt-auto flex justify-end gap-3 pt-6">
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setFromDate("");
                  setToDate("");
                  setTypeFilter("");
                  setCategoryFilter("");
                  setTagFilter("");
                  setSort("date_desc");
                }}
                className="rounded border border-white/10 px-4 py-2"
              >
                Clear
              </button>
              <button type="button" onClick={() => setFiltersOpen(false)} className="rounded bg-cyan-600 px-4 py-2 font-semibold">
                Apply
              </button>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </div>
  );

  async function loadOptions() {
    try {
      const [tagsRes, categoriesRes] = await Promise.all([getMediaTags(), getMediaCategories()]);
      setTagOptions(tagsRes.items);
      setCategoryOptions(categoriesRes.items);
    } catch {
      // ignore
    }
  }

  async function toggleVisibility(id: string) {
    const current = items.find((item) => item.id === id);
    if (!current) return;
    const nextVisibility = current.visibility === "PUBLIC" ? "PRIVATE" : "PUBLIC";
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, visibility: nextVisibility } : item)));
    setPatchingIds((prev) => new Set(prev).add(id));
    try {
      await patchMedia(id, { visibility: nextVisibility });
    } catch (err) {
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, visibility: current.visibility } : item)));
      setUploadError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setPatchingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleUpload(files: File[]) {
    setUploadError(null);
    setUploadMessage(null);
    setUploadWarning(null);
    setUploading(true);
    try {
      const capped = files.slice(0, 20);
      if (files.length > 20) {
        setUploadWarning("Max 20 files per batch. Extra files were skipped.");
      }

      const batch = capped.map((file) => ({
        key: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        size: file.size,
        progress: 0,
        status: "queued" as const,
      }));
      setUploads(batch);

      let successCount = 0;
      for (const file of capped) {
        const key = `${file.name}-${file.size}-${file.lastModified}`;
        setUploads((prev) =>
          prev.map((item) => (item.key === key ? { ...item, status: "uploading", progress: 0 } : item)),
        );
        try {
          await uploadWithProgress(file, (progress) => {
            setUploads((prev) =>
              prev.map((item) => (item.key === key ? { ...item, progress } : item)),
            );
          });
          setUploads((prev) =>
            prev.map((item) => (item.key === key ? { ...item, status: "done", progress: 100 } : item)),
          );
          successCount += 1;
        } catch (err) {
          setUploads((prev) =>
            prev.map((item) =>
              item.key === key
                ? {
                    ...item,
                    status: "error",
                    error: err instanceof Error ? err.message : "Upload failed",
                  }
                : item,
            ),
          );
        }
      }

      if (successCount > 0) {
        setUploadMessage(`Queued ${successCount} file(s) for processing`);
        refresh();
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }
}

function uploadWithProgress(file: File, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("visibility", "PRIVATE");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/media/upload");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress((event.loaded / event.total) * 100);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        try {
          const payload = JSON.parse(xhr.responseText);
          reject(new Error(payload.error ?? "Upload failed"));
        } catch {
          reject(new Error("Upload failed"));
        }
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(formData);
  });
}

function formatBytes(bytes: number) {
  if (!bytes) return "-";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatAspect(aspect?: number | null) {
  if (!aspect || !Number.isFinite(aspect)) return "-";
  return aspect.toFixed(2);
}

function formatDimensions(width?: number | null, height?: number | null) {
  if (!width || !height) return "-";
  return `${width}×${height}`;
}

function formatDuration(value?: number | null) {
  if (!value || value <= 0) return "-";
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `${seconds}s`;
}

function parseDimensionInput(value: string) {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveAspect(width: number | null, height: number | null, fallback: number) {
  if (width && height) return width / height;
  return fallback;
}

function VisibilityToggle({
  checked,
  onChange,
  disabled,
  compact,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex items-center rounded-full transition ${
        compact ? "h-5 w-10" : "h-6 w-12"
      } ${checked ? "bg-cyan-500" : "bg-slate-600"} ${disabled ? "opacity-50" : ""}`}
      aria-pressed={checked}
    >
      <span
        className={`inline-block transform rounded-full bg-white transition ${
          compact ? "h-4 w-4" : "h-5 w-5"
        } ${checked ? (compact ? "translate-x-5" : "translate-x-6") : "translate-x-1"}`}
      />
    </button>
  );
}

function statusColor(status: string) {
  if (status === "error") return "bg-red-600/80 text-white";
  if (status === "processing") return "bg-amber-500/80 text-black";
  return "bg-cyan-500/80 text-black";
}

function EditDrawerContent({
  value,
  saving,
  deleting,
  tagOptions,
  categoryOptions,
  onCancel,
  onSave,
  onDelete,
}: {
  value: {
    id: string;
    title: string;
    description: string;
    dateTaken: string;
    placeName: string;
    width: string;
    height: string;
    tags: string[];
    category: string;
  };
  saving: boolean;
  deleting: boolean;
  tagOptions: string[];
  categoryOptions: string[];
  onCancel: () => void;
  onSave: (next: {
    id: string;
    title: string;
    description: string;
    dateTaken: string;
    placeName: string;
    width: string;
    height: string;
    tags: string[];
    category: string;
  }) => void;
  onDelete: (id: string) => void;
}) {
  const [form, setForm] = useState(value);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    setForm(value);
    setTagInput("");
  }, [value]);

  const disable = saving || deleting;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3">
        <label className="block text-sm text-slate-300">Title</label>
        <input
          value={form.title}
          onChange={(event) => setForm({ ...form, title: event.target.value })}
          className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
        />
        <label className="block text-sm text-slate-300">Description</label>
        <textarea
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
          rows={3}
          className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
        />
        <label className="block text-sm text-slate-300">Date taken</label>
        <input
          type="datetime-local"
          value={form.dateTaken}
          onChange={(event) => setForm({ ...form, dateTaken: event.target.value })}
          className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
        />
        <label className="block text-sm text-slate-300">Place name</label>
        <input
          value={form.placeName}
          onChange={(event) => setForm({ ...form, placeName: event.target.value })}
          className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
        />
        <label className="block text-sm text-slate-300">Dimensions (px)</label>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            min={1}
            placeholder="Width"
            value={form.width}
            onChange={(event) => setForm({ ...form, width: event.target.value })}
            className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
          />
          <input
            type="number"
            min={1}
            placeholder="Height"
            value={form.height}
            onChange={(event) => setForm({ ...form, height: event.target.value })}
            className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
          />
        </div>
        <label className="block text-sm text-slate-300">Category</label>
        <input
          list="edit-category-options"
          value={form.category}
          onChange={(event) => setForm({ ...form, category: event.target.value })}
          className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
        />
        <datalist id="edit-category-options">
          {categoryOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <label className="block text-sm text-slate-300">Tags</label>
        <div className="flex flex-wrap gap-2">
          {form.tags.map((tag) => (
            <span key={tag} className="flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs">
              {tag}
              <button
                type="button"
                onClick={() => setForm({ ...form, tags: form.tags.filter((item) => item !== tag) })}
                className="text-slate-400 hover:text-white"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            list="edit-tag-options"
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                addTag(tagInput);
              }
            }}
            placeholder="Add a tag"
            className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
          />
          <button
            type="button"
            onClick={() => addTag(tagInput)}
            className="rounded border border-white/10 px-3 py-2 text-sm"
          >
            Add
          </button>
        </div>
        <datalist id="edit-tag-options">
          {tagOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 pt-6">
        <button
          type="button"
          disabled={disable}
          onClick={() => onDelete(form.id)}
          className="rounded border border-rose-400/50 px-4 py-2 text-rose-200 disabled:opacity-60"
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-white/20 px-4 py-2">
          Cancel
        </button>
        <button
          type="button"
          disabled={disable}
          onClick={() => onSave(form)}
          className="rounded bg-cyan-600 px-4 py-2 font-semibold disabled:opacity-60"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );

  function addTag(raw: string) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) return;
    if (form.tags.includes(normalized)) {
      setTagInput("");
      return;
    }
    setForm({ ...form, tags: [...form.tags, normalized].slice(0, 30) });
    setTagInput("");
  }
}

function toLocalInputValue(date: Date) {
  const tzOffsetMs = date.getTimezoneOffset() * 60_000;
  const local = new Date(date.getTime() - tzOffsetMs);
  return local.toISOString().slice(0, 16);
}
