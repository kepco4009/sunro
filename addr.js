/* 순로앱 주소 찾기 모듈
 * 입력: "인천 연수구 ○○로 12", "○○로12번길 3-1", "옥련동 123", "옥련동 산12번지", "송도1동 12" 등
 * 자료: data/addr/index.json, rn_{시군구}.json(도로명→지번), pcl_{시군구}.json(지번→좌표)
 * 결과: {status:'ok'|'multi'|'none', items:[{lat,lng,road,jibun,name,sgg,kind}], reason}
 */
(function (root) {
  function AddrDB(index, load) {
    // load(파일이름) → Promise<JSON>
    this.ix = index; this.load = load; this.cache = {};
    var dongByName = {}, sggByName = {};
    var self = this;
    Object.keys(index.dong).forEach(function (code) {
      var d = index.dong[code];  // [시도, 시군구, 읍면동, 리]
      var add = function (k) { (dongByName[k] = dongByName[k] || []).push(code); };
      if (d[3]) { add(d[3]); add(d[2] + ' ' + d[3]); } else add(d[2]);
    });
    // 행정동 이름(송도1동 등)은 같은 이름의 법정동이 없을 때만 씀
    var legal = Object.assign({}, dongByName);
    Object.keys(index.hdong || {}).forEach(function (k) {
      var nm = k.split('|')[1];
      if (legal[nm]) return;
      index.hdong[k].forEach(function (code) {
        var arr = dongByName[nm] = dongByName[nm] || [];
        if (arr.indexOf(code) < 0) arr.push(code);
      });
    });
    Object.keys(index.sgg).forEach(function (s) {
      var full = index.sgg[s].name, parts = full.split(' ');
      var add = function (k) { (sggByName[k] = sggByName[k] || []).push(s); };
      add(full); add(parts.slice(1).join(' ')); add(parts[parts.length - 1]);
      if (parts.length === 3) add(parts[1]);   // "부천시"
    });
    Object.keys(index.alias || {}).forEach(function (old) {
      var news = index.alias[old];
      var codes = [];
      news.forEach(function (n) { (sggByName[n] || []).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); }); });
      var short = old.split(' ').slice(1).join(' ');
      sggByName['옛' + short] = codes;
    });
    this.dongByName = dongByName; this.sggByName = sggByName;
  }

  AddrDB.prototype.get = function (fn) {
    var self = this;
    if (!this.cache[fn]) this.cache[fn] = this.load(fn).then(function (j) { return j; });
    return this.cache[fn];
  };

  function clean(s) {
    return s.replace(/\(.*?\)/g, ' ').replace(/[,]/g, ' ').replace(/번지/g, ' ')
            .replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
  }

  /** 입력 한 줄을 해석: {sgg:[...], road, under, bn, bb, dong, san, mn, sn} */
  AddrDB.prototype.parse = function (text) {
    var s = clean(text), out = { sggs: null };
    s = s.replace(/^(인천광역시|인천시|인천|경기도|경기)\s*/, '');
    // 시군구
    var self = this, m;
    var tok = s.split(' ');
    for (var n = Math.min(2, tok.length); n >= 1; n--) {
      var cand = tok.slice(0, n).join(' ');
      var key = /^(중구|동구|서구)$/.test(cand) ? '옛' + cand : cand;
      if (self.sggByName[key]) { out.sggs = self.sggByName[key]; s = tok.slice(n).join(' '); break; }
    }
    // 도로명주소: (도로명)(지하)? 본번(-부번)?
    m = s.match(/^([가-힣A-Za-z0-9·]+?(?:대로|로|길))\s*(지하\s*)?(\d+)(?:-(\d+))?(?:\s|$)/);
    if (m && !/^\d+$/.test(m[1])) {
      out.road = m[1]; out.under = m[2] ? 1 : 0; out.bn = +m[3]; out.bb = m[4] ? +m[4] : 0; return out;
    }
    // 지번주소: (읍면)? (동/가/리) (산)? 본번(-부번)?
    m = s.match(/^((?:[가-힣0-9]+[읍면]\s+)?[가-힣0-9.·]+(?:동|가|리|읍|면|로))\s*(산\s*)?(\d+)(?:-(\d+))?(?:\s|$)/);
    if (m) {
      out.dong = m[1]; out.san = m[2] ? 1 : 0; out.mn = +m[3]; out.sn = m[4] ? +m[4] : 0; return out;
    }
    out.bad = true; return out;
  };

  AddrDB.prototype.fullJibun = function (code, san, mn, sn) {
    var d = this.ix.dong[code] || ['', '', '', ''];
    return [d[0], d[1], d[2], d[3]].filter(Boolean).join(' ') + ' ' + (san ? '산' : '') + mn + (sn ? '-' + sn : '');
  };

  // 지번 → 좌표
  AddrDB.prototype.parcel = function (code, san, mn, sn) {
    var sgg = code.slice(0, 5), e = this.ix.sgg[sgg];
    if (!e || !e.pcl) return Promise.resolve(null);
    return this.get(e.pcl).then(function (j) {
      var arr = j.d[code]; if (!arr) return null;
      // 정렬된 배열에서 찾기
      var lo = 0, hi = arr.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1, a = arr[mid];
        var c = (a[0] - san) || (a[1] - mn) || (a[2] - sn);
        if (c === 0) return { lat: a[3] / 1e5, lng: a[4] / 1e5 };
        if (c < 0) lo = mid + 1; else hi = mid - 1;
      }
      // 정확한 번지가 없으면: 같은 산 여부에서 본번이 가장 가까운 필지(본번 차이 10 이내)
      var best = null, bd = Infinity;
      for (var i = 0; i < arr.length; i++) {
        var b = arr[i]; if (b[0] !== san) continue;
        var d = Math.abs(b[1] - mn) * 1000 + Math.abs(b[2] - sn);
        if (d < bd) { bd = d; best = b; }
      }
      if (best && Math.abs(best[1] - mn) <= 10)
        return { lat: best[3] / 1e5, lng: best[4] / 1e5, approx: (best[0] ? '산' : '') + best[1] + (best[2] ? '-' + best[2] : '') };
      return null;
    });
  };

  // 지번 → 그 땅의 도로명주소 (있으면)
  AddrDB.prototype.roadOf = function (code, san, mn, sn) {
    var sgg = code.slice(0, 5), e = this.ix.sgg[sgg], self = this;
    if (!e || !e.rn) return Promise.resolve(null);
    return this.get(e.rn).then(function (j) {
      if (!j._rev) {
        j._rev = {};
        Object.keys(j.r).forEach(function (road) {
          j.r[road].forEach(function (x) {
            var k = x[3] + '|' + x[4] + '|' + x[5] + '|' + x[6];
            if (!j._rev[k]) j._rev[k] = [road, x];
          });
        });
      }
      var hit = j._rev[code + '|' + san + '|' + mn + '|' + sn];
      if (!hit) return null;
      var x = hit[1];
      return { road: e.name + ' ' + hit[0] + (x[0] ? ' 지하' : ' ') + x[1] + (x[2] ? '-' + x[2] : ''), name: x[7] };
    });
  };

  /** 주소 한 줄 찾기. pref: 먼저 찾아볼 시군구 코드 목록(부서 기본 지역) */
  AddrDB.prototype.find = function (text, pref) {
    var self = this, q = this.parse(text);
    if (q.bad) return Promise.resolve({ status: 'none', reason: '주소 형식을 알 수 없음', q: q, items: [] });
    var all = Object.keys(this.ix.sgg);
    var order = q.sggs || (pref && pref.length ? pref.concat(all.filter(function (s) { return pref.indexOf(s) < 0; })) : all);

    if (q.road) {
      // 도로명: 먼저 기본 지역에서, 없으면 나머지에서
      var tryList = function (list) {
        return Promise.all(list.filter(function (s) { return self.ix.sgg[s].rn; }).map(function (s) {
          return self.get(self.ix.sgg[s].rn).then(function (j) {
            var rows = j.r[q.road] || [];
            return rows.filter(function (x) { return x[1] === q.bn && x[2] === q.bb && (x[0] === q.under || !q.under); })
                       .map(function (x) { return { sgg: s, x: x }; });
          });
        })).then(function (rs) { return [].concat.apply([], rs); });
      };
      var first = q.sggs ? order : (pref && pref.length ? pref : order);
      return tryList(first).then(function (hits) {
        if (hits.length || first === order) return hits;
        return tryList(order.filter(function (s) { return first.indexOf(s) < 0; }));
      }).then(function (hits) {
        if (hits.length) return hits;
        // 길 이름은 있는데 그 건물번호가 없으면: 같은 길에서 번호가 가장 가까운 주소 (20 이내, 근사)
        return Promise.all(order.filter(function (s) { return self.ix.sgg[s].rn; }).map(function (s) {
          return self.get(self.ix.sgg[s].rn).then(function (j) {
            var rows = j.r[q.road] || [], best = null, bd = Infinity;
            rows.forEach(function (x) { var d = Math.abs(x[1] - q.bn) * 100 + Math.abs(x[2] - q.bb); if (d < bd) { bd = d; best = x; } });
            return best && Math.abs(best[1] - q.bn) <= 20 ? [{ sgg: s, x: best, near: true }] : [];
          });
        })).then(function (rs) { return [].concat.apply([], rs); });
      }).then(function (hits) {
        if (!hits.length) return { status: 'none', reason: '도로명주소를 찾지 못함', q: q, items: [] };
        return Promise.all(hits.map(function (h) {
          var x = h.x;
          return self.parcel(x[3], x[4], x[5], x[6]).then(function (p) {
            if (p) return p;
            // 같은 길에서 건물번호가 가장 가까운 주소의 좌표로 대신 (근사)
            return self.get(self.ix.sgg[h.sgg].rn).then(function (j) {
              var rows = (j.r[q.road] || []).filter(function (y) { return y !== x; })
                .sort(function (a, b) { return Math.abs(a[1] - x[1]) - Math.abs(b[1] - x[1]); }).slice(0, 6);
              var tryNext = function (i) {
                if (i >= rows.length) return null;
                return self.parcel(rows[i][3], rows[i][4], rows[i][5], rows[i][6]).then(function (pp) {
                  if (pp && !pp.approx) { pp.approx = q.road + ' ' + rows[i][1] + (rows[i][2] ? '-' + rows[i][2] : ''); return pp; }
                  return tryNext(i + 1);
                });
              };
              return tryNext(0);
            });
          }).then(function (p) {
            if (!p) return null;
            return { lat: p.lat, lng: p.lng, kind: '도로명', sgg: h.sgg, name: x[7],
                     approx: h.near ? q.road + ' ' + x[1] + (x[2] ? '-' + x[2] : '') : (p.approx || null),
                     outside: !!(pref && pref.length && pref.indexOf(h.sgg) < 0),
                     road: self.ix.sgg[h.sgg].name + ' ' + q.road + (x[0] ? ' 지하' : ' ') + x[1] + (x[2] ? '-' + x[2] : ''),
                     jibun: self.fullJibun(x[3], x[4], x[5], x[6]) };
          });
        })).then(function (items) {
          items = items.filter(Boolean);
          // 같은 시군구의 같은 주소(동이 여러 개인 건물)는 하나로
          var seen = {}; items = items.filter(function (it) { var k = it.road; if (seen[k]) return false; seen[k] = 1; return true; });
          if (!items.length) return { status: 'none', reason: '주소는 있으나 좌표 없음', q: q, items: [] };
          return { status: items.length === 1 ? 'ok' : 'multi', q: q, items: items };
        });
      });
    }

    // 지번
    var codes = (self.dongByName[q.dong] || []).slice();
    if (!codes.length && / /.test(q.dong)) codes = (self.dongByName[q.dong.split(' ').pop()] || []).slice();
    if (q.sggs) codes = codes.filter(function (c) { return q.sggs.indexOf(c.slice(0, 5)) >= 0; });
    if (!codes.length) return Promise.resolve({ status: 'none', reason: '동·리 이름을 찾지 못함', q: q, items: [] });
    var prefCodes = pref && pref.length && !q.sggs ? codes.filter(function (c) { return pref.indexOf(c.slice(0, 5)) >= 0; }) : [];
    var look = function (cs) {
      return Promise.all(cs.map(function (c) {
        return self.parcel(c, q.san, q.mn, q.sn).then(function (p) {
          if (!p) return null;
          return self.roadOf(c, q.san, q.mn, q.sn).then(function (r) {
            return { lat: p.lat, lng: p.lng, kind: '지번', sgg: c.slice(0, 5), jibun: self.fullJibun(c, q.san, q.mn, q.sn), approx: p.approx || null,
                     outside: !!(pref && pref.length && pref.indexOf(c.slice(0, 5)) < 0),
                     road: r ? r.road : null, name: r ? r.name : '' };
          });
        });
      })).then(function (a) { return a.filter(Boolean); });
    };
    return (prefCodes.length ? look(prefCodes) : Promise.resolve([])).then(function (items) {
      return items.length ? items : look(codes.filter(function (c) { return prefCodes.indexOf(c) < 0; }));
    }).then(function (items) {
      if (!items.length) return { status: 'none', reason: '해당 번지가 없음', q: q, items: [] };
      var exact = items.filter(function (it) { return !it.approx; });
      if (exact.length) items = exact;          // 정확히 맞는 번지가 있으면 근사 후보는 버림
      return { status: items.length === 1 ? 'ok' : 'multi', q: q, items: items };
    });
  };

  var api = { AddrDB: AddrDB };
  root.sunroAddr = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
