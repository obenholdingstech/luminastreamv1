import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { sessionId, errorCode, errorMessage } = body;

    await base44.asServiceRole.entities.ErrorLog.create({
      sessionId: sessionId || 'unknown',
      errorCode: errorCode || 'UNKNOWN',
      errorMessage: errorMessage || 'Unknown error',
      timestamp: new Date().toISOString(),
    });

    // Increment error count on the session
    if (sessionId) {
      try {
        const session = await base44.asServiceRole.entities.Session.get(sessionId);
        if (session) {
          await base44.asServiceRole.entities.Session.update(sessionId, {
            errorCount: (session.errorCount || 0) + 1,
          });
        }
      } catch (_e) { /* session may not exist */ }
    }

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});