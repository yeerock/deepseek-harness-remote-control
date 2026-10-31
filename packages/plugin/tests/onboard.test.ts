import { describe, expect, it } from 'vitest';
import { buildJoinPrompt, isLoopbackOrigin, REPO_TAG, REPO_URL } from '../src/onboard.js';

describe('join prompt', () => {
  const base = {
    publicUrl: 'https://dsh-rc.example.ts.net',
    version: '0.4.14',
  };

  it('is one short command per OS, pinned to the release tag', () => {
    const prompt = buildJoinPrompt(base);
    expect(prompt).toContain('https://dsh-rc.example.ts.net');
    expect(prompt).toContain(`raw.githubusercontent.com/yeerock/deepseek-harness-remote-control/${REPO_TAG}/scripts/install.ps1`);
    expect(prompt).toContain(`/${REPO_TAG}/scripts/install.sh | sh -s -- 'https://dsh-rc.example.ts.net' ${REPO_TAG}`);
    expect(prompt).toContain(`$env:DSHRC_TAG='${REPO_TAG}'`);
    expect(prompt).toContain("$env:DSHRC_EDGE='https://dsh-rc.example.ts.net'");
    expect(prompt).toContain('DSH RC 0.4.14');
    expect(prompt).toContain('DONE');
    expect(prompt.length).toBeLessThan(900);
    expect(REPO_URL).toContain('github.com');
  });

  it('cannot carry shell metacharacters from the edge URL', () => {
    const prompt = buildJoinPrompt({ ...base, publicUrl: "https://edge.example/x';rm -rf ~;'" });
    expect(prompt).toContain("$env:DSHRC_EDGE='https://edge.example'");
    expect(prompt).not.toContain('rm -rf');
  });

  it('is one paragraph with no newlines or secrets', () => {
    const prompt = buildJoinPrompt(base);
    expect(prompt).not.toContain('\n');
    expect(prompt).not.toContain('dshrc_guest');
    expect(prompt).not.toContain('dshrc_session');
    expect(prompt).not.toContain('deviceSecret');
    expect(prompt).not.toContain('Bearer ');
    expect(prompt).toContain('Never ask for or share a password');
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