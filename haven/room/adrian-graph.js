const visibleLimit = 256;
const ink = { wiki: '#af725a', tag: '#638779', mixed: '#ae8643' };
const byFrequency = (a, b) => b.buckets.length - a.buckets.length || a.label.localeCompare(b.label, 'zh');

// Place only the visible stars. Attraction follows Ombre's co-occurrence edges.
function placeStars(nodes, edges, width, height, focusId) {
  const points = nodes.map((node, index) => {
    const radius = Math.sqrt(index / Math.max(1, nodes.length - 1)) * 0.42;
    const angle = index * 2.39996;
    return { node, x: width * (0.5 + Math.cos(angle) * radius),
      y: height * (0.5 + Math.sin(angle) * radius), dx: 0, dy: 0 };
  });
  const byId = new Map(points.map(point => [point.node.id, point]));
  const links = edges.map(edge => ({
    a: byId.get(edge.source), b: byId.get(edge.target),
    strength: 1 + Math.min(2, Math.log2(edge.weight || 1))
  }));
  const spacing = Math.min(88, Math.sqrt(width * height / Math.max(1, nodes.length)) * 0.76);
  for (let pass = 0; pass < 54; pass++) {
    for (const point of points) {
      point.dx = (width / 2 - point.x) * 0.72;
      point.dy = (height / 2 - point.y) * 0.72;
    }
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      for (let j = i + 1; j < points.length; j++) {
        const b = points[j];
        const x = a.x - b.x;
        const y = a.y - b.y;
        const squared = Math.max(4, x * x + y * y);
        const push = spacing * spacing * 0.36 / squared;
        a.dx += x * push;
        a.dy += y * push;
        b.dx -= x * push;
        b.dy -= y * push;
      }
    }
    for (const { a, b, strength } of links) {
      const x = b.x - a.x;
      const y = b.y - a.y;
      const pull = Math.sqrt(x * x + y * y) / spacing * 0.20 * strength;
      a.dx += x * pull;
      a.dy += y * pull;
      b.dx -= x * pull;
      b.dy -= y * pull;
    }
    const step = 7 * (1 - pass / 54) + 0.4;
    for (const p of points) {
      if (p.node.id === focusId) continue;
      const scale = Math.min(0.27, step / Math.max(1, Math.hypot(p.dx, p.dy)));
      p.x += p.dx * scale;
      p.y += p.dy * scale;
    }
  }
  // Fit the finished constellation as one shape. Clamping individual points
  // during repulsion would pin weakly connected stars to the four borders.
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  const cx = focusId ? width / 2 : (left + right) / 2;
  const cy = focusId ? height / 2 : (top + bottom) / 2;
  const zoom = Math.min(1.6, (width / 2 - 19) / Math.max(1, cx - left, right - cx),
    (height / 2 - 25) / Math.max(1, cy - top, bottom - cy));
  for (const p of points) {
    p.x = width / 2 + (p.x - cx) * zoom;
    p.y = height / 2 + (p.y - cy) * zoom;
  }
  return { points, links };
}

export function createMemoryGraph({ onSelect }) {
  const canvas = document.querySelector('#links');
  const context = canvas.getContext('2d');
  const picker = document.querySelector('#concept');
  const depth = document.querySelector('#graph-depth');
  const back = document.querySelector('#graph-overview');
  const heading = document.querySelector('#concept-heading');
  const count = document.querySelector('#graph-count');
  const atlas = document.querySelector('#graph-atlas');
  const empty = document.querySelector('#graph-empty');
  let nodes = [];
  let edges = [];
  let byId = new Map();
  let adjacent = new Map();
  let focusId = '';
  let graphNodes = [];
  let graphEdges = [];
  let plotted = [];
  let layout;

  function redraw() {
    plotted = [];
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!context || !width || !height || !graphNodes.length) return;
    const scale = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    if (!layout || layout.width !== width || layout.height !== height) {
      layout = { ...placeStars(graphNodes, graphEdges, width, height, focusId), width, height };
    }
    const { points, links } = layout;
    plotted = points;

    const dense = points.length > 80;
    const crowdedLinks = links.length > points.length * 4;
    for (const { a, b, strength } of links) {
      const focused = focusId && (a.node.id === focusId || b.node.id === focusId);
      context.lineWidth = (dense ? 0.5 : 0.7) + (strength - 1) * 0.3;
      context.strokeStyle = focused ? '#7f74587d' : crowdedLinks ? '#9b907b18' : '#9b907b40';
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }
    for (const { node, x, y } of points) {
      const radius = (dense ? 1.7 : 3.2) + Math.min(4.5, Math.sqrt(node.buckets.length) * 0.65);
      context.fillStyle = ink[node.kind] || '#857662';
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      if (node.anchor || node.id === focusId) {
        context.strokeStyle = node.id === focusId ? '#665434' : '#bea164be';
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(x, y, radius + 3, 0, Math.PI * 2);
        context.stroke();
      }
    }
    const labelRects = [];
    for (const { node, x, y } of points) {
      if (labelRects.length >= (focusId ? 4 : 6)) break;
      const label = node.label.length > 13 ? node.label.slice(0, 12) + '…' : node.label;
      context.font = node.id === focusId ? '600 13px serif' : '12px serif';
      const half = context.measureText(label).width / 2 + 3;
      const cx = Math.max(half + 2, Math.min(width - half - 2, x));
      const cy = y < height - 26 ? y + 17 : y - 15;
      const rect = { left: cx - half, right: cx + half, top: cy - 8, bottom: cy + 8 };
      if (labelRects.some(r => r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top)) continue;
      labelRects.push(rect);
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.lineWidth = 3;
      context.strokeStyle = '#faf5e9';
      context.fillStyle = '#534836';
      context.strokeText(label, cx, cy);
      context.fillText(label, cx, cy);
    }
  }

  function render() {
    const focused = byId.get(focusId);
    let scope = nodes;
    if (focused) {
      const reached = new Set([focusId]);
      scope = [focused];
      let layer = [focusId];
      for (let hop = 0; hop < Number(depth.value) && layer.length; hop++) {
        const next = new Set();
        for (const id of layer) {
          for (const neighbor of adjacent.get(id)) {
            if (!reached.has(neighbor)) next.add(neighbor);
          }
        }
        layer = [...next];
        for (const id of layer) reached.add(id);
        scope.push(...layer.map(id => byId.get(id)).sort(byFrequency));
      }
    }
    graphNodes = scope.slice(0, visibleLimit);
    const visible = new Set(graphNodes.map(n => n.id));
    graphEdges = edges.filter(edge => visible.has(edge.source) && visible.has(edge.target));
    layout = null;
    picker.value = focusId;
    back.hidden = !focused;
    depth.disabled = !focused;
    heading.hidden = !focused;
    heading.textContent = focused ? focused.label + ' · 关联记忆' : '';
    count.textContent = graphNodes.length === scope.length
      ? '共 ' + scope.length + ' 个概念'
      : '显示 ' + graphNodes.length + ' / ' + scope.length + ' 个概念';
    redraw();
  }

  function focus(id) {
    focusId = byId.has(id) ? id : '';
    render();
    onSelect(byId.get(focusId) || null);
  }

  function clear() {
    nodes = [];
    edges = [];
    byId.clear();
    adjacent.clear();
    focusId = '';
    graphNodes = [];
    graphEdges = [];
    plotted = [];
    layout = null;
    picker.replaceChildren();
    heading.textContent = count.textContent = canvas.title = '';
    atlas.hidden = empty.hidden = true;
    canvas.width = canvas.width;
  }

  function setData(data) {
    clear();
    nodes = [...data.nodes].sort(byFrequency);
    if (!nodes.length) {
      empty.hidden = false;
      onSelect(null);
      return;
    }
    edges = data.edges;
    byId = new Map(nodes.map(n => [n.id, n]));
    adjacent = new Map(nodes.map(n => [n.id, new Set()]));
    for (const edge of edges) {
      adjacent.get(edge.source)?.add(edge.target);
      adjacent.get(edge.target)?.add(edge.source);
    }
    picker.add(new Option('全部概念', ''));
    for (const node of nodes) picker.add(new Option(node.label, node.id));
    depth.value = '1';
    atlas.hidden = false;
    focus('');
  }

  function nearest(event) {
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    let best;
    let distance = 22;
    for (const point of plotted) {
      const delta = Math.hypot(point.x - x, point.y - y);
      if (delta < distance) { best = point.node; distance = delta; }
    }
    return best;
  }
  canvas.addEventListener('click', event => {
    const node = nearest(event);
    if (node) focus(node.id === focusId ? '' : node.id);
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    const node = nearest(event);
    canvas.title = node?.label || '';
    canvas.style.cursor = node ? 'pointer' : '';
  });
  picker.addEventListener('change', () => focus(picker.value));
  depth.addEventListener('change', render);
  back.addEventListener('click', () => { focus(''); picker.focus(); });
  new ResizeObserver(redraw).observe(canvas);
  return { setData, redraw, clear };
}
