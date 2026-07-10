import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Activity, AlertCircle, LogOut, RefreshCw, Check, X } from 'lucide-react';
import PerformanceTracker from './PerformanceTracker';
import VoiceMetricsPanel from './VoiceMetricsPanel';

function StatCard({ label, value, icon: Icon, color }) {
  return (
    <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-5">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} style={{ color }} />
        <span className="text-[10px] tracking-widest uppercase text-[#64748B]">{label}</span>
      </div>
      <p className="text-2xl font-light text-white">{value}</p>
    </div>
  );
}

export default function AdminDashboard({ passcode, onLogout }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadStats = async () => {
    try {
      const res = await base44.functions.invoke('getAdminStats', { passcode });
      setStats(res.data);
    } catch (_err) {
      // passcode may have changed or session expired
    }
    setLoading(false);
  };

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#080810] flex items-center justify-center">
        <RefreshCw className="animate-spin text-[#64748B]" size={24} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080810] text-white">
      {/* Header */}
      <div className="border-b border-[#1A1A2E] px-8 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-[13px] font-semibold tracking-[0.3em] uppercase">Mirror</h1>
          <p className="text-[10px] tracking-widest text-[#64748B] uppercase mt-0.5">Admin Dashboard</p>
        </div>
        <button
          onClick={onLogout}
          className="text-[#64748B] hover:text-white transition flex items-center gap-2 text-xs"
        >
          <LogOut size={14} /> Exit
        </button>
      </div>

      <div className="p-8 max-w-6xl mx-auto space-y-8">
        {/* Stats grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard label="Active Sessions" value={stats?.activeSessionCount || 0} icon={Activity} color="#10B981" />
          <StatCard label="Today" value={stats?.todaySessionCount || 0} icon={Activity} color="#6366F1" />
          <StatCard label="Total" value={stats?.totalSessionCount || 0} icon={Activity} color="#64748B" />
          <StatCard
            label="API Key"
            value={stats?.apiKeyConfigured ? 'Active' : 'Missing'}
            icon={stats?.apiKeyConfigured ? Check : X}
            color={stats?.apiKeyConfigured ? '#10B981' : '#EF4444'}
          />
        </div>

        {/* Real-time performance tracker */}
        <PerformanceTracker sessions={stats?.activeSessions} summary={stats?.performanceSummary} />

        {/* Real-time voice conversion metrics */}
        <VoiceMetricsPanel sessions={stats?.activeSessions} summary={stats?.voiceSummary} />

        {/* Two-column: active sessions + errors */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6">
            <h2 className="text-[11px] tracking-widest uppercase text-[#64748B] mb-4">Active Sessions</h2>
            {stats?.activeSessions?.length ? (
              <div className="space-y-3">
                {stats.activeSessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between text-xs">
                    <span className="text-white/70 font-mono">{s.id.slice(0, 8)}…</span>
                    <span className="text-[#64748B]">{new Date(s.startTime).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[#64748B]">No active sessions</p>
            )}
          </div>

          <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6">
            <h2 className="text-[11px] tracking-widest uppercase text-[#64748B] mb-4 flex items-center gap-2">
              <AlertCircle size={12} /> Recent Errors
            </h2>
            {stats?.recentErrors?.length ? (
              <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                {stats.recentErrors.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-start gap-3 text-xs py-2 border-b border-[#1A1A2E] last:border-0"
                  >
                    <span className="text-red-400 font-mono whitespace-nowrap">{e.errorCode}</span>
                    <span className="text-white/60 flex-1 truncate">{e.errorMessage}</span>
                    <span className="text-[#64748B] whitespace-nowrap">
                      {new Date(e.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[#64748B]">No errors logged</p>
            )}
          </div>
        </div>

        {/* Session history */}
        <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6">
          <h2 className="text-[11px] tracking-widest uppercase text-[#64748B] mb-4">Session History</h2>
          {stats?.recentSessions?.length ? (
            <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
              {stats.recentSessions.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between text-xs py-2 border-b border-[#1A1A2E] last:border-0"
                >
                  <span className="text-white/70 font-mono">{s.id.slice(0, 8)}…</span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] uppercase ${
                      s.status === 'active'
                        ? 'bg-green-500/10 text-green-400'
                        : s.status === 'error'
                        ? 'bg-red-500/10 text-red-400'
                        : 'bg-[#2A2A3E] text-[#64748B]'
                    }`}
                  >
                    {s.status}
                  </span>
                  <span className="text-[#64748B]">{s.durationSeconds ? `${s.durationSeconds}s` : '—'}</span>
                  <span className="text-[#64748B]">{new Date(s.startTime).toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[#64748B]">No sessions yet</p>
          )}
        </div>
      </div>
    </div>
  );
}