import { fileURLToPath } from 'node:url';

const samplePage = new URL('./test/sample.html', import.meta.url);

export default {
  ignoreFiles: [
    'test',
    'test/**',
    'node_modules/**',
    'web-ext-artifacts/**',
    'package.json',
    'package-lock.json',
    'web-ext-config.mjs',
    'README.md',
    '.gitignore'
  ],
  run: {
    // Opens the local test page so there is something to highlight straight away.
    startUrl: ['file://' + fileURLToPath(samplePage)]
  }
};
