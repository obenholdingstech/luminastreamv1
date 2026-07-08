Deno.serve(async (req) => {
  try {
    const response = await fetch('https://app.resemble.ai/api/v2/voices?page=1&page_size=100', {
      headers: {
        'Authorization': `Bearer ${Deno.env.get('RESEMBLE_API_KEY')}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return Response.json({
        error: errorData.message || 'Failed to fetch voices',
      }, { status: 500 });
    }

    const data = await response.json();
    const voices = (data.items || []).map((v) => ({
      voiceId: v.uuid,
      name: v.name,
      stsSupported: v.api_support?.sts || false,
    }));

    return Response.json({ voices });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});