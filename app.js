(function () {
  'use strict';

  var canvas = document.getElementById('cv');
  var ctx = canvas.getContext('2d');
  var hintEl = document.getElementById('hint');
  var statusEl = document.getElementById('status');

  var seq = 0;
  function uid(prefix) { seq++; return prefix + seq; }
  function emptySketch() {
    return { points: [], segments: [], circles: [], constraints: [] };
  }
  var sketch = emptySketch();

  var view = { scale: 1, ox: 0, oy: 0 };
  function toWorld(sx, sy) {
    return { x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale };
  }
  function resizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  var undoStack = [];
  var redoStack = [];
  function clone(s) {
    return {
      points: s.points.map(function (p) { return { id: p.id, x: p.x, y: p.y }; }),
      segments: s.segments.map(function (g) { return { id: g.id, a: g.a, b: g.b }; }),
      circles: s.circles.map(function (c) { return { id: c.id, center: c.center, r: c.r }; }),
      constraints: s.constraints.map(function (c) { return Object.assign({}, c); })
    };
  }
  var opBase = null;
  function beginOperation() { if (opBase === null) opBase = clone(sketch); }
  function commitOperation() {
    if (opBase !== null) {
      undoStack.push(opBase);
      if (undoStack.length > 200) undoStack.shift();
      redoStack.length = 0;
      opBase = null;
    }
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(clone(sketch));
    sketch = undoStack.pop();
    selection = [];
    rerunAndRender();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(clone(sketch));
    sketch = redoStack.pop();
    selection = [];
    rerunAndRender();
  }

  var tool = 'select';
  var selection = [];
  var pending = null;
  var spaceDown = false;

  function setTool(t) {
    tool = t;
    document.querySelectorAll('#bar [data-tool]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tool === t);
    });
  }

  function getPoint(id) { return sketch.points.find(function (p) { return p.id === id; }); }
  function getCircle(id) { return sketch.circles.find(function (c) { return c.id === id; }); }
  function isFixed(pid) {
    return sketch.constraints.some(function (c) { return c.type === 'fix' && c.point === pid; });
  }

  var lastResult = { conflicts: [], converged: true, iterations: 0 };
  function rerun(anchors) {
    var sol = Solver.solve(sketch, anchors || [], { maxIter: 50 });
    lastResult = Solver.applySolution(sketch, sol, 2);
  }
  function rerunAndRender() { rerun(); render(); }

  function addPoint(x, y) {
    var p = { id: uid('P'), x: x, y: y };
    sketch.points.push(p);
    return p;
  }
  function hitTestPoint(wx, wy, screenTol) {
    var tol = screenTol / view.scale;
    var best = null, bestD = tol;
    sketch.points.forEach(function (p) {
      var d = Math.hypot(p.x - wx, p.y - wy);
      if (d < bestD) { bestD = d; best = p; }
    });
    return best;
  }
  function findOrCreatePointAt(w) {
    var hit = hitTestPoint(w.x, w.y, 10);
    return hit || addPoint(w.x, w.y);
  }
  function deleteSelection() {
    if (!selection.length) return;
    var sel = selection.slice();
    beginOperation();
    sel.forEach(function (s) {
      var id = s.id;
      if (s.kind === 'point') {
        sketch.points = sketch.points.filter(function (p) { return p.id !== id; });
        sketch.segments = sketch.segments.filter(function (g) { return g.a !== id && g.b !== id; });
        sketch.circles = sketch.circles.filter(function (c) { return c.center !== id; });
      } else if (s.kind === 'segment') {
        sketch.segments = sketch.segments.filter(function (g) { return g.id !== id; });
      } else if (s.kind === 'circle') {
        sketch.circles = sketch.circles.filter(function (c) { return c.id !== id; });
      }
    });
    sketch.constraints = sketch.constraints.filter(function (c) {
      return !sel.some(function (s) {
        if (s.kind === 'point') return c.a === s.id || c.b === s.id || c.point === s.id;
        if (s.kind === 'circle') return c.circle === s.id;
        return false;
      });
    });
    selection = [];
    commitOperation();
    rerunAndRender();
  }

  var CONSTRAINT_DEFS = {
    coincident: { need: 2, label: '重合：依次点 2 个点' },
    horizontal: { need: 2, label: '水平：依次点 2 个点' },
    vertical: { need: 2, label: '竖直：依次点 2 个点' },
    distance: { need: 2, label: '固定距离：依次点 2 个点，取当前间距' },
    tangent: { need: 2, label: '点圆相切：先点一个点，再点圆的边线' },
    fix: { need: 1, label: '锚定：点一个要固定在当前位置的点' }
  };
  var CONSTRAINT_NAMES = {
    coincident: '重合', horizontal: '水平', vertical: '竖直',
    distance: '固定距离', tangent: '点圆相切', fix: '锚定'
  };
  function startConstraint(kind) {
    pending = { kind: kind, picks: [] };
    setHint(CONSTRAINT_DEFS[kind].label + '（Esc 取消）');
    render();
  }
  function finishConstraint() {
    var k = pending.kind, picks = pending.picks;
    pending = null;
    beginOperation();
    var c = { id: uid('K'), type: k };
    if (k === 'coincident' || k === 'horizontal' || k === 'vertical') {
      c.a = picks[0]; c.b = picks[1];
    } else if (k === 'distance') {
      c.a = picks[0]; c.b = picks[1];
      var pa = getPoint(picks[0]), pb = getPoint(picks[1]);
      c.value = Math.max(5, Math.hypot(pa.x - pb.x, pa.y - pb.y));
    } else if (k === 'tangent') {
      c.point = picks[0]; c.circle = picks[1];
    } else if (k === 'fix') {
      var pp = getPoint(picks[0]);
      c.point = pp.id; c.x = pp.x; c.y = pp.y;
    }
    sketch.constraints.push(c);
    commitOperation();
    setHint('已添加约束。拖动点查看联动。');
    rerunAndRender();
  }

  function hitTestCircle(wx, wy) {
    var tol = 6 / view.scale;
    var best = null, bestD = tol;
    sketch.circles.forEach(function (c) {
      var cen = getPoint(c.center);
      var d = Math.abs(Math.hypot(wx - cen.x, wy - cen.y) - c.r);
      if (d < bestD) { bestD = d; best = c; }
    });
    return best;
  }
  function hitTestSegment(wx, wy) {
    var tol = 6 / view.scale;
    var best = null, bestD = tol;
    sketch.segments.forEach(function (g) {
      var a = getPoint(g.a), b = getPoint(g.b);
      var dx = b.x - a.x, dy = b.y - a.y;
      var len2 = dx * dx + dy * dy || 1e-6;
      var t = Math.max(0, Math.min(1, ((wx - a.x) * dx + (wy - a.y) * dy) / len2));
      var px = a.x + t * dx, py = a.y + t * dy;
      var d = Math.hypot(wx - px, wy - py);
      if (d < bestD) { bestD = d; best = g; }
    });
    return best;
  }

  var drag = null;
  function eventWorld(e) {
    var rect = canvas.getBoundingClientRect();
    return toWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture(e.pointerId);
    var w = eventWorld(e);

    if (tool === 'pan' || e.button === 1 || spaceDown) {
      drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy };
      return;
    }
    var p = hitTestPoint(w.x, w.y, 11);

    if (pending) {
      if (pending.kind === 'tangent' && pending.picks.length === 1) {
        var hitC0 = hitTestCircle(w.x, w.y);
        if (!hitC0) return setHint('第二步需要点在圆的边线上');
        pending.picks.push(hitC0.id);
        finishConstraint();
        return;
      }
      var def = CONSTRAINT_DEFS[pending.kind];
      if (!p) return setHint(def.label);
      if (pending.picks.indexOf(p.id) !== -1) return;
      pending.picks.push(p.id);
      if (pending.picks.length >= def.need) finishConstraint();
      else { setHint(def.label + '（已选 ' + pending.picks.length + '/' + def.need + '）'); render(); }
      return;
    }

    if (tool === 'point') {
      beginOperation();
      var np = addPoint(w.x, w.y);
      selection = [{ kind: 'point', id: np.id }];
      commitOperation();
      rerunAndRender();
      return;
    }
    if (tool === 'segment') {
      beginOperation();
      var a = findOrCreatePointAt(w);
      var b = addPoint(w.x + 1, w.y + 1);
      sketch.segments.push({ id: uid('S'), a: a.id, b: b.id });
      drag = { type: 'segment', id: b.id };
      rerunAndRender();
      return;
    }
    if (tool === 'circle') {
      beginOperation();
      var cen = findOrCreatePointAt(w);
      var cir = { id: uid('C'), center: cen.id, r: 40 };
      sketch.circles.push(cir);
      drag = { type: 'circle', id: cir.id };
      rerunAndRender();
      return;
    }

    if (tool === 'select' && p) {
      if (!e.shiftKey) selection = [];
      if (!selection.some(function (s) { return s.kind === 'point' && s.id === p.id; })) {
        selection.push({ kind: 'point', id: p.id });
      }
      beginOperation();
      drag = { type: 'point', id: p.id };
      return;
    }
    var hitC = hitTestCircle(w.x, w.y);
    if (tool === 'select' && hitC) {
      selection = [{ kind: 'circle', id: hitC.id }];
      render();
      return;
    }
    var hitS = hitTestSegment(w.x, w.y);
    if (tool === 'select' && hitS) {
      selection = [{ kind: 'segment', id: hitS.id }];
      render();
      return;
    }
    if (!e.shiftKey) selection = [];
    render();
  });

  canvas.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var w = eventWorld(e);
    if (drag.type === 'pan') {
      view.ox = drag.ox + (e.clientX - drag.sx);
      view.oy = drag.oy + (e.clientY - drag.sy);
      render();
    } else if (drag.type === 'point') {
      rerun([{ id: drag.id, x: w.x, y: w.y, weight: 0.35 }]);
      render();
    } else if (drag.type === 'segment') {
      var bp = getPoint(drag.id);
      bp.x = w.x; bp.y = w.y;
      rerun();
      render();
    } else if (drag.type === 'circle') {
      var cc = getCircle(drag.id);
      var cen = getPoint(cc.center);
      cc.r = Math.max(5, Math.hypot(w.x - cen.x, w.y - cen.y));
      rerun();
      render();
    }
  });

  canvas.addEventListener('pointerup', function () {
    if (!drag) return;
    if (drag.type === 'segment' || drag.type === 'circle' || drag.type === 'point') {
      commitOperation();
      rerunAndRender();
    }
    drag = null;
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var before = toWorld(mx, my);
    var factor = Math.exp(-e.deltaY * 0.0015);
    view.scale = Math.max(0.05, Math.min(40, view.scale * factor));
    view.ox = mx - before.x * view.scale;
    view.oy = my - before.y * view.scale;
    render();
  }, { passive: false });

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && !spaceDown) { spaceDown = true; canvas.style.cursor = 'grab'; }
    if (e.key === 'Escape') { pending = null; setHint('已取消约束创建。'); render(); }
    var mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (!pending) deleteSelection(); }
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') { spaceDown = false; canvas.style.cursor = ''; }
  });

  function setHint(t) { hintEl.textContent = t; }

  function constraintGeometry(c) {
    if (c.type === 'coincident' || c.type === 'horizontal' || c.type === 'vertical' || c.type === 'distance') {
      return { a: getPoint(c.a), b: getPoint(c.b) };
    }
    if (c.type === 'tangent') {
      return { a: getPoint(c.point), b: getPoint(getCircle(c.circle).center) };
    }
    if (c.type === 'fix') return { a: getPoint(c.point), b: null };
    return null;
  }

  function render() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    drawGrid(w, h);

    var conflicts = {};
    lastResult.conflicts.forEach(function (id) { conflicts[id] = true; });
    var pendingPicks = {};
    if (pending) pending.picks.forEach(function (id) { pendingPicks[id] = true; });

    ctx.lineWidth = 2;
    sketch.segments.forEach(function (g) {
      var a = getPoint(g.a), b = getPoint(g.b);
      var sel = selection.some(function (s) { return s.kind === 'segment' && s.id === g.id; });
      ctx.strokeStyle = sel ? '#6fb0ff' : '#9aa3b2';
      ctx.beginPath();
      ctx.moveTo(a.x * view.scale + view.ox, a.y * view.scale + view.oy);
      ctx.lineTo(b.x * view.scale + view.ox, b.y * view.scale + view.oy);
      ctx.stroke();
    });

    sketch.circles.forEach(function (c) {
      var cen = getPoint(c.center);
      var sel = selection.some(function (s) { return s.kind === 'circle' && s.id === c.id; });
      ctx.strokeStyle = sel ? '#6fb0ff' : '#9aa3b2';
      ctx.beginPath();
      ctx.arc(cen.x * view.scale + view.ox, cen.y * view.scale + view.oy, c.r * view.scale, 0, Math.PI * 2);
      ctx.stroke();
      drawCross(cen, '#6b7280');
    });

    sketch.constraints.forEach(function (c) {
      var geom = constraintGeometry(c);
      if (!geom || !geom.a) return;
      var bad = conflicts[c.id];
      drawConstraintTag(c, geom, bad);
    });

    sketch.points.forEach(function (p) {
      var sx = p.x * view.scale + view.ox, sy = p.y * view.scale + view.oy;
      var sel = selection.some(function (s) { return s.kind === 'point' && s.id === p.id; });
      var picked = pendingPicks[p.id];
      var fixed = isFixed(p.id);
      ctx.fillStyle = picked ? '#ffd866' : sel ? '#6fb0ff' : fixed ? '#b39ddb' : '#e8ebf0';
      ctx.strokeStyle = '#1e1f24';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, fixed ? 6 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    updateStatus();
    renderSidebar(conflicts);
  }

  function drawGrid(w, h) {
    var step = 50;
    while (step * view.scale < 18) step *= 2;
    while (step * view.scale > 120) step /= 2;
    var s = step * view.scale;
    var startX = ((view.ox % s) + s) % s;
    var startY = ((view.oy % s) + s) % s;
    ctx.strokeStyle = '#2b2d34';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = startX; x < w; x += s) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (var y = startY; y < h; y += s) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    var ox = view.ox, oy = view.oy;
    ctx.strokeStyle = '#4a4f5c';
    ctx.beginPath();
    ctx.moveTo(ox - 6, oy); ctx.lineTo(ox + 6, oy);
    ctx.moveTo(ox, oy - 6); ctx.lineTo(ox, oy + 6);
    ctx.stroke();
  }

  function drawCross(p, color) {
    var sx = p.x * view.scale + view.ox, sy = p.y * view.scale + view.oy;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx - 4, sy); ctx.lineTo(sx + 4, sy);
    ctx.moveTo(sx, sy - 4); ctx.lineTo(sx, sy + 4);
    ctx.stroke();
  }

  var TAG_GLYPH = {
    coincident: '\u25CE', horizontal: 'H', vertical: 'V',
    distance: 'd', tangent: 'T', fix: '\u2693'
  };

  function drawConstraintTag(c, geom, bad) {
    var color = bad ? '#ff5555' : '#4ec9b0';
    var sx, sy;
    var ax = geom.a.x * view.scale + view.ox, ay = geom.a.y * view.scale + view.oy;
    var bx = geom.b ? geom.b.x * view.scale + view.ox : null;
    var by = geom.b ? geom.b.y * view.scale + view.oy : null;
    sx = bx == null ? ax : (ax + bx) / 2;
    sy = by == null ? ay : (ay + by) / 2;

    if (c.type === 'horizontal') {
      ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.stroke();
    } else if (c.type === 'vertical') {
      ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.stroke();
    }

    var label = TAG_GLYPH[c.type] + (c.type === 'distance' ? '=' + Math.round(c.value) : '');
    ctx.font = 'bold 12px sans-serif';
    var tw = ctx.measureText(label).width;
    ctx.fillStyle = bad ? 'rgba(120,20,20,.92)' : 'rgba(20,60,55,.9)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    var padX = 5, padY = 3;
    var bx0 = sx - tw / 2 - padX, by0 = sy - 8 - padY;
    roundRect(bx0, by0, tw + padX * 2, 16 + padY * 2, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(label, sx - tw / 2, sy + 5);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function updateStatus() {
    var conflictN = lastResult.conflicts.length;
    var state;
    if (conflictN > 0) {
      state = '<span class="bad">冲突约束 ' + conflictN + ' 条（已标红）</span>';
    } else {
      state = '<span class="ok">约束全部满足</span>';
    }
    statusEl.innerHTML =
      state +
      '<span>点 ' + sketch.points.length + ' / 线段 ' + sketch.segments.length + ' / 圆 ' + sketch.circles.length + '</span>' +
      '<span>缩放 ' + view.scale.toFixed(2) + 'x</span>' +
      '<span>迭代 ' + lastResult.iterations + '</span>';
  }

  var entityListEl = document.getElementById('entityList');
  var constraintListEl = document.getElementById('constraintList');

  function constraintText(c) {
    var name = CONSTRAINT_NAMES[c.type];
    if (c.type === 'fix') return name + ' ' + c.point;
    if (c.type === 'tangent') return name + ' ' + c.point + '-' + c.circle;
    if (c.type === 'distance') return name + ' ' + c.a + '-' + c.b + ' =' + Math.round(c.value);
    return name + ' ' + c.a + '-' + c.b;
  }

  function renderSidebar(conflicts) {
    var rows = [];
    sketch.constraints.forEach(function (c) {
      var cls = 'crow' + (conflicts[c.id] ? ' conflict' : '');
      rows.push(
        '<div class="' + cls + '"><span>' + constraintText(c) + '</span>' +
        '<button data-del-k="' + c.id + '">删</button></div>'
      );
    });
    constraintListEl.innerHTML = rows.join('') || '<div style="color:#777">暂无约束</div>';

    var erows = [];
    sketch.points.forEach(function (p) {
      erows.push('<div class="crow"><span>' + p.id + ' (' + Math.round(p.x) + ', ' + Math.round(p.y) + ')' +
        (isFixed(p.id) ? ' \u2693' : '') + '</span></div>');
    });
    sketch.segments.forEach(function (g) {
      erows.push('<div class="crow"><span>' + g.id + ': ' + g.a + '-' + g.b + '</span>' +
        '<button data-del-e="segment:' + g.id + '">删</button></div>');
    });
    sketch.circles.forEach(function (c) {
      erows.push('<div class="crow"><span>' + c.id + ': 心' + c.center + ' r' + Math.round(c.r) + '</span>' +
        '<button data-del-e="circle:' + c.id + '">删</button></div>');
    });
    entityListEl.innerHTML = erows.join('') || '<div style="color:#777">暂无对象</div>';
  }

  constraintListEl.addEventListener('click', function (e) {
    var id = e.target && e.target.dataset && e.target.dataset.delK;
    if (!id) return;
    beginOperation();
    sketch.constraints = sketch.constraints.filter(function (c) { return c.id !== id; });
    commitOperation();
    rerunAndRender();
  });
  entityListEl.addEventListener('click', function (e) {
    var spec = e.target && e.target.dataset && e.target.dataset.delE;
    if (!spec) return;
    var parts = spec.split(':');
    selection = [{ kind: parts[0], id: parts[1] }];
    deleteSelection();
  });

  document.querySelectorAll('#bar [data-tool]').forEach(function (b) {
    b.addEventListener('click', function () { setTool(b.dataset.tool); pending = null; });
  });
  document.getElementById('btn-coincident').onclick = function () { startConstraint('coincident'); };
  document.getElementById('btn-distance').onclick = function () { startConstraint('distance'); };
  document.getElementById('btn-horizontal').onclick = function () { startConstraint('horizontal'); };
  document.getElementById('btn-vertical').onclick = function () { startConstraint('vertical'); };
  document.getElementById('btn-tangent').onclick = function () { startConstraint('tangent'); };
  document.getElementById('btn-fix').onclick = function () { startConstraint('fix'); };
  document.getElementById('btn-undo').onclick = undo;
  document.getElementById('btn-redo').onclick = redo;
  document.getElementById('btn-delete').onclick = deleteSelection;

  function loadDemo(builder) {
    sketch = emptySketch();
    undoStack = []; redoStack = [];
    selection = []; pending = null; opBase = null;
    builder();
    fitView();
    rerunAndRender();
  }

  function fitView() {
    if (!sketch.points.length) return;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    sketch.points.forEach(function (p) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });
    sketch.circles.forEach(function (c) {
      var cen = getPoint(c.center);
      minX = Math.min(minX, cen.x - c.r); maxX = Math.max(maxX, cen.x + c.r);
      minY = Math.min(minY, cen.y - c.r); maxY = Math.max(maxY, cen.y + c.r);
    });
    var w = canvas.clientWidth || 800, h = canvas.clientHeight || 600;
    var bw = Math.max(maxX - minX, 100), bh = Math.max(maxY - minY, 100);
    view.scale = Math.min((w - 160) / bw, (h - 160) / bh, 2);
    view.ox = w / 2 - ((minX + maxX) / 2) * view.scale;
    view.oy = h / 2 - ((minY + maxY) / 2) * view.scale;
  }

  function mkPoint(x, y) { return addPoint(x, y); }
  function fix(p) {
    sketch.constraints.push({ id: uid('K'), type: 'fix', point: p.id, x: p.x, y: p.y });
  }
  function dist(a, b, val) {
    sketch.constraints.push({ id: uid('K'), type: 'distance', a: a.id, b: b.id, value: val });
  }

  document.getElementById('btn-demo-play').onclick = function () {
    loadDemo(function () {
      var A = mkPoint(-220, 0), B = mkPoint(-120, -120), C = mkPoint(40, -120), D = mkPoint(140, 0);
      sketch.segments.push({ id: uid('S'), a: A.id, b: B.id });
      sketch.segments.push({ id: uid('S'), a: B.id, b: C.id });
      sketch.segments.push({ id: uid('S'), a: C.id, b: D.id });
      sketch.segments.push({ id: uid('S'), a: A.id, b: D.id });
      fix(A); fix(D);
      dist(A, B, 160);
      dist(B, C, 160);
      sketch.constraints.push({ id: uid('K'), type: 'horizontal', a: B.id, b: C.id });

      var O = mkPoint(260, 40);
      fix(O);
      var cir = { id: uid('C'), center: O.id, r: 70 };
      sketch.circles.push(cir);
      var T = mkPoint(260, -30);
      sketch.constraints.push({ id: uid('K'), type: 'tangent', point: T.id, circle: cir.id });
      dist(C, T, 120);
    });
    setHint('四连杆：A、D 锚定（紫色），拖动 B 或 C，整个机构会被距离约束拽着动；右侧点 T 同时贴着圆并与 C 保持距离。');
  };

  document.getElementById('btn-demo-conflict').onclick = function () {
    loadDemo(function () {
      var P1 = mkPoint(-120, 60), P2 = mkPoint(0, 60), P3 = mkPoint(-60, -80);
      sketch.segments.push({ id: uid('S'), a: P1.id, b: P2.id });
      sketch.segments.push({ id: uid('S'), a: P2.id, b: P3.id });
      sketch.segments.push({ id: uid('S'), a: P3.id, b: P1.id });
      dist(P1, P2, 100);
      dist(P2, P3, 100);
      dist(P3, P1, 300);
      sketch.constraints.push({ id: uid('K'), type: 'horizontal', a: P1.id, b: P2.id });
      fix(P1);
    });
    setHint('冲突三角形：两条边各 100，第三条被要求 300，违反三角形不等式，无法同时满足——冲突的约束被标红。拖动点试试，红色会随求解结果变化。');
  };

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  document.getElementById('btn-demo-play').click();
})();
