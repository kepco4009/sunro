/* 순로앱 길 찾기 모듈
 * - 바둑판 칸 파일(car_*.json / walk_*.json)을 합쳐 하나의 길 연결망을 만듦
 * - 현장 좌표를 가장 가까운 길 위의 한 점에 붙임 (고속도로·간선 제외)
 * - 출발 현장 하나에서 여러 현장까지의 최단 시간(차량) 또는 최단 거리(도보)를 계산
 * 외부 프로그램 없이 브라우저(그리고 시험용 Node)에서 그대로 동작
 */
(function (root) {
  // 길 종류별 평균속도 (km/h). 35개소 검증으로 조정할 값
  var SPEED = { 1: 80, 2: 60, 3: 40, 4: 35, 5: 30, 6: 25, 7: 20, 8: 15, 9: 12 };
  var NO_SNAP = { 1: 1, 2: 1 };          // 현장을 붙이지 않을 길 (고속도로, 간선)
  var CELL = 0.002;                      // 붙이기용 격자 크기(도) 약 200m

  function hav(la1, lo1, la2, lo2) {
    var R = 6371000, r = Math.PI / 180;
    var a = Math.sin((la2 - la1) * r / 2), b = Math.sin((lo2 - lo1) * r / 2);
    var s = a * a + Math.cos(la1 * r) * Math.cos(la2 * r) * b * b;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /** 칸 파일 여러 개를 합쳐 연결망을 만든다. mode: 'car' | 'walk' */
  function Network(tiles, mode) {
    this.mode = mode;
    var idOf = new Map(), lat = [], lng = [];
    var E = [], seen = new Set();
    function nodeIndex(id, y, x) {
      var k = idOf.get(id);
      if (k === undefined) { k = lat.length; idOf.set(id, k); lat.push(y / 1e5); lng.push(x / 1e5); }
      return k;
    }
    tiles.forEach(function (t) {
      var loc = t.n.map(function (id, i) { return nodeIndex(id, t.y[i], t.x[i]); });
      t.e.forEach(function (e) {
        var u = loc[e[0]], v = loc[e[1]];
        var key = u + '_' + v + '_' + e[2];
        if (seen.has(key)) return;
        seen.add(key);
        // 모양 점 복원
        var pts = [[lat[u], lng[u]]], y = t.y[e[0]], x = t.x[e[0]], sh = e[6];
        for (var i = 0; i < sh.length; i += 2) { y += sh[i]; x += sh[i + 1]; pts.push([y / 1e5, x / 1e5]); }
        pts.push([lat[v], lng[v]]);
        E.push({ u: u, v: v, len: e[2], cls: e[3], one: e[4], lanes: e[5], pts: pts });
      });
    });
    this.lat = lat; this.lng = lng; this.edges = E; this.N = lat.length;
    // 화살표(이동 방향) 목록: 압축 인접 배열
    var cnt = new Int32Array(this.N + 1), arcs = [];
    E.forEach(function (e, i) {
      arcs.push([e.u, e.v, i, 0]);
      if (mode === 'walk' || !e.one) arcs.push([e.v, e.u, i, 1]);
    });
    arcs.forEach(function (a) { cnt[a[0] + 1]++; });
    for (var i = 0; i < this.N; i++) cnt[i + 1] += cnt[i];
    var to = new Int32Array(arcs.length), w = new Float64Array(arcs.length), wl = new Float64Array(arcs.length),
        eid = new Int32Array(arcs.length), rev = new Uint8Array(arcs.length), pos = cnt.slice();
    var self = this;
    arcs.forEach(function (a) {
      var p = pos[a[0]]++;
      to[p] = a[1]; eid[p] = a[2]; rev[p] = a[3]; w[p] = self.cost(E[a[2]]); wl[p] = E[a[2]].len;
    });
    this.start = cnt; this.to = to; this.w = w; this.wl = wl; this.eid = eid; this.rev = rev;
    // 붙이기용 격자: 각 길 조각(segment)을 지나는 칸에 등록
    var grid = new Map();
    E.forEach(function (e, i) {
      if (mode === 'car' && NO_SNAP[e.cls]) return;
      for (var k = 0; k + 1 < e.pts.length; k++) {
        var a = e.pts[k], b = e.pts[k + 1];
        var y0 = Math.floor(Math.min(a[0], b[0]) / CELL), y1 = Math.floor(Math.max(a[0], b[0]) / CELL);
        var x0 = Math.floor(Math.min(a[1], b[1]) / CELL), x1 = Math.floor(Math.max(a[1], b[1]) / CELL);
        for (var gy = y0; gy <= y1; gy++) for (var gx = x0; gx <= x1; gx++) {
          var gk = gy + ':' + gx, arr = grid.get(gk);
          if (!arr) grid.set(gk, arr = []);
          arr.push(i * 4096 + k);
        }
      }
    });
    this.grid = grid;
  }

  // 구간 비용: 차량은 초(시간), 도보는 미터
  Network.prototype.cost = function (e) {
    return this.mode === 'walk' ? e.len : e.len / (SPEED[e.cls] / 3.6);
  };

  /** 좌표를 가장 가까운 길 위의 점에 붙인다 → {edge, t(0~1, u에서 얼마나 갔나), off(길까지 직선 m)} */
  Network.prototype.snap = function (la, lo) {
    var gy = Math.floor(la / CELL), gx = Math.floor(lo / CELL), best = null, bd = Infinity;
    var kx = Math.cos(la * Math.PI / 180) * 111320, ky = 110540;
    for (var r = 0; r <= 6 && (best === null || r <= 1 || bd > (r - 1) * CELL * ky); r++) {
      for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dy), Math.abs(dx)) !== r) continue;
        var arr = this.grid.get((gy + dy) + ':' + (gx + dx));
        if (!arr) continue;
        for (var j = 0; j < arr.length; j++) {
          var i = Math.floor(arr[j] / 4096), k = arr[j] % 4096, e = this.edges[i];
          var a = e.pts[k], b = e.pts[k + 1];
          var ax = (a[1] - lo) * kx, ay = (a[0] - la) * ky, bx = (b[1] - lo) * kx, by = (b[0] - la) * ky;
          var vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
          var s = L2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
          var px = ax + vx * s, py = ay + vy * s, d = Math.sqrt(px * px + py * py);
          if (d < bd) { bd = d; best = { edge: i, seg: k, s: s }; }
        }
      }
    }
    if (!best) return null;
    // 길 전체에서의 위치 비율 t
    var e = this.edges[best.edge], acc = 0, tot = 0, segLen = [];
    for (var k = 0; k + 1 < e.pts.length; k++) {
      var l = hav(e.pts[k][0], e.pts[k][1], e.pts[k + 1][0], e.pts[k + 1][1]); segLen.push(l); tot += l;
    }
    for (k = 0; k < best.seg; k++) acc += segLen[k];
    acc += segLen[best.seg] * best.s;
    return { edge: best.edge, t: tot > 0 ? acc / tot : 0, off: bd };
  };

  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = k.length; k.push(key); v.push(val);
    while (i > 0) { var p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, topK = k[0], topV = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      var i = 0;
      while (true) {
        var l = 2 * i + 1, r = l + 1, m = i, mk = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    this.lastKey = topK; return topV;
  };

  // 붙인 점에서 출발할 때: 길 양 끝 점까지의 비용
  Network.prototype.leave = function (p) {
    var e = this.edges[p.edge], c = this.cost(e), out = [];
    out.push([e.v, (1 - p.t) * c, (1 - p.t) * e.len]);                        // u→v 방향으로 나감
    if (this.mode === 'walk' || !e.one) out.push([e.u, p.t * c, p.t * e.len]); // 반대로 나감 (양방향일 때만)
    return out;
  };
  // 붙인 점에 도착할 때: 길 양 끝 점에서 들어오는 비용
  Network.prototype.arrive = function (p) {
    var e = this.edges[p.edge], c = this.cost(e), out = [];
    out.push([e.u, p.t * c, p.t * e.len]);
    if (this.mode === 'walk' || !e.one) out.push([e.v, (1 - p.t) * c, (1 - p.t) * e.len]);
    return out;
  };

  /** 한 점에서 여러 점까지 최단 비용. limit: 이보다 큰 비용은 탐색 중단 (도보 100m 등) */
  Network.prototype.oneToMany = function (src, targets, limit, keepPrev) {
    var N = this.N, dist = new Float64Array(N).fill(Infinity), dl = new Float64Array(N), prev = keepPrev ? new Int32Array(N).fill(-1) : null;
    var h = new Heap(), self = this;
    this.leave(src).forEach(function (a) { if (a[1] < dist[a[0]]) { dist[a[0]] = a[1]; dl[a[0]] = a[2]; h.push(a[1], a[0]); } });
    // 목표마다 들어오는 끝 점 목록
    var need = new Map(), left = 0;
    targets.forEach(function (p, ti) {
      self.arrive(p).forEach(function (a) {
        var arr = need.get(a[0]); if (!arr) need.set(a[0], arr = []);
        arr.push([ti, a[1], a[2]]); left++;
      });
    });
    var res = targets.map(function () { return Infinity; }), resL = targets.map(function () { return Infinity; });
    // 출발과 도착이 같은 길 위에 있으면 길을 따라 바로 갈 수 있는지
    targets.forEach(function (p, ti) {
      if (p.edge !== src.edge) return;
      var e = self.edges[p.edge], c = self.cost(e);
      if (p.t >= src.t) { res[ti] = (p.t - src.t) * c; resL[ti] = (p.t - src.t) * e.len; }
      else if (self.mode === 'walk' || !e.one) { res[ti] = (src.t - p.t) * c; resL[ti] = (src.t - p.t) * e.len; }
    });
    var done = new Uint8Array(N), lim = limit || Infinity;
    while (h.k.length) {
      var u = h.pop(), du = h.lastKey;
      if (done[u]) continue;
      done[u] = 1;
      if (du > lim) break;
      var arr = need.get(u);
      if (arr) {
        arr.forEach(function (x) { if (du + x[1] < res[x[0]]) { res[x[0]] = du + x[1]; resL[x[0]] = dl[u] + x[2]; } });
        left -= arr.length;
        if (left <= 0 && !keepPrev) break;
      }
      for (var p = this.start[u]; p < this.start[u + 1]; p++) {
        var v = this.to[p], nd = du + this.w[p];
        if (nd < dist[v]) { dist[v] = nd; dl[v] = dl[u] + this.wl[p]; if (prev) prev[v] = p; h.push(nd, v); }
      }
    }
    if (keepPrev) { this._dist = dist; this._prev = prev; }
    this._lastLen = resL;
    return res;
  };

  /** 두 점 사이 경로 모양 (지도 그리기용) */
  Network.prototype.path = function (a, b) {
    this.oneToMany(a, [b], 0, true);
    var self = this, best = Infinity, endNode = -1, endSide = null;
    this.arrive(b).forEach(function (x) { var d = self._dist[x[0]] + x[1]; if (d < best) { best = d; endNode = x[0]; } });
    var nodes = [], p = endNode, guard = 0;
    while (p >= 0 && this._prev[p] >= 0 && guard++ < 100000) {
      var arc = this._prev[p], e = this.edges[this.eid[arc]];
      var pts = this.rev[arc] ? e.pts.slice().reverse() : e.pts.slice();
      nodes.unshift(pts);
      p = this.rev[arc] ? e.v : e.u;      // 이 화살표가 출발한 점
    }
    var line = [];
    nodes.forEach(function (pts) { pts.forEach(function (q) { line.push(q); }); });
    return { cost: best, line: line };
  };

  /** 현장 여러 곳 사이의 비용표 (차량: 초) */
  Network.prototype.matrix = function (pts) {
    var self = this;
    return pts.map(function (p) { return self.oneToMany(p, pts); });
  };

  /** 비용표와 함께, 가장 빠른 길의 길이(m)표도 */
  Network.prototype.matrix2 = function (pts) {
    var self = this, T = [], L = [];
    pts.forEach(function (p) { T.push(self.oneToMany(p, pts)); L.push(self._lastLen.slice()); });
    return { T: T, L: L };
  };

  var api = { Network: Network, SPEED: SPEED, hav: hav };
  root.sunroRoad = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
