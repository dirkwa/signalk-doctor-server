import { describe, it, expect } from 'vitest';
import { classify } from '../src/drift/classify.js';

describe('classify', () => {
  it('returns up-to-date when versions match', () => {
    expect(classify('3.18.0', '3.18.0')).toBe('up-to-date');
  });

  it('detects patch bumps', () => {
    expect(classify('3.18.0', '3.18.1')).toBe('patch');
  });

  it('detects minor bumps', () => {
    expect(classify('3.18.0', '3.19.0')).toBe('minor');
  });

  it('detects major bumps', () => {
    expect(classify('3.18.0', '4.0.0')).toBe('major');
  });

  it('treats prerelease difference at same triple as prerelease', () => {
    expect(classify('4.1.0-beta', '4.1.0')).toBe('prerelease');
  });

  it('accepts leading v prefix', () => {
    expect(classify('v3.18.0', '3.19.0')).toBe('minor');
  });

  it('returns up-to-date when latest is older (local build ahead of npm)', () => {
    expect(classify('3.19.0', '3.18.0')).toBe('up-to-date');
  });

  it('returns unknown for unparseable input', () => {
    expect(classify('not-semver', '3.19.0')).toBe('unknown');
  });
});
