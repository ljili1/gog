// ==UserScript==
// @name         自动领取GOG限免 + 先查状态再关闭已开启的营销订阅（单文件）
// @namespace    https://bbs.tampermonkey.net.cn/
// @version      2.7.0
// @author       Elm Forest (modified) + WorkBuddy
// @description  自动领取GOG限免游戏；领取成功或已领取过时，先从订阅页查询这 4 项 newsletter 开关的当前状态，只把“已开启”的置为 /0（关闭）。不打开页面、不点勾选框。
// @icon         https://www.gog.com/favicon.ico
// @updateURL    https://raw.githubusercontent.com/ljili1/gog/main/gog.js
// @downloadURL  https://raw.githubusercontent.com/ljili1/gog/main/gog.js
// @grant        GM_log
// @grant        GM_xmlhttpRequest
// @connect      www.gog.com
// @license      MIT
// @crontab      * * once * *
// @homepage     https://github.com/Elm-Forest/gog-claim
// @supportURL   https://github.com/Elm-Forest/gog-claim/issues
// ==/UserScript==

// 安装 / 更新链接（ScriptCat、Tampermonkey 直接从这个地址安装即可自动更新）：
//   https://raw.githubusercontent.com/ljili1/gog/main/gog.js
// 若 raw.githubusercontent.com 访问不畅，用 jsDelivr 镜像：
//   https://cdn.jsdelivr.net/gh/ljili1/gog@main/gog.js
// 以后发新版：改 @version 后覆盖本文件（文件名保持 gog.js），管理器会自动提示更新。

/* ================================ 可调配置 ================================ */

// 订阅开关 ID（账户级稳定 ID）。来源：2026-10-05 抓取的 www.gog.com.har，
// 每个开关对应 POST /account/save_newsletter_subscription/<uuid>/1，成功返回 {"status":true}。
var NEWSLETTER_SUBSCRIPTION_IDS = [
    '5353f0f4-3c06-11ee-b0fc-fa163ec9fc5f', // “通过值得信赖的合作伙伴的服务接收营销信息”（2.3.0 起在用）
    '6c5a3004-18f1-11ea-92a9-00163e4e09cc',
    '6c689b94-18f1-11ea-9c45-00163e4e09cc',
    '6c6ab0f0-18f1-11ea-b12a-00163e4e09cc'
];

// 状态查询地址：GOG 现在按语言前缀路由，HAR 里页面的 referer 就是 /zh/ 版本，优先它。
var SUBSCRIPTION_PAGE_URLS = [
    'https://www.gog.com/zh/account/settings/subscriptions',
    'https://www.gog.com/account/settings/subscriptions'
];

// 某一项“状态未知”时怎么办：'skip' = 不动它（严格“只关已开启的”）；'close' = 仍然置 /0（保证关闭）。
var UNKNOWN_STATE_POLICY = 'skip';

// 若一项状态都查不出来（页面改版 / 未登录 / 拉取失败），是否整体回退为“全部置 /0”。
// 这是防止脚本悄悄退化成“什么都不做”的安全网；不需要可改为 false。
var FALLBACK_CLOSE_WHEN_ALL_UNKNOWN = true;

// 关闭完成后是否重新拉一次页面复检（会多一个请求）。
var VERIFY_AFTER_CLOSE = true;

/**
 * 注意：/account/switch_marketing_consent_switch 是“翻转”接口——无参数、调一次取反，
 * 也没有对应的查询接口，盲调会翻反，所以本脚本只读不写、完全不碰它。
 * 而 save_newsletter_subscription 是显式 set：/0 = 关闭、/1 = 开启，幂等、零翻转风险。
 */

/* ============================== 通用请求封装 ============================== */

function gmRequest(options) {
    return new Promise(function (resolve) {
        var settled = false;
        function done(result) { if (!settled) { settled = true; resolve(result); } }
        try {
            GM_xmlhttpRequest({
                url: options.url,
                method: options.method || 'GET',
                timeout: options.timeout || 15000,
                headers: options.headers || {},
                onload: function (xhr) {
                    done({
                        ok: true,
                        status: xhr.status,
                        text: typeof xhr.responseText === 'string' ? xhr.responseText : '',
                        finalUrl: xhr.finalUrl || options.url
                    });
                },
                onerror: function (e) { done({ ok: false, error: (e && e.error) ? e.error : String(e) }); },
                ontimeout: function () { done({ ok: false, error: 'timeout' }); }
            });
        } catch (e) {
            done({ ok: false, error: String(e) });
        }
    });
}

function fetchSubscriptionsPage() {
    var tried = [];
    var index = 0;
    function next() {
        if (index >= SUBSCRIPTION_PAGE_URLS.length) {
            var last = tried[tried.length - 1] || {};
            return Promise.resolve({ ok: false, url: last.url || '', status: last.status || 0, error: last.error || 'no page', tried: tried });
        }
        var url = SUBSCRIPTION_PAGE_URLS[index++];
        return gmRequest({
            url: url,
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Origin': 'https://www.gog.com',
                'Referer': 'https://www.gog.com/account'
            }
        }).then(function (res) {
            tried.push({ url: url, status: res.status || 0, error: res.error || '' });
            if (res.ok && res.status === 200 && res.text) {
                return { ok: true, url: url, status: res.status, html: res.text, tried: tried };
            }
            return next();
        });
    }
    return next();
}

/* ============================== 状态解析 ============================== */
// 订阅页没有独立的查询接口（HAR 里只有 POST），状态是随页面下发的。
// 判定要点：先在“离 UUID 最近的局部范围”里找状态标记，避免把相邻开关的状态算到这一项头上。

function boolFromToken(token) {
    var t = String(token).toLowerCase().replace(/["']/g, '');
    if (t === 'true' || t === '1' || t === 'on' || t === 'checked' || t === 'enabled' || t === 'active' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'off' || t === 'unchecked' || t === 'disabled' || t === 'inactive' || t === 'no') return false;
    return null;
}

function collectStateMarkers(text) {
    var markers = [];
    function push(pos, token, evidence) {
        var state = boolFromToken(token);
        if (state !== null) markers.push({ pos: pos, state: state, evidence: evidence });
    }
    var m;
    var re = /aria-checked\s*=\s*["']?(true|false)["']?/gi;
    while ((m = re.exec(text)) !== null) push(m.index, m[1], 'aria-checked=' + m[1]);
    re = /ng-checked\s*=\s*["'](true|false)["']/gi;
    while ((m = re.exec(text)) !== null) push(m.index, m[1], 'ng-checked=' + m[1]);
    re = /data-(?:state|checked)\s*=\s*["']([a-z]+)["']/gi;
    while ((m = re.exec(text)) !== null) push(m.index, m[1], 'data-state=' + m[1]);
    re = /"(?:enabled|checked|active|is[_-]?(?:enabled|active))"\s*:\s*(true|false|1|0)/gi;
    while ((m = re.exec(text)) !== null) push(m.index, m[1], 'json ' + m[0].slice(0, 40));
    re = /"(?:state|value)"\s*:\s*(true|false|1|0|"on"|"off")/gi;
    while ((m = re.exec(text)) !== null) push(m.index, m[1], 'json ' + m[0].slice(0, 40));
    re = /value\s*=\s*["']([01])["']/gi;
    while ((m = re.exec(text)) !== null) push(m.index, m[1], 'value=' + m[1]);
    re = /class\s*=\s*["'][^"']*\b(is-on|is-off|is-active|is-inactive|is-enabled|is-disabled|switch--on|switch--off)\b[^"']*["']/gi;
    while ((m = re.exec(text)) !== null) push(m.index, m[1].replace('switch--', '').replace('is-', ''), 'class~' + m[1]);
    // 裸 checked 属性（排除 ng-checked / unchecked 这类更长的词）
    re = /checked/gi;
    while ((m = re.exec(text)) !== null) {
        var before = text.charAt(m.index - 1);
        var after = text.charAt(m.index + 7);
        if (/[a-z-]/i.test(before)) continue;
        if (/[a-z]/i.test(after)) continue;
        push(m.index, 'true', 'checked 属性');
    }
    return markers;
}

// 该 UUID 可能落在的局部范围：同一个标签 → 最近的祖先容器 → 包裹它的 JSON 对象
function candidateScopes(html, idx) {
    var scopes = [];

    var tagStart = html.lastIndexOf('<', idx);
    var tagEnd = html.indexOf('>', idx);
    if (tagStart >= 0 && tagEnd > tagStart && tagEnd - tagStart <= 1200 && /^<[a-z]/i.test(html.slice(tagStart, tagStart + 2))) {
        scopes.push({ kind: '同标签', text: html.slice(tagStart, tagEnd + 1), start: tagStart });
    }

    // 所有“包住这个 UUID”的容器都收进来，最后由“范围最小且带状态标记”的那个说话
    var containers = ['label', 'tr', 'li', 'section', 'article', 'form', 'div', 'td', 'p', 'span', 'th'];
    var seen = {};
    for (var c = 0; c < containers.length; c++) {
        var name = containers[c];
        var i = html.lastIndexOf('<' + name, idx);
        if (i < 0 || i >= idx || seen[i + ':' + name]) continue;
        var nextChar = html.charAt(i + name.length + 1);
        if (!/[\s>\/]/.test(nextChar)) continue;
        var closeIdx = html.indexOf('</' + name, idx);
        if (closeIdx < 0 || closeIdx <= idx || closeIdx - i > 2000) continue;
        seen[i + ':' + name] = true;
        scopes.push({ kind: '容器<' + name + '>', text: html.slice(i, closeIdx + name.length + 3), start: i });
    }

    var open = html.lastIndexOf('{', idx);
    var close = html.indexOf('}', idx);
    if (open >= 0 && close > idx && close - open <= 2000) {
        scopes.push({ kind: 'JSON对象', text: html.slice(open, close + 1), start: open });
    }

    return scopes;
}

function detectStateForId(html, id) {
    var idx = html.toLowerCase().indexOf(String(id).toLowerCase());
    if (idx < 0) return { present: false, state: null, evidence: '页面上没有这个 UUID', snippet: '' };

    var snippet = html.slice(Math.max(0, idx - 100), idx + 220);
    var scopes = candidateScopes(html, idx);
    var withMarkers = [];

    for (var i = 0; i < scopes.length; i++) {
        var sc = scopes[i];
        var ms = collectStateMarkers(sc.text);
        if (ms.length > 0) {
            withMarkers.push({
                scope: sc,
                markers: ms.map(function (m) { return { pos: sc.start + m.pos, state: m.state, evidence: m.evidence }; })
            });
        }
    }

    if (withMarkers.length > 0) {
        // 范围越小越可信（同标签 > 容器 > JSON 对象）
        withMarkers.sort(function (a, b) { return a.scope.text.length - b.scope.text.length; });
        for (var j = 0; j < withMarkers.length; j++) {
            var entry = withMarkers[j];
            var states = entry.markers.map(function (m) { return m.state; });
            var uniq = states.filter(function (s, k) { return states.indexOf(s) === k; });
            if (uniq.length === 1) {
                return { present: true, state: uniq[0], evidence: entry.scope.kind + ' ' + entry.markers[0].evidence, snippet: snippet };
            }
            var after = entry.markers.filter(function (m) { return m.pos >= idx; });
            if (after.length > 0) {
                after.sort(function (a, b) { return a.pos - b.pos; });
                return { present: true, state: after[0].state, evidence: entry.scope.kind + ' ' + after[0].evidence, snippet: snippet };
            }
        }
    }

    // 没有状态标记：附近若是一个没有 checked 的复选框，按 HTML 语义就是“未选中”
    var nearestCheckbox = Infinity;
    for (var t = 0; t < scopes.length; t++) {
        var reInput = /<input[^>]*checkbox[^>]*>/gi;
        var mm;
        while ((mm = reInput.exec(scopes[t].text)) !== null) {
            var d = Math.abs(scopes[t].start + mm.index - idx);
            if (d < nearestCheckbox) nearestCheckbox = d;
        }
    }
    if (nearestCheckbox <= 300) {
        return { present: true, state: false, evidence: '最近的复选框（距离 ' + nearestCheckbox + '）没有 checked', snippet: snippet };
    }

    return { present: true, state: null, evidence: '附近没有可识别的状态标记', snippet: snippet };
}

function stateText(state) {
    return state === true ? '开启' : state === false ? '关闭' : '未知';
}

/* ============================== 关闭订阅 ============================== */

function setNewsletterSubscription(uuid, enabled) {
    return gmRequest({
        url: 'https://www.gog.com/account/save_newsletter_subscription/' + uuid + '/' + (enabled ? '1' : '0'),
        method: 'POST',
        timeout: 10000,
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Origin': 'https://www.gog.com',
            'Referer': 'https://www.gog.com/zh/account/settings/subscriptions'
        }
    }).then(function (res) {
        if (!res.ok) {
            GM_log('[订阅] ' + uuid.slice(0, 8) + '… 请求异常: ' + res.error);
            return { uuid: uuid, ok: false, status: 0 };
        }
        GM_log('[订阅] ' + uuid.slice(0, 8) + '… -> /' + (enabled ? '1' : '0') + ' | HTTP ' + res.status + ' ' + String(res.text || '').slice(0, 80));
        return { uuid: uuid, ok: true, status: res.status };
    });
}

// 先查状态，只关闭“已开启”的
function closeSubscriptionsThatAreOn() {
    return fetchSubscriptionsPage().then(function (page) {
        if (!page.ok) {
            GM_log('[订阅] 状态查询失败：' + page.error + '（重试记录 ' + JSON.stringify(page.tried) + '）');
        } else {
            GM_log('[订阅] 状态查询 ' + page.url + ' -> HTTP ' + page.status + '，length=' + page.html.length);
        }

        var html = page.ok ? page.html : '';
        var items = NEWSLETTER_SUBSCRIPTION_IDS.map(function (id) {
            return { id: id, info: html ? detectStateForId(html, id) : { present: false, state: null, evidence: '页面不可用', snippet: '' } };
        });

        items.forEach(function (it) {
            GM_log('[订阅] ' + it.id.slice(0, 8) + '… 状态=' + stateText(it.info.state) + '（' + it.info.evidence + '）');
        });

        var known = items.filter(function (it) { return it.info.state !== null; });
        var allUnknown = known.length === 0;

        if (allUnknown && FALLBACK_CLOSE_WHEN_ALL_UNKNOWN) {
            GM_log('[订阅] 一项状态都没查到（页面改版或未登录），回退为全部置 /0');
        } else if (!allUnknown && known.length < items.length) {
            GM_log('[订阅] ' + (items.length - known.length) + ' 项状态未知，按策略 ' + UNKNOWN_STATE_POLICY + ' 处理');
        }

        // 未知项的上下文写进日志，便于下次把解析规则对准真实结构
        items.forEach(function (it) {
            if (it.info.state === null && it.info.present && it.info.snippet) {
                GM_log('[诊断] ' + it.id.slice(0, 8) + '… 上下文: ' + it.info.snippet.replace(/\s+/g, ' ').slice(0, 240));
            }
        });

        var toClose = items.filter(function (it) {
            if (it.info.state === true) return true;
            if (it.info.state === false) return false;
            return allUnknown ? FALLBACK_CLOSE_WHEN_ALL_UNKNOWN : (UNKNOWN_STATE_POLICY === 'close');
        });
        var skipped = items.length - toClose.length;

        if (toClose.length === 0) {
            GM_log('[订阅] 无需关闭：' + items.length + ' 项都已是关闭状态');
            return { total: items.length, closed: 0, skipped: skipped };
        }

        GM_log('[订阅] 需关闭 ' + toClose.length + ' 项：' + toClose.map(function (it) { return it.id.slice(0, 8) + '…'; }).join('、'));

        var results = [];
        var chain = Promise.resolve();
        toClose.forEach(function (it) {
            chain = chain.then(function () {
                return setNewsletterSubscription(it.id, false).then(function (r) { results.push(r); });
            });
        });

        return chain.then(function () {
            var okCount = results.filter(function (r) { return r.ok && r.status === 200; }).length;
            var skippedIds = items.filter(function (it) { return toClose.indexOf(it) === -1; }).map(function (it) { return it.id.slice(0, 8) + '…'; });
            GM_log('[订阅] 关闭完成：成功 ' + okCount + '/' + results.length +
                (skippedIds.length ? '，跳过 ' + skippedIds.length + ' 项（' + skippedIds.join('、') + '）' : ''));

            if (!VERIFY_AFTER_CLOSE) return { total: items.length, closed: okCount, skipped: skipped };

            return fetchSubscriptionsPage().then(function (again) {
                if (!again.ok) {
                    GM_log('[订阅] 复检失败：' + again.error);
                    return { total: items.length, closed: okCount, skipped: skipped };
                }
                var checked = toClose.map(function (it) {
                    return { id: it.id, state: detectStateForId(again.html, it.id).state };
                });
                var stillOn = checked.filter(function (x) { return x.state === true; }).length;
                var unknownCnt = checked.filter(function (x) { return x.state === null; }).length;
                var parts = checked.map(function (x) { return x.id.slice(0, 8) + '…=' + stateText(x.state); });
                var verdict = stillOn > 0 ? '（仍有 ' + stillOn + ' 项为开启）'
                    : unknownCnt > 0 ? '（' + unknownCnt + ' 项未能确认，下次运行会再查）'
                        : '（全部确认已关闭）';
                GM_log('[订阅] 复检：' + parts.join('，') + verdict);
                return { total: items.length, closed: okCount, skipped: skipped, stillOn: stillOn, unverified: unknownCnt };
            });
        });
    });
}

/* ================================ 主流程 ================================ */
// 201 领取成功 / 409 Already claimed：都要先查状态再按需关闭；
// 401 未登录；404 当前没有可领取的游戏。

return new Promise(function (resolve) {
    GM_xmlhttpRequest({
        url: 'https://www.gog.com/giveaway/claim',
        method: 'POST',
        timeout: 10000,
        onload: function (xhr) {
            var res = {};
            try { res = JSON.parse(xhr.responseText); } catch (e) {}
            if (xhr.status === 201) {
                GM_log('领取成功，先查询再关闭已开启的营销订阅');
                closeSubscriptionsThatAreOn().then(function () { resolve('Claim success'); });
            } else if (xhr.status === 409 && res.message === 'Already claimed') {
                GM_log('已经领过了，先查询再关闭已开启的营销订阅');
                closeSubscriptionsThatAreOn().then(function () { resolve('Repeat Claim'); });
            } else if (xhr.status === 401) {
                GM_log('尚未登陆或登录已过期');
                resolve('Login timeout');
            } else if (xhr.status === 404 && res.message === 'Giveaway has ended') {
                GM_log('当前还没有可以领取的游戏（未触发订阅，跳过关闭）');
                resolve('Giveaway has ended');
            } else {
                GM_log('领取失败，状态: ' + xhr.status);
                resolve('Claim failed:' + JSON.stringify(res));
            }
        },
        onerror: function (e) {
            GM_log('领取请求异常: ' + (e && e.error ? e.error : e));
            resolve('Claim error');
        }
    });
});
