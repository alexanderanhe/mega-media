import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { clearMediaUrlCache, completeSignup, getAuthConfig, login, requestAccess, verifyAccessCode } from "~/shared/client-api";

export default function LoginRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [enableSelfSignup, setEnableSelfSignup] = useState(false);

  useEffect(() => {
    getAuthConfig().then((data) => setEnableSelfSignup(Boolean(data.enableSelfSignup)));
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    try {
      await login(email, password);
      clearMediaUrlCache();
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
        {enableSelfSignup ? (
          <button
            type="button"
            onClick={() => setShowRequest(true)}
            className="text-left text-sm text-cyan-300 hover:text-cyan-200"
          >
            No tienes cuenta? Solicitar acceso
          </button>
        ) : null}
      </form>
      {showRequest ? (
        <RequestAccessModal onClose={() => setShowRequest(false)} />
      ) : null}
    </main>
  );
}

function RequestAccessModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<"request" | "verify" | "complete" | "done">("request");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [requestMessage, setRequestMessage] = useState(
    "Hola, me gustaria solicitar acceso a la galeria. Gracias.",
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Solicitar acceso</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
            Close
          </button>
        </div>
        {step === "request" ? (
          <div className="space-y-3">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nombre"
              type="text"
              className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
            />
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email"
              type="email"
              className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
            />
            {error ? <p className="text-sm text-rose-300">{error}</p> : null}
            <button
              type="button"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                setError(null);
                try {
                  await requestAccess({ name: name.trim(), email: email.trim() });
                  setStep("verify");
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Request failed");
                } finally {
                  setLoading(false);
                }
              }}
              className="flex w-full items-center justify-center gap-2 rounded bg-cyan-600 px-4 py-2 font-semibold disabled:opacity-60"
            >
              Enviar codigo
            </button>
          </div>
        ) : null}
        {step === "verify" ? (
          <div className="space-y-3">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Codigo de 6 digitos"
              inputMode="numeric"
              className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
            />
            {error ? <p className="text-sm text-rose-300">{error}</p> : null}
            <button
              type="button"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                setError(null);
                try {
                  await verifyAccessCode({ email: email.trim(), code: code.trim() });
                  setStep("complete");
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Verification failed");
                } finally {
                  setLoading(false);
                }
              }}
              className="flex w-full items-center justify-center gap-2 rounded bg-cyan-600 px-4 py-2 font-semibold disabled:opacity-60"
            >
              Verificar codigo
            </button>
          </div>
        ) : null}
        {step === "complete" ? (
          <div className="space-y-3">
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              type="password"
              className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
            />
            <textarea
              value={requestMessage}
              onChange={(event) => setRequestMessage(event.target.value)}
              rows={4}
              className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
            />
            {error ? <p className="text-sm text-rose-300">{error}</p> : null}
            <button
              type="button"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                setError(null);
                try {
                  await completeSignup({
                    email: email.trim(),
                    password,
                    requestMessage: requestMessage.trim(),
                  });
                  setStep("done");
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Signup failed");
                } finally {
                  setLoading(false);
                }
              }}
              className="flex w-full items-center justify-center gap-2 rounded bg-cyan-600 px-4 py-2 font-semibold disabled:opacity-60"
            >
              Enviar solicitud
            </button>
          </div>
        ) : null}
        {step === "done" ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">Listo. Tu solicitud fue enviada y esta pendiente de aprobacion.</p>
            <button
              type="button"
              onClick={onClose}
              className="flex w-full items-center justify-center gap-2 rounded bg-cyan-600 px-4 py-2 font-semibold"
            >
              Cerrar
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
