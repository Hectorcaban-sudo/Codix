import * as fs from 'fs';
import * as tls from 'tls';
import { RequestOptions, interpolate } from './config';

export interface TlsOptions {
  ca?: string[];
  cert?: Buffer;
  key?: Buffer;
  pfx?: Buffer;
  passphrase?: string;
  rejectUnauthorized: boolean;
}

function readMaybe(p: string | undefined, apiKey?: string, pfxPass?: string): Buffer | undefined {
  if (!p) return undefined;
  const resolved = interpolate(p, apiKey, pfxPass);
  if (!resolved) return undefined;
  if (resolved.includes('-----BEGIN')) return Buffer.from(resolved);
  return fs.readFileSync(resolved);
}

export function buildTlsOptions(ro: Partial<RequestOptions> | undefined, apiKey?: string, pfxPass?: string): TlsOptions {
  const out: TlsOptions = { rejectUnauthorized: ro?.verifySsl ?? true };
  if (!ro) return out;

  const caPaths = Array.isArray(ro.caBundlePath) ? ro.caBundlePath : ro.caBundlePath ? [ro.caBundlePath] : [];
  if (caPaths.length) {
    out.ca = [...tls.rootCertificates, ...caPaths.map((p) => readMaybe(p, apiKey, pfxPass)!.toString())];
  }

  const resolvedPfxPass = ro.pfxPassphrase ? interpolate(ro.pfxPassphrase, apiKey, pfxPass) : pfxPass;
  if (ro.pfxPath) {
    out.pfx = readMaybe(ro.pfxPath, apiKey, pfxPass);
    if (resolvedPfxPass) out.passphrase = resolvedPfxPass;
  } else if (ro.clientCertificate?.cert) {
    out.cert = readMaybe(ro.clientCertificate.cert, apiKey, pfxPass);
    out.key = readMaybe(ro.clientCertificate.key, apiKey, pfxPass);
    if (ro.clientCertificate.passphrase) out.passphrase = interpolate(ro.clientCertificate.passphrase, apiKey, pfxPass);
    else if (resolvedPfxPass) out.passphrase = resolvedPfxPass;
  }
  return out;
}

export function interpolateHeaders(headers: Record<string, string> | undefined, apiKey?: string, pfxPass?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k] = interpolate(String(v), apiKey, pfxPass);
  return out;
}

export function explainTlsError(e: any): Error {
  const code = e?.cause?.code ?? e?.code ?? '';
  const msg = String(e?.message ?? e) + (e?.cause?.message ? ` (${e.cause.message})` : '');
  const hints: Record<string, string> = {
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'Server certificate is signed by an internal CA. Set requestOptions.caBundlePath to your CA .pem.',
    SELF_SIGNED_CERT_IN_CHAIN: 'Self-signed CA in chain. Set requestOptions.caBundlePath to your CA .pem.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Server uses a self-signed cert. Add it to requestOptions.caBundlePath.',
    ERR_OSSL_BAD_DECRYPT: 'Wrong passphrase for the client key/PFX.',
    ECONNRESET: 'Connection reset. If the server requires a client certificate, check requestOptions.clientCertificate or pfxPath.',
    EPROTO: 'TLS handshake failed. The server may require a client certificate.'
  };
  let hint = hints[code];
  if (!hint && /certificate required|alert number 116|handshake failure|other side closed|UND_ERR_SOCKET/i.test(msg)) {
    hint = 'The server requires a client certificate. Set requestOptions.clientCertificate (cert/key PEM) or requestOptions.pfxPath.';
  }
  return new Error(hint ? `${msg}\nHint: ${hint}` : msg);
}
