import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { sign } from 'jsonwebtoken';
import { AuthService } from './auth.service';

const HS256_SECRET = 'test-hs256-secret';

function generateRsaKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return { privateKey, publicKey };
}

beforeEach(() => {
  delete process.env.JWT_SECRET;
  delete process.env.JWT_PUBLIC_KEY;
});

describe('AuthService.verifyJWT', () => {
  describe('HS256 only (no JWT_PUBLIC_KEY)', () => {
    it('verifies a valid HS256 token', () => {
      process.env.JWT_SECRET = HS256_SECRET;
      const token = sign({ sub: 'user-1' }, HS256_SECRET);
      const payload = AuthService.verifyJWT(token) as { sub: string };
      expect(payload.sub).toBe('user-1');
    });

    it('throws on tampered HS256 token', () => {
      process.env.JWT_SECRET = HS256_SECRET;
      const token = sign({ sub: 'user-1' }, 'wrong-secret');
      expect(() => AuthService.verifyJWT(token)).toThrow();
    });
  });

  describe('RS256 primary + HS256 fallback (JWT_PUBLIC_KEY set)', () => {
    it('verifies a valid RS256 token', () => {
      const { privateKey, publicKey } = generateRsaKeyPair();
      process.env.JWT_SECRET = HS256_SECRET;
      process.env.JWT_PUBLIC_KEY = publicKey.replace(/\n/g, '\\n');

      const token = sign({ sub: 'user-rs256' }, privateKey, { algorithm: 'RS256' });
      const payload = AuthService.verifyJWT(token) as { sub: string };
      expect(payload.sub).toBe('user-rs256');
    });

    it('falls back to HS256 for tokens issued before RS256 migration', () => {
      const { publicKey } = generateRsaKeyPair();
      process.env.JWT_SECRET = HS256_SECRET;
      process.env.JWT_PUBLIC_KEY = publicKey.replace(/\n/g, '\\n');

      // HS256 token signed with JWT_SECRET (old token)
      const oldToken = sign({ sub: 'user-old' }, HS256_SECRET, { algorithm: 'HS256' });
      const payload = AuthService.verifyJWT(oldToken) as { sub: string };
      expect(payload.sub).toBe('user-old');
    });

    it('throws when RS256 token is signed with wrong private key', () => {
      const { publicKey } = generateRsaKeyPair();
      const { privateKey: wrongPrivateKey } = generateRsaKeyPair();
      process.env.JWT_SECRET = HS256_SECRET;
      process.env.JWT_PUBLIC_KEY = publicKey.replace(/\n/g, '\\n');

      const token = sign({ sub: 'user-bad' }, wrongPrivateKey, { algorithm: 'RS256' });
      expect(() => AuthService.verifyJWT(token)).toThrow();
    });

    it('unescapes \\n in JWT_PUBLIC_KEY correctly', () => {
      const { privateKey, publicKey } = generateRsaKeyPair();
      process.env.JWT_SECRET = HS256_SECRET;
      // Simulate how the key is stored in .env (with escaped newlines)
      process.env.JWT_PUBLIC_KEY = publicKey.replace(/\n/g, '\\n');

      const token = sign({ sub: 'user-escaped' }, privateKey, { algorithm: 'RS256' });
      const payload = AuthService.verifyJWT(token) as { sub: string };
      expect(payload.sub).toBe('user-escaped');
    });
  });
});
