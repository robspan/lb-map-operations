import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const DEFAULT_COST = 16384;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELIZATION = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derived = (await scrypt(password, salt, KEY_LENGTH, {
    N: DEFAULT_COST,
    r: DEFAULT_BLOCK_SIZE,
    p: DEFAULT_PARALLELIZATION,
  })) as Buffer;
  return [
    'scrypt',
    DEFAULT_COST,
    DEFAULT_BLOCK_SIZE,
    DEFAULT_PARALLELIZATION,
    salt,
    derived.toString('base64url'),
  ].join('$');
}

function scrypt(
  password: string,
  salt: string,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
      } else {
        resolve(derivedKey);
      }
    });
  });
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, costRaw, blockSizeRaw, parallelizationRaw, salt, hash] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !hash) {
    return false;
  }
  const cost = Number(costRaw);
  const blockSize = Number(blockSizeRaw);
  const parallelization = Number(parallelizationRaw);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelization)) {
    return false;
  }
  const expected = Buffer.from(hash, 'base64url');
  const actual = (await scrypt(password, salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallelization,
  })) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
