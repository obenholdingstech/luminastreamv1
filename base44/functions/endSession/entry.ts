import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { sessionId } = body;

    if (!sessionId) {
      return Response.json({ error: 'sessionId required' }, { status: 400 });
    }

    const session = await base44.asServiceRole.entities.Session.get(sessionId);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const endTime = new Date().toISOString();
    const durationSeconds = Math.round(
      (Date.now() - new Date(session.startTime).getTime()) / 1000
    );

    await base44.asServiceRole.entities.Session.update(sessionId, {
      status: 'ended',
      endTime,
      durationSeconds,
    });

    return Response.json({ success: true, durationSeconds });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});