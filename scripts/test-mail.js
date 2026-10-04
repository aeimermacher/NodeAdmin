import { sendMail } from '../src/mailer.js';

try {
  await sendMail('Test mail', 'If you can read this, NodeAdmin mail alerts are configured correctly.');
  console.log('Test mail sent.');
} catch (err) {
  console.error('Sending failed:', err.message);
  process.exit(1);
}
