import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  route("login", "routes/login.tsx"),

  route("admin", "routes/admin.tsx", [
    route("users", "routes/admin.users.tsx"),
    route("media", "routes/admin.media.tsx"),
  ]),

  route("api/auth/login", "routes/api.auth.login.ts"),
  route("api/auth/logout", "routes/api.auth.logout.ts"),
  route("api/auth/me", "routes/api.auth.me.ts"),

  route("api/admin/users", "routes/api.admin.users.ts"),
  route("api/admin/users/:id", "routes/api.admin.users.$id.ts"),
  route("api/admin/media/upload", "routes/api.admin.media.upload.ts"),
  route("api/admin/media/:id", "routes/api.admin.media.$id.ts"),

  route("api/media/pages", "routes/api.media.pages.ts"),
  route("api/media/facets", "routes/api.media.facets.ts"),
  route("api/media/tags", "routes/api.media.tags.ts"),
  route("api/media/categories", "routes/api.media.categories.ts"),
  route("api/media/urls", "routes/api.media.urls.ts"),
  route("api/media/:id/play", "routes/api.media.$id.play.ts"),
] satisfies RouteConfig;
