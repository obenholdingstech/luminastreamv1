import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const {
      sessionId,
      currentFps, droppedFrameRate, qualityScore, latencyMs, reconnectCount,
      voiceBackend, voiceModel, voiceProcessingMs, voiceRttMs,
      voiceFramesSent, voiceFramesReceived, voiceActive,
    } = body;

    if (!sessionId) {
      return Response.json({ error: 'sessionId is required' }, { status: 400 });
    }

    let session;
    try {
      session = await base44.asServiceRole.entities.Session.get(sessionId);
    } catch (_e) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }
    if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
    if (session.status !== 'active') {
      return Response.json({ error: 'Session is not active' }, { status: 400 });
    }

    // Only update fields that were actually provided
    const update = { lastMetricAt: new Date().toISOString() };
    if (currentFps != null) update.currentFps = currentFps;
    if (droppedFrameRate != null) update.droppedFrameRate = droppedFrameRate;
    if (qualityScore != null) update.qualityScore = qualityScore;
    if (latencyMs != null) update.latencyMs = latencyMs;
    if (reconnectCount != null) update.reconnectCount = reconnectCount;
    if (voiceBackend != null) update.voiceBackend = voiceBackend;
    if (voiceModel != null) update.voiceModel = voiceModel;
    if (voiceProcessingMs != null) update.voiceProcessingMs = voiceProcessingMs;
    if (voiceRttMs != null) update.voiceRttMs = voiceRttMs;
    if (voiceFramesSent != null) update.voiceFramesSent = voiceFramesSent;
    if (voiceFramesReceived != null) update.voiceFramesReceived = voiceFramesReceived;
    if (voiceActive != null) update.voiceActive = voiceActive;

    await base44.asServiceRole.entities.Session.update(sessionId, update);

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});