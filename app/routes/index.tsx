import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FiCalendar, FiImage, FiLogIn, FiLogOut, FiMinus, FiPlus, FiUser, FiUsers } from "react-icons/fi";
import { GameCanvas, type GameCanvasHandle } from "~/components/GameCanvas/GameCanvas";
import { getMediaFacets, getMediaPages, getMe, login, logout } from "~/shared/client-api";
import { Drawer } from "vaul";

export default function IndexRoute() {
  const [items, setItems] = useState<Array<{
    id: string;
    type: "image" | "video";
    aspect: number;
    status: "processing" | "ready" | "error";
    title?: string;
    description?: string;
    dateTaken?: string | null;
    dateEffective?: string;
  }>>([]);
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [years, setYears] = useState<Array<{ year: number; count: number }>>([]);
  const [months, setMonths] = useState<Array<{ month: number; count: number }>>([]);
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [categories, setCategories] = useState<Array<{ category: string; count: number }>>([]);
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<{ id: string; email: string; role: "ADMIN" | "VIEWER" } | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [typeFilter, setTypeFilter] = useState<"" | "image" | "video">("");
  const [tagFilter, setTagFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<GameCanvasHandle | null>(null);

  const query = useMemo(() => {
    const q = new URLSearchParams({ page: "1", pageSize: "200" });
    q.set("sort", "date_asc");
    if (fromDate) q.set("from", startOfDayIso(fromDate));
    if (toDate) q.set("to", endOfDayIso(toDate));
    if (typeFilter) q.set("type", typeFilter);
    if (tagFilter) q.set("tag", tagFilter);
    if (categoryFilter) q.set("category", categoryFilter);
    return q;
  }, [fromDate, toDate, typeFilter, tagFilter, categoryFilter]);

  useEffect(() => {
    setLoading(true);
    getMediaPages(query)
      .then((data) => {
        setItems(
          data.items.map((item) => ({
            id: item.id,
            type: item.type,
            aspect: item.aspect,
            status: item.status,
            title: item.title,
            description: item.description,
            dateTaken: item.dateTaken ?? null,
            dateEffective: item.dateEffective,
          })),
        );
      })
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => {
    getMe().then((data) => setUser(data.user ?? null));
  }, []);

  useEffect(() => {
    getMediaFacets({
      year: year || undefined,
      month: month || undefined,
      from: fromDate ? startOfDayIso(fromDate) : undefined,
      to: toDate ? endOfDayIso(toDate) : undefined,
      type: typeFilter || undefined,
      tag: tagFilter || undefined,
      category: categoryFilter || undefined,
    }).then((data) => {
      setYears(data.years);
      setMonths(data.months);
      setTags(data.tags);
      setCategories(data.categories);
    });
  }, [year, month, fromDate, toDate, typeFilter, tagFilter, categoryFilter]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0c1020] text-slate-100">
      <a href="/" className="fixed left-6 top-6 z-30">
        <img src="/logo.svg" alt="mega media" className="h-10 w-10" />
      </a>
      {loading && <div className="absolute bottom-4 left-4 z-20 rounded bg-black/60 px-3 py-2">Loading media...</div>}
      <GameCanvas
        ref={canvasRef}
        items={items}
        onZoomChange={(value) => setZoom(value)}
      />
      <div className="pointer-events-none absolute bottom-6 right-6 z-30 flex flex-col-reverse items-end gap-3">
        <CircleButton
          onClick={() => {
            if (user) {
              setShowMenu(true);
            } else {
              setShowLogin(true);
            }
          }}
          label={user ? initialsFromEmail(user.email) : ""}
          icon={!user ? <FiUser /> : undefined}
        />
        <CircleButton onClick={() => setShowFilters(true)} icon={<FiCalendar />} />
        <CircleButton onClick={() => canvasRef.current?.zoomOut()} icon={<FiMinus />} />
        <CircleButton
          onClick={() => canvasRef.current?.resetView()}
          label={`${Math.round(zoom * 100)}%`}
          subtle
          compact
        />
        <CircleButton onClick={() => canvasRef.current?.zoomIn()} icon={<FiPlus />} />
      </div>

      {showLogin ? (
        <LoginModal
          onClose={() => setShowLogin(false)}
          onSuccess={(nextUser) => {
            setUser(nextUser);
            setShowLogin(false);
          }}
        />
      ) : null}
      {showMenu && user ? (
        <UserMenuModal
          role={user.role}
          onClose={() => setShowMenu(false)}
          onLogout={async () => {
            await logout();
            setUser(null);
            setShowMenu(false);
            const next = window.location.pathname + window.location.search + window.location.hash;
            window.location.href = `/login?next=${encodeURIComponent(next)}`;
          }}
        />
      ) : null}
      <Drawer.Root open={showFilters} onOpenChange={setShowFilters} direction="right">
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-black/70" />
          <Drawer.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-white/10 bg-black/95 p-6 text-slate-100 shadow-2xl">
            <FilterDrawer
              year={year}
              month={month}
              fromDate={fromDate}
              toDate={toDate}
              years={years}
              months={months}
              tags={tags}
              categories={categories}
              typeFilter={typeFilter}
              tagFilter={tagFilter}
              categoryFilter={categoryFilter}
              onClose={() => setShowFilters(false)}
              onApply={(next) => {
                setYear(next.year);
                setMonth(next.month);
                const range = deriveRange(next);
                setFromDate(range.fromDate);
                setToDate(range.toDate);
                setTypeFilter(next.type);
                setTagFilter(next.tag);
                setCategoryFilter(next.category);
                setShowFilters(false);
              }}
              onClear={() => {
                setYear("");
                setMonth("");
                setFromDate("");
                setToDate("");
                setTypeFilter("");
                setTagFilter("");
                setCategoryFilter("");
                setShowFilters(false);
              }}
            />
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </div>
  );
}

function CircleButton({
  onClick,
  label,
  icon,
  subtle,
  compact,
}: {
  onClick?: () => void;
  label?: string;
  icon?: ReactNode;
  subtle?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-white/10 font-semibold shadow-lg backdrop-blur ${
        compact ? "text-[11px]" : "text-sm"
      } ${subtle ? "bg-black/40 text-slate-200" : "bg-black/70 text-white hover:bg-black/80"}`}
    >
      {icon ?? label}
    </button>
  );
}

function LoginModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (user: { id: string; email: string; role: "ADMIN" | "VIEWER" }) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Login</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
            Close
          </button>
        </div>
        <div className="space-y-3">
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
            type="email"
            className="w-full rounded border border-white/20 bg-black/30 px-3 py-2"
          />
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            type="password"
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
                await login(email, password);
                const me = await getMe();
                if (me.user) onSuccess(me.user);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Login failed");
              } finally {
                setLoading(false);
              }
            }}
            className="flex w-full items-center justify-center gap-2 rounded bg-cyan-600 px-4 py-2 font-semibold disabled:opacity-60"
          >
            <FiLogIn /> Login
          </button>
        </div>
      </div>
    </div>
  );
}

function UserMenuModal({
  role,
  onClose,
  onLogout,
}: {
  role: "ADMIN" | "VIEWER";
  onClose: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Menu</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
            Close
          </button>
        </div>
        <div className="space-y-3">
          <a href="/admin/media" className="flex items-center gap-2 rounded border border-white/10 px-3 py-2">
            <FiImage /> Media
          </a>
          {role === "ADMIN" ? (
            <a href="/admin/users" className="flex items-center gap-2 rounded border border-white/10 px-3 py-2">
              <FiUsers /> Users
            </a>
          ) : null}
          <button
            type="button"
            onClick={onLogout}
            className="flex w-full items-center gap-2 rounded border border-rose-400/40 px-3 py-2 text-rose-200"
          >
            <FiLogOut /> Logout
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterDrawer({
  year,
  month,
  fromDate,
  toDate,
  years,
  months,
  tags,
  categories,
  typeFilter,
  tagFilter,
  categoryFilter,
  onClose,
  onApply,
  onClear,
}: {
  year: string;
  month: string;
  fromDate: string;
  toDate: string;
  years: Array<{ year: number; count: number }>;
  months: Array<{ month: number; count: number }>;
  tags: Array<{ tag: string; count: number }>;
  categories: Array<{ category: string; count: number }>;
  typeFilter: "" | "image" | "video";
  tagFilter: string;
  categoryFilter: string;
  onClose: () => void;
  onApply: (value: { year: string; month: string; fromDate: string; toDate: string; type: "" | "image" | "video"; tag: string; category: string }) => void;
  onClear: () => void;
}) {
  const [nextYear, setNextYear] = useState(year);
  const [nextMonth, setNextMonth] = useState(month);
  const [nextFrom, setNextFrom] = useState(fromDate);
  const [nextTo, setNextTo] = useState(toDate);
  const [nextType, setNextType] = useState<"" | "image" | "video">(typeFilter);
  const [nextTag, setNextTag] = useState(tagFilter);
  const [nextCategory, setNextCategory] = useState(categoryFilter);

  useEffect(() => {
    setNextYear(year);
    setNextMonth(month);
    setNextFrom(fromDate);
    setNextTo(toDate);
    setNextType(typeFilter);
    setNextTag(tagFilter);
    setNextCategory(categoryFilter);
  }, [year, month, fromDate, toDate, typeFilter, tagFilter, categoryFilter]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center justify-between">
        <Drawer.Title className="text-lg font-semibold">Filters</Drawer.Title>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
          Close
        </button>
      </div>
      <div className="space-y-4 overflow-y-auto pb-6">
        <div className="space-y-2">
          <p className="text-xs uppercase text-slate-400">Type</p>
          <div className="flex flex-wrap gap-2">
            {[
              { value: "", label: "All" },
              { value: "image", label: "Images" },
              { value: "video", label: "Videos" },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => setNextType(item.value as "" | "image" | "video")}
                className={`rounded-full border px-3 py-1 text-xs ${
                  item.value === nextType ? "border-cyan-400 bg-cyan-500/20 text-cyan-200" : "border-white/10 text-slate-300"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs uppercase text-slate-400">Categories</p>
          <div className="flex flex-wrap gap-2">
            {[
              { category: "", count: 0, label: "All" },
              ...categories.map((item) => ({ ...item, label: item.category })),
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => setNextCategory(item.category)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  item.category === nextCategory ? "border-cyan-400 bg-cyan-500/20 text-cyan-200" : "border-white/10 text-slate-300"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs uppercase text-slate-400">Tags</p>
          <div className="flex flex-wrap gap-2">
            {[
              { tag: "", count: 0, label: "All" },
              ...tags.map((item) => ({ ...item, label: item.tag })),
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => setNextTag(item.tag)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  item.tag === nextTag ? "border-cyan-400 bg-cyan-500/20 text-cyan-200" : "border-white/10 text-slate-300"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs uppercase text-slate-400">Years</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setNextYear("");
                setNextMonth("");
                setNextFrom("");
                setNextTo("");
              }}
              className={`rounded-full border px-3 py-1 text-xs ${
                nextYear === "" ? "border-cyan-400 bg-cyan-500/20 text-cyan-200" : "border-white/10 text-slate-300"
              }`}
            >
              All
            </button>
            {years.length ? (
              years.map((item) => (
                <button
                  key={item.year}
                  type="button"
                  onClick={() => {
                    setNextYear(String(item.year));
                    setNextMonth("");
                    const range = yearRange(String(item.year));
                    setNextFrom(range.fromDate);
                    setNextTo(range.toDate);
                  }}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    String(item.year) === nextYear ? "border-cyan-400 bg-cyan-500/20 text-cyan-200" : "border-white/10 text-slate-300"
                  }`}
                >
                  {item.year}
                </button>
              ))
            ) : (
              <span className="text-xs text-slate-500">No years</span>
            )}
          </div>
        </div>
        {nextYear && months.length ? (
          <div className="space-y-2">
            <p className="text-xs uppercase text-slate-400">Months</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setNextMonth("");
                  const range = yearRange(nextYear);
                  setNextFrom(range.fromDate);
                  setNextTo(range.toDate);
                }}
                className={`rounded-full border px-3 py-1 text-xs ${
                  nextMonth === "" ? "border-cyan-400 bg-cyan-500/20 text-cyan-200" : "border-white/10 text-slate-300"
                }`}
              >
                All
              </button>
              {months.map((item) => (
                <button
                  key={item.month}
                  type="button"
                  onClick={() => {
                    const value = `${nextYear}-${String(item.month).padStart(2, "0")}`;
                    setNextMonth(value);
                    const range = monthRange(value);
                    setNextFrom(range.fromDate);
                    setNextTo(range.toDate);
                  }}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    `${nextYear}-${String(item.month).padStart(2, "0")}` === nextMonth
                      ? "border-cyan-400 bg-cyan-500/20 text-cyan-200"
                      : "border-white/10 text-slate-300"
                  }`}
                >
                  {String(item.month).padStart(2, "0")}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="space-y-2">
          <p className="text-xs uppercase text-slate-400">Date range</p>
          <div className="grid gap-2 md:grid-cols-2">
            <input
              type="date"
              value={nextFrom}
              onChange={(event) => setNextFrom(event.target.value)}
              className="w-full rounded border border-white/20 bg-black/30 px-3 py-2 text-sm"
            />
            <input
              type="date"
              value={nextTo}
              onChange={(event) => setNextTo(event.target.value)}
              className="w-full rounded border border-white/20 bg-black/30 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>
      <div className="mt-auto flex justify-end gap-3 pt-6">
        <button type="button" onClick={onClear} className="rounded border border-white/20 px-4 py-2">
          Clear
        </button>
        <button
          type="button"
          onClick={() =>
            onApply({
              year: nextYear,
              month: nextMonth,
              fromDate: nextFrom,
              toDate: nextTo,
              type: nextType,
              tag: nextTag,
              category: nextCategory,
            })
          }
          className="rounded bg-cyan-600 px-4 py-2 font-semibold"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function initialsFromEmail(email: string) {
  const [name] = email.split("@");
  const parts = name.split(/[._-]+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  return initials || "U";
}

function startOfDayIso(dateStr: string) {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toISOString();
}

function endOfDayIso(dateStr: string) {
  const date = new Date(`${dateStr}T23:59:59.999`);
  return date.toISOString();
}

function deriveRange(value: { year: string; month: string; fromDate: string; toDate: string }) {
  if (value.fromDate || value.toDate) {
    return { fromDate: value.fromDate, toDate: value.toDate };
  }
  if (value.month) {
    return monthRange(value.month);
  }
  if (value.year) {
    return yearRange(value.year);
  }
  return { fromDate: "", toDate: "" };
}

function yearRange(year: string) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  return { fromDate: start, toDate: end };
}

function monthRange(value: string) {
  const [y, m] = value.split("-").map(Number);
  if (!y || !m) return { fromDate: "", toDate: "" };
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    fromDate: start.toISOString().slice(0, 10),
    toDate: end.toISOString().slice(0, 10),
  };
}
