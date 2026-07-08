import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // ── Fetch user's cloned voices from the database ──
    let clonedVoices = [];
    try {
      const user = await base44.auth.me();
      if (user) {
        const profiles = await base44.entities.VoiceProfile.filter({ created_by_id: user.id });
        clonedVoices = profiles
          .filter((p) => p.status === 'ready')
          .map((p) => ({
            voiceId: p.voiceId,
            name: p.name,
            category: 'cloned',
            previewUrl: p.sampleUrl,
          }));
      }
    } catch (_e) {
      // Not authenticated — skip cloned voices, still return library voices
    }

    // ── Fetch all voices from ElevenLabs (library + any cloned on their side) ──
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': Deno.env.get('ELEVENLABS_API_KEY'),
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return Response.json({
        error: errorData.detail?.message || 'Failed to fetch voices',
      }, { status: 500 });
    }

    const data = await response.json();

    // Build a set of cloned voice IDs to avoid duplicates
    const clonedIds = new Set(clonedVoices.map((v) => v.voiceId));

    // ElevenLabs library voices (exclude ones already in cloned list)
    const libraryVoices = (data.voices || [])
      .filter((v) => !clonedIds.has(v.voice_id))
      .map((v) => ({
        voiceId: v.voice_id,
        name: v.name,
        category: v.category || 'library',
        previewUrl: v.preview_url,
      }));

    // Cloned voices first, then library voices — unified list
    const voices = [...clonedVoices, ...libraryVoices];

    return Response.json({ voices });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});