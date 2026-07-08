Deno.serve(async (req) => {
  try {
    const { text, voiceId, modelId } = await req.json();

    if (!text || !voiceId) {
      return Response.json({ error: 'text and voiceId are required' }, { status: 400 });
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': Deno.env.get('ELEVENLABS_API_KEY'),
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: modelId || 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return Response.json({
        error: errorData.detail?.message || 'TTS generation failed',
      }, { status: 500 });
    }

    const audioBytes = await response.arrayBuffer();
    const bytes = new Uint8Array(audioBytes);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    const audioBase64 = btoa(binary);

    return Response.json({ audioBase64, mimeType: 'audio/mpeg' });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});