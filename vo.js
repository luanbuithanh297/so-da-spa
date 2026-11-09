/* vo.js - cầu nối giữa vỏ app (trang trên cùng) và web app Apps Script trong iframe #app.
   Chỉ làm 3 việc: (1) nhớ mã PIN trong localStorage nếu người dùng chọn "Ghi nhớ", (2) chạy micro (Web Speech API)
   rồi gửi chữ vào app, (3) trả lời tin "hello". Không đọc hay ghi gì khác.

   Giao thức postMessage, mọi tin có src:'sodaspa':
     app -> vỏ:  {type:'hello'} | {type:'getPin'} | {type:'savePin',pin} | {type:'forgetPin'} | {type:'micStart',lang} | {type:'micStop'}
     vỏ -> app:  {type:'shell',ver,mic,hasPin} | {type:'pin',pin} | {type:'micText',text,final} | {type:'micEnd'} | {type:'micError',code}
     code: denied | unsupported | nospeech | other
   Lưu ý: "hasPin" là trường thêm vào tin 'shell' để app biết có nên chờ tin 'pin' hay không.
   Tin trả lời hello/getPin gửi thẳng cho khung vừa hỏi (event.source) với đúng origin của nó, không phát ra mọi khung. */
(function (root) {
  'use strict';

  var SRC = 'sodaspa';
  var PIN_KEY = 'sds_pin';
  var CFG = root.SO_DA_SPA || {};
  var frame = null;
  var rec = null;

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

  /* ---------- Micro ---------- */
  function SR() { return root.SpeechRecognition || root.webkitSpeechRecognition || null; }

  function micErrorCode(err) {
    if (err === 'not-allowed' || err === 'service-not-allowed') return 'denied';
    if (err === 'no-speech') return 'nospeech';
    return 'other';
  }

  function micStart(lang) {
    var Ctor = SR();
    if (!Ctor) { broadcast({ type: 'micError', code: 'unsupported' }); return; }
    if (rec) { try { rec.abort(); } catch (e) { /* bỏ qua */ } rec = null; }
    var r;
    try { r = new Ctor(); } catch (e2) { broadcast({ type: 'micError', code: 'unsupported' }); return; }
    var state = { got: false, err: '', aborted: false };
    r.lang = (typeof lang === 'string' && /^[a-z]{2,3}-[A-Z]{2}$/.test(lang)) ? lang : 'vi-VN';
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    r.onresult = function (e) {
      var text = '', final = false;
      for (var i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        final = !!e.results[i].isFinal;
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (text) { state.got = true; broadcast({ type: 'micText', text: text, final: final }); }
    };
    r.onerror = function (e) {
      if (e && e.error === 'aborted') { state.aborted = true; return; }
      state.err = (e && e.error) || 'other';
    };
    r.onend = function () {
      if (rec === r) rec = null;
      if (!state.aborted) {
        if (state.err) broadcast({ type: 'micError', code: micErrorCode(state.err) });
        else if (!state.got) broadcast({ type: 'micError', code: 'nospeech' });
      }
      broadcast({ type: 'micEnd' });
    };
    rec = r;
    try { r.start(); } catch (e3) {
      rec = null;
      broadcast({ type: 'micError', code: 'other' });
      broadcast({ type: 'micEnd' });
    }
  }

  function micStop() {
    if (!rec) { broadcast({ type: 'micEnd' }); return; }
    try { rec.stop(); } catch (e) { try { rec.abort(); } catch (e2) { /* bỏ qua */ } }
  }

  /* ---------- Nhận tin từ app ---------- */
  function onMessage(ev) {
    if (!originOk(ev.origin)) return;
    var m = ev.data;
    if (!m || m.src !== SRC || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'hello':
        reply(ev, { type: 'shell', ver: String(CFG.version || ''), mic: !!SR(), hasPin: !!readPin() });
        break;
      case 'getPin':
        var p = readPin();
        if (p) reply(ev, { type: 'pin', pin: p });
        break;
      case 'savePin': savePin(m.pin); break;
      case 'forgetPin': forgetPin(); break;
      case 'micStart': micStart(m.lang); break;
      case 'micStop': micStop(); break;
      default: break;
    }
  }

  if (root.addEventListener) root.addEventListener('message', onMessage);

  /* Cho bài kiểm tra tự động (không ảnh hưởng khi chạy thật) */
  root.__soDaSpaVo = { broadcast: broadcast, onMessage: onMessage, originOk: originOk };
})(typeof window !== 'undefined' ? window : globalThis);
