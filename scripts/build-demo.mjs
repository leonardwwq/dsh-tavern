import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { parseArchive } from '../lib/store.js';

const source = fileURLToPath(new URL('../demo/curtain-castle/', import.meta.url));
const destination = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../demo/curtain-castle.zip', import.meta.url)));
const entries = {};
async function walk(relative = '') {
  const children = await fs.readdir(path.join(source, relative), { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    const name = relative ? `${relative}/${child.name}` : child.name;
    if (child.isDirectory()) await walk(name);
    else if (child.isFile()) entries[name] = [new Uint8Array(await fs.readFile(path.join(source, name))), { mtime: new Date('2020-01-01T00:00:00Z') }];
    else throw new Error(`Unsupported demo file: ${name}`);
  }
}
await walk();
const archive = zipSync(entries, { level: 6 });
const snapshot = parseArchive(archive);
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, archive);
console.log(`Built ${snapshot.manifest.title} (${snapshot.manifest.id}@${snapshot.manifest.version}): ${destination} (${archive.length} bytes)`);
