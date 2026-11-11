/* vo.js - cầu nối giữa vỏ app (trang trên cùng) và web app Apps Script trong iframe #app.
   Chỉ làm 3 việc: (1) nhớ mã PIN trong localStorage nếu người dùng chọn "Ghi nhớ", (2) chạy micro (Web Speech API)
   rồi gửi chữ vào app, (3) trả lời tin "hello". Không đọc hay ghi gì khác.

   Giao thức postMessage, mọi tin có src:'sodaspa':
     app -> vỏ:  {type:'hello'} | {type:'getPin'} | {type:'savePin',pin} | {type:'forgetPin'} | {type:'micStart',lang,sid} | {type:'micStop',sid}
     vỏ -> app:  {type:'shell',ver,voVer,mic,hasPin} | {type:'pin',pin} | {type:'micText',text,final,sid} | {type:'micEnd',sid} | {type:'micError',code,detail,sid} | {type:'micNeedTap',sid}
     code: denied | unsupported | nospeech | other
   sid (v1.2): mã lượt nghe do app đặt trong micStart; vỏ gắn lại vào mọi tin mic của lượt đó, và micStop mang sid cũ bị bỏ qua
   (để tin trễ của lượt cũ không phá lượt mới). App bản cũ không gửi sid thì vỏ vẫn chạy như trước.
   v1.3: vỏ -> app {type:'viewport',kb,vvh,insets:{top,right,bottom,left}} (bàn phím iPhone + vùng an toàn đo ở trang trên cùng);
         app -> vỏ {type:'ui',bottom,sheetOpen} (ô chat cao bao nhiêu để đặt nút "Chạm để nói" ngay phía trên; ẩn nút khi có bảng nổi).
   v1.4: chỉ thêm trang xem.html (link "Tiến trình da của bạn" cho khách: nhận ?k=, nhúng <địa chỉ app>?k=; KHÔNG nạp vo.js, không PIN). Giao thức postMessage không đổi.
   Lưu ý: "hasPin" là trường thêm vào tin 'shell' để app biết có nên chờ tin 'pin' hay không.
   Tin trả lời hello/getPin gửi thẳng cho khung vừa hỏi (event.source) với đúng origin của nó, không phát ra mọi khung. */
(function (root) {
  'use strict';

  var SRC = 'sodaspa';
  var PIN_KEY = 'sds_pin';
  var CFG = root.SO_DA_SPA || {};
  var frame = null;
  var VO_VER = '1.4';           /* phiên bản vỏ, hiện trong Cài đặt của app để dò lỗi */

  function getFrame() {
    if (!frame && root.document) frame = root.document.getElementById('app');
    return frame;
  }

  /* ---------- Gửi tin vào app ---------- */
  /* Duyệt đệ quy cửa sổ iframe và mọi khung lồng nhau (proxy cửa sổ khác nguồn vẫn cho đọc .frames và .postMessage),
     gửi postMessage(msg,'*') tới từng khung. Lý do: app thật nằm ở một khung con trong userHtmlFrame trên *.googleusercontent.com.
     CHỈ dùng cho tin không nhạy cảm (micText, micEnd, micError). Mã PIN không bao giờ đi qua broadcast. */
  function broadcast(msg) {
    var f = getFrame();
    if (!f || !f.contentWindow) return 0;
    msg = Object.assign({ src: SRC }, msg);
    var count = 0;
    (function walk(win, depth) {
      if (!win || depth > 6) return;
      try { win.postMessage(msg, '*'); count++; } catch (e) { /* bỏ qua */ }
      var n = 0;
      try { n = win.frames.length; } catch (e2) { n = 0; }
      for (var i = 0; i < n; i++) {
        var child = null;
        try { child = win.frames[i]; } catch (e3) { child = null; }
        if (child) walk(child, depth + 1);
      }
    })(f.contentWindow, 0);
    return count;
  }

  /* Trả lời riêng cho khung đã gửi tin (có thể mang PIN) */
  function reply(ev, msg) {
    try { ev.source.postMessage(Object.assign({ src: SRC }, msg), ev.origin); } catch (e) { /* bỏ qua */ }
  }

  /* ---------- Kiểm tra nguồn tin ---------- */
  function originOk(origin) {
    if (typeof origin !== 'string') return false;
    if (origin === 'https://script.google.com') return true;
    /* Chỉ để thử trên máy (localhost): cho phép thêm một nguồn thử nghiệm khai báo trong config.js (testOrigin). Bản cài thật không có. */
    var host = root.location && root.location.hostname;
    if (CFG.testOrigin && origin === CFG.testOrigin && (host === 'localhost' || host === '127.0.0.1')) return true;
    var m = /^https:\/\/([a-z0-9.-]+)$/i.exec(origin);
    return !!m && /\.googleusercontent\.com$/i.test(m[1]);
  }

  /* ---------- Nhớ PIN (chỉ khi người dùng chọn "Ghi nhớ trên máy này") ---------- */
  function readPin() {
    try { var p = root.localStorage.getItem(PIN_KEY); return /^\d{6,8}$/.test(p || '') ? p : ''; } catch (e) { return ''; }
  }
  function savePin(pin) {
    if (!/^\d{6,8}$/.test(String(pin || ''))) return;
    try { root.localStorage.setItem(PIN_KEY, String(pin)); } catch (e) { /* bỏ qua */ }
  }
  function forgetPin() {
    try { root.localStorage.removeItem(PIN_KEY); } catch (e) { /* bỏ qua */ }
  }

  /* ---------- Micro ----------
     iOS Safari hay làm hỏng micro lần 2 nếu dùng lại một đối tượng nhận giọng cũ hoặc onend không bao giờ tới.
     Vì vậy: mỗi lần micStart tạo MỘT đối tượng MỚI, có mã phiên (sess.id); sự kiện của đối tượng cũ bị bỏ qua;
     và có đồng hồ canh để luôn dọn dẹp rồi gửi micEnd, dù onend không tới. */
  var SESSION_MAX_MS = 30000;     /* tổng một lượt nghe */
  var NO_RESULT_MS = 8000;        /* không có chữ nào sau khi bắt đầu thì dừng */
  var STOP_GRACE_MS = 1500;       /* sau stop() mà onend chưa tới thì tự dọn */
  var RETRY_MS = 250;
  var seq = 0;
  var cur = null;                 /* phiên đang chạy */

  function SR() { return root.SpeechRecognition || root.webkitSpeechRecognition || null; }

  function micErrorCode(err) {
    if (/^(not-allowed|service-not-allowed|NotAllowedError)/.test(err)) return 'denied';
    if (err === 'no-speech') return 'nospeech';
    return 'other';
  }

  function clearTimers(s) {
    ['tNone', 'tMax', 'tGrace', 'tRetry', 'tStart'].forEach(function (k) {
      if (s[k]) { try { root.clearTimeout(s[k]); } catch (e) { /* bỏ qua */ } s[k] = null; }
    });
  }
  function killRec(r) {
    if (!r) return;
    r.onresult = r.onerror = r.onend = r.onstart = null;   /* gỡ sự kiện để đối tượng cũ không tác động nữa */
    try { r.abort(); } catch (e) { /* bỏ qua */ }
  }
  /* Kết thúc một phiên đúng một lần: dọn, báo lỗi (nếu có), luôn gửi micEnd. */
  function finish(s, quiet) {
    if (s.done) return;
    s.done = true;
    clearTimers(s);
    var r = s.r; s.r = null;
    if (cur === s) { cur = null; hidePill(); }
    killRec(r);
    if (quiet) return;
    if (!s.aborted) {
      if (s.err) broadcast({ type: 'micError', code: micErrorCode(s.err), detail: String(s.err), sid: s.sid });
      else if (!s.got && !s.userStop) broadcast({ type: 'micError', code: 'nospeech', detail: s.begun ? 'no-speech' : 'no-start', sid: s.sid });
    }
    broadcast({ type: 'micEnd', sid: s.sid });
  }
  /* Xin dừng nhẹ nhàng; nếu onend không tới trong 1,5 giây thì ép dọn. */
  function requestStop(s) {
    if (s.done) return;
    if (s.r) { try { s.r.stop(); } catch (e) { try { s.r.abort(); } catch (e2) { /* bỏ qua */ } } }
    if (s.tGrace) return;
    s.tGrace = root.setTimeout(function () { s.tGrace = null; finish(s); }, STOP_GRACE_MS);
  }

  /* ---------- Nút nổi "Chạm để nói" (phương án dự phòng) ----------
     iOS có thể chỉ cho start() chạy trong một cú chạm thật ở trang trên cùng; postMessage từ khung con không mang quyền đó.
     Khi start() bị từ chối hoặc không có onstart sau ~1,2 giây, vỏ hiện nút này; chạm vào là gọi start() ngay trong cú chạm. */
  var START_WAIT_MS = 1200;
  var TAP_WAIT_MS = 20000;
  var MIC_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/></svg>';
  var pill = null;
  var pillWanted = false;           /* phiên đang chờ chạm */
  var UI = { bottom: 110, sheetOpen: false };   /* app báo: ô chat cao bao nhiêu, có bảng nổi không */
  function refreshPill() {
    if (!pill) return;
    pill.style.bottom = (UI.bottom + 12) + 'px';
    pill.style.display = (pillWanted && !UI.sheetOpen) ? 'flex' : 'none';
  }

  function pillSet(listening) {
    if (!pill) return;
    pill.innerHTML = MIC_SVG + '<span>' + (listening ? 'Đang nghe… chạm để dừng' : 'Chạm để nói') + '</span>';
    pill.setAttribute('data-listening', listening ? '1' : '0');
  }
  function showPill(s) {
    var d = root.document;
    if (!d || !d.createElement || !d.body) return false;
    if (!pill) {
      pill = d.createElement('button');
      pill.type = 'button';
      pill.id = 'vo-mic-pill';
      pill.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:122px;' +
        'z-index:2147483000;min-height:48px;padding:0 22px;border:0;border-radius:999px;background:#E0457F;color:#fff;' +
        'font:600 16px/1.2 -apple-system,system-ui,sans-serif;display:flex;align-items:center;gap:8px;' +
        'box-shadow:0 6px 20px rgba(224,69,127,.45);-webkit-tap-highlight-color:transparent;touch-action:manipulation';
      pill.addEventListener('click', onPillTap);
      d.body.appendChild(pill);
    }
    pillSet(false);
    pillWanted = true;
    refreshPill();
    return true;
  }
  function hidePill() { pillWanted = false; if (pill) pill.style.display = 'none'; }
  function onPillTap() {
    var s = cur;
    if (!s || s.done) { hidePill(); return; }
    if (s.r && s.begun) { requestStop(s); return; }         /* đang nghe -> chạm để dừng */
    if (s.r) return;                                          /* đang khởi động, chờ */
    if (s.tMax) root.clearTimeout(s.tMax);
    if (s.tNone) root.clearTimeout(s.tNone);
    s.tMax = root.setTimeout(function () { s.tMax = null; requestStop(s); }, SESSION_MAX_MS);
    s.tNone = root.setTimeout(function () { s.tNone = null; requestStop(s); }, NO_RESULT_MS);
    s.err = '';
    pillSet(true);
    launch(s, true);                                          /* start() chạy ngay trong cú chạm thật */
  }
  /* start() bị từ chối / không chạy: chuyển sang chờ chạm vào nút nổi */
  function needTap(s, why) {
    if (s.done || s.needTapShown) return false;
    if (!showPill(s)) return false;
    s.needTapShown = true;
    clearTimers(s);
    killRec(s.r); s.r = null; s.begun = false;
    s.tMax = root.setTimeout(function () { s.tMax = null; finish(s); }, TAP_WAIT_MS);
    broadcast({ type: 'micNeedTap', detail: String(why || ''), sid: s.sid });
    return true;
  }

  function launch(s, tap) {
    var Ctor = SR(), r;
    try { r = new Ctor(); } catch (e) { s.err = 'new: ' + errText(e); finish(s); return; }
    s.r = r;
    r.lang = s.lang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    var live = function () { return !s.done && s.r === r && cur === s && s.id === seq; };
    var began = function () {
      if (!live()) return;
      s.begun = true;
      if (s.tStart) { root.clearTimeout(s.tStart); s.tStart = null; }
      if (s.needTapShown) pillSet(true);
    };
    r.onstart = began;
    r.onaudiostart = began;
    r.onresult = function (e) {
      if (!live()) return;
      began();
      var text = '', final = false;
      for (var i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        final = !!e.results[i].isFinal;
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (s.tNone) { root.clearTimeout(s.tNone); s.tNone = null; }
      if (text) { s.got = true; broadcast({ type: 'micText', text: text, final: final, sid: s.sid }); }
    };
    r.onerror = function (e) {
      if (!live()) return;
      if (e && e.error === 'aborted') { s.aborted = true; return; }
      var code = (e && e.error) || 'other';
      s.err = code;
    };
    r.onend = function () { if (live()) finish(s); };
    try {
      r.start();
    } catch (e2) {
      var invalid = e2 && (e2.name === 'InvalidStateError' || /InvalidState/i.test(String(e2.message || e2)));
      if (invalid && !s.retried) {
        s.retried = true;
        s.r = null;
        killRec(r);
        s.tRetry = root.setTimeout(function () {
          s.tRetry = null;
          if (!s.done && cur === s && s.id === seq) launch(s, tap);
        }, RETRY_MS);
        return;
      }
      if (!tap && /NotAllowed/i.test(String(e2 && e2.name)) && needTap(s, errText(e2))) return;
      s.err = 'start: ' + errText(e2);
      finish(s);
      return;
    }
    /* start() không ném lỗi nhưng cũng không có onstart/onaudiostart sau ~1,2 giây -> khả năng thiếu cú chạm thật */
    if (!tap) {
      s.tStart = root.setTimeout(function () {
        s.tStart = null;
        if (!live() || s.begun) return;
        if (!needTap(s, 'no-start')) { /* không có nút nổi (không có document): để đồng hồ canh xử lý */ }
      }, START_WAIT_MS);
    }
  }
  function errText(e) { return String((e && (e.name ? e.name + (e.message ? ': ' + e.message : '') : e.message)) || e || 'error').slice(0, 120); }

  function micStart(lang, sid) {
    var Ctor = SR();
    sid = (typeof sid === 'string' && sid.length <= 40) ? sid : '';
    if (!Ctor) { broadcast({ type: 'micError', code: 'unsupported', detail: 'unsupported', sid: sid }); broadcast({ type: 'micEnd', sid: sid }); return; }
    if (cur) finish(cur, true);                 /* dọn phiên cũ, không gửi micEnd (app đang bắt đầu lượt mới) */
    var s = { id: ++seq, sid: sid, r: null, got: false, err: '', aborted: false, userStop: false, done: false, retried: false,
      lang: (typeof lang === 'string' && /^[a-z]{2,3}-[A-Z]{2}$/.test(lang)) ? lang : 'vi-VN' };
    cur = s;
    s.tNone = root.setTimeout(function () { s.tNone = null; requestStop(s); }, NO_RESULT_MS);
    s.tMax = root.setTimeout(function () { s.tMax = null; requestStop(s); }, SESSION_MAX_MS);
    launch(s);
  }

  function micStop(sid) {
    sid = (typeof sid === 'string') ? sid : '';
    if (sid && cur && cur.sid && cur.sid !== sid) return;      /* lệnh dừng của lượt cũ, không được dừng lượt mới */
    if (!cur) { broadcast({ type: 'micEnd', sid: sid }); return; }
    cur.userStop = true;
    hidePill();
    requestStop(cur);
  }

  /* ---------- Khung nhìn: bàn phím + vùng an toàn (đo ở trang trên cùng, vì iframe khác nguồn trên iOS có thể báo sai) ---------- */
  var probe = null;
  function insets() {
    var out = { top: 0, right: 0, bottom: 0, left: 0 };
    var d = root.document;
    if (!d || !d.createElement || !d.body || !root.getComputedStyle) return out;
    try {
      if (!probe) {
        probe = d.createElement('div');
        probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
          'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
        d.body.appendChild(probe);
      }
      var cs = root.getComputedStyle(probe);
      out.top = parseFloat(cs.paddingTop) || 0; out.right = parseFloat(cs.paddingRight) || 0;
      out.bottom = parseFloat(cs.paddingBottom) || 0; out.left = parseFloat(cs.paddingLeft) || 0;
    } catch (e) { /* bỏ qua */ }
    return out;
  }
  function viewportMsg() {
    var vv = root.visualViewport, ih = root.innerHeight || 0;
    var vvh = vv ? vv.height : ih;
    var kb = vv ? Math.max(0, Math.round(ih - vv.height - (vv.offsetTop || 0))) : 0;
    return { type: 'viewport', kb: kb, vvh: Math.round(vvh), insets: insets() };
  }
  function sendViewport() { broadcast(viewportMsg()); }
  if (root.visualViewport && root.visualViewport.addEventListener) {
    root.visualViewport.addEventListener('resize', sendViewport);
    root.visualViewport.addEventListener('scroll', sendViewport);
  }

  /* ---------- Nhận tin từ app ---------- */
  function onMessage(ev) {
    if (!originOk(ev.origin)) return;
    var m = ev.data;
    if (!m || m.src !== SRC || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'hello':
        reply(ev, viewportMsg());
        reply(ev, { type: 'shell', ver: String(CFG.version || ''), voVer: VO_VER, mic: !!SR(), hasPin: !!readPin() });
        break;
      case 'ui':
        if (typeof m.bottom === 'number' && m.bottom >= 0 && m.bottom <= 800) UI.bottom = Math.round(m.bottom);
        UI.sheetOpen = m.sheetOpen === true;
        refreshPill();
        break;
      case 'getPin':
        var p = readPin();
        if (p) reply(ev, { type: 'pin', pin: p });
        break;
      case 'savePin': savePin(m.pin); break;
      case 'forgetPin': forgetPin(); break;
      case 'micStart': micStart(m.lang, m.sid); break;
      case 'micStop': micStop(m.sid); break;
      default: break;
    }
  }

  if (root.addEventListener) {
    root.addEventListener('message', onMessage);
    root.addEventListener('resize', sendViewport);
    root.addEventListener('orientationchange', sendViewport);
    root.addEventListener('load', sendViewport);
  }

  /* Cho bài kiểm tra tự động (không ảnh hưởng khi chạy thật) */
  root.__soDaSpaVo = { broadcast: broadcast, onMessage: onMessage, originOk: originOk, viewportMsg: viewportMsg };
})(typeof window !== 'undefined' ? window : globalThis);
