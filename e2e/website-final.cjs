const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const filePath = path.resolve(__dirname, '../../termpolis-web/index.html');
  await page.goto('file:///' + filePath.replace(/\\/g, '/'));
  await page.waitForTimeout(1000);

  // Force ALL reveal elements to be visible (the class is "is-visible")
  await page.evaluate(() => {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));
  });
  await page.waitForTimeout(500);

  const dir = path.resolve(__dirname, 'screenshots');

  await page.screenshot({ path: path.join(dir, 'website-01-hero.png') });
  console.log('1. Hero');

  await page.evaluate(() => document.querySelector('#ai-native')?.scrollIntoView());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, 'website-02-ai-native.png') });
  console.log('2. AI Native');

  await page.evaluate(() => document.querySelector('#swarm')?.scrollIntoView());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, 'website-03-swarm.png') });
  console.log('3. Swarm');

  await page.evaluate(() => document.querySelector('#downloads')?.scrollIntoView());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, 'website-04-downloads.png') });
  console.log('4. Downloads');

  await page.evaluate(() => document.querySelector('#features')?.scrollIntoView());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, 'website-05-features.png') });
  console.log('5. Features');

  // In action section
  await page.evaluate(() => {
    for (const h of document.querySelectorAll('h2')) {
      if (h.textContent.includes('in action')) { h.scrollIntoView(); break; }
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, 'website-06-in-action.png') });
  console.log('6. In Action');

  // Screenshots section
  await page.evaluate(() => {
    for (const h of document.querySelectorAll('h2')) {
      if (h.textContent.includes('up close')) { h.scrollIntoView(); break; }
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, 'website-07-screenshots.png') });
  console.log('7. Screenshots');

  // Sponsor
  await page.evaluate(() => {
    for (const h of document.querySelectorAll('h2')) {
      if (h.textContent.includes('Sponsor')) { h.scrollIntoView(); break; }
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, 'website-08-sponsor.png') });
  console.log('8. Sponsor');

  // Footer
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, 'website-09-footer.png') });
  console.log('9. Footer');

  await browser.close();
  console.log('Done!');
})();
