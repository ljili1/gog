// 用途：在浏览器里抓出「订阅设置页」当前真实的数据来源，用于核对脚本的解析策略。
// 用法：
//   1) 用 CentBrowser 打开并登录 https://www.gog.com/account/settings/subscriptions
//   2) F12 → Console → 粘贴本文件全部内容并回车
//   3) 手动点一下页面里任意一个订阅开关（开→关 或 关→开）
//   4) 执行 window.__gogCalls 查看真实请求；把两次输出一起发出来即可定位
(async function () {
    var uuidRe = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
    var html = document.documentElement.outerHTML;

    var domAttrs = [];
    document.querySelectorAll("*").forEach(function (el) {
        Array.prototype.forEach.call(el.attributes || [], function (a) {
            if (uuidRe.test(a.value)) { uuidRe.lastIndex = 0; domAttrs.push("<" + el.tagName.toLowerCase() + " " + a.name + '="' + a.value.slice(0, 120) + '">'); }
            uuidRe.lastIndex = 0;
        });
    });

    var scripts = [];
    document.querySelectorAll("script").forEach(function (s) {
        var body = s.textContent || "";
        if (/newsletter/i.test(body)) scripts.push({ id: s.id || "", type: s.type || "", isEmpty: !body.trim(), length: body.length });
    });

    var calls = [];
    var of = window.fetch;
    if (of) window.fetch = function () { try { calls.push(String(arguments[0] && (arguments[0].url || arguments[0]))); } catch (e) {} return of.apply(this, arguments); };
    var oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { calls.push(m + " " + u); return oo.apply(this, arguments); };
    window.__gogCalls = calls;

    console.log("1) URL:", location.href);
    console.log("2) 页面里所有 UUID:", JSON.stringify(Array.from(new Set(html.match(uuidRe) || []))));
    console.log("3) 带 UUID 的 DOM 属性:", JSON.stringify(Array.from(new Set(domAttrs)).slice(0, 30)));
    console.log("4) 含 newsletter 的 script 块:", JSON.stringify(scripts));
    console.log("5) 含 newsletter 的 HTML 片段:", (function () { var i = html.search(/newsletter/i); return i < 0 ? "(无)" : html.slice(Math.max(0, i - 120), i + 260); })());
    console.log("6) 现在手动点一下任意订阅开关，然后执行 window.__gogCalls");
})();
