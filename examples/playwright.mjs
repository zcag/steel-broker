// Two agents, two isolated windows, one shared cookie jar.
//
//   npm i playwright-core && node examples/playwright.mjs
//
// Each connectOverCDP() to /cdp gets its OWN fresh window and only sees that
// window — so the two never collide — while sharing the one Chrome profile.

import { chromium } from 'playwright-core';

const BROKER = process.env.BROKER || 'http://127.0.0.1:3030';

async function agent(name, url) {
  const browser = await chromium.connectOverCDP(`${BROKER}/cdp`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(url);
  console.log(`${name}: ${await page.title()}  (sees ${ctx.pages().length} page)`);
  return browser; // keep open so you can watch it via a /v/<lease> link
}

const a = await agent('agent-A', 'https://example.com');
const b = await agent('agent-B', 'https://duckduckgo.com');

console.log(`\nOpen ${BROKER}/ to see both windows and grab a per-window view link.`);
// await a.close(); await b.close();
