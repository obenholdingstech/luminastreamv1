import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { audioUrl, name } = await req.json();

    if (!audioUrl) {
      return Response.json({ error: 'Audio URL is required' }, { status: 400 });
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

    // Store voice profile for reuse
    await base44.asServiceRole.entities.VoiceProfile.create({
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