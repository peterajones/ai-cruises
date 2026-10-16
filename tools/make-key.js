// npm run make-key — a random 43-character key, for JWT_SECRET or SYNC_KEY.
import { randomBytes } from 'node:crypto';
console.log(randomBytes(32).toString('base64url'));
