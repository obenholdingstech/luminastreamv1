Deno.serve(async (req) => {
  try {
    const { voiceUuid, audioUrl, sampleRate } = await req.json();

    if (!voiceUuid || !audioUrl) {
      return Response.json({ error: 'voiceUuid and audioUrl are required' }, { status: 400 });
    }

    const response = await fetch('https://f.cluster.resemble.ai/synthesize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('RESEMBLE_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        voice_uuid: voiceUuid,
        data: `<resemble:convert src="${audioUrl}"></resemble:convert>`,
        sample_rate: sampleRate || 16000,
        output_format: 'wav',
        precision: 'PCM_16',
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return Response.json({
        error: errorData.message || 'Voice conversion failed',
      }, { status: 500 });
    }

    const data = await response.json();

    if (!data.success) {
      return Response.json({ error: data.message || 'Conversion failed' }, { status: 500 });
    }

    return Response.json({ audioBase64: data.audio_content });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});