// ==UserScript==
// @name         自动领取GOG限免 + 自动关闭所有营销订阅（硬编码·单文件）
// @namespace    https://bbs.tampermonkey.net.cn/
// @version      2.6.0
// @author       Elm Forest (modified) + WorkBuddy
// @description  自动领取GOG限免游戏；领取成功或已领取过时，把 4 项 newsletter 营销订阅全部显式置为 /0（关闭）。不打开页面、不点勾选框、不依赖页面结构。
// @icon         https://www.gog.com/favicon.ico
// @grant        GM_log
// @grant        GM_xmlhttpRequest
// @connect      www.gog.com
// @license      MIT
// @crontab      * * once * *
// @homepage     https://github.com/Elm-Forest/gog-claim
// @supportURL   https://github.com/Elm-Forest/gog-claim/issues
// ==/UserScript==

/**
 * 订阅开关 ID（账户级稳定 ID）。
 * 来源：2026-10-05 在 https://www.gog.com/zh/account/settings/subscriptions 抓取的 www.gog.com.har，
 *      每个开关对应 POST /account/save_newsletter_subscription/<uuid>/1，成功返回 {"status":true}。
 * 第 1 项 = “通过值得信赖的合作伙伴的服务接收营销信息”（2.3.0 起一直在用），后 3 项是同页其余 newsletter 开关。
 * 以后 GOG 若新增订阅项：同样抓一次 HAR，把新 UUID 追加到数组即可。
 */
var NEWSLETTER_SUBSCRIPTION_IDS = [
    '5353f0f4-3c06-11ee-b0fc-fa163ec9fc5f',
    '6c5a3004-18f1-11ea-92a9-00163e4e09cc',
    '6c689b94-18f1-11ea-9c45-00163e4e09cc',
    '6c6ab0f0-18f1-11ea-b12a-00163e4e09cc'
];

/**
 * 注意：/account/switch_marketing_consent_switch 是“翻转”接口——无参数、无入参、调用一次就取反，
 * 盲调只会把当前状态翻反，所以这里刻意不调用它；只走显式 set 的 save_newsletter_subscription。
 * 显式 set：URL 末尾 /0 = 关闭、/1 = 开启；调 /0 即“保证关、幂等、零翻转风险”。
 */

function gmRequest(options) {
    return new Promise(function (resolve) {
        var settled = false;
        function done(result) { if (!settled) { settled = true; resolve(result); } }
        try {
            GM_xmlhttpRequest({
                url: options.url,
                method: options.method || 'GET',
                timeout: options.timeout || 10000,
                headers: options.headers || {},
                onload: function (xhr) {
                    done({
                        ok: true,
                        status: xhr.status,
                        text: typeof xhr.responseText === 'string' ? xhr.responseText : ''
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

function setNewsletterSubscription(uuid, enabled) {
    return gmRequest({
        url: 'https://www.gog.com/account/save_newsletter_subscription/' + uuid + '/' + (enabled ? '1' : '0'),
        method: 'POST',
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

// 串行下发，避免并发触发 GOG 的风控；全部显式置 /0。
function disableAllNewsletterSubscriptions() {
    GM_log('[订阅] 共 ' + NEWSLETTER_SUBSCRIPTION_IDS.length + ' 项，逐一置为关闭(/0)');
    var results = [];
    var chain = Promise.resolve();
    NEWSLETTER_SUBSCRIPTION_IDS.forEach(function (uuid) {
        chain = chain.then(function () {
            return setNewsletterSubscription(uuid, false).then(function (r) { results.push(r); });
        });
    });
    return chain.then(function () {
        var okCount = results.filter(function (r) { return r.ok && r.status === 200; }).length;
        var failed = results.filter(function (r) { return !(r.ok && r.status === 200); });
        GM_log('[订阅] 完成：共 ' + results.length + ' 项，成功 ' + okCount + ' 项' +
            (failed.length ? '，失败 ' + failed.length + ' 项（' + failed.map(function (r) { return r.uuid.slice(0, 8) + '→' + (r.ok ? r.status : 'error'); }).join(', ') + '）' : ''));
        return { total: results.length, success: okCount };
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
                disableAllNewsletterSubscriptions().then(function () { resolve('Claim success'); });
            } else if (xhr.status === 409 && res.message === 'Already claimed') {
                GM_log('已经领过了，复检并关闭所有营销订阅');
                disableAllNewsletterSubscriptions().then(function () { resolve('Repeat Claim'); });
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
