import { describe, expect, it } from 'vitest';

import { encodeQr, qrToSvg } from '../src/client/qr.js';

/**
 * Golden matrices generated with the independent `qrcode` npm package
 * (byte-mode segment, ECC M, fixed version and mask). Comparing whole
 * matrices covers data encoding, Reed-Solomon blocks, interleaving, function
 * patterns, zig-zag placement, masking, and format information at once.
 */
describe('qr encoder', () => {
  it('matches the reference matrix for a version 1 code', () => {
    const code = encodeQr('HELLO', 0);
    expect(code).toBeDefined();
    expect(code?.version).toBe(1);
    expect(code?.size).toBe(21);
    const rows = code?.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
    expect(rows).toEqual([
      "111111100111001111111",
      "100000101011001000001",
      "101110100010001011101",
      "101110100011001011101",
      "101110101010101011101",
      "100000100110101000001",
      "111111101010101111111",
      "000000000101100000000",
      "101010100101000010010",
      "101010000110001000010",
      "000001100110100011111",
      "101011010110001000010",
      "011001110110101010100",
      "000000001011010100110",
      "111111100001011100111",
      "100000100011110110000",
      "101110101011011100111",
      "101110100100001100110",
      "101110101010100010101",
      "100000100110001010010",
      "111111101010101100111",
    ]);
  });

  it('matches the reference matrix for a 41-byte pair URL (version 3)', () => {
    const text = 'http://127.0.0.1:8790/pair?code=mbtz-kek3';
    const code = encodeQr(text, 6);
    expect(code?.version).toBe(3);
    const rows = code?.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
    expect(rows).toEqual([
      "11111110101010101100001111111",
      "10000010100101000011001000001",
      "10111010101001101010101011101",
      "10111010000101010101101011101",
      "10111010100011101111101011101",
      "10000010011011001110001000001",
      "11111110101010101010101111111",
      "00000000001111001001100000000",
      "10011111111000110101110010111",
      "01101000000110110111100010110",
      "00110011001010010110001110100",
      "01100100111110111100000110001",
      "01110010101110011000011000001",
      "01010001001100111000111011011",
      "01001110001010010111111001101",
      "00000001000100000011001100101",
      "11010111010101100010010100000",
      "11101100000000110001000111110",
      "11000110010110110001100000001",
      "11001101010111001001101111100",
      "11001111011111000100111111110",
      "00000000101011111011100011000",
      "11111110100011011011101011000",
      "10000010101001000100100010011",
      "10111010110001011001111110010",
      "10111010111000111111000101101",
      "10111010011111011101100010011",
      "10000010000000100001001000101",
      "11111110101111110000100111000",
    ]);
  });

  it('picks the smallest version that fits and refuses oversized payloads', () => {
    expect(encodeQr('http://127.0.0.1:8790/pair?code=mbtz-kek3')?.version).toBe(3);
    expect(encodeQr('x'.repeat(120))?.version).toBeLessThanOrEqual(9);
    expect(encodeQr('x'.repeat(500))).toBeUndefined();
  });

  it('renders a quiet-zoned SVG', () => {
    const code = encodeQr('HELLO', 0);
    if (code === undefined) throw new Error('expected a QR code');
    const svg = qrToSvg(code, 100);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 29 29"'); // 21 modules + 4 quiet modules each side
    expect(svg).toContain('aria-label="Pair URL QR code"');
  });
});
