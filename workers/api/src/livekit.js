// Server-side LiveKit access-token minting, done by hand with Web Crypto so
// the Worker carries ZERO dependencies (livekit-server-sdk pulls in Node-only
// siblings and a WASM/native rtc module that don't run on Workers). The claim
// shape below was verified byte-for-byte against livekit-server-sdk@2.17
// AccessToken.toJwt() and cross-checked with its TokenVerifier + a live
// LiveKit Cloud call — see devlog for the validation run.
//
// Reference token (SDK): header {"alg":"HS256"}, payload
//   { name?, video:{roomJoin,room,canPublish,canSubscribe}, iss, exp, nbf, sub }
// Note there is deliberately NO `iat` — the SDK doesn't emit one.

import { base64UrlEncode, base64UrlEncodeJson, hmacSha256 } from './crypto.js';

// LiveKit ceiling for these join tokens. The spec caps drill tokens at 6h so a
// leaked token self-expires well inside the 12h admin session.
export const MAX_LIVEKIT_TTL_SECONDS = 6 * 60 * 60; // 6h

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export async function mintLiveKitToken(env, { room, identity, name, metadata, video, ttlSeconds = MAX_LIVEKIT_TTL_SECONDS, now = nowSeconds() } = {}) {
  const apiKey = env?.LIVEKIT_API_KEY;
  const apiSecret = env?.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET not configured');
  if (typeof room !== 'string' || room.length === 0) throw new Error('room is required');
  if (typeof identity !== 'string' || identity.length === 0) throw new Error('identity is required');

  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_LIVEKIT_TTL_SECONDS);
  const exp = now + ttl;

  const payload = {
    ...(name ? { name } : {}),
    // P4c: `metadata` is the SDK's participant-metadata claim — LiveKit
    // copies it onto the participant, where the agent reads it as the
    // server-stamped voice policy. It rides the signature, so the client
    // can no more edit it than extend its own expiry.
    ...(metadata ? { metadata } : {}),
    // The default grant is a join token; a caller may hand its own grant
    // (the health probe mints roomAdmin to call RoomService — a server-side
    // credential that never reaches a browser).
    video: video ?? { roomJoin: true, room, canPublish: true, canSubscribe: true },
    iss: apiKey,
    exp,
    nbf: now,
    sub: identity,
  };

  const signingInput = `${base64UrlEncodeJson({ alg: 'HS256' })}.${base64UrlEncodeJson(payload)}`;
  const sig = await hmacSha256(apiSecret, signingInput);
  const token = `${signingInput}.${base64UrlEncode(sig)}`;

  return { token, exp, nbf: now, ttl, room, identity };
}
