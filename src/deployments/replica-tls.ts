import { createECDH, createHmac, createPrivateKey, createPublicKey, sign, type KeyObject } from 'crypto';

export const REPLICA_CA_CN = 'aigw-replica-ca';
const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
const ECDSA_SHA256 = Buffer.from('300a06082a8648ce3d040302', 'hex');
const anchors = new Map<string, string>();

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const len = Buffer.from(body.length.toString(16).padStart(body.length > 0xffff ? 6 : body.length > 0xff ? 4 : 2, '0'), 'hex');
  return Buffer.concat([Buffer.from([tag, 0x80 | len.length]), len, body]);
}

function caKey(token: string): KeyObject {
  const seed = BigInt(`0x${createHmac('sha256', token).update('aigw-replica-tls-ca-v1').digest('hex')}`);
  const d = Buffer.from((seed % (P256_ORDER - BigInt(1)) + BigInt(1)).toString(16).padStart(64, '0'), 'hex');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', d: d.toString('base64url'), x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
  return createPrivateKey({ key: jwk, format: 'jwk' });
}

export function replicaCaKeyPem(token: string): string {
  return caKey(token).export({ type: 'pkcs8', format: 'pem' }) as string;
}

function buildAnchor(token: string): string {
  const key = caKey(token);
  const name = der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from(REPLICA_CA_CN)))));
  const validity = der(0x30, der(0x17, Buffer.from('000101000000Z')), der(0x18, Buffer.from('21000101000000Z')));
  const caTrue = der(0x30, Buffer.from('0603551d13', 'hex'), Buffer.from('0101ff', 'hex'), der(0x04, der(0x30, Buffer.from('0101ff', 'hex'))));
  const keyCertSign = der(0x30, Buffer.from('0603551d0f', 'hex'), Buffer.from('0101ff', 'hex'), der(0x04, Buffer.from('03020204', 'hex')));
  const tbs = der(0x30,
    Buffer.from('a003020102020101', 'hex'), ECDSA_SHA256, name, validity, name,
    createPublicKey(key).export({ type: 'spki', format: 'der' }), der(0xa3, der(0x30, caTrue, keyCertSign)));
  const cert = der(0x30, tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), sign('sha256', tbs, key)));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
}

export function replicaCaCert(token: string): string {
  let anchor = anchors.get(token);
  if (!anchor) {
    anchor = buildAnchor(token);
    anchors.set(token, anchor);
  }
  return anchor;
}

export function replicaTls(url: string, token: string): { tls?: { ca: string } } {
  return /^(https|wss):/i.test(url) ? { tls: { ca: replicaCaCert(token) } } : {};
}
