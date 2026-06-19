import type { MediaGalleryItem } from "./whatsapp.js";

export function renderGallery(items: MediaGalleryItem[], mediaToken: string | undefined): string {
  const groupName = items[0]?.groupName ?? "WhatsApp media";
  const payload = JSON.stringify({ items, mediaToken: mediaToken || "" }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(groupName)} - Media gallery</title>
  <style>
    :root { color-scheme: light; --bg:#f5f6f4; --panel:#fff; --ink:#18211d; --muted:#65706a; --line:#d9dedb; --accent:#087f5b; --video:#b54735; --shadow:0 12px 40px rgba(24,33,29,.18); }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:0; }
    header { position:sticky; top:0; z-index:5; background:rgba(245,246,244,.96); border-bottom:1px solid var(--line); backdrop-filter:blur(12px); }
    .header-inner, main { width:min(1180px,100%); margin:auto; padding:16px; }
    .header-inner { display:flex; align-items:end; justify-content:space-between; gap:16px; }
    h1 { margin:0 0 4px; font-size:clamp(20px,4vw,30px); font-weight:700; overflow-wrap:anywhere; }
    .count { margin:0; color:var(--muted); font-size:14px; }
    .filters { display:flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; flex:none; }
    .filters button { min-height:38px; padding:0 13px; border:0; border-right:1px solid var(--line); background:var(--panel); color:var(--ink); font:inherit; cursor:pointer; }
    .filters button:last-child { border-right:0; }
    .filters button[aria-pressed="true"] { background:var(--ink); color:#fff; }
    main { padding-top:20px; padding-bottom:48px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
    .tile { position:relative; aspect-ratio:1; min-width:0; border:1px solid var(--line); border-radius:6px; overflow:hidden; background:#e8ece9; cursor:pointer; padding:0; color:inherit; text-align:left; }
    .tile img, .tile video { width:100%; height:100%; object-fit:cover; display:block; background:#dfe4e1; }
    .tile video { pointer-events:none; }
    .tile:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
    .meta { position:absolute; left:0; right:0; bottom:0; display:flex; justify-content:space-between; align-items:end; gap:8px; padding:8px 9px; color:#fff; background:rgba(0,0,0,.72); font-size:12px; }
    .kind { padding:3px 6px; border-radius:4px; background:var(--accent); font-weight:700; text-transform:uppercase; }
    .kind.video { background:var(--video); }
    .empty { color:var(--muted); padding:48px 0; text-align:center; }
    dialog { width:100vw; height:100dvh; max-width:none; max-height:none; margin:0; padding:0; border:0; background:#0c0e0d; color:#fff; }
    dialog::backdrop { background:#0c0e0d; }
    .viewer { height:100%; display:grid; grid-template-rows:auto minmax(0,1fr) auto; }
    .viewer-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:56px; padding:8px 14px; border-bottom:1px solid #303532; }
    .viewer-title { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:14px; }
    .close { border:1px solid #59615d; background:#202522; color:#fff; border-radius:6px; min-height:38px; padding:0 14px; font:inherit; cursor:pointer; }
    .stage { min-height:0; display:grid; place-items:center; overflow:hidden; }
    .stage img, .stage video { display:block; max-width:100%; max-height:100%; object-fit:contain; }
    .stage video { width:100%; height:100%; }
    .caption { max-height:24vh; overflow:auto; margin:0; padding:12px 16px calc(12px + env(safe-area-inset-bottom)); color:#d8ddda; border-top:1px solid #303532; font-size:14px; white-space:pre-wrap; }
    @media (max-width:640px) { .header-inner { align-items:stretch; flex-direction:column; } .filters { width:100%; } .filters button { flex:1; padding:0 8px; } .grid { grid-template-columns:repeat(3,minmax(0,1fr)); gap:3px; } .tile { border-radius:2px; } .meta { padding:22px 5px 5px; } .meta time { display:none; } }
    @media (prefers-color-scheme:dark) { :root { color-scheme:dark; --bg:#121614; --panel:#1b211e; --ink:#eef2ef; --muted:#a5aea9; --line:#39413d; } header { background:rgba(18,22,20,.96); } .tile { background:#252c28; } }
  </style>
</head>
<body>
  <header><div class="header-inner"><div><h1>${escapeHtml(groupName)}</h1><p class="count" id="count"></p></div><div class="filters" aria-label="Media type"><button data-filter="all" aria-pressed="true">All</button><button data-filter="image" aria-pressed="false">Photos</button><button data-filter="video" aria-pressed="false">Videos</button></div></div></header>
  <main><div class="grid" id="grid"></div><p class="empty" id="empty" hidden>No media in this view.</p></main>
  <dialog id="viewer"><div class="viewer"><div class="viewer-bar"><div class="viewer-title" id="viewer-title"></div><button class="close" id="close" type="button">Close</button></div><div class="stage" id="stage"></div><p class="caption" id="caption"></p></div></dialog>
  <script type="application/json" id="gallery-data">${payload}</script>
  <script>
    const data = JSON.parse(document.getElementById('gallery-data').textContent);
    const grid = document.getElementById('grid');
    const empty = document.getElementById('empty');
    const count = document.getElementById('count');
    const viewer = document.getElementById('viewer');
    const stage = document.getElementById('stage');
    const caption = document.getElementById('caption');
    const viewerTitle = document.getElementById('viewer-title');
    const tokenSuffix = data.mediaToken ? '?token=' + encodeURIComponent(data.mediaToken) : '';
    const mediaUrl = item => '/media/' + encodeURIComponent(item.groupId) + '/' + encodeURIComponent(item.id) + tokenSuffix;
    const visualType = item => item.type === 'image' || item.type === 'sticker' ? 'image' : item.type;
    const formatTime = value => new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(new Date(value));
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const media = entry.target.querySelector('[data-src]');
      if (media) {
        if (media.tagName === 'VIDEO') {
          media.addEventListener('loadedmetadata', () => {
            if (Number.isFinite(media.duration) && media.duration > 0) media.currentTime = Math.min(0.1, media.duration / 2);
          }, { once:true });
        }
        media.src = media.dataset.src;
        media.removeAttribute('data-src');
      }
      observer.unobserve(entry.target);
    }), { rootMargin:'240px' });

    function openItem(item) {
      stage.replaceChildren();
      const kind = visualType(item);
      const media = document.createElement(kind === 'video' ? 'video' : 'img');
      media.src = mediaUrl(item);
      if (kind === 'video') { media.controls = true; media.autoplay = true; media.playsInline = true; }
      media.alt = item.text || kind;
      stage.append(media);
      viewerTitle.textContent = formatTime(item.timestamp);
      caption.textContent = item.text || '';
      viewer.showModal();
    }

    function render(filter) {
      grid.replaceChildren();
      const items = data.items.filter(item => filter === 'all' || visualType(item) === filter);
      count.textContent = items.length + (items.length === 1 ? ' item' : ' items') + ' - streamed on demand';
      empty.hidden = items.length !== 0;
      for (const item of items) {
        const kind = visualType(item);
        const tile = document.createElement('button');
        tile.className = 'tile'; tile.type = 'button'; tile.setAttribute('aria-label', 'Open ' + kind + ' from ' + formatTime(item.timestamp));
        const media = document.createElement(kind === 'video' ? 'video' : 'img');
        media.dataset.src = mediaUrl(item); media.alt = item.text || kind;
        if (kind === 'video') { media.muted = true; media.playsInline = true; media.preload = 'metadata'; }
        const meta = document.createElement('span'); meta.className = 'meta';
        const badge = document.createElement('span'); badge.className = 'kind ' + kind; badge.textContent = kind;
        const time = document.createElement('time'); time.textContent = formatTime(item.timestamp);
        meta.append(badge, time); tile.append(media, meta); tile.addEventListener('click', () => openItem(item));
        grid.append(tile); observer.observe(tile);
      }
    }

    document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll('[data-filter]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      render(button.dataset.filter);
    }));
    document.getElementById('close').addEventListener('click', () => viewer.close());
    viewer.addEventListener('close', () => { stage.querySelector('video')?.pause(); stage.replaceChildren(); });
    render('all');
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] || character);
}
