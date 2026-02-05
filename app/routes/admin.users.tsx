import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Route } from "./+types/admin.users";
import { requireAdminPage } from "~/server/guards";
import { createAdminUser, getAdminUsers, patchAdminUser } from "~/shared/client-api";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdminPage(request);
  return null;
}

export default function AdminUsersRoute() {
  const [users, setUsers] = useState<Array<{ id: string; email: string; role: "ADMIN" | "VIEWER"; isActive: boolean; createdAt: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    const form = new FormData(event.currentTarget);
    await createAdminUser({
      email: String(form.get("email")),
      password: String(form.get("password")),
      role: String(form.get("role")) as "ADMIN" | "VIEWER",
    });
    event.currentTarget.reset();
    refresh();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-slate-900 p-4">
        <h2 className="mb-3 text-lg font-semibold">Create user</h2>
        <form onSubmit={createUser} className="grid gap-2 md:grid-cols-4">
          <input name="email" type="email" placeholder="email" required className="rounded border border-white/20 bg-black/30 px-3 py-2" />
          <input name="password" type="password" placeholder="password" required className="rounded border border-white/20 bg-black/30 px-3 py-2" />
          <select name="role" className="rounded border border-white/20 bg-black/30 px-3 py-2">
            <option value="VIEWER">VIEWER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
          <button type="submit" className="rounded bg-cyan-600 px-4 py-2 font-semibold">Create</button>
        </form>
      </section>

      <section className="rounded-xl border border-white/10 bg-slate-900 p-4">
        <h2 className="mb-3 text-lg font-semibold">Users</h2>
        {error ? <p className="mb-3 text-rose-400">{error}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400">
                <th>Email</th>
                <th>Role</th>
                <th>Active</th>
                <th>Actions</th>
              </tr>
            </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, idx) => (
                  <tr key={`skeleton-${idx}`} className="border-t border-white/10">
                    <td className="py-3"><div className="skeleton h-4 w-48" /></td>
                    <td><div className="skeleton h-4 w-20" /></td>
                    <td><div className="skeleton h-4 w-16" /></td>
                    <td><div className="skeleton h-8 w-40" /></td>
                  </tr>
                ))
              : users.map((user) => (
                  <tr key={user.id} className="border-t border-white/10">
                    <td className="py-2">{user.email}</td>
                    <td>{user.role}</td>
                    <td>{user.isActive ? "yes" : "no"}</td>
                    <td className="space-x-2 py-2">
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
    </div>
  );
}
