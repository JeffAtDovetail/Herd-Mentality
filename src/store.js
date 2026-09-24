// Tiny JSON-file persistence. The game runs once on one laptop, so a database would be
// overkill: state is written to data/*.json after every change (atomically, via a temp
// file + rename) so a crash or restart picks up exactly where it left off.

import fs from 'node:fs';
import path from 'node:path';

export function createStore(dir) {
  fs.mkdirSync(path.join(dir, 'games'), { recursive: true });

  const file = (name) => path.join(dir, name);

  function read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file(name), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`Could not read ${name}: ${err.message}`);
      return fallback;
    }
  }

  function writeNow(name, data) {
    const target = file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
  }

  // Coalesce bursts of changes (e.g. 100 answers in two seconds) into one write.
  const pending = new Map();
  let timer = null;
  function write(name, data) {
    pending.set(name, data);
    timer ??= setTimeout(flush, 150);
  }
  function flush() {
    clearTimeout(timer);
    timer = null;
    for (const [name, data] of pending) {
      try {
        writeNow(name, data);
      } catch (err) {
        console.error(`Could not save ${name}: ${err.message}`);
      }
    }
    pending.clear();
  }

  return { read, write, writeNow, flush, dir };
}
