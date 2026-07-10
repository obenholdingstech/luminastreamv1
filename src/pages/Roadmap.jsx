import { useState } from 'react';
import { jsPDF } from 'jspdf';
import { Download, ArrowLeft, FileText, Cpu, Database, Zap, Server, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';

// ── Roadmap content (single source → renders to screen + PDF) ──
const content = [
  { type: 'title', text: 'MIRROR — Realtime Voice Conversion' },
  { type: 'subtitle', text: 'System Roadmap & Scaling Architecture' },
  { type: 'meta', text: 'July 2026  ·  Phase 1 Complete  ·  Current Quality 5.9/10  →  Target 9.9/10' },
  { type: 'divider' },

  { type: 'h2', text: '1. Executive Summary' },
  { type: 'p', text: 'Mirror is a realtime AI video + voice conversion platform. The voice subsystem converts a user\u2019s microphone input into a target voice in real time with minimal latency. Phase 1 is complete: a GPU-backed RVC (Retrieval-based Voice Conversion) server is live on RunPod, wired to the Base44 application via a binary WebSocket protocol. Users can now speak and hear themselves in a converted voice.' },
  { type: 'p', text: 'Current quality rating: 5.9/10. North star: 9.9/10 \u2014 indistinguishable from the target voice, with imperceptible latency, at production scale. This document captures where we are, where we are headed, and the architecture decisions that keep us scaling-ready so we never hit a wall we cannot migrate past.' },

  { type: 'h2', text: '2. Current State \u2014 Phase 1 (Complete)' },
  { type: 'ul', items: [
    'RVC inference server deployed on RunPod GPU (OpenVoiceChanger + RVC v2, CUDA, half precision)',
    'Binary WebSocket audio protocol \u2014 float32 PCM, 44100Hz, 4096-sample chunks',
    'Model dropdown populated live from the server /api/models/ endpoint, with search',
    'RVC-first voice selector with automatic fallback to ElevenLabs STS',
    'Live audio metrics in Admin dashboard \u2014 GPU processing time, round-trip latency, frame counts',
    'Model auto-activation on go-live (POST /api/models/<name>/activate)',
    'Voice metrics persisted to the Session entity for historical analysis',
  ]},
  { type: 'h2', text: 'Not Done Yet' },
  { type: 'ul', items: [
    'No .index feature file linked \u2014 timbre quality is limited (the biggest current lever)',
    'Single voice model only (aloy_beta12333333)',
    'No voice cloning pipeline \u2014 users cannot create custom models yet',
    'No GPU auto-scaling \u2014 single instance, manual',
    'No database indexing optimization or caching layer',
    'No async job queue for training / notifications',
  ]},

  { type: 'h2', text: '3. North Star & Quality Targets' },
  { type: 'p', text: 'Goal: 9.9/10 realtime voice conversion \u2014 indistinguishable from the target voice, with imperceptible latency, at scale.' },
  { type: 'table', headers: ['KPI', 'Current', 'Target'], colWidths: [200, 110, 110], rows: [
    ['GPU processing time / chunk', '~?', '< 30 ms'],
    ['Round-trip latency (send \u2192 receive)', '~?', '< 120 ms'],
    ['Pitch / formant accuracy', 'low', '> 95% match'],
    ['Artifact / glitch rate', 'moderate', '< 0.5% frames'],
    ['Mean Opinion Score (MOS)', '3.0', '> 4.5 / 5'],
    ['Concurrent streams / GPU', '1', '20\u201340'],
    ['Clone training time', 'n/a', '< 10 min'],
    ['DB query p99 @ 100k rows', 'unmeasured', '< 50 ms'],
  ]},

  { type: 'h2', text: '4. Architecture Overview' },
  { type: 'p', text: 'Current data flow: Browser (mic) \u2192 AudioWorklet (resample to float32, off main thread) \u2192 WebSocket \u2192 RVC GPU Server (FastAPI + RVC v2) \u2192 converted float32 PCM \u2192 Browser (speakers + recording).' },
  { type: 'ul', items: [
    'Frontend: React + AudioWorklet (dedicated audio thread), useVoiceStream hook, ovcClient WebSocket helpers',
    'Backend (Base44): functions \u2014 createSession, getVoiceConfig, listRvcModels, reportMetrics, cloneVoice; entities \u2014 Session, VoiceProfile, AppConfig, ErrorLog',
    'GPU Layer: RunPod instance running OpenVoiceChanger (FastAPI + WebSocket), RVC v2 models in /workspace/models/',
    'Metrics: Session entity stores per-chunk GPU time + RTT, polled by Admin dashboard every 5s',
  ]},

  { type: 'h2', text: '5. Scaling Architecture Principles' },
  { type: 'p', text: 'These principles guide every decision. We design as if we may migrate off Base44 tomorrow. The scaling cliff that hits vibe-coded AI apps is usually unindexed queries, synchronous heavy work, and platform-coupled logic. We avoid all three.' },

  { type: 'h3', text: '5.1 Database Indexing & Query Optimization' },
  { type: 'ul', items: [
    'Add indexes on high-cardinality query fields: Session(status, created_date), Session(voiceActive), ErrorLog(timestamp), VoiceProfile(created_by_id, status)',
    'All list queries use sort + explicit limit \u2014 no unbounded reads',
    'Pagination via skip/limit with caps; switch to cursor-based beyond 10k results',
    'No full-collection scans in admin aggregation \u2014 precompute summaries on a schedule',
  ]},

  { type: 'h3', text: '5.2 Caching Strategy' },
  { type: 'ul', items: [
    'listRvcModels \u2014 models rarely change; cache 60s TTL (client + server)',
    'getVoiceConfig \u2014 static until secret changes; cache indefinitely',
    'ElevenLabs voice library \u2014 1hr TTL',
    'Admin stats summaries \u2014 precompute every 30s via scheduled workflow instead of re-aggregating on every 5s poll',
    'Model activation state \u2014 avoid redundant POST /activate for already-active models',
  ]},

  { type: 'h3', text: '5.3 Async Processing' },
  { type: 'ul', items: [
    'Voice cloning training \u2192 queue; user does not wait during training',
    'Metrics reporting \u2192 fire-and-forget (already async)',
    'Email / notifications \u2192 queue via Base44 workflows',
    'Session end / cleanup \u2192 background task',
    'Heavy batch ops \u2192 scheduled workflows, off-peak',
  ]},

  { type: 'h3', text: '5.4 Avoiding Base44 Internal Limits' },
  { type: 'ul', items: [
    'Entity query caps \u2014 paginate; never list(10000) in hot paths',
    'Function timeout \u2014 keep handlers < 5s; offload heavy work to background',
    'File storage \u2014 never store audio blobs in entity fields; use UploadFile + file_url',
    'Rate limits \u2014 client-side backoff + server-side session caps',
    'Entity record size \u2014 keep Session lean; summarize metrics, never store per-frame',
  ]},

  { type: 'h3', text: '5.5 Migration Readiness' },
  { type: 'ul', items: [
    'All external-service logic lives in backend functions, not hardcoded in frontend \u2194 portable',
    'GPU server is standalone (RunPod), not coupled to Base44',
    'Entity schemas are standard JSON \u2194 exportable',
    'RVC is open-source \u2194 no proprietary lock-in in the voice pipeline',
    'Documented interfaces between layers \u2194 swap any layer independently',
  ]},

  { type: 'h2', text: '6. Phased Roadmap' },
  { type: 'table', headers: ['Phase', 'Focus', 'Key Deliverables', 'Status'], colWidths: [60, 120, 240, 70], rows: [
    ['1', 'Engine Foundation', 'RVC server, WS pipeline, live metrics', 'Done'],
    ['2A', 'Quality Tuning', '.index files, pitch/formant, crossfade, chunk tuning', 'Next'],
    ['2B', 'Multi-Model', 'Model registry, per-session select, hot-swap', 'Planned'],
    ['3', 'Voice Cloning', 'Upload \u2192 train \u2192 register pipeline, 5-voice cap', 'Planned'],
    ['4', 'GPU Auto-Scale', 'Multi-instance, load balancer, autoscaler', 'Planned'],
    ['5', 'Prod Scaling', 'DB indexes, caching, async queue, RLS', 'Planned'],
    ['6', 'Migration Ready', 'Standalone deploy option, data export', 'Planned'],
  ]},

  { type: 'h2', text: '7. Phase 2A \u2014 Quality Tuning (Immediate Next Step)' },
  { type: 'p', text: 'This is the current focus: move 5.9 \u2192 8.0+. Each change is measured against the Admin metrics panel (GPU processing time + round-trip latency) and A/B logged.' },

  { type: 'h3', text: '7.1 Add the .index feature file' },
  { type: 'ul', items: [
    'The .index (feature index) dramatically improves timbre accuracy \u2014 RVC retrieves target voice characteristics per-frame instead of approximating',
    'Upload aloy_beta12333333.index to /workspace/models/ on the RunPod server',
    'Server auto-detects has_index=true; the dropdown badge updates from "no index" to indexed',
    'Expected jump: +1.5\u20132.0 quality points',
  ]},

  { type: 'h3', text: '7.2 Parameter tuning' },
  { type: 'ul', items: [
    'Chunk size \u2014 test 2048 / 4096 / 8192: smaller = lower latency, larger = better quality',
    'Sample rate \u2014 model is native 40000Hz; we currently send 44100 (server resamples). Test sending 40000 directly to skip resampling',
    'Pitch (f0) \u2014 adjust f0up to match the target voice pitch',
    'Crossfade \u2014 tune overlap between chunks to remove seam artifacts',
    'f0 method \u2014 RMVPE (best quality) vs harvest (faster)',
  ]},

  { type: 'h3', text: '7.3 Pipeline tuning' },
  { type: 'ul', items: [
    'AudioWorklet chunk size \u2014 latency vs stability trade-off',
    'Mute-while-processing to prevent echo',
    'Small pre-buffer to absorb jitter without adding perceptible latency',
  ]},

  { type: 'h3', text: '7.4 Measurement loop' },
  { type: 'ul', items: [
    'After each change, record GPU processing + RTT in the Admin panel',
    'A/B compare settings, log results, pick winners',
    'Target: GPU < 30ms, RTT < 120ms, clean audio, MOS > 4.0',
  ]},

  { type: 'h2', text: '8. Phase 3 \u2014 Voice Cloning Pipeline' },
  { type: 'p', text: 'Users upload a voice sample \u2192 the system trains a custom RVC model \u2192 registers it on the GPU server \u2192 it appears in their dropdown. This is the user-facing scale feature.' },
  { type: 'ul', items: [
    'User uploads audio (\u226530s clean sample) via VoiceCloneUploader',
    'Backend queues an async training job (user does not wait)',
    'Training service (separate GPU job) runs RVC training \u2192 produces .pth + .index',
    'Upload model files to the inference server /models/ directory',
    'Register model in VoiceProfile entity (per-user, status=ready)',
    'Model appears in the user\u2019s dropdown; activation on select',
  ]},
  { type: 'p', text: 'Constraints: max 5 cloned voices per account (enforced in cloneVoice). Training is GPU-intensive and runs separate from inference so realtime streams are never starved. Queue with priority (paid users first). Cache trained models; batch training off-peak.' },

  { type: 'h2', text: '9. Phase 4 \u2014 GPU Auto-Scaling' },
  { type: 'p', text: 'A single instance will not scale. The plan:' },
  { type: 'ul', items: [
    'Pool of inference instances behind a WebSocket-aware load balancer (sticky sessions per stream)',
    'Autoscaler triggers on concurrent-stream count \u2014 > 70% capacity spins a new instance',
    'Model distribution \u2014 shared network volume or pre-baked image with common models; cloned models synced on creation',
    'Health checks via /health endpoint (already exists) \u2192 remove unhealthy instances',
    'Graceful drain on scale-down \u2014 finish active streams before terminating',
    'Cost control \u2014 scale to zero off-peak (cold start acceptable for first user)',
  ]},
  { type: 'p', text: 'RunPod supports template-based scaling; Kubernetes GPU node pools are the alternative for finer control. The inference server stays stateless per-stream so any instance can serve any user once models are synced.' },

  { type: 'h2', text: '10. Phase 5 \u2014 Production Scaling Hardening' },
  { type: 'ul', items: [
    'Apply all database indexes (5.1) and verify p99 with a seed of 100k rows',
    'Ship the caching layer (5.2) \u2014 listRvcModels, getVoiceConfig, admin summaries',
    'Ship the async queue (5.3) \u2014 training, notifications, cleanup',
    'Row-level security on VoiceProfile so users only see their own cloned voices',
    'Rate limiting + per-user concurrent session caps enforced server-side',
    'Structured error logging + alerting on error-rate thresholds',
  ]},

  { type: 'h2', text: '11. Risks & Mitigations' },
  { type: 'table', headers: ['Risk', 'Impact', 'Mitigation'], colWidths: [170, 150, 190], rows: [
    ['Base44 query limit at scale', 'Slow admin / stats', 'Precompute summaries, paginate, index'],
    ['GPU single point of failure', 'All voice down', 'Multi-instance + autoscale (Phase 4)'],
    ['Cloning training cost', 'High GPU bill', 'Queue off-peak, cache models, cap 5/user'],
    ['WebSocket drops', 'Audio gaps', 'Reconnect logic + client pre-buffer'],
    ['Echo / feedback', 'Bad UX', 'Mute-while-processing, headphone guidance'],
    ['Model quality variance', 'Inconsistent UX', 'Per-model quality score + A/B testing'],
  ]},

  { type: 'h2', text: '12. Next Immediate Action' },
  { type: 'ul', items: [
    '1. Upload aloy_beta12333333.index to /workspace/models/ on the RunPod server',
    '2. Confirm has_index: true in the dropdown badge',
    '3. Test and record the quality delta in the Admin metrics panel',
    '4. Begin chunk-size / sample-rate / pitch A/B tuning using the metrics panel',
    '5. Log results; iterate toward 8.0+',
  ]},
  { type: 'p', text: 'Once Phase 2A reaches 8.0+, we move to Phase 2B (multi-model) and Phase 3 (cloning pipeline) in parallel with Phase 5 (scaling hardening) so the foundation is ready before user load arrives.' },

  { type: 'divider' },
  { type: 'meta', text: 'End of roadmap \u2014 Mirror Realtime Voice Conversion System' },
];

// ── PDF generator ──
function generatePdf() {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const contentW = pageW - margin * 2;
  let y = margin;
  let pageNum = 1;

  const footer = () => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text(`Mirror Roadmap  ·  Page ${pageNum}`, pageW / 2, pageH - 20, { align: 'center' });
  };

  const ensureSpace = (h) => {
    if (y + h > pageH - margin - 10) {
      footer();
      doc.addPage();
      pageNum++;
      y = margin;
    }
  };

  for (const block of content) {
    switch (block.type) {
      case 'title':
        ensureSpace(40);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(20);
        doc.setTextColor(99, 102, 241);
        doc.text(block.text, margin, y + 20);
        y += 32;
        break;
      case 'subtitle':
        ensureSpace(20);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(13);
        doc.setTextColor(80, 80, 80);
        doc.text(block.text, margin, y + 12);
        y += 20;
        break;
      case 'meta':
        ensureSpace(16);
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(9);
        doc.setTextColor(120, 120, 120);
        const metaLines = doc.splitTextToSize(block.text, contentW);
        metaLines.forEach((line) => {
          ensureSpace(12);
          doc.text(line, margin, y + 8);
          y += 12;
        });
        y += 6;
        break;
      case 'divider':
        ensureSpace(16);
        doc.setDrawColor(220, 220, 230);
        doc.setLineWidth(0.5);
        doc.line(margin, y, pageW - margin, y);
        y += 14;
        break;
      case 'h2':
        ensureSpace(24);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(99, 102, 241);
        doc.text(block.text, margin, y + 10);
        y += 20;
        break;
      case 'h3':
        ensureSpace(18);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.setTextColor(55, 55, 60);
        doc.text(block.text, margin, y + 8);
        y += 14;
        break;
      case 'p': {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9.5);
        doc.setTextColor(55, 55, 55);
        const lines = doc.splitTextToSize(block.text, contentW);
        lines.forEach((line) => {
          ensureSpace(13);
          doc.text(line, margin, y + 8);
          y += 13;
        });
        y += 5;
        break;
      }
      case 'ul':
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9.5);
        doc.setTextColor(55, 55, 55);
        block.items.forEach((item) => {
          const lines = doc.splitTextToSize(item, contentW - 14);
          lines.forEach((line, i) => {
            ensureSpace(13);
            doc.text(i === 0 ? '\u2022  ' + line : line, margin + 14, y + 8);
            y += 13;
          });
        });
        y += 6;
        break;
      case 'table': {
        const rowH = 16;
        const totalW = block.colWidths.reduce((a, b) => a + b, 0);
        // header
        ensureSpace(rowH + 4);
        doc.setFillColor(99, 102, 241);
        doc.rect(margin, y, totalW, rowH, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(255, 255, 255);
        let cx = margin;
        block.headers.forEach((h, i) => {
          doc.text(h, cx + 4, y + 11);
          cx += block.colWidths[i];
        });
        y += rowH;
        // rows
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        block.rows.forEach((row, ri) => {
          ensureSpace(rowH);
          if (ri % 2 === 0) {
            doc.setFillColor(244, 245, 250);
            doc.rect(margin, y, totalW, rowH, 'F');
          }
          cx = margin;
          row.forEach((cell, i) => {
            doc.setTextColor(55, 55, 55);
            const cellLines = doc.splitTextToSize(String(cell), block.colWidths[i] - 8);
            doc.text(cellLines[0] || '', cx + 4, y + 11);
            cx += block.colWidths[i];
          });
          y += rowH;
        });
        y += 8;
        break;
      }
    }
  }
  footer();
  doc.save('Mirror-Voice-Roadmap.pdf');
}

// ── Screen renderer ──
function Block({ block }) {
  switch (block.type) {
    case 'title':
      return <h1 className="text-2xl font-bold text-[#6366F1] tracking-tight">{block.text}</h1>;
    case 'subtitle':
      return <p className="text-sm text-[#9CA3AF] mt-1">{block.text}</p>;
    case 'meta':
      return <p className="text-xs text-[#64748B] italic mt-1">{block.text}</p>;
    case 'divider':
      return <hr className="border-[#2A2A3E] my-5" />;
    case 'h2':
      return <h2 className="text-base font-bold text-[#6366F1] mt-6 mb-2 tracking-wide uppercase">{block.text}</h2>;
    case 'h3':
      return <h3 className="text-sm font-semibold text-white mt-4 mb-1.5">{block.text}</h3>;
    case 'p':
      return <p className="text-sm text-[#9CA3AF] leading-relaxed mb-2">{block.text}</p>;
    case 'ul':
      return (
        <ul className="space-y-1 mb-2">
          {block.items.map((item, i) => (
            <li key={i} className="text-sm text-[#9CA3AF] leading-relaxed flex gap-2">
              <span className="text-[#6366F1] flex-shrink-0">•</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="overflow-x-auto mb-3 mt-2">
          <table className="w-full text-xs border border-[#2A2A3E] rounded overflow-hidden">
            <thead>
              <tr className="bg-[#6366F1]">
                {block.headers.map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 text-white font-semibold uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 0 ? 'bg-[#13131F]' : 'bg-[#0F0F1A]'}>
                  {row.map((cell, i) => (
                    <td key={i} className="px-3 py-2 text-[#9CA3AF] align-top">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export default function Roadmap() {
  const [generating, setGenerating] = useState(false);

  const handleDownload = () => {
    setGenerating(true);
    try {
      generatePdf();
    } catch (_e) {}
    setGenerating(false);
  };

  return (
    <div className="min-h-screen bg-[#080810] text-white">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-[#080810]/90 backdrop-blur border-b border-[#1A1A2E] px-8 py-4 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 text-[#64748B] hover:text-white transition text-xs">
          <ArrowLeft size={14} /> Back to Studio
        </Link>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[9px] tracking-widest uppercase text-[#64748B]">
            <Cpu size={11} className="text-[#10B981]" /> Phase 1
            <span className="mx-1">·</span>
            <Database size={11} className="text-[#6366F1]" /> Scaling Arch
            <span className="mx-1">·</span>
            <TrendingUp size={11} className="text-[#F59E0B]" /> 5.9 → 9.9
          </div>
          <button
            onClick={handleDownload}
            disabled={generating}
            className="flex items-center gap-2 bg-[#6366F1] hover:bg-[#5558E0] text-white text-xs font-medium px-4 py-2 rounded-md transition disabled:opacity-50"
          >
            {generating ? <Zap size={14} className="animate-pulse" /> : <Download size={14} />}
            {generating ? 'Generating…' : 'Download PDF'}
          </button>
        </div>
      </div>

      {/* Document body */}
      <div className="max-w-3xl mx-auto px-8 py-8">
        <div className="flex items-center gap-2 text-[#64748B] text-[10px] tracking-widest uppercase mb-6">
          <FileText size={12} /> Roadmap Document
        </div>
        <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-8">
          {content.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </div>
        <div className="flex items-center justify-center gap-2 text-[#4A5568] text-[10px] tracking-widest uppercase mt-6">
          <Server size={11} /> Built for scale · Migration-ready · Open pipeline
        </div>
      </div>
    </div>
  );
}