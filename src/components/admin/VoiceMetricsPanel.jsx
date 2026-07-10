import { AudioWaveform, Cpu, Clock, Zap, Activity, AlertTriangle, Check } from 'lucide-react';

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

function latencyColor(ms, good, ok) {
  if (ms == null || ms === 0) return '#64748B';
  if (ms <= good) return '#10B981';
  if (ms <= ok) return '#F59E0B';
  return '#EF4444';
}

export default function VoiceMetricsPanel({ sessions, summary }) {
  const voiceSessions = (sessions || []).filter((s) => s.voiceActive || s.voiceBackend);

  return (
    <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[11px] tracking-widest uppercase text-[#64748B] flex items-center gap-2">
          <AudioWaveform size={12} /> Real-Time Voice Conversion
        </h2>
        <span className="text-[9px] text-[#64748B] flex items-center gap-1">
          <Activity size={10} /> {summary?.trackedVoiceSessions || 0} active
        </span>
      </div>

      {voiceSessions.length === 0 ? (
        <p className="text-xs text-[#64748B] py-4 text-center">
          No voice data — start a Converted Voice session to see GPU processing + round-trip latency
        </p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mb-5">
            <MetricCard
              label="GPU Process"
              value={summary?.avgProcessingMs || 0}
              unit="ms"
              icon={Cpu}
              color={latencyColor(summary?.avgProcessingMs, 50, 100)}
            />
            <MetricCard
              label="Round-Trip"
              value={summary?.avgRttMs || 0}
              unit="ms"
              icon={Clock}
              color={latencyColor(summary?.avgRttMs, 150, 300)}
            />
            <MetricCard
              label="Frames Sent"
              value={summary?.totalFramesSent || 0}
              unit=""
              icon={Zap}
              color="#6366F1"
            />
            <MetricCard
              label="Frames Recv"
              value={summary?.totalFramesReceived || 0}
              unit=""
              icon={Activity}
              color="#10B981"
            />
          </div>

          <div className="space-y-1">
            <div className="grid grid-cols-7 gap-2 text-[9px] tracking-widest uppercase text-[#4A5568] pb-2 border-b border-[#1A1A2E]">
              <span>Session</span>
              <span>Backend</span>
              <span>Model</span>
              <span>GPU ms</span>
              <span>RTT</span>
              <span>Sent</span>
              <span>Recv</span>
            </div>
            {voiceSessions.map((s) => {
              const procColor = latencyColor(s.voiceProcessingMs, 50, 100);
              const rttColor = latencyColor(s.voiceRttMs, 150, 300);
              return (
                <div
                  key={s.id}
                  className="grid grid-cols-7 gap-2 text-xs py-2 border-b border-[#1A1A2E] last:border-0 items-center"
                >
                  <span className="text-white/70 font-mono truncate">{s.id.slice(0, 8)}…</span>
                  <span className="font-mono text-[#64748B] uppercase text-[10px]">
                    {s.voiceBackend || '—'}
                  </span>
                  <span className="text-white/60 truncate text-[10px]" title={s.voiceModel}>
                    {s.voiceModel ? s.voiceModel.replace(/\.pth$/i, '') : '—'}
                  </span>
                  <span className="font-mono" style={{ color: procColor }}>
                    {s.voiceProcessingMs ? `${s.voiceProcessingMs}` : '—'}
                  </span>
                  <span className="font-mono" style={{ color: rttColor }}>
                    {s.voiceRttMs ? `${s.voiceRttMs}ms` : '—'}
                  </span>
                  <span className="font-mono text-[#64748B]">{s.voiceFramesSent || '—'}</span>
                  <span className="font-mono text-[#64748B]">{s.voiceFramesReceived || '—'}</span>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center gap-4 text-[9px] text-[#4A5568]">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#10B981]" /> Good</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#F59E0B]" /> Tune</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#EF4444]" /> Poor</span>
            <span className="ml-auto flex items-center gap-1">
              {summary && summary.totalFramesSent > 0 && summary.totalFramesReceived === 0 && (
                <><AlertTriangle size={10} className="text-[#F59E0B]" /> No audio returning — check server</>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}