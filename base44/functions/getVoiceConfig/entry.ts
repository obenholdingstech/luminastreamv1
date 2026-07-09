import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const rvcServerUrl = Deno.env.get('RVC_SERVER_URL');

    return Response.json({
      backend: rvcServerUrl ? 'rvc' : 'elevenlabs',
      serverUrl: rvcServerUrl || null,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});