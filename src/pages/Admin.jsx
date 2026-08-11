// The admin console (P8, pulled forward — CEO directive, 9 Aug 2026). The
// DOOR is unchanged: adminGate decides, nothing renders before the verdict,
// non-admins are walked to the public hero. What's new are the ROOMS —
// people, operations, money-truth — each backed by a server-walled endpoint
// (adminRoutes: cookie + role, checked per request; this page's gate stays
// UX). Every list renders loading / error-with-retry / ready, reloads are
// sequenced, and the one mutation (suspend/reactivate) takes two clicks —
// the second is the confirmation, and the refusals speak the server's words.

import {
  Activity,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  ShieldCheck,
  UserX,
  UserCheck,
  Loader2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/hooks/useAuth';
import { adminGate } from '@/lib/adminGate';
import {
  fetchHealth,
  fetchOverview,
  fetchSessions,
  fetchSettlements,
  fetchUsers,
  setUserStatus,
} from '@/lib/adminClient';

const when = (epochSeconds) =>
  epochSeconds ? new Date(epochSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16) : '—';

/**
 * One list's lifecycle: loading → error(retry) | ready. Reloads sequenced.
 * @returns {[{ phase: string, items: any }, () => Promise<void>]}
 */
function useAdminList(loader) {
  const [state, setState] = useState({ phase: 'loading', items: null });
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const items = await loader();
    if (mine !== seq.current) return;
    setState(items === null ? { phase: 'error', items: null } : { phase: 'ready', items });
  }, [loader]);
  useEffect(() => {
    reload();
  }, [reload]);
  return [state, reload];
}

function Panel({ title, state, reload, children }) {
  return (
    <section className="rounded-xl border border-[#1E1E2E] bg-[#0B0B14] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[10px] tracking-[0.22em] uppercase text-[#94A3B8]">{title}</h2>
        <button
          type="button"
          onClick={reload}
          title={`refresh ${title}`}
          className="text-[#475569] hover:text-[#A5B4FC] transition-colors"
        >
          <RefreshCw size={11} aria-hidden />
        </button>
      </div>
      {state.phase === 'loading' ? (
        <p className="text-[11px] text-[#64748B]">loading…</p>
      ) : state.phase === 'error' ? (
        <p className="flex items-center gap-2 text-[11px] text-[#FBBF24]">
          could not load
          <button type="button" onClick={reload} className="text-[#A5B4FC] hover:text-[#E2E8F0]">
            retry
          </button>
        </p>
      ) : (
        children
      )}
    </section>
  );
}

function Stat({ label, value, tone = 'text-[#E2E8F0]' }) {
  return (
    <div className="rounded-lg border border-[#1E1E2E] bg-[#08080F] px-4 py-3">
      <div className="text-[9px] tracking-[0.18em] uppercase text-[#64748B]">{label}</div>
      <div className={`mt-1 text-lg font-light tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

const STATUS_PILLS = {
  ok: ['text-[#34D399]', 'ok'],
  payment: ['text-[#FBBF24]', 'payment issue'],
  rejected: ['text-[#FCA5A5]', 'key rejected'],
  unreachable: ['text-[#64748B]', 'unreachable'],
};

function HealthView() {
  const [health, reloadHealth] = useAdminList(fetchHealth);
  // The screen answers "dead key or crashed unit" at a glance and stays
  // current on its own while open — a 30s cadence, cleaned up on unmount.
  useEffect(() => {
    const timer = setInterval(reloadHealth, 30_000);
    return () => clearInterval(timer);
  }, [reloadHealth]);

  const h = health.items;
  return (
    <div className="flex flex-col gap-4">
      <Panel title="vendor keys" state={health} reload={reloadHealth}>
        {(h?.vendors ?? []).length === 0 ? (
          <p className="text-[11px] text-[#64748B]">no vendor keys configured</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="text-[9px] tracking-[0.18em] uppercase text-[#64748B]">
                  <th className="py-1.5 pr-4 font-normal">vendor</th>
                  <th className="py-1.5 pr-4 font-normal">key</th>
                  <th className="py-1.5 pr-4 font-normal">status</th>
                  <th className="py-1.5 pr-4 font-normal">quota</th>
                  <th className="py-1.5 font-normal">detail</th>
                </tr>
              </thead>
              <tbody className="text-[#CBD5E1]">
                {(h?.vendors ?? []).map((v) => {
                  const [tone, word] = STATUS_PILLS[v.status] ?? ['text-[#64748B]', v.status];
                  return (
                    <tr key={`${v.vendor}:${v.fingerprint}`} className="border-t border-[#14141F]">
                      <td className="py-2 pr-4">{v.vendor}</td>
                      <td className="py-2 pr-4 font-mono text-[11px]">{v.fingerprint}</td>
                      <td className={`py-2 pr-4 ${tone}`}>● {word}</td>
                      <td className="py-2 pr-4 tabular-nums">
                        {v.quota
                          ? `${Math.round((v.quota.used / v.quota.limit) * 100)}% of ${v.quota.limit.toLocaleString()}`
                          : '—'}
                      </td>
                      <td className="py-2 text-[11px] text-[#64748B]">{v.detail ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="agents" state={health} reload={reloadHealth}>
        {(h?.agents ?? []).length === 0 ? (
          <p className="text-[11px] text-[#64748B]">no rooms configured</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="text-[9px] tracking-[0.18em] uppercase text-[#64748B]">
                  <th className="py-1.5 pr-4 font-normal">room</th>
                  <th className="py-1.5 pr-4 font-normal">agent</th>
                  <th className="py-1.5 pr-4 font-normal">participants</th>
                  <th className="py-1.5 font-normal">detail</th>
                </tr>
              </thead>
              <tbody className="text-[#CBD5E1]">
                {(h?.agents ?? []).map((a) => (
                  <tr key={a.room} className="border-t border-[#14141F]">
                    <td className="py-2 pr-4">{a.room}</td>
                    <td className="py-2 pr-4">
                      {a.agentLive === true ? (
                        <span className="text-[#34D399]">● live{a.agentIdentity ? ` — ${a.agentIdentity}` : ''}</span>
                      ) : a.agentLive === false ? (
                        <span className="text-[#FCA5A5]">● not serving</span>
                      ) : (
                        <span className="text-[#64748B]">● unknown</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{a.participants ?? '—'}</td>
                    <td className="py-2 text-[11px] text-[#64748B]">{a.detail ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {h?.checkedAt ? (
        <p className="text-right text-[10px] text-[#3E4A5F] tabular-nums">
          checked {new Date(h.checkedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC · auto-refreshes every 30s
        </p>
      ) : null}
    </div>
  );
}

export default function Admin() {
  const auth = useAuth();
  const gate = adminGate(auth);
  const redirectTo = gate.verdict === 'redirect' ? gate.to : null;

  useEffect(() => {
    if (redirectTo) globalThis.location?.replace(redirectTo);
  }, [redirectTo]);

  const [signOutError, setSignOutError] = useState('');
  const onSignOut = async () => {
    setSignOutError('');
    try {
      await auth.signOut();
    } catch {
      setSignOutError('sign-out failed — the session is still active; try again');
    }
  };

  const [view, setView] = useState('console'); // 'console' | 'health'
  const [overview, reloadOverview] = useAdminList(fetchOverview);
  const [users, reloadUsers] = useAdminList(fetchUsers);
  const [sessions, reloadSessions] = useAdminList(fetchSessions);
  const [settlements, reloadSettlements] = useAdminList(fetchSettlements);

  // The two-click mutation: first click arms THIS user's confirm, second
  // executes; anything else disarms. Refusals speak the server's words.
  const [arming, setArming] = useState(null); // { id, nextStatus } | null
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const onToggleStatus = async (u) => {
    const nextStatus = u.status === 'active' ? 'suspended' : 'active';
    if (arming?.id !== u.id || arming?.nextStatus !== nextStatus) {
      setArming({ id: u.id, nextStatus });
      setNotice('');
      return;
    }
    // `arming` survives until cleanup so the in-flight row can render its
    // spinner (CodeRabbit, PR 103 — clearing it first made the Loader
    // unreachable); `busy` disables every button meanwhile.
    setBusy(true);
    const res = await setUserStatus(u.id, nextStatus);
    setNotice(res.ok ? '' : (res.message ?? ''));
    await Promise.all([reloadUsers(), reloadOverview()]);
    setArming(null);
    setBusy(false);
  };

  if (gate.verdict !== 'allow') return null;

  const ov = overview.items;
  return (
    <div className="min-h-screen bg-[#08080F] text-white">
      <header className="px-6 sm:px-10 py-6 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <span className="text-[13px] tracking-[0.42em] uppercase text-white/90">Lumina</span>
          <span className="text-[13px] tracking-[0.42em] uppercase text-white/35">Stream</span>
          <span className="ml-2 flex items-center gap-1 text-[10px] tracking-[0.3em] uppercase text-[#F59E0B]">
            <ShieldCheck size={11} aria-hidden /> admin
          </span>
        </div>
        <div className="flex items-center gap-3">
          <nav className="flex rounded-full border border-[#1E1E2E] p-0.5" aria-label="admin views">
            <button
              type="button"
              onClick={() => setView('console')}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[10px] tracking-[0.14em] uppercase transition-colors ${
                view === 'console' ? 'bg-[#1E1E2E] text-[#E2E8F0]' : 'text-[#64748B] hover:text-[#94A3B8]'
              }`}
            >
              <LayoutDashboard size={10} aria-hidden /> console
            </button>
            <button
              type="button"
              onClick={() => setView('health')}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[10px] tracking-[0.14em] uppercase transition-colors ${
                view === 'health' ? 'bg-[#1E1E2E] text-[#E2E8F0]' : 'text-[#64748B] hover:text-[#94A3B8]'
              }`}
            >
              <HeartPulse size={10} aria-hidden /> health
            </button>
          </nav>
          {signOutError ? (
            <span role="alert" className="text-[10px] text-[#FCA5A5]">
              {signOutError}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onSignOut}
            className="flex items-center gap-1.5 rounded-full border border-[#475569] px-4 py-1.5 text-[10px] tracking-[0.14em] uppercase text-[#94A3B8] hover:border-[#A5B4FC] hover:text-[#E2E8F0] transition-colors"
          >
            <LogOut size={10} aria-hidden /> sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-16 flex flex-col gap-4">
        {view === 'health' ? (
          <HealthView />
        ) : (
          <>
        {/* ── overview ─────────────────────────────────────────────── */}
        <Panel title="overview" state={overview} reload={reloadOverview}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="users" value={`${ov?.users?.active ?? 0} active / ${ov?.users?.total ?? 0}`} />
            <Stat
              label="live sessions"
              value={
                ov?.capacity
                  ? `${ov.capacity.live ?? 0} of ${ov.capacity.capacity ?? '—'}`
                  : 'unavailable'
              }
              tone={ov?.capacity ? 'text-[#E2E8F0]' : 'text-[#64748B]'}
            />
            <Stat
              label="video budget"
              value={
                ov?.videoBudget
                  ? `${Math.floor((ov.videoBudget.remainingSeconds ?? 0) / 60)}m left`
                  : 'unavailable'
              }
              tone={ov?.videoBudget ? 'text-[#E2E8F0]' : 'text-[#64748B]'}
            />
            <Stat
              label="voice cloning"
              value={ov?.voiceCloningEnabled ? 'live' : 'key pending'}
              tone={ov?.voiceCloningEnabled ? 'text-[#34D399]' : 'text-[#FBBF24]'}
            />
          </div>
        </Panel>

        {/* ── people ───────────────────────────────────────────────── */}
        <Panel title={`people${users.items ? ` · ${users.items.length}` : ''}`} state={users} reload={reloadUsers}>
          {notice ? (
            <p role="alert" className="mb-2 text-[11px] text-[#FBBF24]">
              {notice}
            </p>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="text-[9px] tracking-[0.18em] uppercase text-[#64748B]">
                  <th className="py-1.5 pr-4 font-normal">email</th>
                  <th className="py-1.5 pr-4 font-normal">role</th>
                  <th className="py-1.5 pr-4 font-normal">verified</th>
                  <th className="py-1.5 pr-4 font-normal">voices</th>
                  <th className="py-1.5 pr-4 font-normal">avatars</th>
                  <th className="py-1.5 pr-4 font-normal">joined</th>
                  <th className="py-1.5 pr-4 font-normal">status</th>
                  <th className="py-1.5 font-normal" />
                </tr>
              </thead>
              <tbody className="text-[#CBD5E1]">
                {(users.items ?? []).map((u) => (
                  <tr key={u.id} className="border-t border-[#14141F]">
                    <td className="py-2 pr-4">{u.email ?? '—'}</td>
                    <td className="py-2 pr-4">
                      {u.role === 'admin' ? (
                        <span className="text-[#F59E0B]">admin</span>
                      ) : (
                        'user'
                      )}
                    </td>
                    <td className="py-2 pr-4">{u.verified ? 'yes' : 'no'}</td>
                    <td className="py-2 pr-4 tabular-nums">{u.voices}</td>
                    <td className="py-2 pr-4 tabular-nums">{u.avatars}</td>
                    <td className="py-2 pr-4 tabular-nums">{when(u.createdAt)}</td>
                    <td className="py-2 pr-4">
                      {u.status === 'active' ? (
                        <span className="text-[#34D399]">active</span>
                      ) : (
                        <span className="text-[#FCA5A5]">suspended</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onToggleStatus(u)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[9px] tracking-[0.12em] uppercase transition-colors disabled:opacity-50 ${
                          arming?.id === u.id
                            ? 'border-[#F59E0B] text-[#F59E0B]'
                            : 'border-[#334155] text-[#94A3B8] hover:border-[#A5B4FC] hover:text-[#E2E8F0]'
                        }`}
                      >
                        {busy && arming?.id === u.id ? (
                          <Loader2 size={9} className="animate-spin" aria-hidden />
                        ) : u.status === 'active' ? (
                          <UserX size={9} aria-hidden />
                        ) : (
                          <UserCheck size={9} aria-hidden />
                        )}
                        {arming?.id === u.id
                          ? `confirm ${arming.nextStatus === 'suspended' ? 'suspend' : 'reactivate'}`
                          : u.status === 'active'
                            ? 'suspend'
                            : 'reactivate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* ── recent sessions ──────────────────────────────────────── */}
        <Panel title="recent sessions" state={sessions} reload={reloadSessions}>
          {(sessions.items ?? []).length === 0 ? (
            <p className="text-[11px] text-[#64748B]">no sessions recorded yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="text-[9px] tracking-[0.18em] uppercase text-[#64748B]">
                    <th className="py-1.5 pr-4 font-normal">started</th>
                    <th className="py-1.5 pr-4 font-normal">room</th>
                    <th className="py-1.5 pr-4 font-normal">mode</th>
                    <th className="py-1.5 font-normal">user</th>
                  </tr>
                </thead>
                <tbody className="text-[#CBD5E1]">
                  {(sessions.items ?? []).map((s) => (
                    <tr key={s.id} className="border-t border-[#14141F]">
                      <td className="py-2 pr-4 tabular-nums">{when(s.started_at)}</td>
                      <td className="py-2 pr-4">{s.room}</td>
                      <td className="py-2 pr-4">{s.mode ?? '—'}</td>
                      <td className="py-2">{s.user_id ?? 'ops'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ── vendor truth ─────────────────────────────────────────── */}
        <Panel title="video settlements" state={settlements} reload={reloadSettlements}>
          {(settlements.items ?? []).length === 0 ? (
            <p className="flex items-center gap-1.5 text-[11px] text-[#64748B]">
              <Activity size={11} aria-hidden /> no settlements yet — rows appear as video
              sessions end
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="text-[9px] tracking-[0.18em] uppercase text-[#64748B]">
                    <th className="py-1.5 pr-4 font-normal">settled</th>
                    <th className="py-1.5 pr-4 font-normal">granted</th>
                    <th className="py-1.5 pr-4 font-normal">used</th>
                    <th className="py-1.5 pr-4 font-normal">deducted¢</th>
                    <th className="py-1.5 pr-4 font-normal">source</th>
                    <th className="py-1.5 font-normal">flags</th>
                  </tr>
                </thead>
                <tbody className="text-[#CBD5E1]">
                  {(settlements.items ?? []).map((s) => (
                    <tr key={s.reservationId} className="border-t border-[#14141F]">
                      <td className="py-2 pr-4 tabular-nums">
                        {s.settledAt ? when(Math.floor(s.settledAt / 1000)) : '—'}
                      </td>
                      <td className="py-2 pr-4 tabular-nums">{s.grantedSeconds}s</td>
                      <td className="py-2 pr-4 tabular-nums">{s.usedSeconds}s</td>
                      <td className="py-2 pr-4 tabular-nums">{s.deductedCents ?? '—'}</td>
                      <td className="py-2 pr-4">{s.source}</td>
                      <td className="py-2 text-[#FBBF24]">{s.orphanFlag ? 'orphan' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
          </>
        )}
      </main>
    </div>
  );
}
