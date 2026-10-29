import { describe, expect, it } from 'vitest';
import { buildJoinPrompt, isLoopbackOrigin, REPO_TAG, REPO_URL } from '../src/onboard.js';

describe('join prompt', () => {
  const base = {
    publicUrl: 'https://dsh-rc.example.ts.net',
    version: '0.3.6',
  };

  it('carries the public edge, pinned tag, repository and device name', () => {
    const prompt = buildJoinPrompt(base);
    expect(prompt).toContain('https://dsh-rc.example.ts.net');
    expect(prompt).toContain(REPO_URL);
    expect(prompt).toContain(REPO_TAG);
    expect(prompt).toContain('this computer\'s hostname');
    expect(prompt).toContain('DSH RC 0.3.6');
    expect(prompt).toContain('git clone --branch');
    expect(prompt).toContain('scripts/join-edge.mjs');
    expect(prompt).toContain('zero human action');
    expect(prompt).toContain('join-edge.mjs');
  });

  it('is one paragraph with no newlines or secrets', () => {
    const prompt = buildJoinPrompt(base);
    expect(prompt).not.toContain('\n');
    expect(prompt).not.toContain('dshrc_guest');
    expect(prompt).not.toContain('dshrc_session');
    expect(prompt).not.toContain('deviceSecret');
    expect(prompt).not.toContain('Bearer ');
    expect(prompt.includes('owner password')).toBe(true); // only as "do not ask for"
  });

  it('sanitizes the device name and trailing slashes', () => {
    const prompt = buildJoinPrompt({ ...base, publicUrl: 'https://edge.example/' });
    expect(prompt).toContain('https://edge.example');
    expect(prompt).not.toContain('https://edge.example/');
    expect(prompt).not.toContain('\r');
  });

  it('classifies loopback and invalid origins', () => {
    for (const value of ['http://127.0.0.1:8787', 'http://localhost:8787', 'https://[::1]/', 'not a url']) {
      expect(isLoopbackOrigin(value), value).toBe(true);
    }
    expect(isLoopbackOrigin('https://dsh-rc.example.ts.net')).toBe(false);
  });
});