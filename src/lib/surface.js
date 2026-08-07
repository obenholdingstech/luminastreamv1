// Hostname → surface (the realignment's routing map, CEO 7 Aug 2026):
//
//   luminastream.live            landing   the public hero — the only page a
//   www.luminastream.live                  stranger should ever meet
//   account.luminastream.live    account   sign-in / sign-up / verification
//   studio.luminastream.live     studio    the workspace, signed-in only
//   (anything else)              studio    pages.dev previews and localhost
//                                          keep the working surface, because
//                                          dev and probes live there
//
// Pure function of the hostname so the map is testable without a browser and
// greppable when the next surface arrives.

export const SURFACE_URLS = {
  landing: 'https://luminastream.live',
  account: 'https://account.luminastream.live',
  studio: 'https://studio.luminastream.live',
};

export function surfaceForHost(hostname) {
  const host = typeof hostname === 'string' ? hostname.toLowerCase() : '';
  if (host === 'luminastream.live' || host === 'www.luminastream.live') return 'landing';
  if (host === 'account.luminastream.live') return 'account';
  return 'studio';
}
