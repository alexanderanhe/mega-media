import { getCollections } from "~/server/db";
import { ApiError, jsonError, jsonOk, requireRole } from "~/server/http";

const STREAM_INTERVAL_MS = 3000;

export const loader = async ({ request }: { request: Request }) => {
  try {
    await requireRole(request, "ADMIN");
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonError(error.status, error.message);
    }
    throw error;
  }
  const url = new URL(request.url);
  const wantsStream =
    url.searchParams.get("stream") === "1" ||
    request.headers.get("accept")?.includes("text/event-stream");

  if (!wantsStream) {
    return jsonOk(await buildJobsSnapshot());
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = async () => {
        if (closed) return;
        try {
          const payload = await buildJobsSnapshot();
          controller.enqueue(
            encoder.encode(`event: jobs\ndata: ${JSON.stringify(payload)}\n\n`),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to load jobs";
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`),
          );
        }
      };

      const interval = setInterval(send, STREAM_INTERVAL_MS);
      void send();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      request.signal.addEventListener("abort", cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
};

async function buildJobsSnapshot() {
  const { media, mediaParts } = await getCollections();
  const [processingMedia, partsAgg] = await Promise.all([
    media
      .find(
        { status: "processing" },
        { projection: { title: 1, type: 1, createdAt: 1, mergedFrom: 1, r2KeyOriginal: 1 } },
      )
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray(),
    mediaParts
      .aggregate<{
        _id: { groupKey: string; status: "pending" | "merging" | "error" };
        baseName: string;
        extension: string;
        minPart: number;
        maxPart: number;
        count: number;
        lastSeenAt: Date;
        errorMessage?: string;
      }>([
        { $match: { status: { $in: ["pending", "merging", "error"] } } },
        {
          $group: {
            _id: { groupKey: "$groupKey", status: "$status" },
            baseName: { $first: "$baseName" },
            extension: { $first: "$extension" },
            minPart: { $min: "$partNumber" },
            maxPart: { $max: "$partNumber" },
            count: { $sum: 1 },
            lastSeenAt: { $max: "$updatedAt" },
            errorMessage: { $first: "$errorMessage" },
          },
        },
      ])
      .toArray(),
  ]);

  const mergeGroups = new Map<
    string,
    {
      groupKey: string;
      baseName: string;
      extension: string;
      pendingCount: number;
      mergingCount: number;
      errorCount: number;
      minPart: number | null;
      maxPart: number | null;
      lastSeenAt: Date | null;
      errorMessage?: string;
    }
  >();

  for (const row of partsAgg) {
    const groupKey = row._id.groupKey;
    const status = row._id.status;
    const existing = mergeGroups.get(groupKey) ?? {
      groupKey,
      baseName: row.baseName,
      extension: row.extension,
      pendingCount: 0,
      mergingCount: 0,
      errorCount: 0,
      minPart: null,
      maxPart: null,
      lastSeenAt: null,
      errorMessage: row.errorMessage ?? undefined,
    };
    if (status === "pending") existing.pendingCount += row.count;
    if (status === "merging") existing.mergingCount += row.count;
    if (status === "error") existing.errorCount += row.count;
    existing.minPart = minNumber(existing.minPart, row.minPart);
    existing.maxPart = maxNumber(existing.maxPart, row.maxPart);
    existing.lastSeenAt = maxDate(existing.lastSeenAt, row.lastSeenAt);
    if (!existing.errorMessage && row.errorMessage) existing.errorMessage = row.errorMessage;
    mergeGroups.set(groupKey, existing);
  }

  const mergeJobs = Array.from(mergeGroups.values()).map((group) => {
    const minPart = group.minPart ?? 0;
    const maxPart = group.maxPart ?? 0;
    const count = group.pendingCount + group.mergingCount + group.errorCount;
    const contiguous = minPart === 1 && count === maxPart;
    const progress = maxPart ? Math.min(100, Math.round((count / maxPart) * 100)) : 0;
    const status = group.mergingCount > 0 ? "merging" : group.errorCount > 0 ? "error" : "pending";
    return {
      groupKey: group.groupKey,
      baseName: group.baseName,
      extension: group.extension,
      status,
      receivedParts: count,
      maxPart,
      contiguous,
      progress,
      lastSeenAt: group.lastSeenAt,
      errorMessage: group.errorMessage ?? null,
    };
  });

  return {
    updatedAt: new Date().toISOString(),
    mediaProcessing: processingMedia.map((item) => ({
      id: item._id.toString(),
      title: item.title ?? "Untitled",
      type: item.type,
      createdAt: item.createdAt,
      r2KeyOriginal: item.r2KeyOriginal,
      mergedFrom: item.mergedFrom
        ? {
            baseName: item.mergedFrom.baseName,
            totalParts: item.mergedFrom.totalParts,
            mergedAt: item.mergedFrom.mergedAt,
          }
        : null,
    })),
    mergeJobs: mergeJobs.sort(sortMergeJobs),
  };
}

function minNumber(current: number | null, next: number) {
  if (current === null) return next;
  return Math.min(current, next);
}

function maxNumber(current: number | null, next: number) {
  if (current === null) return next;
  return Math.max(current, next);
}

function maxDate(current: Date | null, next: Date) {
  if (!current) return next;
  return current > next ? current : next;
}

function sortMergeJobs(a: { status: string; lastSeenAt: Date | null }, b: { status: string; lastSeenAt: Date | null }) {
  if (a.status !== b.status) {
    const order = ["merging", "pending", "error"];
    return order.indexOf(a.status) - order.indexOf(b.status);
  }
  const aTime = a.lastSeenAt ? a.lastSeenAt.getTime() : 0;
  const bTime = b.lastSeenAt ? b.lastSeenAt.getTime() : 0;
  return bTime - aTime;
}
