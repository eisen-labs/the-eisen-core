import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(__dirname, '..', 'media');

// Create media directory if it doesn't exist
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

// Copy CSS files
const stylesToCopy = [
  'reset.css',
  'vscode.css',
  'main.css'
];

for (const file of stylesToCopy) {
  const src = path.join(__dirname, '..', 'src', 'styles', file);
  const dest = path.join(mediaDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file}`);
  }
}

// Copy graph.js from ui dist
const graphJsSrc = path.join(__dirname, '..', '..', 'ui', 'dist', 'main.js');
const graphJsDest = path.join(mediaDir, 'graph.js');
if (fs.existsSync(graphJsSrc)) {
  fs.copyFileSync(graphJsSrc, graphJsDest);
  console.log('Copied graph.js');
}

// Copy graph.css from ui dist
const graphCssSrc = path.join(__dirname, '..', '..', 'ui', 'dist', 'style.css');
const graphCssDest = path.join(mediaDir, 'graph.css');
if (fs.existsSync(graphCssSrc)) {
  fs.copyFileSync(graphCssSrc, graphCssDest);
  console.log('Copied graph.css');
}

console.log('Media files copied successfully');
