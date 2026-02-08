import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  role: z.enum(["ADMIN", "VIEWER"]),
});

export const patchUserSchema = z.object({
  role: z.enum(["ADMIN", "VIEWER"]).optional(),
  isActive: z.boolean().optional(),
  approvalStatus: z.enum(["pending", "approved", "disabled"]).optional(),
  password: z.string().min(8).max(128).optional(),
  name: z.string().min(2).max(120).optional(),
});

export const requestAccessSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
});

export const verifyAccessCodeSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
});

export const completeSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  requestMessage: z.string().min(4).max(2000),
});

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(60),
  year: z.string().regex(/^\d{4}$/).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  visibility: z.enum(["PUBLIC", "PRIVATE"]).optional(),
  q: z.string().max(200).optional(),
  type: z.enum(["image", "video"]).optional(),
  tag: z.string().max(64).optional(),
  category: z.string().max(64).optional(),
  sort: z.enum(["date_desc", "date_asc", "size_desc", "size_asc", "title_asc", "title_desc"]).optional(),
});

export const batchUrlsSchema = z.object({
  requests: z
    .array(
      z.object({
        id: z.string().min(12),
        kind: z.enum(["lod", "blur"]).optional(),
        lod: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
      }),
    )
    .max(200),
});

export const patchMediaSchema = z.object({
  visibility: z.enum(["PUBLIC", "PRIVATE"]).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().max(64)).max(30).optional(),
  category: z.string().max(64).nullable().optional(),
  dateTaken: z.string().datetime().nullable().optional(),
  placeName: z.string().max(256).nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  location: z
    .object({
      lat: z.number(),
      lng: z.number(),
      source: z.enum(["manual", "exif", "none"]).default("manual"),
    })
    .nullable()
    .optional(),
});
