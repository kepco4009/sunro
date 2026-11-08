/* 순로앱 여러 날 나누기
 * 입력 비용표 T(초), 길이표 L(m): 0=출발, 1..n=현장, n+1=복귀
 * 방법
 *  1) 반경 묶기: 묶이지 않은 현장 중 "반경 안 이웃이 가장 많은 현장"을 가운데로 정하고,
 *     그 현장에서 차로 반경 안에 닿는 현장을 한 묶음으로 (묶음 지름은 반경의 2배를 넘지 않음)
 *  2) 묶음(과 홀로인 현장)을 출발→…→복귀 한 바퀴 순서로 잇는다
 *  3) 그 순서를 일수만큼 차례로 자른다. 하루 기준 = 곳 수 ÷ 일수, 기준과의 차이가 가장 작게.
 *     묶음 때문에 기준의 30%까지는 넘어도 됨. 한 묶음이 그보다 크면 '나누기' 또는 '그날 전부'
 *  4) 날마다 출발→그날 현장→복귀 순서를 다시 짠다
 */
(function (root) {
  var C = root.sunroCore || (typeof require !== 'undefined' ? require('./core.js') : null);

  function solveOrder(T, ids) {
    // ids: 원래 번호(1..n). 0과 n+1(출발·복귀)을 앞뒤에 붙여 작은 표를 만들어 순서를 구함
    var n = T.length - 2, idx = [0].concat(ids, [n + 1]);
    var M = idx.map(function (a) { return idx.map(function (b) { return T[a][b]; }); });
    var k = ids.length;
    if (k === 0) return [];
    var ord = k <= 9 ? C.solveExact(M, k) : C.solveHeuristic(M, k);
    return ord.map(function (j) { return idx[j]; });
  }

  function clusters(L, n, R) {
    var d = function (i, j) { return Math.min(L[i][j], L[j][i]); };
    var free = {}, out = [];
    for (var i = 1; i <= n; i++) free[i] = true;
    while (true) {
      var best = -1, bc = 0, bl = null;
      for (var a = 1; a <= n; a++) {
        if (!free[a]) continue;
        var nb = [];
        for (var b = 1; b <= n; b++) if (b !== a && free[b] && d(a, b) <= R) nb.push(b);
        if (nb.length > bc) { bc = nb.length; best = a; bl = nb; }
      }
      if (best < 0) break;
      var g = [best].concat(bl);
      g.forEach(function (x) { free[x] = false; });
      out.push(g);
    }
    for (var s = 1; s <= n; s++) if (free[s]) out.push([s]);
    return out;
  }

  /**
   * opts: {days, radius(m, 0=끄기), big: 'split'(연속 날로 나누기, 기본) | 'keep'(그날 전부)}
   */
  function split(T, L, opts) {
    var n = T.length - 2, D = Math.max(1, Math.min(opts.days || 1, n)), R = opts.radius || 0;
    var target = n / D, cap = Math.max(Math.ceil(target), Math.floor(target * 1.3 + 1e-9));
    var groups = D > 1 && R > 0 ? clusters(L, n, R) : (function () { var a = []; for (var i = 1; i <= n; i++) a.push([i]); return a; })();
    var clusterOf = {};
    groups.forEach(function (g, gi) { if (g.length > 1) g.forEach(function (x) { clusterOf[x] = gi; }); });

    // 묶음 대표(가운데 현장)로 한 바퀴 순서
    var reps = groups.map(function (g) { return g[0]; });
    var repOrder = solveOrder(T, reps);
    var unitsInOrder = repOrder.map(function (r) { return groups[reps.indexOf(r)]; });

    // 너무 큰 묶음 처리
    var big = [], units = [];
    unitsInOrder.forEach(function (g) {
      var gi = groups.indexOf(g);
      if (g.length > cap && D > 1) {
        big.push({ group: gi, size: g.length });
        if (opts.big !== 'keep') {
          var inner = solveOrder(T, g), k = Math.ceil(g.length / target), per = Math.ceil(g.length / k);
          for (var i = 0; i < g.length; i += per) units.push({ ids: inner.slice(i, i + per), group: gi, piece: true });
          return;
        }
      }
      units.push({ ids: g.slice(), group: gi });
    });

    // 차례로 자르기 (기준과의 차이 제곱합이 가장 작게, 상한 초과는 피함)
    var m = units.length, Dd = Math.min(D, m);
    var pre = [0]; units.forEach(function (u) { pre.push(pre[pre.length - 1] + u.ids.length); });
    var cost = function (i, j) {           // units[i..j-1]
      var sz = pre[j] - pre[i], c = (sz - target) * (sz - target);
      if (sz > cap && j - i > 1) c += 1e6;  // 상한 넘는 날은 묶음 하나뿐일 때만 허용
      return c;
    };
    var INF = 1e18, dp = [], cut = [];
    for (var k = 0; k <= Dd; k++) { dp.push(new Array(m + 1).fill(INF)); cut.push(new Array(m + 1).fill(-1)); }
    dp[0][0] = 0;
    for (k = 1; k <= Dd; k++) for (var j = k; j <= m; j++) for (var i = k - 1; i < j; i++) {
      if (dp[k - 1][i] >= INF) continue;
      var v = dp[k - 1][i] + cost(i, j);
      if (v < dp[k][j]) { dp[k][j] = v; cut[k][j] = i; }
    }
    var bounds = [], jj = m;
    for (k = Dd; k >= 1; k--) { var ii = cut[k][jj]; bounds.unshift([ii, jj]); jj = ii; }

    var days = bounds.map(function (b, di) {
      var ids = [];
      for (var u = b[0]; u < b[1]; u++) ids = ids.concat(units[u].ids);
      var order = solveOrder(T, ids), sec = 0, len = 0, prev = 0;
      order.concat([n + 1]).forEach(function (x) { sec += T[prev][x]; len += L[prev][x]; prev = x; });
      return { day: di + 1, order: order, sec: sec, m: len, count: ids.length,
               over: ids.length > Math.ceil(target) ? ids.length - Math.ceil(target) : 0 };
    });
    return { days: days, target: target, cap: cap, big: big, groups: groups, clusterOf: clusterOf, requestedDays: opts.days, usedDays: Dd };
  }

  var api = { split: split, clusters: clusters, solveOrder: solveOrder };
  root.sunroDays = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
