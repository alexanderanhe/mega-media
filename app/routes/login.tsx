import { useState } from "react";
import type { FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { login } from "~/shared/client-api";

export default function LoginRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    try {
      await login(email, password);
      const params = new URLSearchParams(location.search);
      const next = params.get("next") || "/";
      navigate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <form onSubmit={onSubmit} className="w-full max-w-md space-y-4 rounded-2xl border border-white/10 bg-slate-900 p-6">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <label className="block space-y-1">
          <span className="text-sm text-slate-300">Email</span>
          <input name="email" type="email" required className="w-full rounded border border-white/20 bg-black/30 px-3 py-2" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-slate-300">Password</span>
          <input name="password" type="password" required className="w-full rounded border border-white/20 bg-black/30 px-3 py-2" />
        </label>
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
        <button type="submit" disabled={loading} className="w-full rounded bg-cyan-600 px-4 py-2 font-semibold disabled:opacity-60">
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
