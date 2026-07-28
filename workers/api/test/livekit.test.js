// Run: node --test workers/api/test/livekit.test.js
//
// Claim/expiry contract for the hand-rolled LiveKit minter. The equivalence
// check against livekit-server-sdk (byte-for-byte claims + TokenVerifier) and
// the live LiveKit Cloud acceptance test are a separate validation run kept out
// of the committed suite so `node --test` stays dependency-free and offline —
// see the devlog for that evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintLiveKitToken, MAX_LIVEKIT_TTL_SECONDS } from '../src/livekit.js';
import { base64UrlDecode, decodeJson, hmacSha256, base64UrlEncode } from '../src/crypto.js';

const ENV = {
  LIVEKIT_API_KEY: 'APIkey',
  LIVEKIT_API_SECRET: 'secretsecretsecret',
  LIVEKIT_URL: 'wss://proj.livekit.cloud',
};

function parts(jwt) {
  const [h, p, s] = jwt.split('.');
  return { header: decodeJson(base64UrlDecode(h)), payload: decodeJson(base64UrlDecode(p)), h, p, s };
}

test('header {"alg":"HS256"} and claims match the LiveKit spec', async () => {
  const now = 1_700_000_000;
  const { token } = await mintLiveKitToken(ENV, { room: 'r1', identity: 'u1', now });
  const { header, payload } = parts(token);

  assert.deepEqual(header, { alg: 'HS256' });
  assert.equal(payload.iss, 'APIkey');
  assert.equal(payload.sub, 'u1');
  assert.equal(payload.nbf, now);
  assert.equal(payload.exp, now + MAX_LIVEKIT_TTL_SECONDS);
  assert.deepEqual(payload.video, {
    roomJoin: true,
    room: 'r1',
    canPublish: true,
    canSubscribe: true,
  });
  assert.ok(!('iat' in payload), 'LiveKit tokens carry no iat');
});

test('exp − nbf equals ttl, and ttl clamps to the 6h ceiling', async () => {
  const now = 1_700_000_000;
  const { token, ttl } = await mintLiveKitToken(ENV, {
    room: 'r',
    identity: 'u',
    ttlSeconds: 24 * 3600, // ask for 24h
    now,
  });
  assert.equal(ttl, MAX_LIVEKIT_TTL_SECONDS);
  const { payload } = parts(token);
  assert.equal(payload.exp - payload.nbf, MAX_LIVEKIT_TTL_SECONDS);
});

test('a shorter ttl is honored', async () => {
  const now = 1_700_000_000;
  const { token } = await mintLiveKitToken(ENV, { room: 'r', identity: 'u', ttlSeconds: 900, now });
  const { payload } = parts(token);
  assert.equal(payload.exp - payload.nbf, 900);
});

test('signature verifies under the API secret and not under another', async () => {
  const { token } = await mintLiveKitToken(ENV, { room: 'r', identity: 'u' });
  const { h, p, s } = parts(token);
  const good = base64UrlEncode(await hmacSha256(ENV.LIVEKIT_API_SECRET, `${h}.${p}`));
  const bad = base64UrlEncode(await hmacSha256('wrong-secret', `${h}.${p}`));
  assert.equal(s, good);
  assert.notEqual(s, bad);
});

test('name is present only when supplied', async () => {
  const withName = parts((await mintLiveKitToken(ENV, { room: 'r', identity: 'u', name: 'Amy' })).token).payload;
  assert.equal(withName.name, 'Amy');
  const without = parts((await mintLiveKitToken(ENV, { room: 'r', identity: 'u' })).token).payload;
  assert.ok(!('name' in without));
});

test('missing config or required args throw', async () => {
  await assert.rejects(() => mintLiveKitToken({}, { room: 'r', identity: 'u' }));
  await assert.rejects(() => mintLiveKitToken(ENV, { room: '', identity: 'u' }));
  await assert.rejects(() => mintLiveKitToken(ENV, { room: 'r', identity: '' }));
});
