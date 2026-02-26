import { MongoClient, ObjectId } from "mongodb";
import { createHash } from "node:crypto";

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  throw new Error("Missing MONGODB_URI. Run with: node --env-file=.env ./scripts/backfill-merge-parts.mjs");
}

const client = new MongoClient(mongoUri);

function getDbName(uri) {
  const parsed = new URL(uri);
  return parsed.pathname.replace(/^\//, "") || "mega_media_grid";
}

function parsePartTitle(title) {
  const match = /^(.*)-part(\d+)\.([a-z0-9]{1,5})$/i.exec(title.trim());
  if (!match) return null;
  const baseName = match[1].trim();
  const partNumber = Number.parseInt(match[2], 10);
  const extension = match[3].toLowerCase();
  if (!baseName || !Number.isFinite(partNumber) || partNumber < 1) return null;
  return { baseName, partNumber, extension };
}

async function run() {
  await client.connect();
  const db = client.db(getDbName(mongoUri));
  const media = db.collection("media");
  const mediaParts = db.collection("media_parts");

  const cursor = media.find({
    type: "video",
    status: "ready",
    title: { $regex: /-part\d+\.[a-z0-9]{1,5}$/i },
  });

  let scanned = 0;
  let upserted = 0;
  let locked = 0;

  for await (const doc of cursor) {
    scanned += 1;
    if (doc.mergeLocked) continue;
    const info = parsePartTitle(doc.title || "");
    if (!info) continue;

    const groupKey = `${info.baseName}.${info.extension}`;
    const groupHash = createHash("sha1").update(groupKey).digest("hex");
    const now = new Date();

    const result = await mediaParts.updateOne(
      { groupKey, partNumber: info.partNumber },
      {
        $set: {
          groupKey,
          groupHash,
          baseName: info.baseName,
          originalName: doc.title,
          extension: info.extension,
          partNumber: info.partNumber,
          r2Key: doc.r2KeyOriginal,
          bytes: doc.originalBytes ?? 0,
          status: "pending",
          visibility: doc.visibility ?? "PRIVATE",
          title: doc.title ?? info.baseName,
          description: doc.description ?? "",
          dateTaken: doc.dateTaken ?? null,
          location: doc.location ?? null,
          updatedAt: now,
          sourceMediaId: new ObjectId(doc._id),
        },
        $setOnInsert: { _id: new ObjectId(), createdAt: now },
        $unset: { errorMessage: "" },
      },
      { upsert: true },
    );

    if (result.upsertedCount || result.modifiedCount) {
      upserted += 1;
      const lockRes = await media.updateOne(
        { _id: doc._id, mergeLocked: { $ne: true } },
        {
          $set: {
            mergeLocked: true,
            mergeLockedAt: now,
            mergeGroupKey: groupKey,
          },
        },
      );
      if (lockRes.modifiedCount) locked += 1;
    }
  }

  console.log(`Scanned: ${scanned}`);
  console.log(`Upserted parts: ${upserted}`);
  console.log(`Locked media: ${locked}`);
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => client.close());
