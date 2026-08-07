// The mail sender (realignment: every user must verify their email).
// ZeptoMail's transactional API, sending as the CEO's verified domain
// obenholding.org. ENV-GATED: without ZEPTOMAIL_TOKEN this module reports
// 'email_disabled' and callers degrade honestly — sign-up still works, the
// UI says verification mail is not yet enabled, and the session gate keeps
// unverified users out of the studio exactly as before.

const ZEPTO_ENDPOINT = 'https://api.zeptomail.com/v1.1/email';
const FROM_ADDRESS = 'noreply@obenholding.org';
const FROM_NAME = 'LuminaStream';

export function emailEnabled(env) {
  return typeof env.ZEPTOMAIL_TOKEN === 'string' && env.ZEPTOMAIL_TOKEN.length > 0;
}

/**
 * One verification email. Returns { ok } | { ok:false, error } — a mail
 * failure is reported, never thrown: sign-up must not die because a mail
 * API hiccuped (the user can resend).
 */
export async function sendVerificationEmail(env, { to, link }, fetchImpl) {
  if (!emailEnabled(env)) return { ok: false, error: 'email_disabled' };
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));
  try {
    const res = await doFetch(ZEPTO_ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Zoho-enczapikey ${env.ZEPTOMAIL_TOKEN}`,
      },
      body: JSON.stringify({
        from: { address: FROM_ADDRESS, name: FROM_NAME },
        to: [{ email_address: { address: to } }],
        subject: 'Verify your LuminaStream email',
        htmlbody: [
          '<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#1c1c1e">',
          '<p style="letter-spacing:.3em;font-size:12px;color:#6b4fa0">LUMINA STREAM</p>',
          '<h2 style="font-weight:600">Confirm your email</h2>',
          '<p>One click and your account can open the lens:</p>',
          `<p style="margin:28px 0"><a href="${link}" style="background:#111;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none">Verify my email</a></p>`,
          '<p style="color:#5b5b60;font-size:13px">The link works once and expires in 24 hours. If you did not create a LuminaStream account, ignore this email — nothing happens without the click.</p>',
          '</div>',
        ].join(''),
      }),
    });
    if (!res.ok) {
      console.error('zeptomail send failed', res.status);
      return { ok: false, error: 'email_send_failed' };
    }
    return { ok: true };
  } catch (err) {
    console.error('zeptomail send failed', err);
    return { ok: false, error: 'email_send_failed' };
  }
}
