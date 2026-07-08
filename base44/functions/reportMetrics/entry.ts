import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { sessionId, currentFps, droppedFrameRate, qualityScore, latencyMs, reconnectCount } = await req.json();

    if (!sessionId) {
      return Response.json({ error: 'sessionId is required' }, { status: 400 });
    }

    // Find and validate the session
    let session;
    try {
      session = await base44.asServiceRole.entities.Session.get(sessionId);
    } catch (_e) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    if (session.status !== 'active') {
      return Response.json({ error: 'Session is not active' }, { status: 400 });
    }

    // Update with real-time performance metrics
    await base44.asServiceRole.entities.Session.update(sessionId, {
      currentFps,
      droppedFrameRate,
      qualityScore,
      latencyMs,
      reconnectCount,
      lastMetricAt: new Date().toISOString(),
    });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});