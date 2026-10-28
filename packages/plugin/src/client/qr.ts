/**
 * Minimal QR Code encoder (byte mode, ECC level M, versions 1-9).
 *
 * Why hand-written: the client bundle must be a single self-contained script
 * with no third-party dependency, and the QR payload is a short pair URL
 * (< 180 bytes), so the full spec surface is unnecessary. Versions 1-9 use an
 * 8-bit character count and top out at 182 data codewords, which is ample.
 *
 * The implementation follows ISO/IEC 18004: data encoding → Reed-Solomon
 * blocks → function patterns → zigzag placement → mask selection → format
 * information. It is verified module-for-module against `segno` in the plugin
 * test suite.
 */

const ECC_LEVEL_M = 0b00;

interface VersionSpec {
  /** Data codewords per block, group 1. */
  group1: number;
  /** Number of blocks in group 1. */
  group1Blocks: number;
  /** Data codewords per block, group 2 (0 when absent). */
  group2: number;
  group2Blocks: number;
  /** EC codewords per block. */
  ecPerBlock: number;
  /** Total codewords (data + EC). */
  totalCodewords: number;
}

/** ECC level M block structure for versions 1-9. */
const VERSIONS: Record<number, VersionSpec> = {
  1: { group1: 16, group1Blocks: 1, group2: 0, group2Blocks: 0, ecPerBlock: 10, totalCodewords: 26 },
  2: { group1: 28, group1Blocks: 1, group2: 0, group2Blocks: 0, ecPerBlock: 16, totalCodewords: 44 },
  3: { group1: 44, group1Blocks: 1, group2: 0, group2Blocks: 0, ecPerBlock: 26, totalCodewords: 70 },
  4: { group1: 32, group1Blocks: 2, group2: 0, group2Blocks: 0, ecPerBlock: 18, totalCodewords: 100 },
  5: { group1: 43, group1Blocks: 2, group2: 0, group2Blocks: 0, ecPerBlock: 24, totalCodewords: 134 },
  6: { group1: 27, group1Blocks: 4, group2: 0, group2Blocks: 0, ecPerBlock: 16, totalCodewords: 172 },
  7: { group1: 31, group1Blocks: 4, group2: 0, group2Blocks: 0, ecPerBlock: 18, totalCodewords: 196 },
  8: { group1: 38, group1Blocks: 2, group2: 39, group2Blocks: 2, ecPerBlock: 22, totalCodewords: 242 },
  9: { group1: 36, group1Blocks: 3, group2: 37, group2Blocks: 2, ecPerBlock: 22, totalCodewords: 292 },
};

/** Alignment pattern centre coordinates per version (empty for v1). */
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
};

const MAX_VERSION = 9;

/* ------------------------------ GF(256) math ------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] as number;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

/** Generator polynomial ∏(x - α^i) for i in [0, degree). */
export function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const root = EXP[i] as number;
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] as number) ^ (poly[j] as number);
      next[j + 1] = (next[j + 1] as number) ^ gfMul(poly[j] as number, root);
    }
    poly = next;
  }
  return poly;
}

/** EC codewords for one block: remainder of data·x^degree ÷ generator. */
export function ecCodewords(data: number[], degree: number): number[] {
  const generator = generatorPoly(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = (byte as number) ^ (remainder.shift() as number);
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i] = (remainder[i] as number) ^ gfMul(generator[i + 1] as number, factor);
    }
  }
  return remainder;
}

/* -------------------------------- bit buffer ------------------------------- */

class BitBuffer {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      bytes.push(byte);
    }
    return bytes;
  }
}

/* ------------------------------- codewords -------------------------------- */

interface EncodedData {
  codewords: number[];
  version: number;
}

function encodeData(text: string): EncodedData | undefined {
  const bytes = Array.from(new TextEncoder().encode(text));
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const spec = VERSIONS[version];
    if (spec === undefined) continue;
    const dataCodewords = spec.group1 * spec.group1Blocks + spec.group2 * spec.group2Blocks;
    // 4 mode bits + 8 count bits, rounded up to a whole codeword.
    if (bytes.length > dataCodewords - 2) continue;

    const buffer = new BitBuffer();
    buffer.push(0b0100, 4);
    buffer.push(bytes.length, 8);
    for (const byte of bytes) buffer.push(byte, 8);

    const capacityBits = dataCodewords * 8;
    const terminator = Math.min(4, capacityBits - buffer.length);
    buffer.push(0, terminator);
    while (buffer.length % 8 !== 0) buffer.push(0, 1);
    const data = buffer.toBytes();
    const pads = [0xec, 0x11];
    let padIndex = 0;
    while (data.length < dataCodewords) {
      data.push(pads[padIndex % 2] as number);
      padIndex += 1;
    }
    return { codewords: data, version };
  }
  return undefined;
}

function interleave(data: number[], spec: VersionSpec): number[] {
  const blocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < spec.group1Blocks; i += 1) {
    blocks.push(data.slice(offset, offset + spec.group1));
    offset += spec.group1;
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    blocks.push(data.slice(offset, offset + spec.group2));
    offset += spec.group2;
  }
  const ecc = blocks.map((block) => ecCodewords(block, spec.ecPerBlock));

  const out: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) {
      if (i < block.length) out.push(block[i] as number);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecc) out.push(block[i] as number);
  }
  return out;
}

/* --------------------------------- matrix --------------------------------- */

interface Matrix {
  size: number;
  modules: boolean[][];
  reserved: boolean[][];
}

function createMatrix(version: number): Matrix {
  const size = version * 4 + 17;
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunction(matrix: Matrix, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) return;
  matrix.modules[y]![x] = dark;
  matrix.reserved[y]![x] = true;
}

function drawFinder(matrix: Matrix, centerX: number, centerY: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(matrix, centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(matrix: Matrix, centerX: number, centerY: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunction(matrix, centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(matrix: Matrix, version: number): void {
  const size = matrix.size;
  drawFinder(matrix, 3, 3);
  drawFinder(matrix, size - 4, 3);
  drawFinder(matrix, 3, size - 4);

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunction(matrix, 6, i, dark);
    setFunction(matrix, i, 6, dark);
  }

  const centers = ALIGNMENT[version] ?? [];
  for (const centerY of centers) {
    for (const centerX of centers) {
      const overlapsFinder =
        (centerX === 6 && centerY === 6) ||
        (centerX === 6 && centerY === size - 7) ||
        (centerX === size - 7 && centerY === 6);
      if (!overlapsFinder) drawAlignment(matrix, centerX, centerY);
    }
  }

  // Reserve format information areas (drawn later once the mask is chosen).
  for (let i = 0; i <= 8; i += 1) {
    if (!matrix.reserved[8]![i]) {
      matrix.reserved[8]![i] = true;
      matrix.modules[8]![i] = false;
    }
    if (!matrix.reserved[i]![8]) {
      matrix.reserved[i]![8] = true;
      matrix.modules[i]![8] = false;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    matrix.reserved[8]![size - 1 - i] = true;
    matrix.modules[8]![size - 1 - i] = false;
    matrix.reserved[size - 1 - i]![8] = true;
    matrix.modules[size - 1 - i]![8] = false;
  }
  setFunction(matrix, 8, size - 8, true); // dark module

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(matrix, a, b, bit);
      setFunction(matrix, b, a, bit);
    }
  }
}

function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return (version << 12) | remainder;
}

function drawFormat(matrix: Matrix, mask: number): void {
  const size = matrix.size;
  const data = (ECC_LEVEL_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (index: number): boolean => ((bits >>> index) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) setFunction(matrix, 8, i, bit(i));
  setFunction(matrix, 8, 7, bit(6));
  setFunction(matrix, 8, 8, bit(7));
  setFunction(matrix, 7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) setFunction(matrix, 14 - i, 8, bit(i));

  for (let i = 0; i < 8; i += 1) setFunction(matrix, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) setFunction(matrix, 8, size - 15 + i, bit(i));
}

function placeCodewords(matrix: Matrix, codewords: number[]): void {
  const size = matrix.size;
  let index = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (matrix.reserved[y]![x] === true) continue;
        if (index >= totalBits) continue;
        const byte = codewords[index >>> 3] as number;
        matrix.modules[y]![x] = ((byte >>> (7 - (index & 7))) & 1) === 1;
        index += 1;
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(matrix: Matrix, mask: number): void {
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.reserved[y]![x] === true) continue;
      if (maskBit(mask, x, y)) matrix.modules[y]![x] = !matrix.modules[y]![x];
    }
  }
}

/* -------------------------------- penalty --------------------------------- */

function penaltyScore(matrix: Matrix): number {
  const size = matrix.size;
  const modules = matrix.modules;
  let score = 0;

  const runs = (get: (index: number) => boolean): void => {
    let runColor = get(0);
    let runLength = 1;
    for (let i = 1; i < size; i += 1) {
      const color = get(i);
      if (color === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) score += 3 + (runLength - 5);
        runColor = color;
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + (runLength - 5);
  };

  for (let y = 0; y < size; y += 1) runs((x) => modules[y]![x] === true);
  for (let x = 0; x < size; x += 1) runs((y) => modules[y]![x] === true);

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y]![x];
      if (modules[y]![x + 1] === color && modules[y + 1]![x] === color && modules[y + 1]![x + 1] === color) {
        score += 3;
      }
    }
  }

  const finderLike = (get: (index: number) => boolean): void => {
    for (let i = 0; i + 6 < size; i += 1) {
      if (get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6)) {
        let before = true;
        for (let k = i - 4; k < i; k += 1) {
          if (k >= 0 && get(k)) {
            before = false;
            break;
          }
        }
        let after = true;
        for (let k = i + 7; k < i + 11; k += 1) {
          if (k < size && get(k)) {
            after = false;
            break;
          }
        }
        if (before !== after) score += 40;
      }
    }
  };
  for (let y = 0; y < size; y += 1) finderLike((x) => modules[y]![x] === true);
  for (let x = 0; x < size; x += 1) finderLike((y) => modules[y]![x] === true);

  let dark = 0;
  for (const row of modules) for (const module of row) if (module) dark += 1;
  const total = size * size;
  score += Math.floor(Math.abs((dark * 100) / total - 50) / 5) * 10;
  return score;
}

/* --------------------------------- public --------------------------------- */

export interface QrCode {
  version: number;
  size: number;
  /** Row-major modules; true = dark. */
  modules: boolean[][];
  mask: number;
}

/**
 * Encode a short piece of text (UTF-8, ≤ 180 bytes) as a QR Code.
 *
 * @param text payload, normally the pair URL.
 * @param forcedMask test hook: pin a mask instead of selecting the best one.
 * @returns the module matrix, or undefined when the payload fits no version.
 */
export function encodeQr(text: string, forcedMask?: number): QrCode | undefined {
  const encoded = encodeData(text);
  if (encoded === undefined) return undefined;
  const spec = VERSIONS[encoded.version] as VersionSpec;
  const codewords = interleave(encoded.codewords, spec);

  let best: QrCode | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  const masks = forcedMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask];
  for (const mask of masks) {
    const matrix = createMatrix(encoded.version);
    drawFunctionPatterns(matrix, encoded.version);
    placeCodewords(matrix, codewords);
    applyMask(matrix, mask);
    drawFormat(matrix, mask);
    const candidate: QrCode = { version: encoded.version, size: matrix.size, modules: matrix.modules, mask };
    if (forcedMask !== undefined) return candidate;
    const score = penaltyScore(matrix);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Render a QR code as an inline SVG string with a 4-module quiet zone. */
export function qrToSvg(code: QrCode, sizePx = 168): string {
  const quiet = 4;
  const dimension = code.size + quiet * 2;
  const parts: string[] = [];
  for (let y = 0; y < code.size; y += 1) {
    for (let x = 0; x < code.size; x += 1) {
      if (code.modules[y]?.[x] === true) {
        parts.push(`M${String(x + quiet)} ${String(y + quiet)}h1v1h-1z`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(sizePx)}" height="${String(sizePx)}" ` +
    `viewBox="0 0 ${String(dimension)} ${String(dimension)}" role="img" aria-label="Pair URL QR code" ` +
    `shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/>` +
    `<path d="${parts.join('')}" fill="#000000"/></svg>`
  );
}