import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

describe('Feature 8.3: Canonical Protocol Specification Test Vectors', () => {
  // Normative parameters from SPECIFICATION.md
  const aliceSeed = Buffer.from('alice-seed-32-bytes-deterministic!'.slice(0, 32));
  const bobSeed = Buffer.from('bob-seed-32-bytes-deterministic-!!'.slice(0, 32));
  const linkId = 'link_vector_test_001';
  const seq = 1;
  const timestamp = 1789254000;
  const nonce = '0123456789abcdef0123456789abcdef';
  const expectedPlaintext = 'Canonical AgentLink Protocol v2.1 Test Payload';

  const expectedAliceSignPub = 'o3IC+U9VTT3zJldqYSHfvlX7YBoDselksrLU0riPUBg=';
  const expectedAliceEncPub = 'QNrquoPck7z3btQktbLrdeW2nfbiQmkycmv2Qy5JKVM=';
  const expectedBobSignPub = 'QgxX4xv5GP+cdyX0Sg2r/fvvWeYvRW70bOHm7Jqu1Zo=';
  const expectedBobEncPub = 'jC9UEX1kooqk5A0h+aIidsAVxXBUDo2caxujhac4cjU=';

  const expectedDerivedKeyHex = 'a316366148711a3dfb790a2ad8b47660068829aa1ad909a7c6ae858942578784';
  const expectedIvB64 = 'ABEiM0RVZneImaq7';
  const expectedDataB64 = 'SQGoMyHE3tvmAZe7IxU0GaIuFQ+Q5AF4uiGmPk0Wd0M9h3WG7JyrrsYUq5xQkbS1ci3RexVUCaNx1zkx1+4=';
  const expectedSigB64 = 'zvNq4RJ93ifplEvtPUCxk9JUJxd0n1OQnQ4dTxn6yIpeI6+eUfzmEvRTLIP4Q0udwTS34vTQnuy7gqTcTGXfCA==';

  // Construct keys from seeds using standard DER PKCS#8 prefixes
  const aliceEdPriv = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), aliceSeed]),
    format: 'der',
    type: 'pkcs8',
  });
  const aliceXPriv = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), aliceSeed]),
    format: 'der',
    type: 'pkcs8',
  });
  const bobEdPriv = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bobSeed]),
    format: 'der',
    type: 'pkcs8',
  });
  const bobXPriv = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), bobSeed]),
    format: 'der',
    type: 'pkcs8',
  });

  const extractRawPublicKey = (key: crypto.KeyObject): Buffer => {
    const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
    // Ed25519 & X25519 SPKI have standard 12-byte header (302a300506032b65..032100) followed by 32 raw bytes
    return spki.subarray(spki.length - 32);
  };

  it('verifies public keys and fingerprints against normative vectors', () => {
    const aliceSignPubRaw = extractRawPublicKey(crypto.createPublicKey(aliceEdPriv));
    const aliceEncPubRaw = extractRawPublicKey(crypto.createPublicKey(aliceXPriv));
    const bobSignPubRaw = extractRawPublicKey(crypto.createPublicKey(bobEdPriv));
    const bobEncPubRaw = extractRawPublicKey(crypto.createPublicKey(bobXPriv));

    expect(aliceSignPubRaw.toString('base64')).toBe(expectedAliceSignPub);
    expect(aliceEncPubRaw.toString('base64')).toBe(expectedAliceEncPub);
    expect(bobSignPubRaw.toString('base64')).toBe(expectedBobSignPub);
    expect(bobEncPubRaw.toString('base64')).toBe(expectedBobEncPub);

    const aliceKid = `kid-alice-${crypto.createHash('sha256').update(aliceSignPubRaw).digest('hex').slice(0, 16)}`;
    const bobKid = `kid-bob-${crypto.createHash('sha256').update(bobSignPubRaw).digest('hex').slice(0, 16)}`;
    expect(aliceKid).toBe('kid-alice-32022ca472e9065e');
    expect(bobKid).toBe('kid-bob-b2e58518b5e42de9');
  });

  it('derives identical HKDF-SHA256 symmetric key from ECDH shared secret', () => {
    const aliceXPub = crypto.createPublicKey(aliceXPriv);
    const bobXPub = crypto.createPublicKey(bobXPriv);

    const sharedAlice = crypto.diffieHellman({ privateKey: aliceXPriv, publicKey: bobXPub });
    const sharedBob = crypto.diffieHellman({ privateKey: bobXPriv, publicKey: aliceXPub });
    expect(sharedAlice).toEqual(sharedBob);

    const salt = crypto.createHash('sha256').update(linkId).digest();
    const info = Buffer.from(`AgentLink-v2-E2EE:${linkId}`);
    const derivedKey = crypto.hkdfSync('sha256', sharedAlice, salt, info, 32);

    expect(Buffer.from(derivedKey).toString('hex')).toBe(expectedDerivedKeyHex);
  });

  it('decrypts normative Envelope v2 ciphertext with bound AAD', () => {
    const key = Buffer.from(expectedDerivedKeyHex, 'hex');
    const iv = Buffer.from(expectedIvB64, 'base64');
    const data = Buffer.from(expectedDataB64, 'base64');
    const ciphertext = data.subarray(0, data.length - 16);
    const authTag = data.subarray(data.length - 16);

    const aad = Buffer.from(`v2:${linkId}:alice:bob:${seq}:${nonce}`);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    expect(decrypted.toString('utf8')).toBe(expectedPlaintext);
  });

  it('verifies normative Ed25519 digital signature over canonical string', () => {
    const aliceSignPub = crypto.createPublicKey(aliceEdPriv);
    const canonicalStr = `v2:${linkId}:alice:bob:${seq}:${timestamp}:${nonce}:${expectedIvB64}:${expectedDataB64}`;
    const sig = Buffer.from(expectedSigB64, 'base64');

    const isValid = crypto.verify(null, Buffer.from(canonicalStr), aliceSignPub, sig);
    expect(isValid).toBe(true);
  });

  it('rejects tampered ciphertext, tampered AAD, and tampered signature fail-closed', () => {
    const key = Buffer.from(expectedDerivedKeyHex, 'hex');
    const iv = Buffer.from(expectedIvB64, 'base64');
    const data = Buffer.from(expectedDataB64, 'base64');
    const ciphertext = data.subarray(0, data.length - 16);
    const authTag = data.subarray(data.length - 16);

    // 1. Tampered ciphertext byte
    const tamperedCiphertext = Buffer.from(ciphertext);
    tamperedCiphertext[0] ^= 0xff;
    const decipher1 = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher1.setAAD(Buffer.from(`v2:${linkId}:alice:bob:${seq}:${nonce}`));
    decipher1.setAuthTag(authTag);
    expect(() => {
      decipher1.update(tamperedCiphertext);
      decipher1.final();
    }).toThrow();

    // 2. Tampered AAD (e.g. sequence number changed from 1 to 2)
    const tamperedAad = Buffer.from(`v2:${linkId}:alice:bob:2:${nonce}`);
    const decipher2 = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher2.setAAD(tamperedAad);
    decipher2.setAuthTag(authTag);
    expect(() => {
      decipher2.update(ciphertext);
      decipher2.final();
    }).toThrow();

    // 3. Tampered canonical string for signature
    const aliceSignPub = crypto.createPublicKey(aliceEdPriv);
    const tamperedCanonical = `v2:${linkId}:alice:bob:2:${timestamp}:${nonce}:${expectedIvB64}:${expectedDataB64}`;
    const sig = Buffer.from(expectedSigB64, 'base64');
    const isSigValid = crypto.verify(null, Buffer.from(tamperedCanonical), aliceSignPub, sig);
    expect(isSigValid).toBe(false);
  });
});
