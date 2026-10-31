import { appendFileSync } from 'node:fs';

const inputLog = process.argv[2];
let acknowledgement = 0;
let lastCommand = 'boot';
const heading = () => `Synthetic web links | Fixture ACK ${acknowledgement}:${lastCommand}`;
const link = (uri, label) => `\x1b]8;;${uri}\x07${label}\x1b]8;;\x07`;
const website = (uri = 'https://example.com', label = 'Visit the website') =>
  `\x1b[2;1H${link(uri, label)}\x1b[K`;
function paint() {
  process.stdout.write(
    '\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h' +
      [
        heading(),
        link('https://example.com', 'Visit the website'),
        link('http://example.com', 'Visit HTTP'),
        link('mailto:test@example.com', 'Send mail'),
        link('javascript:alert(1)', 'Unsupported scheme'),
        link('httpsx://example.com', 'Near-miss scheme'),
        'https://example.org/bare',
        link('https://example.com/wrapped', 'Wrapped website ' + 'continuation '.repeat(25) + 'final web segment'),
      ].join('\r\n'),
  );
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  appendFileSync(inputLog, JSON.stringify([...data]) + '\n');
  for (const command of data.toString()) {
    if (command === 's') process.stdout.write('\x1b[?1000l\x1b[?1006l');
    if (command === 'r') paint();
    if (command === 'p') process.stdout.write(website());
    if (command === 'u') process.stdout.write(website('https://example.com/replaced'));
    if (command === 'g') process.stdout.write(website('https://example.com', 'Visit website'));
    if (command === 'z') process.stdout.write('\x1b[999;1H\r\nScrolled fixture\r\n');
    if ('srpugz'.includes(command)) {
      acknowledgement++;
      lastCommand = command;
      process.stdout.write(`\x1b7\x1b[1;1H${heading()}\x1b[K\x1b8`);
    }
  }
});
process.stdout.on('resize', paint);
paint();
