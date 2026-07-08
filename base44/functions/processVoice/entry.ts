Deno.serve(async (req) => {
  try {
    const { voiceId, audioBase64, outputFormat } = await req.json();
    const format = outputFormat || 'pcm_44100';

    if (!voiceId || !audioBase64) {
      return Response.json({ error: 'voiceId and audioBase64 are required' }, { status: 400 });
    }

    // Decode base64 PCM to bytes
    const binaryString = atob(audioBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Create blob from raw PCM data
    const audioBlob = new Blob([bytes], { type: 'application/octet-stream' });

    // Build multipart form for ElevenLabs Speech-to-Speech
    const formData = new FormData();
    formData.append('audio', audioBlob, 'input.pcm');
    formData.append('model_id', 'eleven_english_sts_v2');
    formData.append('file_format', 'pcm_s16le_16');
    formData.append('remove_background_noise', 'false');

    // Call ElevenLabs S2S with max latency optimization + PCM output
    const elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/speech-to-speech/${voiceId}?output_format=${format}&optimize_streaming_latency=4`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': Deno.env.get('ELEVENLABS_API_KEY'),
        },
        body: formData,
      }
    );

    if (!elevenResponse.ok) {
      const errorData = await elevenResponse.json().catch(() => ({}));
      return Response.json({
        error: errorData.detail?.message || errorData.detail || 'Speech-to-speech conversion failed',
      }, { status: 500 });
    }

    // Read converted audio as raw bytes
    const audioBuffer = await elevenResponse.arrayBuffer();
    const audioBytes = new Uint8Array(audioBuffer);

    // Convert to base64 for JSON transport
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < audioBytes.length; i += chunkSize) {
      const chunk = audioBytes.subarray(i, Math.min(i + chunkSize, audioBytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    const responseBase64 = btoa(binary);

    return Response.json({ audioBase64: responseBase64 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});