import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const apiKey = Deno.env.get("DECART_API_KEY");
    if (!apiKey) {
      return Response.json({ error: 'Service not configured' }, { status: 503 });
    }

    // Get client IP for rate limiting (1 active session per IP)
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const ipHash = await hashIP(clientIp);

    // Get global config for max concurrent sessions
    let maxConcurrent = 10000;
    try {
      const configs = await base44.asServiceRole.entities.AppConfig.list();
      if (configs[0]?.maxConcurrentSessions) {
        maxConcurrent = configs[0].maxConcurrentSessions;
      }
    } catch (_e) { /* use default */ }

    // Check global capacity — only load what we need
    const activeSessions = await base44.asServiceRole.entities.Session.filter(
      { status: 'active' },
      '-created_date',
      maxConcurrent + 1
    );

    if (activeSessions.length >= maxConcurrent) {
      return Response.json({ error: 'Server at capacity' }, { status: 429 });
    }

    // End any existing active session for this IP (enforce 1 per IP)
    const existing = activeSessions.find(s => s.ipHash === ipHash);
    if (existing) {
      await base44.asServiceRole.entities.Session.update(existing.id, {
        status: 'ended',
        endTime: new Date().toISOString(),
      });
    }

    // Create new session record
    const session = await base44.asServiceRole.entities.Session.create({
      sessionToken: crypto.randomUUID(),
      ipHash,
      status: 'active',
      startTime: new Date().toISOString(),
      modelVersion: 'lucy-2.5',
      errorCount: 0,
    });

    return Response.json({
      sessionId: session.id,
      apiKey,
      modelConfig: {
        modelId: 'lucy-2.5',
        fps: 25,
        width: 1280,
        height: 704,
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});