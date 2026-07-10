import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const raw = Deno.env.get('RVC_SERVER_URL');
    if (!raw) return Response.json({ error: 'RVC server not configured' }, { status: 500 });

    // Derive base HTTP URL from whatever form the secret was stored in
    let base = raw.trim().replace(/\/+$/, '');
    base = base.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    base = base.replace(/\/ws\/audio$/i, '');

    const res = await fetch(`${base}/api/models/`);
    if (!res.ok) {
      return Response.json({ error: `RVC server returned ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    const models = Array.isArray(data) ? data : (data.models || []);

    return Response.json({
      voices: models.map((m) => {
        const id = m.name || m.path || m.id;
        return {
          voiceId: id,
          name: String(id).replace(/\.pth$/i, ''),
          category: m.details?.engine || m.type || 'rvc',
          active: !!m.active,
          hasIndex: !!m.has_index || !!m.details?.index,
          sampleRate: m.details?.target_sample_rate || null,
          speakers: m.details?.speakers || null,
          device: m.details?.device || null,
        };
      }),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});