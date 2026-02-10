import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  route("login", "routes/login.tsx"),

  route("admin", "routes/admin.tsx", [
    route("users", "routes/admin.users.tsx"),
    route("media", "routes/admin.media.tsx"),
    route("media/trim/:id", "routes/admin.media.trim.$id.tsx"),
  ]),

  route("api/auth/login", "routes/api.auth.login.ts"),
  route("api/auth/logout", "routes/api.auth.logout.ts"),
  route("api/auth/me", "routes/api.auth.me.ts"),
  route("api/auth/config", "routes/api.auth.config.ts"),
  route("api/auth/request-access", "routes/api.auth.request-access.ts"),
  route("api/auth/verify-access", "routes/api.auth.verify-access.ts"),
  route("api/auth/complete-signup", "routes/api.auth.complete-signup.ts"),

  route("api/admin/users", "routes/api.admin.users.ts"),
  route("api/admin/users/:id", "routes/api.admin.users.$id.ts"),
  route("api/admin/media/upload", "routes/api.admin.media.upload.ts"),
  route("api/admin/media/:id", "routes/api.admin.media.$id.ts"),
  route("api/admin/media/:id/retry", "routes/api.admin.media.$id.retry.ts"),
  route("api/admin/media/:id/trim", "routes/api.admin.media.$id.trim.ts"),
  route("api/admin/media/:id/split", "routes/api.admin.media.$id.split.ts"),
  route("api/admin/media/:id/preview", "routes/api.admin.media.$id.preview.ts"),
  route("api/admin/media/summary", "routes/api.admin.media.summary.ts"),

  route("api/media/pages", "routes/api.media.pages.ts"),
  route("api/media/:id/like", "routes/api.media.$id.like.ts"),
  route("api/media/facets", "routes/api.media.facets.ts"),
  route("api/media/tags", "routes/api.media.tags.ts"),
  route("api/media/categories", "routes/api.media.categories.ts"),
  route("api/media/urls", "routes/api.media.urls.ts"),
  route("api/media/:id/play", "routes/api.media.$id.play.ts"),
] satisfies RouteConfig;
