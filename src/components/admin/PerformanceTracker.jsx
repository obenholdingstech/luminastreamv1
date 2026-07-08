import { Gauge, Zap, Clock, TrendingUp, Wifi } from 'lucide-react';

function QualityBar({ score }) {
  const color = score >= 80 ? '#10B981' : score >= 50 ? '#F59E0B' : '#EF4444';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-[#1A1A2E] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${score}%`, background: color }}
        />
      </div>
      <span className="text-[10px] font-mono w-6" style={{ color }}>
        {score}
      </span>
    </div>
  );
}

function MetricCard({ label, value, unit, icon: Icon, color }) {
  return (
    <div className="bg-[#13131F] border border-[#1A1A2E] rounded-md p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={11} style={{ color }} />
        <span className="text-[9px] tracking-widest uppercase text-[#64748B]">{label}</span>
      </div>
      <p className="text-lg font-light text-white">
        {value}
        <span className="text-[10px] text-[#64748B] ml-1">{unit}</span>
      </p>
    </div>
  );
}

export default function PerformanceTracker({ sessions, summary }) {
  const tracked = (sessions || []).filter((s) => s.qualityScore != null);

  return (
    <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[11px] tracking-widest uppercase text-[#64748B] flex items-center gap-2">
          <Gauge size={12} /> Real-Time Performance
        </h2>
        <span className="text-[9px] text-[#64748B] flex items-center gap-1">
          <Wifi size={10} /> {summary?.trackedSessions || 0} tracked
        </span>
      </div>

      {tracked.length === 0 ? (
        <p className="text-xs text-[#64748B] py-4 text-center">
          No performance data — metrics appear when streams are active
        </p>
      ) : (
        <>
          {/* Aggregate metrics */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            <MetricCard label="Avg FPS" value={summary?.avgFps || 0} unit="fps" icon={Zap} color="#10B981" />
            <MetricCard
              label="Avg Latency"
              value={summary?.avgLatency || 0}
              unit="ms"
              icon={Clock}
              color="#6366F1"
            />
            <MetricCard
              label="Avg Quality"
              value={summary?.avgQuality || 0}
              unit="/100"
              icon={TrendingUp}
              color="#F59E0B"
            />
          </div>

          {/* Per-session breakdown */}
          <div className="space-y-1">
            <div className="grid grid-cols-5 gap-2 text-[9px] tracking-widest uppercase text-[#4A5568] pb-2 border-b border-[#1A1A2E]">
              <span>Session</span>
              <span>FPS</span>
              <span>Latency</span>
              <span>Drops</span>
              <span>Quality</span>
            </div>
            {tracked.map((s) => {
              const fpsColor =
                s.currentFps >= 20 ? '#10B981' : s.currentFps >= 15 ? '#F59E0B' : '#EF4444';
              const latencyColor =
                s.latencyMs <= 200 ? '#10B981' : s.latencyMs <= 500 ? '#F59E0B' : '#EF4444';
              return (
                <div
                  key={s.id}
                  className="grid grid-cols-5 gap-2 text-xs py-2 border-b border-[#1A1A2E] last:border-0 items-center"
                >
                  <span className="text-white/70 font-mono truncate">{s.id.slice(0, 8)}…</span>
                  <span className="font-mono" style={{ color: fpsColor }}>
                    {s.currentFps || '—'}
                  </span>
                  <span className="font-mono" style={{ color: latencyColor }}>
                    {s.latencyMs ? `${s.latencyMs}ms` : '—'}
                  </span>
                  <span className="font-mono text-[#64748B]">
                    {s.droppedFrameRate != null ? `${s.droppedFrameRate}%` : '—'}
                  </span>
                  <QualityBar score={s.qualityScore || 0} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}