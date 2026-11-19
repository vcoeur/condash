// Prints plain absolute file paths (plus one labelled OSC 8 link and one bare
// URL to pin the pre-existing link routes) as static text, for the plain-path
// terminal-link spec. The lines come in as a JSON array in PATH_LINES.
const link = (uri, label) => `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
const lines = JSON.parse(process.env.PATH_LINES ?? '[]');
function paint() {
  process.stdout.write('\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h');
  process.stdout.write(['Synthetic plain paths', ...lines].join('\r\n'));
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.on('resize', paint);
paint();
