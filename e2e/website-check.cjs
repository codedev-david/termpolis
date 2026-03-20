const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const filePath = path.resolve(__dirname, '../../termpolis-web/index.html');
  await page.goto('file:///' + filePath.replace(/\\/g, '/'));
  await page.waitForTimeout(2000);

  const dir = path.resolve(__dirname, 'screenshots');

  await page.screenshot({ path: path.join(dir, 'website-hero.png') });
  console.log('1. Hero captured');

  await page.evaluate(() => document.querySelector('#ai-native')?.scrollIntoView());
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'website-ai-native.png') });
  console.log('2. AI Native captured');

  await page.evaluate(() => document.querySelector('#swarm')?.scrollIntoView());
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'website-swarm.png') });
  console.log('3. Swarm captured');

  await page.evaluate(() => document.querySelector('#downloads')?.scrollIntoView());
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'website-downloads.png') });
  console.log('4. Downloads captured');

  await page.evaluate(() => document.querySelector('#features')?.scrollIntoView());
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'website-features.png') });
  console.log('5. Features captured');

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'website-footer.png') });
  console.log('6. Footer captured');

  await page.screenshot({ path: path.join(dir, 'website-full.png'), fullPage: true });
  console.log('7. Full page captured');

  await browser.close();
  console.log('Done!');
})();
