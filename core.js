/* 순로앱 계산 모듈 (시제품 W1)
 * - 거리: 직선거리 x 1.3 (W1은 가짜 도로 대신 이 값 사용. W4에서 실제 도로망으로 교체)
 * - 순서: 9곳 이하는 모든 순서를 따져 보는 정확한 풀이, 그 이상은
 *   "가까운 곳부터 + 구간 뒤집기(2-opt) + 한 곳 옮기기(or-opt)"를 여러 번 시작해 가장 짧은 것 선택.
 * - 같은 입력이면 항상 같은 결과 (난수는 고정 씨앗).
 */
(function (root) {
  var DETOUR = 1.3;

  function haversine(a, b) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // 점 목록 [start, p1..pn, end] 의 거리표 (미터)
  function buildMatrix(pts) {
    var n = pts.length, m = [];
    for (var i = 0; i < n; i++) {
      m.push(new Array(n).fill(0));
    }
    for (i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      var d = haversine(pts[i], pts[j]) * DETOUR;
      m[i][j] = d; m[j][i] = d;
    }
    return m;
  }

  // 순서 order(방문할 곳 번호 1..n)의 총거리. 0번=출발, n+1번=복귀
  function pathLen(m, order) {
    var n = order.length, t = 0, prev = 0;
    for (var i = 0; i < n; i++) { t += m[prev][order[i]]; prev = order[i]; }
    return t + m[prev][n + 1];
  }

  // 모든 순서를 따져 보는 정확한 풀이 (n <= 9)
  function solveExact(m, n) {
    var best = Infinity, bestOrder = [];
    var used = new Array(n + 2).fill(false), cur = [];
    function rec(prev, len) {
      if (len >= best) return;
      if (cur.length === n) {
        var tot = len + m[prev][n + 1];
        if (tot < best) { best = tot; bestOrder = cur.slice(); }
        return;
      }
      for (var k = 1; k <= n; k++) {
        if (used[k]) continue;
        used[k] = true; cur.push(k);
        rec(k, len + m[prev][k]);
        cur.pop(); used[k] = false;
      }
    }
    rec(0, 0);
    return bestOrder;
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function nearestNeighbor(m, n, first) {
    var used = new Array(n + 2).fill(false), order = [], prev = 0;
    if (first) { order.push(first); used[first] = true; prev = first; }
    while (order.length < n) {
      var best = -1, bd = Infinity;
      for (var k = 1; k <= n; k++) {
        if (!used[k] && m[prev][k] < bd) { bd = m[prev][k]; best = k; }
      }
      order.push(best); used[best] = true; prev = best;
    }
    return order;
  }

  // 구간 뒤집기 + 한 곳 옮기기를 더 줄일 수 없을 때까지 반복
  function improve(m, order) {
    var n = order.length, improved = true, guard = 0;
    function node(i) { return i < 0 ? 0 : (i >= n ? n + 1 : order[i]); }
    while (improved && guard++ < 200) {
      improved = false;
      // 2-opt: i..j 구간 뒤집기
      for (var i = 0; i < n - 1; i++) {
        for (var j = i + 1; j < n; j++) {
          var a = node(i - 1), b = node(i), c = node(j), d = node(j + 1);
          var delta = m[a][c] + m[b][d] - m[a][b] - m[c][d];
          if (delta < -1e-9) {
            var seg = order.slice(i, j + 1).reverse();
            for (var k = 0; k < seg.length; k++) order[i + k] = seg[k];
            improved = true;
          }
        }
      }
      // or-opt: 한 곳(또는 연속 2~3곳)을 다른 자리로 옮기기
      for (var len = 1; len <= 3; len++) {
        for (i = 0; i + len <= n; i++) {
          var p = node(i - 1), f = node(i), l = node(i + len - 1), q = node(i + len);
          var removeGain = m[p][f] + m[l][q] - m[p][q];
          var seg2 = order.slice(i, i + len);
          var rest = order.slice(0, i).concat(order.slice(i + len));
          var bestDelta = -1e-9, bestPos = -1, bestRev = false;
          for (var pos = 0; pos <= rest.length; pos++) {
            if (pos === i) continue;
            var x = pos === 0 ? 0 : rest[pos - 1];
            var y = pos === rest.length ? n + 1 : rest[pos];
            var addFwd = m[x][seg2[0]] + m[seg2[len - 1]][y] - m[x][y];
            var addRev = m[x][seg2[len - 1]] + m[seg2[0]][y] - m[x][y];
            if (addFwd - removeGain < bestDelta) { bestDelta = addFwd - removeGain; bestPos = pos; bestRev = false; }
            if (addRev - removeGain < bestDelta) { bestDelta = addRev - removeGain; bestPos = pos; bestRev = true; }
          }
          if (bestPos >= 0) {
            var ins = bestRev ? seg2.slice().reverse() : seg2;
            var out = rest.slice(0, bestPos).concat(ins, rest.slice(bestPos));
            for (k = 0; k < n; k++) order[k] = out[k];
            improved = true;
          }
        }
      }
    }
    return order;
  }

  // 정확 풀이를 쓰지 않는 근사 풀이 (시험에서 정확 풀이와 비교하려고 따로 공개)
  function solveHeuristic(m, n, starts) {
    var rnd = mulberry32(12345), best = null, bestLen = Infinity;
    starts = starts || 40;
    for (var s = 0; s < starts; s++) {
      var order;
      if (s === 0) order = nearestNeighbor(m, n, 0);
      else if (s <= n) order = nearestNeighbor(m, n, s);
      else {
        order = []; for (var k = 1; k <= n; k++) order.push(k);
        for (k = n - 1; k > 0; k--) { var r = Math.floor(rnd() * (k + 1)); var t = order[k]; order[k] = order[r]; order[r] = t; }
      }
      order = improve(m, order);
      var L = pathLen(m, order);
      if (L < bestLen - 1e-9) { bestLen = L; best = order.slice(); }
    }
    return best;
  }

  /**
   * 하루 순로 계산
   * sites: [{name, lat, lng, memo}], start/end: {lat,lng,name}
   * 반환: {order:[sites 순서], legs:[구간 미터], total:미터, walk:[다음 곳까지 직선 100m 이내 여부]}
   */
  function plan(sites, start, end) {
    var n = sites.length;
    if (n === 0) return { stops: [], total: 0 };
    var pts = [start].concat(sites, [end]);
    var m = buildMatrix(pts);
    var order = n <= 9 ? solveExact(m, n) : solveHeuristic(m, n);
    var stops = [], prev = 0, total = 0;
    for (var i = 0; i < n; i++) {
      var k = order[i], leg = m[prev][k];
      var straight = haversine(pts[prev], pts[k]);
      stops.push({
        site: sites[k - 1], legMeters: leg, straightMeters: straight,
        walkable: i > 0 && straight <= 100   // 앞 곳에서 직선 100m 이내
      });
      total += leg; prev = k;
    }
    var back = m[prev][n + 1];
    total += back;
    return { stops: stops, backMeters: back, total: total, method: n <= 9 ? 'exact' : 'heuristic' };
  }

  root.sunroCore = {
    haversine: haversine, buildMatrix: buildMatrix, pathLen: pathLen,
    solveExact: solveExact, solveHeuristic: solveHeuristic, plan: plan, DETOUR: DETOUR
  };
  if (typeof module !== 'undefined') module.exports = root.sunroCore;
})(typeof window !== 'undefined' ? window : globalThis);
