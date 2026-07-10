import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const passcode = body.passcode;

    if (passcode !== Deno.env.get("ADMIN_PASSCODE")) {
      return Response.json({ error: 'Access denied' }, { status: 403 });
    }

    const activeSessions = await base44.asServiceRole.entities.Session.filter(
      { status: 'active' },
      '-created_date',
      10000
    );

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const allSessions = await base44.asServiceRole.entities.Session.list('-created_date', 100);
    const todaySessions = allSessions.filter(s => new Date(s.created_date) >= todayStart);

    const recentErrors = await base44.asServiceRole.entities.ErrorLog.list('-created_date', 50);

    let config = null;
    try {
      const configs = await base44.asServiceRole.entities.AppConfig.list();
      config = configs[0] || null;
    } catch (_e) { /* no config yet */ }

    const sessionFields = (s) => ({
      id: s.id,
      startTime: s.startTime,
      modelVersion: s.modelVersion,
      errorCount: s.errorCount,
      currentFps: s.currentFps,
      droppedFrameRate: s.droppedFrameRate,
      qualityScore: s.qualityScore,
      latencyMs: s.latencyMs,
      reconnectCount: s.reconnectCount,
      lastMetricAt: s.lastMetricAt,
      voiceBackend: s.voiceBackend,
      voiceModel: s.voiceModel,
      voiceProcessingMs: s.voiceProcessingMs,
      voiceRttMs: s.voiceRttMs,
      voiceFramesSent: s.voiceFramesSent,
      voiceFramesReceived: s.voiceFramesReceived,
      voiceActive: s.voiceActive,
    });

    return Response.json({
      activeSessionCount: activeSessions.length,
      todaySessionCount: todaySessions.length,
      totalSessionCount: allSessions.length,
      activeSessions: activeSessions.map(sessionFields),
      performanceSummary: (() => {
        const withMetrics = activeSessions.filter(s => s.qualityScore != null);
        if (withMetrics.length === 0) return { avgFps: 0, avgLatency: 0, avgQuality: 0, trackedSessions: 0 };
        return {
          avgFps: Math.round(withMetrics.reduce((sum, s) => sum + (s.currentFps || 0), 0) / withMetrics.length),
          avgLatency: Math.round(withMetrics.reduce((sum, s) => sum + (s.latencyMs || 0), 0) / withMetrics.length),
          avgQuality: Math.round(withMetrics.reduce((sum, s) => sum + (s.qualityScore || 0), 0) / withMetrics.length),
          trackedSessions: withMetrics.length,
        };
      })(),
      voiceSummary: (() => {
        const vs = activeSessions.filter(s => s.voiceActive);
        if (vs.length === 0) return { avgProcessingMs: 0, avgRttMs: 0, totalFramesSent: 0, totalFramesReceived: 0, trackedVoiceSessions: 0 };
        const avg = (key) => Math.round(vs.reduce((sum, s) => sum + (s[key] || 0), 0) / vs.length * 10) / 10;
        return {
          avgProcessingMs: avg('voiceProcessingMs'),
          avgRttMs: Math.round(avg('voiceRttMs')),
          totalFramesSent: vs.reduce((sum, s) => sum + (s.voiceFramesSent || 0), 0),
          totalFramesReceived: vs.reduce((sum, s) => sum + (s.voiceFramesReceived || 0), 0),
          trackedVoiceSessions: vs.length,
        };
      })(),
      recentErrors: recentErrors.map(e => ({
        id: e.id,
        sessionId: e.sessionId,
        errorCode: e.errorCode,
        errorMessage: e.errorMessage,
        timestamp: e.timestamp,
      })),
      recentSessions: allSessions.slice(0, 20).map(s => ({
        id: s.id,
        status: s.status,
        startTime: s.startTime,
        endTime: s.endTime,
        durationSeconds: s.durationSeconds,
        modelVersion: s.modelVersion,
        errorCount: s.errorCount,
      })),
      config: config ? {
        defaultPrompt: config.defaultPrompt,
        autoEnhance: config.autoEnhance,
        maxConcurrentSessions: config.maxConcurrentSessions,
      } : null,
      apiKeyConfigured: !!Deno.env.get("DECART_API_KEY"),
      rvcConfigured: !!Deno.env.get("RVC_SERVER_URL"),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});