import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Voice backend config is not sensitive (server URL + a boolean) — no auth gate.
// This keeps the voice stream from failing on transient auth issues.
Deno.serve(async (req) => {
  try {
    const rvcServerUrl = Deno.env.get('RVC_SERVER_URL');
    return Response.json({
      backend: rvcServerUrl ? 'rvc' : 'elevenlabs',
      serverUrl: rvcServerUrl || null,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});