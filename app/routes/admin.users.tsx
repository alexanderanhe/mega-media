import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Route } from "./+types/admin.users";
import { Drawer } from "vaul";
import { requireAdminPage } from "~/server/guards";
import { createAdminUser, getAdminUsers, patchAdminUser } from "~/shared/client-api";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdminPage(request);
  return null;
}

export default function AdminUsersRoute() {
  const [users, setUsers] = useState<
    Array<{
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
    }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = () => {
    setLoading(true);
    getAdminUsers()
      .then((res) => setUsers(res.items))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      await createAdminUser({
        email: String(form.get("email")),
        password: String(form.get("password")),
        role: String(form.get("role")) as "ADMIN" | "VIEWER",
      });
      event.currentTarget.reset();
      setCreateOpen(false);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-slate-900 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Users</h2>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded border border-white/20 px-3 py-2 text-sm font-semibold"
          >
            Create user
          </button>
        </div>
        {error ? <p className="mb-3 text-rose-400">{error}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400">
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Request</th>
                <th>Active</th>
                <th>Actions</th>
              </tr>
            </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, idx) => (
                  <tr key={`skeleton-${idx}`} className="border-t border-white/10">
                    <td className="py-3"><div className="skeleton h-4 w-28" /></td>
                    <td className="py-3"><div className="skeleton h-4 w-48" /></td>
                    <td><div className="skeleton h-4 w-20" /></td>
                    <td><div className="skeleton h-4 w-20" /></td>
                    <td><div className="skeleton h-4 w-56" /></td>
                    <td><div className="skeleton h-4 w-16" /></td>
                    <td><div className="skeleton h-8 w-40" /></td>
                  </tr>
                ))
              : users.map((user) => (
                  <tr key={user.id} className="border-t border-white/10">
                    <td className="py-2">{user.name || "-"}</td>
                    <td className="py-2">{user.email}</td>
                    <td>{user.role}</td>
                    <td>{user.approvalStatus ?? (user.isActive ? "approved" : "pending")}</td>
                    <td className="max-w-xs truncate text-slate-300">{user.requestMessage || "-"}</td>
                    <td>{user.isActive ? "yes" : "no"}</td>
                    <td className="space-x-2 py-2">
                      {user.approvalStatus === "pending" || !user.isActive ? (
                        <button
                          type="button"
                          className="rounded border border-emerald-400/40 px-2 py-1 text-emerald-200"
                          onClick={() =>
                            patchAdminUser(user.id, { isActive: true, approvalStatus: "approved" }).then(refresh)
                          }
                        >
                          Approve
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="rounded border border-white/20 px-2 py-1"
                        onClick={() => patchAdminUser(user.id, { isActive: !user.isActive }).then(refresh)}
                      >
                        {user.isActive ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        className="rounded border border-white/20 px-2 py-1"
                        onClick={() =>
                          patchAdminUser(user.id, { role: user.role === "ADMIN" ? "VIEWER" : "ADMIN" }).then(refresh)
                        }
                      >
                        Toggle role
                      </button>
                      <button
                        type="button"
                        className="rounded border border-white/20 px-2 py-1"
                        onClick={() => {
                          const password = window.prompt(`New password for ${user.email}`);
                          if (!password) return;
                          patchAdminUser(user.id, { password }).then(refresh);
                        }}
                      >
                        Reset password
                      </button>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      </section>
      <Drawer.Root open={createOpen} onOpenChange={setCreateOpen} direction="right">
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-black/70" />
          <Drawer.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-white/10 bg-black/95 p-6 text-slate-100 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <Drawer.Title className="text-lg font-semibold">Create user</Drawer.Title>
              <button type="button" onClick={() => setCreateOpen(false)} className="text-slate-400 hover:text-white">
                Close
              </button>
            </div>
            <form onSubmit={createUser} className="grid gap-3">
              <input
                name="email"
                type="email"
                placeholder="email"
                required
                className="rounded border border-white/20 bg-black/30 px-3 py-2"
              />
              <input
                name="password"
                type="password"
                placeholder="password"
                required
                className="rounded border border-white/20 bg-black/30 px-3 py-2"
              />
              <select name="role" className="rounded border border-white/20 bg-black/30 px-3 py-2">
                <option value="VIEWER">VIEWER</option>
                <option value="ADMIN">ADMIN</option>
              </select>
              <div className="flex items-center justify-end gap-3 pt-2">
                <button type="button" onClick={() => setCreateOpen(false)} className="rounded border border-white/20 px-4 py-2">
                  Cancel
                </button>
                <button type="submit" className="rounded bg-cyan-600 px-4 py-2 font-semibold">
                  Create
                </button>
              </div>
            </form>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </div>
  );
}
