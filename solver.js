/* 平面约束求解器：带阻尼的高斯-牛顿（Levenberg-Marquardt 风格）。
 * 纯函数、无 DOM 依赖，可直接在 Node 里冒烟测试。
 * 变量排布：点 i -> [2i, 2i+1]；圆 i -> 额外半径 1 维。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Solver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_ITER = 60;
  var EPS = 1e-9;

  function buildVars(sketch, anchors) {
    var np = sketch.points.length;
    var nc = sketch.circles.length;
    var x = new Array(2 * np + nc);
    for (var i = 0; i < np; i++) {
      x[2 * i] = sketch.points[i].x;
      x[2 * i + 1] = sketch.points[i].y;
    }
    for (var j = 0; j < nc; j++) x[2 * np + j] = sketch.circles[j].r;
    return x;
  }

  // 返回 {r: 残差数组, J: 按行存的稀疏雅可比 [[{col,val}...]], w: 权重}
  function residuals(sketch, x, anchors) {
    var np = sketch.points.length;
    var rows = [];
    var pidx = {};
    sketch.points.forEach(function (p, i) { pidx[p.id] = i; });
    var cidx = {};
    sketch.circles.forEach(function (c, i) { cidx[c.id] = i; });

    function addRow(r, derivs, w) {
      rows.push({ r: r, d: derivs, w: w == null ? 1 : w });
    }
    function px(id) { return x[2 * pidx[id]]; }
    function py(id) { return x[2 * pidx[id] + 1]; }

    sketch.constraints.forEach(function (c) {
      if (c.type === 'fix') {
        var fi = pidx[c.point];
        addRow(x[2 * fi] - c.x, [{ c: 2 * fi, v: 1 }], 5000);
        addRow(x[2 * fi + 1] - c.y, [{ c: 2 * fi + 1, v: 1 }], 5000);
      } else
      if (c.type === 'coincident') {
        var a = pidx[c.a], b = pidx[c.b];
        addRow(x[2 * a] - x[2 * b], [{ c: 2 * a, v: 1 }, { c: 2 * b, v: -1 }]);
        addRow(x[2 * a + 1] - x[2 * b + 1], [{ c: 2 * a + 1, v: 1 }, { c: 2 * b + 1, v: -1 }]);
      } else if (c.type === 'horizontal') {
        addRow(py(c.a) - py(c.b), [{ c: 2 * pidx[c.a] + 1, v: 1 }, { c: 2 * pidx[c.b] + 1, v: -1 }]);
      } else if (c.type === 'vertical') {
        addRow(px(c.a) - px(c.b), [{ c: 2 * pidx[c.a], v: 1 }, { c: 2 * pidx[c.b], v: -1 }]);
      } else if (c.type === 'distance') {
        var ia = pidx[c.a], ib = pidx[c.b];
        var dx = x[2 * ia] - x[2 * ib];
        var dy = x[2 * ia + 1] - x[2 * ib + 1];
        var d = Math.sqrt(dx * dx + dy * dy) || EPS;
        var f = d - c.value;
        addRow(f, [
          { c: 2 * ia, v: dx / d }, { c: 2 * ia + 1, v: dy / d },
          { c: 2 * ib, v: -dx / d }, { c: 2 * ib + 1, v: -dy / d }
        ]);
      } else if (c.type === 'tangent') {
        // 点落在圆上：|P - center| - r = 0
        var pi = pidx[c.point], ci = cidx[c.circle];
        var ceni = pidx[sketch.circles[ci].center];
        var ex = x[2 * pi] - x[2 * ceni];
        var ey = x[2 * pi + 1] - x[2 * ceni + 1];
        var e = Math.sqrt(ex * ex + ey * ey) || EPS;
        var cenCol = 2 * ceni;
        var rCol = 2 * np + ci;
        addRow(e - x[rCol], [
          { c: 2 * pi, v: ex / e }, { c: 2 * pi + 1, v: ey / e },
          { c: cenCol, v: -ex / e }, { c: cenCol + 1, v: -ey / e },
          { c: rCol, v: -1 }
        ]);
      }
    });

    // 拖拽锚点：软权重，冲突时允许被拖动但仍给出反馈
    (anchors || []).forEach(function (a) {
      var i = pidx[a.id];
      addRow(x[2 * i] - a.x, [{ c: 2 * i, v: 1 }], a.weight == null ? 0.35 : a.weight);
      addRow(x[2 * i + 1] - a.y, [{ c: 2 * i + 1, v: 1 }], a.weight == null ? 0.35 : a.weight);
    });

    // 圆半径软固定：相切约束可以拉动半径
    sketch.circles.forEach(function (c, i) {
      addRow(x[2 * np + i] - c.r, [{ c: 2 * np + i, v: 1 }], 0.8);
    });

    return rows;
  }

  function solve(sketch, anchors, opts) {
    opts = opts || {};
    var maxIter = opts.maxIter || MAX_ITER;
    var x = buildVars(sketch, anchors);
    var n = x.length;
    var lambda = 1e-3;
    var iter = 0;
    var converged = false;

    for (; iter < maxIter; iter++) {
      var rows = residuals(sketch, x, anchors);
      // H = sum w J'J, g = sum w J'r
      var H = new Array(n * n).fill(0);
      var g = new Array(n).fill(0);
      var maxR = 0;
      rows.forEach(function (row) {
        var w = row.w;
        row.d.forEach(function (d1) {
          g[d1.c] += w * d1.v * row.r;
          row.d.forEach(function (d2) {
            H[d1.c * n + d2.c] += w * d1.v * d2.v;
          });
        });
        if (Math.abs(row.r) > maxR) maxR = Math.abs(row.r);
      });
      if (maxR < 1e-7) { converged = true; break; }

      var accepted = false;
      var damp = lambda;
      for (var attempt = 0; attempt < 12; attempt++) {
        var A = H.slice();
        for (var i = 0; i < n; i++) A[i * n + i] += damp * (H[i * n + i] + 1e-6);
        var delta = gaussianSolve(A, g, n);
        if (!delta) { damp *= 4; continue; }
        var x2 = new Array(n);
        var step = 0;
        for (var k = 0; k < n; k++) {
          x2[k] = x[k] - delta[k];
          if (Math.abs(delta[k]) > step) step = Math.abs(delta[k]);
        }
        // 半径必须为正
        var np = sketch.points.length;
        var radiusOk = true;
        for (var cj = 0; cj < sketch.circles.length; cj++) {
          if (x2[2 * np + cj] < 1) { radiusOk = false; break; }
        }
        if (!radiusOk) { damp *= 4; continue; }
        var r2 = residuals(sketch, x2, anchors);
        var norm2 = 0, norm1 = 0;
        r2.forEach(function (row) { norm2 += row.w * row.r * row.r; });
        rows.forEach(function (row) { norm1 += row.w * row.r * row.r; });
        if (norm2 < norm1) {
          x = x2; lambda = Math.max(damp / 3, 1e-9); accepted = true;
          if (step < 1e-9) { converged = maxR < 1e-5; }
          break;
        }
        damp *= 4;
      }
      if (!accepted) { converged = maxR < 1e-4; break; }
    }

    return { x: x, iterations: iter, converged: converged };
  }

  function gaussianSolve(A, b, n) {
    var M = new Array(n);
    for (var i = 0; i < n; i++) {
      M[i] = new Array(n + 1);
      for (var j = 0; j < n; j++) M[i][j] = A[i * n + j];
      M[i][n] = b[i];
    }
    for (var p = 0; p < n; p++) {
      var piv = p;
      for (var r = p + 1; r < n; r++) if (Math.abs(M[r][p]) > Math.abs(M[piv][p])) piv = r;
      if (Math.abs(M[piv][p]) < 1e-12) return null;
      var tmp = M[piv]; M[piv] = M[p]; M[p] = tmp;
      for (var q = p + 1; q < n; q++) {
        var f = M[q][p] / M[p][p];
        for (var k = p; k <= n; k++) M[q][k] -= f * M[p][k];
      }
    }
    var x = new Array(n);
    for (var rr = n - 1; rr >= 0; rr--) {
      var s = M[rr][n];
      for (var kk = rr + 1; kk < n; kk++) s -= M[rr][kk] * x[kk];
      x[rr] = s / M[rr][rr];
    }
    return x;
  }

  // 单条约束残差，用于冲突标红
  function constraintResidual(sketch, c) {
    var P = {};
    sketch.points.forEach(function (p) { P[p.id] = p; });
    var C = {};
    sketch.circles.forEach(function (cc) { C[cc.id] = cc; });
    if (c.type === 'coincident') {
      return Math.max(Math.abs(P[c.a].x - P[c.b].x), Math.abs(P[c.a].y - P[c.b].y));
    }
    if (c.type === 'horizontal') return Math.abs(P[c.a].y - P[c.b].y);
    if (c.type === 'vertical') return Math.abs(P[c.a].x - P[c.b].x);
    if (c.type === 'distance') {
      var dx = P[c.a].x - P[c.b].x, dy = P[c.a].y - P[c.b].y;
      return Math.abs(Math.sqrt(dx * dx + dy * dy) - c.value);
    }
    if (c.type === 'tangent') {
      var cen = P[C[c.circle].center];
      var pnt = P[c.point];
      var ex = pnt.x - cen.x, ey = pnt.y - cen.y;
      return Math.abs(Math.sqrt(ex * ex + ey * ey) - C[c.circle].r);
    }
    return 0;
  }

  // 把解写回草图，返回冲突约束 id 列表。tol 为图纸单位残差容差。
  function applySolution(sketch, sol, tol) {
    tol = tol == null ? 6 : tol;
    var np = sketch.points.length;
    sketch.points.forEach(function (p, i) {
      p.x = sol.x[2 * i]; p.y = sol.x[2 * i + 1];
    });
    sketch.circles.forEach(function (c, i) { c.r = Math.max(1, sol.x[2 * np + i]); });
    var conflicts = [];
    sketch.constraints.forEach(function (c) {
      if (constraintResidual(sketch, c) > tol) conflicts.push(c.id);
    });
    return { conflicts: conflicts, converged: sol.converged, iterations: sol.iterations };
  }

  return {
    solve: solve,
    applySolution: applySolution,
    constraintResidual: constraintResidual
  };
});
