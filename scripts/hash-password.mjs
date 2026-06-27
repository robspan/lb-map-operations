import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const password = process.argv[2] || process.env.OPS_PASSWORD;
if (!password) {
  console.error('usage: npm run ops:hash-password -- <password>');
  process.exit(2);
}

const derive = promisify(scrypt);
const salt = randomBytes(16).toString('base64url');
const cost = 16384;
const blockSize = 8;
const parallelization = 1;
const hash = await derive(password, salt, 64, {
  N: cost,
  r: blockSize,
  p: parallelization,
});

console.log(['scrypt', cost, blockSize, parallelization, salt, hash.toString('base64url')].join('$'));
