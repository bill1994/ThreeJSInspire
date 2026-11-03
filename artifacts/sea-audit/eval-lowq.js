window.__porco.qa.setQuality(false);
await new Promise((r) => setTimeout(r, 2000)); // the material rebuild is async
window.__porco.qa.step(30, 1 / 60);
return { quality: window.__porco.world?.quality, elapsed: window.__porco.qa.elapsed };
