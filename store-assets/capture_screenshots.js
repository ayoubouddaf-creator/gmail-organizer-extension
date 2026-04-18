/**
 * Run this script with Node.js to capture all screenshots via Chrome DevTools Protocol.
 * 
 * Prerequisites:
 *   npm install chrome-remote-interface
 * 
 * Steps:
 *   1. Open Chrome with remote debugging enabled:
 *      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 *   2. In Chrome, open: chrome-extension://bmihlnhdjhbphfeobnmapjdphbfipgce/options.html
 *   3. Run: node capture_screenshots.js
 */

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

const EXTENSION_ID = 'bmihlnhdjhbphfeobnmapjdphbfipgce';
const OUTPUT_DIR = __dirname;
const WIDTH = 1280;
const HEIGHT = 800;

const PAGES = [
  { name: 'screenshot-1-dashboard.png',      hash: '' },
  { name: 'screenshot-2-categorization.png', hash: '#categorization' },
  { name: 'screenshot-3-rules.png',          hash: '#rules' },
  { name: 'screenshot-4-history.png',        hash: '#history' },
];

async function capturePages() {
  const client = await CDP();
  const { Page, Emulation } = client;

  await Page.enable();

  // Set viewport
  await Emulation.setDeviceMetricsOverride({
    width: WIDTH, height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false
  });

  for (const { name, hash } of PAGES) {
    const url = `chrome-extension://${EXTENSION_ID}/options.html${hash}`;
    console.log(`Capturing: ${url}`);
    
    await Page.navigate({ url });
    await Page.loadEventFired();
    await new Promise(r => setTimeout(r, 1500)); // wait for JS to render

    const { data } = await Page.captureScreenshot({ format: 'png', clip: {
      x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1
    }});

    const outPath = path.join(OUTPUT_DIR, name);
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
    console.log(`  ✓ Saved: ${outPath}`);
  }

  await client.close();
  console.log('\nAll screenshots captured\!');
}

capturePages().catch(console.error);
