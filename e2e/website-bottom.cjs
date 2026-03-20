const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const filePath = path.resolve(__dirname, '../../termpolis-web/index.html');
  await page.goto('file:///' + filePath.replace(/\\/g, '/'));
  await page.waitForTimeout(1000);

  // Force all reveal elements to be visible
  await page.evaluate(() => {
    document.querySelectorAll('.reveal').forEach(el => {
      el.style.opacity = '1';
      el.style.transform = 'none';
      el.classList.add('visible');
    });
  });
  await page.waitForTimeout(500);

  const dir = path.resolve(__dirname, 'screenshots');

  // Screenshots section
  await page.evaluate(() => {
    const el = document.querySelectorAll('.section.reveal');
    el[el.length - 3]?.scrollIntoView();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'website-screenshots-section.png') });
  console.log('1. Screenshots section captured');

  // Sponsor section
  await page.evaluate(() => {
    const el = document.querySelectorAll('.section.reveal');
    el[el.length - 2]?.scrollIntoView();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'website-sponsor-section.png') });
  console.log('2. Sponsor section captured');

  // Footer
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'website-footer-final.png') });
  console.log('3. Footer captured');

  // In action section (replacement for video)
  await page.evaluate(() => {
    const headings = document.querySelectorAll('h2');
    for (const h of headings) {
      if (h.textContent.includes('in action')) { h.scrollIntoView(); break; }
    }
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'website-in-action.png') });
  console.log('4. In action section captured');

  await browser.close();
  console.log('Done!');
})();
