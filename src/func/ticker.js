// ─── Persistent market ticker (bottom marquee) ───────────────────────────────
// Shows the top movers among a curated set of high-traffic market staples as a
// left-to-right scrolling ticker: in-game item icon, Jita sell price, and a
// green ↗ / red ↘ day-over-day change. Data comes from the get-market-movers IPC
// (cached ~1h server-side); we refresh every 30 min and pause scrolling on hover.

let _tickerTimer = null;

async function initMarketTicker() {
  const track = document.getElementById('marketTickerTrack');
  if (!track) return;
  await refreshMarketTicker();
  clearInterval(_tickerTimer);
  _tickerTimer = setInterval(refreshMarketTicker, 30 * 60 * 1000);
}

async function refreshMarketTicker() {
  const track = document.getElementById('marketTickerTrack');
  if (!track) return;

  let movers = [];
  try { movers = await window.eveAPI.getMarketMovers(); } catch (_) {}

  if (!Array.isArray(movers) || !movers.length) {
    track.innerHTML = '<span class="ticker-empty">Market data unavailable.</span>';
    return;
  }

  const itemHtml = movers.map(m => {
    const flat  = Math.abs(m.pct) < 0.05;
    const up    = m.pct > 0;
    const cls   = flat ? 'flat' : (up ? 'up' : 'down');
    const arrow = flat ? '' : (up ? '↗' : '↘');
    const sign  = m.pct > 0 ? '+' : '';
    return `<span class="ticker-item ${cls}" title="${escHtml(m.name)} · Jita sell">
      <img class="ticker-icon" src="https://images.evetech.net/types/${m.typeId}/icon?size=32"
           alt="" loading="lazy" onerror="this.style.display='none'"/>
      <span class="ticker-name">${escHtml(m.name)}</span>
      <span class="ticker-price">${formatISK(m.sell)}</span>
      <span class="ticker-pct">${arrow} ${sign}${m.pct.toFixed(1)}%</span>
    </span>`;
  }).join('');

  // Duplicate the sequence so the CSS marquee (translateX → -50%) loops seamlessly.
  track.innerHTML = itemHtml + itemHtml;

  // Scale the scroll duration to the content width so speed stays consistent
  // regardless of how many items / how long the names are (~70px per second).
  requestAnimationFrame(() => {
    const half = track.scrollWidth / 2;
    if (half > 0) track.style.animationDuration = Math.max(40, Math.round(half / 70)) + 's';
  });
}
