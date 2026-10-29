import { existsSync } from 'node:fs';
const need = ['src/renderer.ts', 'src/sky-sunset.ts', 'src/main.ts', 'index.html', 'package.json'];
let miss = need.filter(f => !existsSync(f));
if (miss.length) { console.error('missing ' + miss.join(',')); process.exit(1); }
console.log('smoke ok');
