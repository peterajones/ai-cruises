// npm run hash-password — asks for a password twice (not shown) and prints the hash for
// LOGIN_PASSWORD_HASH. The password itself is never stored or printed.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { checkNewPassword, hashPassword } from '../auth.js';

const silent = new Writable({ write(_chunk, _enc, done) { done(); } });
async function ask(prompt) {
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  const answer = await rl.question('');
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const a = await ask('New password: ');
const b = await ask('Again: ');
const problem = checkNewPassword(a, b);
if (problem) {
  console.error(problem);
  process.exit(1);
}
console.log(`\nLOGIN_PASSWORD_HASH=${hashPassword(a)}`);
console.log('\nPaste that line into Coolify (Environment Variables). A new hash logs out every device.');
