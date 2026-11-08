/* 순로앱 파일 읽기: .txt / .csv / .xlsx
 * readFile(name, ArrayBuffer) → Promise<{kind:'lines', lines:[...]} | {kind:'table', rows:[[...], ...]}>
 * - 글자 파일은 UTF-8로 읽고, 깨지면 EUC-KR(한글 윈도 엑셀 CSV)로 다시 읽음
 * - 엑셀은 압축을 직접 풀어 첫 번째 시트만 읽음 (외부 프로그램 없음)
 */
(function (root) {
  function decodeText(buf) {
    var u8 = new Uint8Array(buf);
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) u8 = u8.subarray(3);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
    catch (e) { return new TextDecoder('euc-kr').decode(u8); }
  }

  function parseCSV(text) {
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim(); }); });
  }

  // ---- 압축(zip) 풀기 ----
  function inflateRaw(u8) {
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function unzip(buf) {
    var u8 = new Uint8Array(buf), dv = new DataView(buf), files = {};
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('엑셀 파일 구조를 읽을 수 없습니다');
    var n = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true);
    for (var k = 0; k < n; k++) {
      var method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
      var nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
      var lho = dv.getUint32(off + 42, true);
      var name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nl));
      files[name] = { method: method, csize: csize, lho: lho };
      off += 46 + nl + el + cl;
    }
    return {
      names: Object.keys(files),
      read: function (name) {
        var f = files[name]; if (!f) return Promise.resolve(null);
        var nl2 = dv.getUint16(f.lho + 26, true), el2 = dv.getUint16(f.lho + 28, true);
        var data = u8.subarray(f.lho + 30 + nl2 + el2, f.lho + 30 + nl2 + el2 + f.csize);
        var p = f.method === 0 ? Promise.resolve(data) : inflateRaw(data);
        return p.then(function (d) { return new TextDecoder().decode(d); });
      }
    };
  }
  function xmlText(s) {
    return s.replace(/<[^>]+>/g, '')
      .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(+d); })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref), c = 0;
    for (var i = 0; i < m[1].length; i++) c = c * 26 + (m[1].charCodeAt(i) - 64);
    return c - 1;
  }
  function readXlsx(buf) {
    var z = unzip(buf);
    return Promise.all([z.read('xl/workbook.xml'), z.read('xl/_rels/workbook.xml.rels'), z.read('xl/sharedStrings.xml')]).then(function (r) {
      var wb = r[0] || '', rels = r[1] || '', ss = r[2] || '';
      var shared = (ss.match(/<si>[\s\S]*?<\/si>/g) || []).map(function (si) {
        return (si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(xmlText).join('');
      });
      // 첫 번째 시트 파일 찾기
      var first = /<sheet [^>]*r:id="([^"]+)"/.exec(wb), target = null;
      if (first) {
        var re = new RegExp('<Relationship [^>]*Id="' + first[1] + '"[^>]*Target="([^"]+)"');
        var mm = re.exec(rels) || new RegExp('<Relationship [^>]*Target="([^"]+)"[^>]*Id="' + first[1] + '"').exec(rels);
        if (mm) target = mm[1].replace(/^\/?(xl\/)?/, 'xl/');
      }
      if (!target) target = z.names.filter(function (x) { return /^xl\/worksheets\/sheet\d*\.xml$/.test(x); }).sort()[0];
      return z.read(target).then(function (sh) {
        var rows = [];
        (sh.match(/<row[\s\S]*?<\/row>/g) || []).forEach(function (rx) {
          var row = [];
          (rx.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).forEach(function (cx) {
            var ref = /r="([A-Z]+\d+)"/.exec(cx), t = /\st="([^"]+)"/.exec(cx), v = /<v>([\s\S]*?)<\/v>/.exec(cx);
            var val = '';
            if (t && t[1] === 's' && v) val = shared[+v[1]] || '';
            else if (t && t[1] === 'inlineStr') val = (cx.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(xmlText).join('');
            else if (v) val = xmlText(v[1]);
            var ci = ref ? colIndex(ref[1]) : row.length;
            while (row.length < ci) row.push('');
            row[ci] = val;
          });
          rows.push(row);
        });
        return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
      });
    });
  }

  function readFile(name, buf) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'xlsx') return readXlsx(buf).then(function (rows) { return { kind: 'table', rows: rows }; });
    if (ext === 'xls') return Promise.reject(new Error('옛날 엑셀(.xls)은 읽지 못합니다. 엑셀에서 "다른 이름으로 저장" → .xlsx로 저장해 주세요.'));
    var text = decodeText(buf);
    if (ext === 'csv') {
      var rows = parseCSV(text);
      // 열이 두 개 이상이고 첫 줄에 "주소"가 있으면 표로, 아니면 줄 목록으로
      if (rows.length && rows[0].length > 1 && rows[0].some(function (c) { return /주소/.test(c); })) return Promise.resolve({ kind: 'table', rows: rows });
    }
    return Promise.resolve({ kind: 'lines', lines: text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean) });
  }

  /** 표의 머리글에서 주소·메모 칸을 짐작 */
  function guessColumns(rows) {
    var head = (rows[0] || []).map(function (c) { return String(c || ''); });
    var addr = -1, memo = -1;
    head.forEach(function (h, i) {
      if (addr < 0 && /도로명/.test(h)) addr = i;
    });
    head.forEach(function (h, i) { if (addr < 0 && /주소|소재지|지번/.test(h)) addr = i; });
    head.forEach(function (h, i) { if (memo < 0 && i !== addr && /메모|비고|업무|내용|설비/.test(h)) memo = i; });
    var hasHead = addr >= 0;
    if (addr < 0) {   // 머리글이 없으면 '로|길|동 + 숫자'가 가장 많은 칸
      var best = -1, bc = 0, w = Math.max.apply(null, rows.map(function (r) { return r.length; }));
      for (var c = 0; c < w; c++) {
        var cnt = rows.filter(function (r) { return /(로|길|동|리)\s*(산\s*)?\d/.test(String(r[c] || '')); }).length;
        if (cnt > bc) { bc = cnt; best = c; }
      }
      addr = best;
    }
    return { addr: addr, memo: memo, hasHead: hasHead, head: head };
  }

  var api = { readFile: readFile, guessColumns: guessColumns, parseCSV: parseCSV, decodeText: decodeText };
  root.sunroFile = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
