import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { ArrowRight, Lock } from 'lucide-react';

export default function AdminGate({ onSuccess }) {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(false);
    try {
      const res = await base44.functions.invoke('getAdminStats', { passcode });
      if (res.data) {
        onSuccess(passcode);
      } else {
        setError(true);
      }
    } catch (err) {
      setError(true);
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-[#080810] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-[13px] font-semibold tracking-[0.3em] text-white uppercase">Mirror</h1>
          <p className="text-[10px] tracking-widest text-[#64748B] uppercase mt-1">Admin Access</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#64748B]" />
            <input
              type="password"
              value={passcode}
              onChange={(e) => {
                setPasscode(e.target.value);
                setError(false);
              }}
              placeholder="Enter passcode"
              autoFocus
              className={`w-full bg-[#13131F] border rounded-md pl-10 pr-3 py-3 text-sm text-white placeholder:text-[#4A5568] focus:outline-none transition ${
                error ? 'border-red-500/50 animate-shake' : 'border-[#2A2A3E] focus:border-[#6366F1]'
              }`}
            />
          </div>
          {error && <p className="text-xs text-red-400">Access denied</p>}
          <button
            type="submit"
            disabled={loading || !passcode}
            className="w-full py-3 bg-[#6366F1] hover:bg-[#5558E0] text-white text-sm font-medium rounded-md transition disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? 'Verifying...' : 'Enter'}
            {!loading && <ArrowRight size={16} />}
          </button>
        </form>
      </div>
    </div>
  );
}