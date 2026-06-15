import { describe, it, expect } from 'vitest';
import { categorizeError } from '../src/errors.js';

describe('categorizeError', () => {
  it('classifies DNS / connection failures as network', () => {
    for (const raw of [
      'getaddrinfo ENOTFOUND ghcr.io',
      'connect ECONNREFUSED 140.82.0.1:443',
      'connect ETIMEDOUT',
      'connect EHOSTUNREACH 140.82.0.1:443',
      'read ECONNRESET',
      'getaddrinfo EAI_AGAIN ghcr.io',
      'UND_ERR_SOCKET: other side closed',
      'no route to host',
      'network is unreachable',
    ]) {
      expect(categorizeError(new Error(raw)).kind).toBe('network');
    }
  });

  it('classifies a registry 5xx / 429 as registry-unavailable (transient, retryable)', () => {
    for (const raw of [
      'tags/list: HTTP 502',
      'tags/list: HTTP 503',
      'manifest: HTTP 500',
      'token: HTTP 504',
      'tags/list: HTTP 429',
      'fetch failed',
    ]) {
      const c = categorizeError(new Error(raw));
      expect(c.kind).toBe('registry-unavailable');
      // The message must read as "try again", not a hard failure.
      expect(c.userMessage).toMatch(/temporarily unavailable|try again/i);
    }
  });

  it('keeps a real auth failure as auth, not registry-unavailable', () => {
    // 401/403 must NOT be swept up by the 5xx pattern.
    expect(categorizeError(new Error('tags/list: HTTP 401 unauthorized')).kind).toBe('auth');
    expect(
      categorizeError(new Error('denied: requested access to the resource is denied')).kind,
    ).toBe('auth');
  });

  it('classifies a 4xx not-found as not-found', () => {
    expect(categorizeError(new Error('manifest: HTTP 404 not found')).kind).toBe('not-found');
  });

  it('falls back to unknown for unrecognized errors', () => {
    expect(categorizeError(new Error('something weird happened')).kind).toBe('unknown');
  });

  it('does not misclassify a 4xx (non-401/404) as a 5xx', () => {
    // HTTP 400 is a client error, not transient-registry; should be unknown.
    expect(categorizeError(new Error('tags/list: HTTP 400 bad request')).kind).toBe('unknown');
  });
});
