const STATE_CONFIG = {
  idle: { color: '#64748B', label: 'Ready', pulse: false },
  connecting: { color: '#F59E0B', label: 'Connecting', pulse: true },
  connected: { color: '#10B981', label: 'Live', pulse: false },
  disconnected: { color: '#F59E0B', label: 'Reconnecting', pulse: true },
  error: { color: '#EF4444', label: 'Error', pulse: false },
};

export default function StatusBadge({ state = 'idle' }) {
  const config = STATE_CONFIG[state] || STATE_CONFIG.idle;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm border border-white/10">
      <span
        className="w-2 h-2 rounded-full"
        style={{
          backgroundColor: config.color,
          boxShadow: config.pulse ? `0 0 8px ${config.color}` : 'none',
          animation: config.pulse ? 'pulse-glow 1.5s ease-in-out infinite' : 'none',
        }}
      />
      <span className="text-[11px] tracking-widest uppercase text-white/80">{config.label}</span>
    </div>
  );
}