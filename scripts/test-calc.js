const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('wss://connect.anchorbrowser.io/?sessionId=85a93706-fa69-4264-b814-ebe4e92c95cc');
  const page = await browser.newPage();
  await page.goto('https://app.factsmoney.com/facts-funnel');
  await page.waitForTimeout(2000);

  // Test slider interaction - set income to 150000
  const incomeSlider = await page.$('[id="slider-income"]');
  if (incomeSlider) {
    await incomeSlider.fill('150000');
    await incomeSlider.dispatchEvent('input');
    await page.waitForTimeout(500);
  }

  // Set nm debt to 200000
  const nmSlider = await page.$('[id="slider-nm"]');
  if (nmSlider) {
    await nmSlider.fill('200000');
    await nmSlider.dispatchEvent('input');
    await page.waitForTimeout(500);
  }

  // Set rate to 7
  const rateSlider = await page.$('[id="slider-rate"]');
  if (rateSlider) {
    await rateSlider.fill('7');
    await rateSlider.dispatchEvent('input');
    await page.waitForTimeout(500);
  }

  const monthlyTheft = await page.$eval('[id="monthly-theft"]', el => el.textContent);
  const lifetimeTheft = await page.$eval('[id="lifetime-theft"]', el => el.textContent);

  console.log('Monthly theft:', monthlyTheft);
  console.log('Lifetime theft:', lifetimeTheft);

  // Check Q3 buttons
  const q3Btns = await page.$$eval('[data-q="2"]', els => els.map(e => e.textContent));
  console.log('Q3 buttons:', q3Btns.join(' / '));

  // Check Q3 question text
  const q3Card = await page.$('[id="fc-2"]');
  if (q3Card) {
    const q3Text = await q3Card.$eval('.forensic-text', el => el.textContent);
    console.log('Q3 question text:', q3Text);
  }

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });