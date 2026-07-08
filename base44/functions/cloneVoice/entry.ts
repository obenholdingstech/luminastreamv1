import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_VOICES_PER_USER = 5;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { audioUrl, name } = await req.json();

    if (!audioUrl) {
      return Response.json({ error: 'Audio URL is required' }, { status: 400 });
    }

    // ── Rate limit: max 5 cloned voices per account ──
    const existingVoices = await base44.asServiceRole.entities.VoiceProfile.filter({
      created_by_id: user.id,
    });
    if (existingVoices.length >= MAX_VOICES_PER_USER) {
      return Response.json({
        error: `Voice limit reached (${MAX_VOICES_PER_USER}). Delete an existing voice before cloning a new one.`,
      }, { status: 403 });
    }

    // Fetch the audio file from Base44 storage
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      return Response.json({ error: 'Failed to fetch audio file' }, { status: 500 });
    }
    const audioBlob = await audioResponse.blob();

    // Create multipart form for ElevenLabs Instant Voice Cloning
    const formData = new FormData();
    formData.append('name', name || `mirror_voice_${Date.now()}`);
    formData.append('files', audioBlob, 'reference.wav');

    // Call ElevenLabs voice cloning API
    const elevenResponse = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: {
        'xi-api-key': Deno.env.get('ELEVENLABS_API_KEY'),
      },
      body: formData,
    });

    if (!elevenResponse.ok) {
      const errorData = await elevenResponse.json().catch(() => ({}));
      return Response.json({
        error: errorData.detail?.message || errorData.detail || 'Voice cloning failed',
      }, { status: 500 });
    }

    const result = await elevenResponse.json();
    const voiceId = typeof result === 'string' ? result : result.voice_id;

    if (!voiceId) {
      return Response.json({ error: 'No voice ID returned' }, { status: 500 });
    }

    // Store voice profile for reuse (user-scoped — created_by_id set automatically)
    await base44.entities.VoiceProfile.create({
      voiceId: voiceId,
      name: name || `mirror_voice_${Date.now()}`,
      sampleUrl: audioUrl,
      status: 'ready',
    });

    return Response.json({ voiceId: voiceId });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});