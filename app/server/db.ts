import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import { getEnv } from "./env";
import type { UserRole } from "~/shared/types";

type UserDoc = {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  role: UserRole;
  isActive: boolean;
  name?: string;
  approvalStatus?: "pending" | "approved" | "disabled";
  requestMessage?: string;
  requestedAt?: Date;
  emailVerifiedAt?: Date;
  verificationCodeHash?: string;
  verificationCodeExpiresAt?: Date;
  verificationSentAt?: Date;
  createdAt: Date;
};

type MediaCollectionDoc = {
  _id: ObjectId;
  type: "image" | "video";
  visibility: "PUBLIC" | "PRIVATE";
  title: string;
  description: string;
  fileHash: string;
  tags: string[];
  category: string | null;
  createdAt: Date;
  dateTaken: Date | null;
  dateEffective: Date;
  location: { lat: number; lng: number; source: "exif" | "manual" | "none"; placeName?: string } | null;
  r2KeyOriginal: string;
  variants: Record<string, { r2Key: string; w: number; h: number; bytes: number; mime: string }>;
  poster: { r2Key: string; w: number; h: number; mime: string } | null;
  preview: { r2Key: string; mime: string; duration?: number } | null;
  blur?: { r2Key: string; w: number; h: number; mime: string } | null;
  originalBytes?: number | null;
  width?: number | null;
  height?: number | null;
  aspect: number;
  status: "processing" | "ready" | "error";
  errorMessage?: string;
  splitGroupId?: ObjectId;
  splitParentId?: ObjectId;
  splitOrder?: number;
  splitStartSeconds?: number;
  splitEndSeconds?: number;
  splitChildrenCount?: number;
  mergeLocked?: boolean;
  mergeLockedAt?: Date;
  mergeGroupKey?: string;
  mergedFrom?: {
    groupKey: string;
    groupHash: string;
    baseName: string;
    fileNames: string[];
    parts: number[];
    totalParts: number;
    r2Keys: string[];
    mergedAt: Date;
  };
};

type MediaPartDoc = {
  _id: ObjectId;
  groupKey: string;
  groupHash: string;
  baseName: string;
  originalName: string;
  extension: string;
  partNumber: number;
  r2Key: string;
  bytes: number;
  status: "pending" | "merging" | "error";
  errorMessage?: string;
  sourceMediaId?: ObjectId;
  visibility: "PUBLIC" | "PRIVATE";
  title: string;
  description: string;
  dateTaken: Date | null;
  location: { lat: number; lng: number; source: "exif" | "manual" | "none"; placeName?: string } | null;
  createdAt: Date;
  updatedAt: Date;
  lockedAt?: Date;
};

type LikeDoc = {
  _id: ObjectId;
  userId: ObjectId;
  mediaId: ObjectId;
  createdAt: Date;
};

let clientPromise: Promise<MongoClient> | null = null;
let initializedPromise: Promise<void> | null = null;

async function getClient() {
  if (!clientPromise) {
    const env = getEnv();
    const client = new MongoClient(env.MONGODB_URI!);
    clientPromise = client.connect();
  }
  return clientPromise;
}

function getDbName(uri: string) {
  const parsed = new URL(uri);
  return parsed.pathname.replace(/^\//, "") || "mega_media_grid";
}

export async function getDb() {
  const env = getEnv();
  const client = await getClient();
  return client.db(getDbName(env.MONGODB_URI!));
}

export async function getCollections() {
  const db = await getDb();
  if (!initializedPromise) {
    initializedPromise = initialize(db);
  }
  await initializedPromise;
  return {
    users: db.collection<UserDoc>("users"),
    media: db.collection<MediaCollectionDoc>("media"),
    mediaParts: db.collection<MediaPartDoc>("media_parts"),
    likes: db.collection<LikeDoc>("likes"),
  };
}

async function initialize(db: Awaited<ReturnType<typeof getDb>>) {
  const users = db.collection<UserDoc>("users");
  const media = db.collection<MediaCollectionDoc>("media");
  const mediaParts = db.collection<MediaPartDoc>("media_parts");
  const likes = db.collection<LikeDoc>("likes");

  await users.createIndex({ email: 1 }, { unique: true });
  await media.createIndex({ dateEffective: -1 });
  await media.createIndex({ visibility: 1, status: 1, dateEffective: -1 });
  await media.createIndex({ tags: 1 });
  await media.createIndex({ category: 1 });
  await media.createIndex({ splitParentId: 1, splitOrder: 1 });
  await media.createIndex({ splitGroupId: 1 });
  await media.createIndex(
    { fileHash: 1 },
    { unique: true, partialFilterExpression: { fileHash: { $type: "string" } } },
  );
  await likes.createIndex({ userId: 1, mediaId: 1 }, { unique: true });
  await likes.createIndex({ mediaId: 1 });

  await mediaParts.createIndex({ groupKey: 1, partNumber: 1 }, { unique: true });
  await mediaParts.createIndex({ groupKey: 1, status: 1, createdAt: 1 });
  await mediaParts.createIndex({ status: 1, lockedAt: 1 });

  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!bootstrapEmail || !bootstrapPassword) return;

  const existingAdmin = await users.findOne({ role: "ADMIN" });
  if (existingAdmin) return;

  await users.insertOne({
    _id: new ObjectId(),
    email: bootstrapEmail.toLowerCase(),
    passwordHash: await bcrypt.hash(bootstrapPassword, 10),
    role: "ADMIN",
    isActive: true,
    approvalStatus: "approved",
    createdAt: new Date(),
  });
}

export { ObjectId };
export type { UserDoc, MediaCollectionDoc, MediaPartDoc, LikeDoc };
