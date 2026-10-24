const link = (uri, label) => `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
function paint() {
  process.stdout.write('\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h');
  process.stdout.write([
    'Synthetic document links',
    link('guide.md', 'Read the guide'),
    link('decision.mdx', 'Answer the form'),
    link('https://example.com', 'Visit the website'),
    link('../outside.md', 'Outside document'),
    link('escape.md', 'Symlink escape'),
    link('missing.md', 'Missing document'),
    link('invalid%xx.md', 'Malformed target'),
    link('javascript:guide.md', 'Unsupported scheme'),
    link('guide.md', 'Wrapped label ' + 'continuation '.repeat(25)),
  ].join('\r\n'));
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  if (data.toString() === 's') process.stdout.write('\x1b[?1000l\x1b[?1006l');
});
process.stdout.on('resize', paint);
paint();
