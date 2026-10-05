// ==UserScript==
// @name         自动领取GOG限免 + 自动关闭所有营销订阅（多策略解析·单文件）
// @namespace    https://bbs.tampermonkey.net.cn/
// @version      2.5.0
// @author       Elm Forest (modified) + WorkBuddy
// @description  自动领取GOG限免游戏；领取成功或已领取过时从订阅页多策略解析所有 newsletter 订阅项并统一置为 /0（关闭）。不打开页面、不点勾选框；解析不到时输出可核对的诊断信息，并回退到已知账户级 ID。
// @icon         https://www.gog.com/favicon.ico
// @grant        GM_log
// @grant        GM_xmlhttpRequest
// @connect      www.gog.com
// @license      MIT
// @crontab      * * once * *
// @homepage     https://github.com/Elm-Forest/gog-claim
// @supportURL   https://github.com/Elm-Forest/gog-claim/issues
// ==/UserScript==

/* ================================ 可调配置 ================================ */

// 订阅设置页候选地址：GOG 现在按语言前缀路由（浏览器历史里实际访问的是 /zh/ 前缀，两种都试）。
var SUBSCRIPTION_PAGE_URLS = [
    'https://www.gog.com/account/settings/subscriptions',
    'https://www.gog.com/zh/account/settings/subscriptions'
];

// 兜底订阅 ID：2.3.0 长期使用的账户级 ID（“接收值得信赖合作伙伴的营销信息”那一项）。
// 页面改版导致解析失败时仍会把它置为 /0，保证最关键的一项不会漏。
var KNOWN_SUBSCRIPTION_IDS = [
    '5353f0f4-3c06-11ee-b0fc-fa163ec9fc5f'
];

// 连“newsletter 语境”都找不到时，是否把页面上出现过的所有 UUID 都尝试置为 /0。
// save 接口是幂等的（显式 set），未知 ID 会被服务端拒绝，不会误开任何订阅。
var AGGRESSIVE_SCAN_ALL_UUIDS = true;

var UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

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
                        finalUrl: xhr.finalUrl || options.url,
                        responseHeaders: xhr.responseHeaders || ''
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

/* ============================== UUID 解析策略 ============================== */
// 2.4.0 只认 "save_newsletter_subscription/<uuid>" 这一种写法，页面一改版就全军覆没。
// 这里改成多策略叠加，任意一种命中即可。

function addCandidate(bucket, id, sourceTag) {
    var key = String(id || '').toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) return;
    if (!bucket[key]) bucket[key] = {};
    bucket[key][sourceTag] = true;
}

// 策略 A：老结构，页面上直接出现 save_newsletter_subscription/<uuid>
function scanExplicitEndpoint(text, bucket) {
    var re = new RegExp('save_newsletter_subscription/(' + UUID_PATTERN + ')', 'gi');
    var m;
    while ((m = re.exec(text)) !== null) addCandidate(bucket, m[1], 'endpoint');
}

// 策略 B：newsletter 关键字附近 200 字符内的 UUID（两个方向都扫，兼容 JSON 键值与模板属性）
function scanNeighbourhood(text, bucket) {
    var reAfter = new RegExp('newsletter[\\s\\S]{0,200}?(' + UUID_PATTERN + ')', 'gi');
    var reBefore = new RegExp('(' + UUID_PATTERN + ')[\\s\\S]{0,200}?newsletter', 'gi');
    var m;
    while ((m = reAfter.exec(text)) !== null) addCandidate(bucket, m[1], 'near-after');
    while ((m = reBefore.exec(text)) !== null) addCandidate(bucket, m[1], 'near-before');
}

// 策略 C：属性写法（data-*-uuid / data-*-newsletter-*）以及 newsletter 上下文里的 value="<uuid>"
function scanAttributes(text, bucket) {
    var reAttr = new RegExp('[a-zA-Z0-9_:-]*(?:uuid|newsletter)[a-zA-Z0-9_:-]*\\s*=\\s*["\'](' + UUID_PATTERN + ')["\']', 'gi');
    var m;
    while ((m = reAttr.exec(text)) !== null) addCandidate(bucket, m[1], 'attr');
    var reValue = new RegExp('value\\s*=\\s*["\'](' + UUID_PATTERN + ')["\']', 'gi');
    while ((m = reValue.exec(text)) !== null) {
        var start = Math.max(0, m.index - 400);
        if (/newsletter/i.test(text.slice(start, m.index))) addCandidate(bucket, m[1], 'value-near-newsletter');
    }
}

// 策略 D：内嵌 JSON（Angular SSR 的 ng-state、<script type="application/json">、window.__XXX__ 状态对象）
function scanEmbeddedJson(text, bucket) {
    var reScript = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    var m;
    while ((m = reScript.exec(text)) !== null) {
        var block = m[1];
        if (block.length < 8) continue;
        if (!/newsletter/i.test(block)) continue;
        var reUuid = new RegExp(UUID_PATTERN, 'gi');
        var u;
        while ((u = reUuid.exec(block)) !== null) addCandidate(bucket, u[0], 'embedded-json');
    }
}

// 策略 E：兜底，页面上出现过的所有 UUID
function scanAllUuids(text, bucket) {
    var re = new RegExp(UUID_PATTERN, 'gi');
    var m;
    while ((m = re.exec(text)) !== null) addCandidate(bucket, m[0], 'any-uuid');
}

// 只被“兜底扫描”命中的 ID 不算语境命中
function scopedIds(bucket) {
    return Object.keys(bucket).filter(function (k) {
        return Object.keys(bucket[k]).some(function (tag) { return tag !== 'any-uuid'; });
    });
}

function extractSubscriptionIds(html) {
    var bucket = {};
    scanExplicitEndpoint(html, bucket);
    scanNeighbourhood(html, bucket);
    scanAttributes(html, bucket);
    scanEmbeddedJson(html, bucket);
    if (scopedIds(bucket).length === 0 && AGGRESSIVE_SCAN_ALL_UUIDS) scanAllUuids(html, bucket);
    return bucket;
}

/* ============================== 失败诊断 ============================== */
// 解析失败时把页面特征写进日志，方便下次直接定位（无需人工翻 HTML）。

function describePage(res) {
    var html = res.text || '';
    var title = (html.match(/<title>([\s\S]{0,120}?)<\/title>/i) || [null, ''])[1].replace(/\s+/g, ' ').trim();
    var base = (html.match(/<base[^>]*href=["']([^"']+)["']/i) || [null, ''])[1];
    var newsletterHits = (html.match(/newsletter/gi) || []).length;
    var uuidHits = (html.match(new RegExp(UUID_PATTERN, 'gi')) || []).length;
    var jsonScripts = (html.match(/<script[^>]*type=["']application\/json["']/gi) || []).length;
    var looksLikeLogin = /sign in|log in|login|登录/i.test(html);
    var idx = html.search(/newsletter/i);
    var excerpt = idx >= 0 ? html.slice(Math.max(0, idx - 80), idx + 200) : html.slice(0, 200);
    return '[诊断] ' + res.finalUrl + ' | HTTP ' + res.status + ' | len=' + html.length +
        ' | title="' + title + '"' + (base ? ' | base=' + base : '') +
        ' | newsletter出现=' + newsletterHits + ' | UUID形式串=' + uuidHits +
        ' | json脚本块=' + jsonScripts +
        ' | 疑似登录页=' + (looksLikeLogin ? '是' : '否') +
        ' | 片段=' + excerpt.replace(/\s+/g, ' ').slice(0, 240);
}

/* ============================== 关闭订阅 ============================== */

// 显式 set：/0 = 关闭、/1 = 开启；调 /0 即“保证关、幂等、零翻转风险”。
function setNewsletterSubscription(uuid, enabled) {
    return gmRequest({
        url: 'https://www.gog.com/account/save_newsletter_subscription/' + uuid + '/' + (enabled ? '1' : '0'),
        method: 'POST',
        timeout: 10000,
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Origin': 'https://www.gog.com',
            'Referer': 'https://www.gog.com/account/settings/subscriptions'
        }
    }).then(function (res) {
        if (!res.ok) {
            GM_log('[订阅] ' + uuid.slice(0, 8) + '… 请求异常: ' + res.error);
            return { ok: false, status: 0 };
        }
        GM_log('[订阅] ' + uuid.slice(0, 8) + '… -> /' + (enabled ? '1' : '0') + ' | HTTP ' + res.status + ' ' + String(res.text || '').slice(0, 120));
        return { ok: true, status: res.status };
    });
}

function closeAllMarketingSubscriptions() {
    var bucket = {};
    var diagnostics = [];
    var index = 0;

    function fetchNextPage() {
        if (index >= SUBSCRIPTION_PAGE_URLS.length) return Promise.resolve(false);
        var url = SUBSCRIPTION_PAGE_URLS[index++];
        return gmRequest({
            url: url,
            method: 'GET',
            timeout: 15000,
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Origin': 'https://www.gog.com',
                'Referer': 'https://www.gog.com/account'
            }
        }).then(function (res) {
            if (!res.ok) {
                diagnostics.push('[诊断] ' + url + ' | 请求异常: ' + res.error);
                return fetchNextPage();
            }
            if (res.status !== 200) {
                diagnostics.push('[诊断] ' + url + ' | HTTP ' + res.status);
                return fetchNextPage();
            }
            var found = extractSubscriptionIds(res.text || '');
            GM_log('[订阅] 解析 ' + url + ' -> 候选 UUID ' + Object.keys(found).length + ' 个（其中 newsletter 语境 ' + scopedIds(found).length + ' 个）');
            if (Object.keys(found).length > 0) {
                bucket = found;
                return true;
            }
            diagnostics.push(describePage(res));
            return fetchNextPage();
        });
    }

    return fetchNextPage().then(function (foundOnPage) {
        if (foundOnPage) return true;
        // 再试一次：部分改版后的页面在 XHR 头下返回 JSON 列表
        return gmRequest({
            url: SUBSCRIPTION_PAGE_URLS[0],
            method: 'GET',
            timeout: 15000,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': 'https://www.gog.com',
                'Referer': 'https://www.gog.com/account'
            }
        }).then(function (res) {
            if (res.ok && res.status === 200) {
                var found = extractSubscriptionIds(res.text || '');
                if (Object.keys(found).length > 0) {
                    GM_log('[订阅] JSON 方式命中 ' + Object.keys(found).length + ' 个 UUID');
                    bucket = found;
                    return true;
                }
            } else if (!res.ok) {
                diagnostics.push('[诊断] JSON 方式请求异常: ' + res.error);
            }
            return false;
        });
    }).then(function () {
        // 兜底 ID 始终并入，保证最关键的一项不会因为解析失败而漏掉
        KNOWN_SUBSCRIPTION_IDS.forEach(function (id) { addCandidate(bucket, id, 'known'); });

        var ids = Object.keys(bucket);
        if (ids.length === 0) {
            GM_log('[订阅] 未匹配到任何 newsletter UUID，也没有兜底 ID（需人工复核）');
            diagnostics.forEach(function (line) { GM_log(line); });
            return { total: 0, success: 0 };
        }

        var scoped = scopedIds(bucket);
        var aggressive = ids.filter(function (id) { return scoped.indexOf(id) === -1 && !bucket[id]['known']; });
        if (aggressive.length > 0) {
            GM_log('[订阅] newsletter 语境未命中，已启用兜底扫描：尝试页面上出现的所有 UUID');
        }
        diagnostics.forEach(function (line) { GM_log(line); });
        GM_log('[订阅] 共 ' + ids.length + ' 项，逐一置为关闭(/0)');

        var results = [];
        var chain = Promise.resolve();
        ids.forEach(function (id) {
            chain = chain.then(function () {
                return setNewsletterSubscription(id, false).then(function (r) {
                    results.push({ id: id, ok: r.ok, status: r.status });
                });
            });
        });

        return chain.then(function () {
            var okCount = results.filter(function (r) { return r.ok && (r.status === 200 || r.status === 204); }).length;
            var statusSummary = {};
            results.forEach(function (r) {
                var k = r.ok ? String(r.status) : 'error';
                statusSummary[k] = (statusSummary[k] || 0) + 1;
            });
            GM_log('[订阅] 完成：共 ' + results.length + ' 项，成功 ' + okCount + ' 项，状态分布 ' + JSON.stringify(statusSummary));
            return { total: results.length, success: okCount };
        });
    });
}

/* ================================ 主流程 ================================ */
// 201 领取成功 / 409 Already claimed：都要复检并关闭营销订阅；
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
                GM_log('领取成功，关闭所有营销订阅');
                closeAllMarketingSubscriptions().then(function () { resolve('Claim success'); });
            } else if (xhr.status === 409 && res.message === 'Already claimed') {
                GM_log('已经领过了，复检并关闭所有营销订阅');
                closeAllMarketingSubscriptions().then(function () { resolve('Repeat Claim'); });
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
