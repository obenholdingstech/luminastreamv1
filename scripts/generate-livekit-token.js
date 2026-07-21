// DEV-ONLY helper: mints a LiveKit access token for local testing.
// In production, tokens will be issued by a server-side endpoint — the
// LiveKit API secret must never be exposed to the client.
//
// Usage: node scripts/generate-livekit-token.js
import path from 'node:path';
import { AccessToken } from 'livekit-server-sdk';

process.loadEnvFile(path.join(import.meta.dirname, '..', 'secrets.env'));

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('secrets.env must define LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET');
  process.exit(1);
}

const room = 'luminastream-test';

const accessToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
  identity: 'test-user',
  ttl: '2h',
});
accessToken.addGrant({ roomJoin: true, room });

console.log(`URL:   ${LIVEKIT_URL}`);
console.log(`Room:  ${room}`);
console.log(`Token: ${await accessToken.toJwt()}`);
