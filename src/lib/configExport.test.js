// Run: node --test src/lib/configExport.test.js
// Pins the lock-in contract: export the AGENT-CONFIRMED config (never raw
// slider state), in the shape the agent's tts_profile.json loader reads back.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildConfigExport, configExportFilename } from './configExport.js';

const CLOCK = new Date('2026-07-29T12:00:00.000Z');

// A representative tts broadcast: flat applied config + per-knob metadata.
const ttsConfig = {
  engine: 'tts',
  appVersion: '1.2.3',
  config: {
    engine: 'tts',
    tts_model: 'eleven_flash_v2_5',
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.2,
    use_speaker_boost: true,
    speed: 1.0,
    prime_hops: 1.5,
    vad_threshold: 0.5,
    vad_hangover_ms: 200,
    min_speech_ms: 200,
    queue_wait_warn_ms: 250,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true, speed: 1.0 },
  },
  metadata: [
    { name: 'tts_model', target: 'tts' },
    { name: 'stability', target: 'tts' },
    { name: 'similarity_boost', target: 'tts' },
    { name: 'style', target: 'tts' },
    { name: 'use_speaker_boost', target: 'tts' },
    { name: 'speed', target: 'tts' },
    { name: 'prime_hops', target: 'agent' },
    { name: 'vad_threshold', target: 'agent' },
    { name: 'vad_hangover_ms', target: 'agent' },
    { name: 'min_speech_ms', target: 'agent' },
    { name: 'queue_wait_warn_ms', target: 'agent' },
  ],
};

test('no agent broadcast yet → null (nothing to export but the truth)', () => {
  assert.equal(buildConfigExport(null), null);
  assert.equal(buildConfigExport({ config: null }), null);
});

test('exports the agent-confirmed tts config + metadata in profile shape', () => {
  const out = buildConfigExport(ttsConfig, CLOCK);
  assert.equal(out.exported_at, '2026-07-29T12:00:00.000Z');
  assert.equal(out.app_version, '1.2.3');
  assert.equal(out.engine, 'tts');
  assert.equal(out.model, 'eleven_flash_v2_5'); // tts_model → model
  assert.deepEqual(out.voice_settings, {
    stability: 0.5, similarity_boost: 0.75, style: 0.2,
    use_speaker_boost: true, speed: 1.0,
  });
  assert.deepEqual(out.pipeline, {
    prime_hops: 1.5, vad_threshold: 0.5, vad_hangover_ms: 200,
    min_speech_ms: 200, queue_wait_warn_ms: 250,
  });
  assert.ok(!('rvc' in out)); // tts agent exports no rvc section
});

test('reads AGENT truth, never a pending slider edit', () => {
  // A raw slider might sit at 0.9; export must reflect config (0.5), full stop.
  const out = buildConfigExport(ttsConfig, CLOCK);
  assert.equal(out.voice_settings.stability, 0.5);
});

test('engine-agnostic: an rvc agent exports rvc + pipeline, no voice/model', () => {
  const rvcConfig = {
    engine: 'rvc',
    appVersion: '1.2.3',
    config: { index_rate: 0.75, protect: 0.33, f0_method: 'rmvpe', prime_hops: 1.5, vad_threshold: 0.5 },
    metadata: [
      { name: 'index_rate', target: 'rvc' },
      { name: 'protect', target: 'rvc' },
      { name: 'f0_method', target: 'rvc' },
      { name: 'prime_hops', target: 'agent' },
      { name: 'vad_threshold', target: 'agent' },
    ],
  };
  const out = buildConfigExport(rvcConfig, CLOCK);
  assert.equal(out.engine, 'rvc');
  assert.ok(!('model' in out) && !('voice_settings' in out));
  assert.deepEqual(out.rvc, { index_rate: 0.75, protect: 0.33, f0_method: 'rmvpe' });
  assert.deepEqual(out.pipeline, { prime_hops: 1.5, vad_threshold: 0.5 });
});

test('a locked profile pins the voice (id + name), not just its settings', () => {
  const withVoice = {
    ...ttsConfig,
    config: { ...ttsConfig.config, voice: 'v_amy', voice_name: 'Amy Clone' },
    metadata: [{ name: 'voice', target: 'tts' }, ...ttsConfig.metadata],
  };
  const out = buildConfigExport(withVoice, CLOCK);
  assert.equal(out.voice, 'v_amy');
  assert.equal(out.voice_name, 'Amy Clone');
  // voice must NOT leak into voice_settings — it is not a synthesis setting
  assert.ok(!('voice' in out.voice_settings));
});

test('filename encodes engine + model + timestamp, filesystem-safe', () => {
  const name = configExportFilename(ttsConfig, CLOCK);
  assert.equal(name, 'tuning-tts-eleven_flash_v2_5-2026-07-29_12-00-00.json');
  assert.ok(!/[:.]/.test(name.replace('.json', '')));
});
