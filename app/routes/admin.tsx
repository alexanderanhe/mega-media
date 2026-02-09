import { useEffect, useState } from "react";
import { Outlet } from "react-router";
import type { Route } from "./+types/admin";
import { requireAdminPage } from "~/server/guards";
import { getMe, logout } from "~/shared/client-api";

function resolveBrandingLogo() {
  const raw = (import.meta as any).env?.VITE_BRANDING_DIR ?? "/branding/default";
  const trimmed = typeof raw === "string" ? raw.trim() : "/branding/default";
  if (!trimmed) return "/branding/default/favicon.svg";
  const normalized = trimmed.replace(/\/+$/, "");
  if (normalized.startsWith("/public/")) return `${normalized.replace(/^\/public/, "")}/favicon.svg`;
  if (normalized.startsWith("public/")) return `/${normalized.replace(/^public\//, "")}/favicon.svg`;
  if (normalized.startsWith("/")) return `${normalized}/favicon.svg`;
  if (normalized.startsWith("branding/")) return `/${normalized}/favicon.svg`;
  return `/branding/${normalized}/favicon.svg`;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdminPage(request);
  return null;
}

export default function AdminLayout() {
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    getMe().then((data) => setUser(data.user));
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-white/10 px-6 py-3">
        <a href="/" className="flex items-center gap-3">
          <img src={resolveBrandingLogo()} alt="mega media" className="h-10 w-10" />
        </a>
        <nav className="flex items-center gap-4 text-sm">
          <a href="/">Grid</a>
          <a href="/admin/users">Users</a>
          <a href="/admin/media">Media</a>
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpen((prev) => !prev)}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/50 text-sm font-semibold"
            >
              {user ? initialsFromEmail(user.email) : "?"}
            </button>
            {open ? (
              <div className="absolute right-0 mt-2 w-44 rounded-lg border border-white/10 bg-slate-900 p-2 shadow-xl">
                <button
                  type="button"
                  onClick={async () => {
                    await logout();
                    const next = window.location.pathname + window.location.search + window.location.hash;
                    window.location.href = `/login?next=${encodeURIComponent(next)}`;
                  }}
                  className="w-full rounded px-3 py-2 text-left text-sm hover:bg-white/5"
                >
                  Logout
                </button>
              </div>
            ) : null}
          </div>
        </nav>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}

function initialsFromEmail(email: string) {
  const [name] = email.split("@");
  const parts = name.split(/[._-]+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  return initials || "U";
}
