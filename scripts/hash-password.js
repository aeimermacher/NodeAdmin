import readline from 'node:readline';
import { hashPassword } from '../src/auth.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
rl._writeToOutput = (s) => {
  if (!muted) rl.output.write(s);
};

rl.question('Password: ', async (password) => {
  rl.close();
  process.stdout.write('\n');
  if (password.length < 6) {
    console.error('Use at least 6 characters.');
    process.exit(1);
  }
  console.log(`ADMIN_PASSWORD_HASH=${await hashPassword(password)}`);
});
muted = true;
