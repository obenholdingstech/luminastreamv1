// Export-to-config — the lock-in mechanism, as config-as-code.
//
// "Export JSON" downloads the CURRENT AGENT-CONFIRMED config (agentConfig.config,
// the applied truth — NEVER the raw slider positions in knobEdits) plus metadata
// (timestamp, engine, model, app version). Committing that one JSON as
// agent/tts_profile.json via PR is how the CEO's ear-found profile gets locked
// in — reviewable, no code edit. The shape mirrors what the agent's
// flatten_profile() reads back, so export → commit → load round-trips.
//
// Driven entirely by the broadcast metadata (each knob's target), so there are
// NO hardcoded engine assumptions here: a tts agent exports voice_settings +
// pipeline, an rvc agent exports rvc + pipeline, from the same code.

/**
 * @param {object|null} agentConfig  the hook's agentConfig ({config, engine, appVersion, metadata})
 * @param {Date} [now]               injectable clock for deterministic tests
 * @returns {object|null}            the export object, or null if no agent truth yet
 */
export function buildConfigExport(agentConfig, now = new Date()) {
  if (!agentConfig || !agentConfig.config) return null;
  const config = agentConfig.config;
  const metadata = agentConfig.metadata || [];

  const out = {
    exported_at: now.toISOString(),
    app_version: agentConfig.appVersion ?? null,
    engine: agentConfig.engine ?? config.engine ?? null,
  };

  const voice_settings = {};
  const pipeline = {};
  const rvc = {};
  for (const knob of metadata) {
    const value = config[knob.name];
    if (value === undefined) continue; // agent hasn't confirmed this one
    if (knob.name === 'tts_model') {
      out.model = value; // the model select maps to the profile's `model`
      continue;
    }
    if (knob.name === 'voice') {
      // A locked profile pins the VOICE, not just its settings (ticket 6).
      out.voice = value; // voice_id — round-trips to the agent's profile loader
      if (config.voice_name) out.voice_name = config.voice_name; // human-readable
      continue;
    }
    if (knob.target === 'tts') voice_settings[knob.name] = value;
    else if (knob.target === 'agent') pipeline[knob.name] = value;
    else if (knob.target === 'rvc') rvc[knob.name] = value;
  }
  if (Object.keys(voice_settings).length) out.voice_settings = voice_settings;
  if (Object.keys(pipeline).length) out.pipeline = pipeline;
  if (Object.keys(rvc).length) out.rvc = rvc;
  return out;
}

/** A stable, filesystem-friendly filename for the download. */
export function configExportFilename(agentConfig, now = new Date()) {
  const engine = agentConfig?.engine ?? agentConfig?.config?.engine ?? 'agent';
  const model = agentConfig?.config?.tts_model ? `-${agentConfig.config.tts_model}` : '';
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
  return `tuning-${engine}${model}-${stamp}.json`;
}
