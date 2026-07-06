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
    .controls { display:flex; flex-wrap:wrap; justify-content:end; gap:8px; }
    .filters { display:flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; flex:none; }
    .filters button, select { min-height:38px; padding:0 12px; border:0; border-right:1px solid var(--line); background:var(--panel); color:var(--ink); font:inherit; cursor:pointer; }
    .filters button:last-child { border-right:0; }
    .filters button[aria-pressed="true"] { background:var(--ink); color:#fff; }
    select { border:1px solid var(--line); border-radius:6px; }
    main { padding-top:20px; padding-bottom:48px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
    .tile { position:relative; aspect-ratio:1; min-width:0; border:1px solid var(--line); border-radius:6px; overflow:hidden; background:#e8ece9; cursor:pointer; padding:0; color:inherit; text-align:left; }
    .tile img, .tile video { width:100%; height:100%; object-fit:cover; display:block; background:#dfe4e1; }
    .tile video { pointer-events:none; }
    .tile:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
    .meta { position:absolute; left:0; right:0; bottom:0; display:flex; justify-content:space-between; align-items:end; gap:8px; padding:8px 9px; color:#fff; background:rgba(0,0,0,.72); font-size:12px; }
    .kind { padding:3px 6px; border-radius:4px; background:var(--accent); font-weight:700; text-transform:uppercase; }
    .kind.video { background:var(--video); }
    .analysis-badges { position:absolute; left:6px; right:6px; top:6px; display:flex; flex-wrap:wrap; gap:4px; z-index:1; }
    .analysis-badges span { max-width:100%; padding:3px 5px; border-radius:4px; background:rgba(8,127,91,.9); color:#fff; font-size:11px; font-weight:700; line-height:1.1; overflow:hidden; text-overflow:ellipsis; }
    .analysis-badges .warn { background:rgba(181,71,53,.94); }
    .analysis-badges .muted { background:rgba(38,46,42,.88); }
    .document-preview { width:100%; height:100%; display:grid; place-items:center; background:#e9eeeb; color:#34413a; font-size:clamp(16px,4vw,28px); font-weight:800; }
    .empty { color:var(--muted); padding:48px 0; text-align:center; }
    dialog { width:100vw; height:100dvh; max-width:none; max-height:none; margin:0; padding:0; border:0; background:#0c0e0d; color:#fff; }
    dialog::backdrop { background:#0c0e0d; }
    .viewer { height:100%; display:grid; grid-template-rows:auto minmax(0,1fr) auto; }
    .viewer-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:56px; padding:8px 14px; border-bottom:1px solid #303532; }
    .viewer-actions { display:flex; gap:8px; }
    .viewer-title { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:14px; }
    .close, .nav { border:1px solid #59615d; background:#202522; color:#fff; border-radius:6px; min-height:38px; padding:0 14px; font:inherit; cursor:pointer; }
    .nav:disabled { opacity:.38; cursor:default; }
    .stage { min-height:0; display:grid; place-items:center; overflow:hidden; }
    .stage img, .stage video, .stage iframe { display:block; width:100%; height:100%; min-width:0; min-height:0; border:0; object-fit:contain; }
    .caption { max-height:34vh; overflow:auto; margin:0; padding:10px 16px calc(12px + env(safe-area-inset-bottom)); color:#d8ddda; border-top:1px solid #303532; font-size:14px; white-space:pre-wrap; }
    .preview-tabs { display:flex; flex-wrap:wrap; gap:6px; padding:8px 14px; border-bottom:1px solid #303532; }
    .preview-tabs button { min-height:32px; border:1px solid #59615d; background:#202522; color:#fff; border-radius:6px; padding:0 10px; font:inherit; cursor:pointer; font-size:13px; }
    .preview-tabs button[aria-pressed="true"] { background:#eef2ef; color:#111; }
    details.analysis { border-top:1px solid #303532; padding:8px 16px; background:#121614; }
    details.analysis summary { cursor:pointer; font-weight:700; }
    .analysis-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px 14px; margin-top:10px; color:#d8ddda; font-size:13px; }
    .analysis-grid b { display:block; color:#fff; font-size:12px; text-transform:uppercase; }
    .swatches { display:flex; gap:5px; align-items:center; flex-wrap:wrap; }
    .swatch { width:22px; height:22px; border-radius:4px; border:1px solid rgba(255,255,255,.35); }
    @media (max-width:640px) { .header-inner { align-items:stretch; flex-direction:column; } .controls { justify-content:stretch; } .filters { width:100%; overflow:auto; } .filters button { flex:1; padding:0 8px; } select { width:100%; } .grid { grid-template-columns:repeat(3,minmax(0,1fr)); gap:3px; } .tile { border-radius:2px; } .meta { padding:22px 5px 5px; } .meta time { display:none; } .analysis-badges { left:3px; right:3px; top:3px; } .analysis-badges span { font-size:9px; padding:2px 3px; } }
    @media (prefers-color-scheme:dark) { :root { color-scheme:dark; --bg:#121614; --panel:#1b211e; --ink:#eef2ef; --muted:#a5aea9; --line:#39413d; } header { background:rgba(18,22,20,.96); } .tile { background:#252c28; } }
  </style>
</head>
<body>
  <header><div class="header-inner"><div><h1>${escapeHtml(groupName)}</h1><p class="count" id="count"></p></div><div class="controls"><div class="filters" aria-label="Gallery filters"><button data-filter="all" aria-pressed="true">All</button><button data-filter="image" aria-pressed="false">Photos</button><button data-filter="video" aria-pressed="false">Videos</button><button data-filter="document" aria-pressed="false">PDFs</button><button data-filter="blurry" aria-pressed="false">Blurry</button><button data-filter="dark" aria-pressed="false">Dark</button><button data-filter="screenshot" aria-pressed="false">Screenshots</button><button data-filter="duplicate" aria-pressed="false">Duplicates</button><button data-filter="highres" aria-pressed="false">High-res</button><button data-filter="compressed" aria-pressed="false">Compressed</button></div><select id="sort"><option value="time">Sort by time</option><option value="blur">Blur score</option><option value="brightness">Brightness</option><option value="resolution">Resolution</option><option value="filesize">File size</option><option value="similarity">Similarity</option></select></div></div></header>
  <main><div class="grid" id="grid"></div><p class="empty" id="empty" hidden>No media in this view.</p></main>
  <dialog id="viewer"><div class="viewer"><div class="viewer-bar"><div class="viewer-title" id="viewer-title"></div><div class="viewer-actions"><button class="nav" id="prev" type="button" aria-label="Previous media">Prev</button><button class="nav" id="next" type="button" aria-label="Next media">Next</button><button class="close" id="close" type="button">Close</button></div></div><div><div class="preview-tabs" id="preview-tabs"></div><div class="stage" id="stage"></div></div><div><details class="analysis" id="analysis-panel"><summary>Image analysis</summary><div class="analysis-grid" id="analysis-grid"></div></details><p class="caption" id="caption"></p></div></div></dialog>
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
    const analysisGrid = document.getElementById('analysis-grid');
    const analysisPanel = document.getElementById('analysis-panel');
    const previewTabs = document.getElementById('preview-tabs');
    const sortSelect = document.getElementById('sort');
    const prev = document.getElementById('prev');
    const next = document.getElementById('next');
    let visibleItems = [];
    let currentIndex = -1;
    const tokenSuffix = data.mediaToken ? '?token=' + encodeURIComponent(data.mediaToken) : '';
    const mediaUrl = item => '/media/' + encodeURIComponent(item.groupId) + '/' + encodeURIComponent(item.id) + tokenSuffix;
    const previewUrl = (item, kind) => '/api/image-analysis/' + encodeURIComponent(item.groupId) + '/' + encodeURIComponent(item.id) + '/preview/' + encodeURIComponent(kind) + tokenSuffix;
    const visualType = item => item.type === 'image' || item.type === 'sticker' ? 'image' : item.type;
    const formatTime = value => new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(new Date(value));
    const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    const fmt = (value, digits = 1) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'Pending';
    const isDuplicate = item => Boolean(item.analysis?.exact_duplicate_of || item.analysis?.similar_matches?.some(match => match.duplicate));
    const isHighRes = item => number(item.analysis?.width) * number(item.analysis?.height) >= 3000000;
    const filterMatches = (item, filter) => {
      const kind = visualType(item);
      const a = item.analysis || {};
      if (filter === 'all') return true;
      if (['image', 'video', 'document'].includes(filter)) return kind === filter;
      if (filter === 'blurry') return a.blur_label === 'blurry' || a.blur_label === 'slightly blurry';
      if (filter === 'dark') return a.brightness_label === 'dark' || a.brightness_label === 'very dark';
      if (filter === 'screenshot') return Boolean(a.is_screenshot);
      if (filter === 'duplicate') return isDuplicate(item);
      if (filter === 'highres') return isHighRes(item);
      if (filter === 'compressed') return a.compression_label === 'heavily compressed';
      return true;
    };
    const sortItems = items => {
      const sorted = [...items];
      const mode = sortSelect.value;
      const resolution = item => number(item.analysis?.width) * number(item.analysis?.height);
      const similarity = item => item.analysis?.similar_matches?.[0]?.distance ?? 999;
      if (mode === 'blur') sorted.sort((a,b) => number(a.analysis?.blur_score) - number(b.analysis?.blur_score));
      else if (mode === 'brightness') sorted.sort((a,b) => number(a.analysis?.brightness_mean) - number(b.analysis?.brightness_mean));
      else if (mode === 'resolution') sorted.sort((a,b) => resolution(b) - resolution(a));
      else if (mode === 'filesize') sorted.sort((a,b) => number(b.analysis?.file_size_bytes || b.fileLength) - number(a.analysis?.file_size_bytes || a.fileLength));
      else if (mode === 'similarity') sorted.sort((a,b) => similarity(a) - similarity(b));
      return sorted;
    };
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

    function showItem(index, previewKind = 'original') {
      if (index < 0 || index >= visibleItems.length) return;
      currentIndex = index;
      const item = visibleItems[index];
      stage.replaceChildren();
      const kind = visualType(item);
      const media = document.createElement(kind === 'video' ? 'video' : kind === 'document' ? 'iframe' : 'img');
      media.src = previewKind === 'original' ? mediaUrl(item) : previewUrl(item, previewKind);
      if (kind === 'video') { media.controls = true; media.autoplay = true; media.playsInline = true; }
      if (kind === 'document') media.title = item.fileName || item.text || 'PDF document';
      else media.alt = previewKind === 'original' ? (item.text || kind) : previewKind + ' preview';
      stage.append(media);
      viewerTitle.textContent = (item.fileName ? item.fileName + ' - ' : '') + formatTime(item.timestamp) + ' (' + (index + 1) + '/' + visibleItems.length + ')';
      caption.textContent = item.text || '';
      renderPreviewTabs(item, previewKind);
      renderAnalysis(item);
      prev.disabled = index === 0;
      next.disabled = index === visibleItems.length - 1;
    }

    function openItem(index) {
      showItem(index);
      if (!viewer.open) viewer.showModal();
    }

    function render(filter) {
      grid.replaceChildren();
      visibleItems = sortItems(data.items.filter(item => filterMatches(item, filter)));
      const pending = visibleItems.filter(item => (item.type === 'image' || item.type === 'sticker') && !item.analysis).length;
      count.textContent = visibleItems.length + (visibleItems.length === 1 ? ' item' : ' items') + (pending ? ' - ' + pending + ' queued for analysis' : ' - streamed on demand');
      empty.hidden = visibleItems.length !== 0;
      visibleItems.forEach((item, index) => {
        const kind = visualType(item);
        const tile = document.createElement('button');
        tile.className = 'tile'; tile.type = 'button'; tile.setAttribute('aria-label', 'Open ' + kind + ' from ' + formatTime(item.timestamp));
        const media = kind === 'document' ? document.createElement('span') : document.createElement(kind === 'video' ? 'video' : 'img');
        if (kind === 'document') { media.className = 'document-preview'; media.textContent = 'PDF'; }
        else { media.dataset.src = mediaUrl(item); media.alt = item.text || kind; }
        if (kind === 'video') { media.muted = true; media.playsInline = true; media.preload = 'metadata'; }
        const badges = analysisBadges(item);
        const meta = document.createElement('span'); meta.className = 'meta';
        const badge = document.createElement('span'); badge.className = 'kind ' + kind; badge.textContent = kind;
        const time = document.createElement('time'); time.textContent = formatTime(item.timestamp);
        meta.append(badge, time); tile.append(media, badges, meta); tile.addEventListener('click', () => openItem(index));
        grid.append(tile); if (kind !== 'document') observer.observe(tile);
      });
    }

    function analysisBadges(item) {
      const wrap = document.createElement('span'); wrap.className = 'analysis-badges';
      const a = item.analysis;
      if (!a) {
        if (item.type === 'image' || item.type === 'sticker') addBadge(wrap, 'Queued', 'muted');
        return wrap;
      }
      if (a.status && a.status !== 'success') {
        addBadge(wrap, a.status === 'error' ? 'Analysis error' : 'Analysing', a.status === 'error' ? 'warn' : 'muted');
        return wrap;
      }
      addBadge(wrap, a.blur_label === 'sharp' ? 'Sharp' : 'Blurry', a.blur_label === 'sharp' ? '' : 'warn');
      addBadge(wrap, ['dark','very dark'].includes(a.brightness_label) ? 'Dark' : ['bright','overexposed'].includes(a.brightness_label) ? 'Bright' : 'Normal', ['dark','very dark','overexposed'].includes(a.brightness_label) ? 'warn' : '');
      if (isDuplicate(item)) addBadge(wrap, 'Duplicate', 'warn');
      if (a.compression_label === 'heavily compressed') addBadge(wrap, 'Compressed', 'warn');
      return wrap;
    }

    function addBadge(parent, text, className) {
      const badge = document.createElement('span');
      badge.textContent = text;
      if (className) badge.className = className;
      parent.append(badge);
    }

    function renderPreviewTabs(item, active) {
      previewTabs.replaceChildren();
      const tabs = ['original'];
      if (item.analysis) tabs.push('grayscale', 'edges', 'fourier', 'histogram');
      for (const tab of tabs) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = tab[0].toUpperCase() + tab.slice(1);
        button.setAttribute('aria-pressed', String(tab === active));
        button.addEventListener('click', () => showItem(currentIndex, tab));
        previewTabs.append(button);
      }
    }

    function renderAnalysis(item) {
      analysisGrid.replaceChildren();
      const a = item.analysis;
      analysisPanel.hidden = !a || (a.status && a.status !== 'success');
      if (!a) return;
      if (a.status && a.status !== 'success') return;
      addMetric('Dimensions', (a.width || '?') + ' x ' + (a.height || '?'));
      addMetric('File size', Math.round(number(a.file_size_bytes || item.fileLength) / 1024) + ' KB');
      addMetric('Brightness', fmt(a.brightness_mean) + ' - ' + (a.brightness_label || 'pending'));
      addMetric('Contrast', fmt(a.contrast_stddev) + ' - ' + (a.contrast_label || 'pending'));
      addMetric('Blur score', fmt(a.blur_score) + ' - ' + (a.blur_label || 'pending'));
      addMetric('Edge density', fmt(number(a.edge_density) * 100, 2) + '%');
      addMetric('Noise estimate', fmt(a.noise_score, 2) + ' approximate');
      addMetric('Compression', fmt(a.blockiness_score, 2) + ' - ' + (a.compression_label || 'normal'));
      addMetric('Frequency energy', 'Low/smooth ' + fmt(number(a.low_frequency_energy) * 100, 1) + '%, medium/texture ' + fmt(number(a.medium_frequency_energy) * 100, 1) + '%, high/edges-noise ' + fmt(number(a.high_frequency_energy) * 100, 1) + '%');
      addMetric('Duplicates', duplicateText(a));
      const colors = document.createElement('span'); colors.className = 'swatches';
      (a.dominant_colors || []).forEach(color => {
        const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.style.background = 'rgb(' + color.rgb.join(',') + ')'; swatch.title = Math.round(color.percent * 100) + '%';
        colors.append(swatch);
      });
      addMetric('Dominant colours', colors);
    }

    function addMetric(label, value) {
      const cell = document.createElement('div');
      const title = document.createElement('b'); title.textContent = label;
      cell.append(title);
      if (typeof value === 'string') cell.append(document.createTextNode(value));
      else cell.append(value);
      analysisGrid.append(cell);
    }

    function duplicateText(a) {
      if (a.exact_duplicate_of) return 'Exact match: ' + a.exact_duplicate_of;
      if (a.similar_matches?.length) return a.similar_matches.map(match => match.group_id + '/' + match.media_id + ' (' + match.distance + ')').join(', ');
      return 'None detected';
    }

    document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll('[data-filter]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      render(button.dataset.filter);
    }));
    sortSelect.addEventListener('change', () => render(document.querySelector('[data-filter][aria-pressed="true"]').dataset.filter));
    document.getElementById('close').addEventListener('click', () => viewer.close());
    prev.addEventListener('click', () => showItem(currentIndex - 1));
    next.addEventListener('click', () => showItem(currentIndex + 1));
    document.addEventListener('keydown', event => {
      if (!viewer.open) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); showItem(currentIndex - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); showItem(currentIndex + 1); }
    });
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
