let input = '';
for await (const chunk of process.stdin) input += chunk;
const fields = Object.fromEntries(input.trim().split('\n').map((line) => {
  const separator = line.indexOf('=');
  return [line.slice(0, separator), line.slice(separator + 1)];
}));
if (process.argv[2] === 'get' && fields.protocol === 'https' && fields.host === 'github.com' && process.env.GITHUB_TOKEN) {
  process.stdout.write(`username=x-access-token\npassword=${process.env.GITHUB_TOKEN}\n\n`);
}