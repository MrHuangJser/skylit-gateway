// Inspect the sidebar DOM around the FLOWSEEKER section: ancestors, attributes and
// the links it contains, to find a stable selector for hiding it.
import { chromium } from 'playwright-core';
const base = process.env.DEVICE_BASE || 'http://127.0.0.1:48175';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  const info = await page.evaluate(() => {
    const desc = el => el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.attributes].filter(a => a.name !== 'class' && a.name !== 'style').map(a => `[${a.name}="${a.value.slice(0, 40)}"]`).join('')} class="${(el.getAttribute('class') || '').slice(0, 80)}"` : null;
    const label = [...document.querySelectorAll('*')].find(e => e.childElementCount === 0 && e.textContent.trim() === 'FLOWSEEKER');
    const chain = [];
    for (let e = label, i = 0; e && i < 9; e = e.parentElement, i++) chain.push(desc(e));
    const flowLinks = [...document.querySelectorAll('a[href^="/flow"]')].map(a => ({ href: a.getAttribute('href'), attrs: desc(a) }));
    // The nearest ancestor of the label that also contains every /flow link = the section.
    let section = label;
    while (section && !flowLinks.every(l => section.querySelector(`a[href="${l.href}"]`))) section = section.parentElement;
    const siblings = section ? [...section.parentElement.children].map(c => desc(c).slice(0, 140) + ' text=' + c.textContent.trim().slice(0, 20)) : [];
    return { chain, flowLinks: flowLinks.slice(0, 3), flowLinkCount: flowLinks.length, section: desc(section), siblings };
  });
  console.log(JSON.stringify(info, null, 2));
} finally { await browser.close(); }
