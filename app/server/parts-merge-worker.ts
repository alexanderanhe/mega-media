import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import { ObjectId, getCollections } from "./db";
import { deleteObjects, downloadObjectToFile, uploadFileToR2 } from "./r2";
import { enqueueMediaProcessing } from "./media-processor";

const POLL_SECONDS = clampNumber(Number(process.env.PARTS_MERGE_POLL_SECONDS ?? 30), 10, 600);
const QUIET_SECONDS = clampNumber(Number(process.env.PARTS_MERGE_QUIET_SECONDS ?? 90), 15, 3600);

let started = false;
let running = false;

if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

export function schedulePartsMergeWorker() {
  if (started) return;
  started = true;
  setInterval(() => {
    void tick();
  }, POLL_SECONDS * 1000);
  void tick();
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await processReadyGroups();
  } finally {
    running = false;
  }
}

async function processReadyGroups() {
  const { mediaParts, media } = await getCollections();
  const quietBefore = new Date(Date.now() - QUIET_SECONDS * 1000);

  const candidates = await mediaParts
    .aggregate<{
      _id: string;
      groupHash: string;
      baseName: string;
      extension: string;
      maxPart: number;
      minPart: number;
      count: number;
      lastSeenAt: Date;
    }>([
      { $match: { status: "pending" } },
      {
        $group: {
          _id: "$groupKey",
          groupHash: { $first: "$groupHash" },
          baseName: { $first: "$baseName" },
          extension: { $first: "$extension" },
          maxPart: { $max: "$partNumber" },
          minPart: { $min: "$partNumber" },
          count: { $sum: 1 },
          lastSeenAt: { $max: "$updatedAt" },
        },
      },
    ])
    .toArray();

  for (const candidate of candidates) {
    if (candidate.minPart !== 1) continue;
    if (candidate.count !== candidate.maxPart) continue;
    if (candidate.lastSeenAt > quietBefore) continue;

    const lockAt = new Date();
    const lockResult = await mediaParts.updateMany(
      { groupKey: candidate._id, status: "pending" },
      { $set: { status: "merging", lockedAt: lockAt, updatedAt: lockAt }, $unset: { errorMessage: "" } },
    );

    if (lockResult.modifiedCount !== candidate.count) {
      await mediaParts.updateMany(
        { groupKey: candidate._id, status: "merging", lockedAt: lockAt },
        { $set: { status: "pending", updatedAt: new Date() }, $unset: { lockedAt: "" } },
      );
      continue;
    }

    const parts = await mediaParts
      .find({ groupKey: candidate._id, status: "merging", lockedAt: lockAt })
      .sort({ partNumber: 1 })
      .toArray();

    if (parts.length !== candidate.count || parts[0]?.partNumber !== 1) {
      await mediaParts.updateMany(
        { groupKey: candidate._id, status: "merging", lockedAt: lockAt },
        { $set: { status: "pending", updatedAt: new Date() }, $unset: { lockedAt: "" } },
      );
      continue;
    }

    const contiguous = parts.every((part, index) => part.partNumber === index + 1);
    if (!contiguous) {
      await mediaParts.updateMany(
        { groupKey: candidate._id, status: "merging", lockedAt: lockAt },
        { $set: { status: "pending", updatedAt: new Date() }, $unset: { lockedAt: "" } },
      );
      continue;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mmg-merge-"));
    let mergedPath = "";
    let finalExt = candidate.extension;
    try {
      const partFiles: string[] = [];
      for (const part of parts) {
        const target = path.join(
          tempDir,
          `part-${String(part.partNumber).padStart(4, "0")}.${candidate.extension}`,
        );
        await downloadObjectToFile(part.r2Key, target);
        partFiles.push(target);
      }

      const listPath = path.join(tempDir, "concat.txt");
      const listBody = partFiles.map((file) => `file '${escapeForConcat(file)}'`).join("\n");
      await fs.writeFile(listPath, listBody);

      mergedPath = path.join(
        os.tmpdir(),
        `${candidate.groupHash}-${Date.now()}-merged.${candidate.extension}`,
      );

      const copyOk = await concatCopy(listPath, mergedPath);
      if (!copyOk) {
        finalExt = "mp4";
        const reencodePath = path.join(os.tmpdir(), `${candidate.groupHash}-${Date.now()}-merged.mp4`);
        const reencodeOk = await concatReencode(listPath, reencodePath);
        if (!reencodeOk) throw new Error("Failed to merge parts");
        mergedPath = reencodePath;
      }

      const fileHash = await hashFile(mergedPath);
      const existing = await media.findOne({ fileHash });
      if (existing) {
        await deleteObjects(parts.map((part) => part.r2Key));
        await mediaParts.deleteMany({ groupKey: candidate._id });
        continue;
      }

      const now = new Date();
      const id = new ObjectId();
      const originalKey = `media/${id.toString()}/original.${finalExt}`;
      const contentType = mimeFromExt(finalExt);
      const size = (await fs.stat(mergedPath)).size;

      await uploadFileToR2({
        key: originalKey,
        filePath: mergedPath,
        contentType,
        cacheControl: "public, max-age=31536000, immutable",
      });

      const metaSource = parts[0];
      const mergedAt = new Date();
      await media.insertOne({
        _id: id,
        type: "video",
        visibility: metaSource.visibility ?? "PRIVATE",
        title: metaSource.title || candidate.baseName,
        description: metaSource.description ?? "",
        fileHash,
        tags: [],
        category: null,
        createdAt: now,
        dateTaken: metaSource.dateTaken ?? null,
        dateEffective: metaSource.dateTaken ?? now,
        location: metaSource.location ?? null,
        r2KeyOriginal: originalKey,
        originalBytes: size,
        variants: {},
        poster: null,
        preview: null,
        blur: null,
        width: null,
        height: null,
        aspect: 1,
        status: "processing",
        mergedFrom: {
          groupKey: candidate._id,
          groupHash: candidate.groupHash,
          baseName: candidate.baseName,
          fileNames: parts.map((part) => part.originalName),
          parts: parts.map((part) => part.partNumber),
          totalParts: parts.length,
          r2Keys: parts.map((part) => part.r2Key),
          mergedAt,
        },
      });

      enqueueMediaProcessing({
        mediaId: id.toString(),
        localPath: mergedPath,
        type: "video",
        mime: contentType,
        extension: finalExt,
        manualDateTaken: metaSource.dateTaken ?? null,
        placeName: metaSource.location?.placeName,
      });

      await deleteObjects(parts.map((part) => part.r2Key));
      await cleanupSourceMedia(parts);
      await mediaParts.deleteMany({ groupKey: candidate._id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Merge failed";
      await mediaParts.updateMany(
        { groupKey: candidate._id, status: "merging", lockedAt: lockAt },
        { $set: { status: "error", errorMessage: message, updatedAt: new Date() }, $unset: { lockedAt: "" } },
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function cleanupSourceMedia(
  parts: Array<{ sourceMediaId?: ObjectId | null }>,
) {
  const { media } = await getCollections();
  const sourceIds = Array.from(
    new Set(
      parts
        .map((part) => part.sourceMediaId?.toString())
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (!sourceIds.length) return;

  for (const id of sourceIds) {
    const doc = await media.findOne({ _id: new ObjectId(id) });
    if (!doc) continue;
    const keys = [
      doc.r2KeyOriginal,
      ...Object.values(doc.variants ?? {}).map((variant) => variant.r2Key),
      doc.poster?.r2Key,
      doc.preview?.r2Key,
      doc.blur?.r2Key,
    ].filter(Boolean) as string[];
    await deleteObjects(keys);
    await media.deleteOne({ _id: new ObjectId(id) });
  }
}

function escapeForConcat(value: string) {
  return value.replace(/'/g, "'\\''");
}

function concatCopy(listPath: string, outputPath: string) {
  return new Promise<boolean>((resolve) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy", "-movflags +faststart"])
      .output(outputPath)
      .on("end", () => resolve(true))
      .on("error", () => resolve(false))
      .run();
  });
}

function concatReencode(listPath: string, outputPath: string) {
  return new Promise<boolean>((resolve) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions([
        "-movflags +faststart",
        "-c:v libx264",
        "-preset veryfast",
        "-crf 26",
        "-c:a aac",
        "-b:a 128k",
      ])
      .output(outputPath)
      .on("end", () => resolve(true))
      .on("error", () => resolve(false))
      .run();
  });
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function mimeFromExt(ext: string) {
  const normalized = ext.toLowerCase();
  if (normalized === "mov" || normalized === "qt") return "video/quicktime";
  if (normalized === "webm") return "video/webm";
  return "video/mp4";
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
