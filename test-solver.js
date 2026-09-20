const Solver = require('./solver.js');

let pass = 0, fail = 0;
function approx(name, got, want, tol) {
  if (Math.abs(got - want) <= tol) { pass++; console.log('PASS', name, got.toFixed(3)); }
  else { fail++; console.log('FAIL', name, 'got', got, 'want', want); }
}

// 1) 两个锚定 + 固定距离 + 水平：自由点应被拉到约束位
{
  const s = {
    points: [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 50, y: 30 }, { id: 'C', x: 120, y: 40 }],
    segments: [], circles: [],
    constraints: [
      { id: 'f1', type: 'fix', point: 'A', x: 0, y: 0 },
      { id: 'f2', type: 'fix', point: 'B', x: 100, y: 0 },
      { id: 'd1', type: 'distance', a: 'B', b: 'C', value: 100 },
      { id: 'h1', type: 'horizontal', a: 'A', b: 'C' }
    ]
  };
  const sol = Solver.solve(s, []);
  const res = Solver.applySolution(s, sol, 2);
  approx('C.x = 200', s.points[2].x, 200, 3);
  approx('C.y = 0', s.points[2].y, 0, 3);
  if (res.conflicts.length === 0) { pass++; console.log('PASS no conflicts'); }
  else { fail++; console.log('FAIL unexpected conflicts', res.conflicts); }
}

// 2) 不可能三角形 -> 冲突
{
  const s = {
    points: [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 100, y: 0 }, { id: 'C', x: 50, y: 80 }],
    segments: [], circles: [],
    constraints: [
      { id: 'd1', type: 'distance', a: 'A', b: 'B', value: 100 },
      { id: 'd2', type: 'distance', a: 'B', b: 'C', value: 100 },
      { id: 'd3', type: 'distance', a: 'C', b: 'A', value: 300 }
    ]
  };
  const sol = Solver.solve(s, []);
  const res = Solver.applySolution(s, sol, 2);
  if (res.conflicts.length >= 1) { pass++; console.log('PASS conflicts detected', res.conflicts); }
  else { fail++; console.log('FAIL conflict not detected'); }
}

// 3) 点圆相切：拖动锚点到某位置，相切点应落到圆周
{
  const s = {
    points: [{ id: 'O', x: 0, y: 0 }, { id: 'T', x: 30, y: 40 }],
    segments: [],
    circles: [{ id: 'C1', center: 'O', r: 50 }],
    constraints: [
      { id: 'f1', type: 'fix', point: 'O', x: 0, y: 0 },
      { id: 't1', type: 'tangent', point: 'T', circle: 'C1' }
    ]
  };
  // 光标拉到圆周上另一点 (50,0)：T 应沿圆周滑过去
  const sol = Solver.solve(s, [{ id: 'T', x: 50, y: 0, weight: 0.35 }]);
  Solver.applySolution(s, sol, 2);
  const d = Math.hypot(s.points[1].x, s.points[1].y);
  approx('T on circle r=50', d, 50, 4);
  approx('T slides toward (50,0): x', s.points[1].x, 50, 8);
  approx('T slides toward (50,0): y', s.points[1].y, 0, 8);
  approx('radius retained', s.circles[0].r, 50, 3);
}

// 4) 重合 + 竖直
{
  const s = {
    points: [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 30, y: 20 }, { id: 'C', x: 60, y: 50 }],
    segments: [], circles: [],
    constraints: [
      { id: 'f1', type: 'fix', point: 'A', x: 0, y: 0 },
      { id: 'co', type: 'coincident', a: 'A', b: 'B' },
      { id: 'v', type: 'vertical', a: 'B', b: 'C' },
      { id: 'd', type: 'distance', a: 'B', b: 'C', value: 80 }
    ]
  };
  const sol = Solver.solve(s, []);
  Solver.applySolution(s, sol, 2);
  approx('B coincident A x', s.points[1].x, 0, 2);
  approx('B coincident A y', s.points[1].y, 0, 2);
  approx('C vertical x=0', s.points[2].x, 0, 2);
  approx('C distance 80', s.points[2].y, 80, 4);
}

console.log('\\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
