/* 순로앱 부서 번호 상자
 * dept.json = { v, salt, entries: [{ id, iv, ct }] }
 *  - id : SHA-256(salt + ':' + 번호) 앞 16자리 → 번호를 몰라도 파일만 보고는 원래 번호를 알 수 없음
 *  - ct : 설정(JSON)을 번호로 만든 열쇠(PBKDF2)로 잠근 것(AES-GCM) → 번호를 알아야 설정을 꺼낼 수 있음
 * 4~5자리 번호라 마음먹고 대입하면 풀 수 있는 간이 잠금이며, 공개돼도 무방한 정보만 넣는다.
 */
(function (root) {
  var subtle = (root.crypto || (typeof require !== 'undefined' ? require('crypto').webcrypto : null)).subtle;
  var enc = new TextEncoder(), dec = new TextDecoder();
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function b64(u8) { var s = ''; u8 = new Uint8Array(u8); for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function unb64(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function clean(code) { return String(code || '').replace(/\D/g, ''); }

  function idOf(salt, code) {
    return subtle.digest('SHA-256', enc.encode(salt + ':' + clean(code))).then(function (h) { return hex(h).slice(0, 16); });
  }
  function keyOf(salt, code, id) {
    return subtle.importKey('raw', enc.encode(clean(code)), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode(salt + id), iterations: 60000, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }

  /** 설정 하나 잠그기 */
  function lock(salt, code, settings) {
    return idOf(salt, code).then(function (id) {
      return keyOf(salt, code, id).then(function (key) {
        var iv = (root.crypto || require('crypto').webcrypto).getRandomValues(new Uint8Array(12));
        return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify(settings))).then(function (ct) {
          return { id: id, iv: b64(iv), ct: b64(ct) };
        });
      });
    });
  }

  /** 번호로 설정 꺼내기. 없으면 null */
  function unlock(box, code) {
    if (!box || clean(code).length < 3) return Promise.resolve(null);
    return idOf(box.salt, code).then(function (id) {
      var e = (box.entries || []).filter(function (x) { return x.id === id; })[0];
      if (!e) return null;
      return keyOf(box.salt, code, id).then(function (key) {
        return subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, key, unb64(e.ct));
      }).then(function (pt) { return JSON.parse(dec.decode(pt)); }).catch(function () { return null; });
    });
  }

  /** 관리자 화면: 목록 전체로 dept.json 만들기 */
  function build(list) {
    var c = root.crypto || require('crypto').webcrypto;
    var salt = hex(c.getRandomValues(new Uint8Array(16)));
    return Promise.all(list.map(function (d) { return lock(salt, d.code, d.settings); })).then(function (entries) {
      return { v: 1, made: new Date().toISOString().slice(0, 10), salt: salt, entries: entries };
    });
  }

  var api = { lock: lock, unlock: unlock, build: build, clean: clean };
  root.sunroDept = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
