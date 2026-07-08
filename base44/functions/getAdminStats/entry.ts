import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const passcode = body.passcode;

    if (passcode !== Deno.env.get("ADMIN_PASSCODE")) {
      return Response.json({ error: 'Access denied' }, { status: 403 });
    }

    // Active sessions
    const activeSessions = await base44.asServiceRole.entities.Session.filter(
      { status: 'active' },
      '-created_date',
      10000
    );

    // Today's sessions
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const allSessions = await base44.asServiceRole.entities.Session.list('-created_date', 100);
    const todaySessions = allSessions.filter(
      s => new Date(s.created_date) >= todayStart
    );

    // Recent errors
    const recentErrors = await base44.asServiceRole.entities.ErrorLog.list('-created_date', 50);

    // Global config
    let config = null;
    try {
      const configs = await base44.asServiceRole.entities.AppConfig.list();
      config = configs[0] || null;
    } catch (_e) { /* no config yet */ }

    return Response.json({
      activeSessionCount: activeSessions.length,
      todaySessionCount: todaySessions.length,
      totalSessionCount: allSessions.length,
      activeSessions: activeSessions.map(s => ({
        id: s.id,
        startTime: s.startTime,
        modelVersion: s.modelVersion,
        errorCount: s.errorCount,
      })),
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
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});