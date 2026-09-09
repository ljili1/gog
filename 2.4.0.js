// ==UserScript==
// @name         自动领取GOG限免 + 自动关闭所有营销订阅（设置接口·单文件）
// @namespace    https://bbs.tampermonkey.net.cn/
// @version      2.4.0
// @author       Elm Forest (modified) + WorkBuddy
// @description  自动领取GOG限免游戏，领取成功或已领取过时从订阅页动态解析所有 newsletter 订阅项并统一置为 /0（关闭）。不打开页面、不点勾选框、不依赖硬编码 UUID。
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
 * 将单个 newsletter 订阅置为关闭(/0)或开启(/1)。
 * URL 末尾 /0 = 关闭、/1 = 开启；显式 set 而非翻转。
 */
function setNewsletterSubscription(uuid, enabled) {
    GM_xmlhttpRequest({
        url: 'https://www.gog.com/account/save_newsletter_subscription/' + uuid + '/' + (enabled ? '1' : '0'),
        method: 'POST',
        timeout: 10000,
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Origin': 'https://www.gog.com',
            'Referer': 'https://www.gog.com/account/settings/subscriptions'
        },
        onload: (xhr) => {
            GM_log('[订阅] ' + uuid.slice(0, 8) + '… -> /' + (enabled ? '1' : '0') + ' | HTTP ' + xhr.status + ' ' + String(xhr.responseText || '').slice(0, 120));
        },
        onerror: (e) => {
            GM_log('[订阅] ' + uuid.slice(0, 8) + '… 请求失败: ' + (e && e.error ? e.error : e));
        }
    });
}

/**
 * 拉取订阅页 HTML，正则提取页面上所有 newsletter 订阅 UUID 并统一置为关闭。
 * 设计要点：
 *   1. 不依赖硬编码 UUID（账户级 ID 与具体账号绑定，旧版本一处硬编码覆盖不全）；
 *   2. 自动覆盖 GOG 后续新增的订阅项，无需脚本跟着改；
 *   3. 不论领取过程中 GOG 勾的是哪一个，都能被一并关掉。
 */
function disableAllNewsletterSubscriptions() {
    GM_xmlhttpRequest({
        url: 'https://www.gog.com/account/settings/subscriptions',
        method: 'GET',
        timeout: 15000,
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Origin': 'https://www.gog.com',
            'Referer': 'https://www.gog.com/account'
        },
        onload: (xhr) => {
            if (xhr.status !== 200) {
                GM_log('[订阅] 拉取订阅页失败: HTTP ' + xhr.status);
                return;
            }
            const html = xhr.responseText || '';
            // 匹配 save_newsletter_subscription/<uuid> 的所有引用（页面里通常会出现 ≥2 次：开关元素 + 隐藏字段）
            const re = /save_newsletter_subscription\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
            const uuids = new Set();
            let m;
            while ((m = re.exec(html)) !== null) {
                uuids.add(m[1]);
            }
            if (uuids.size === 0) {
                GM_log('[订阅] 未匹配到任何 newsletter UUID（页面结构可能已变更，需人工复核）');
                return;
            }
            GM_log('[订阅] 共发现 ' + uuids.size + ' 项订阅，全部置为关闭(/0)');
            uuids.forEach((uuid) => setNewsletterSubscription(uuid, false));
        },
        onerror: (e) => {
            GM_log('[订阅] 拉取订阅页异常: ' + (e && e.error ? e.error : e));
        }
    });
}

// 主流程：领取限免 → 领取成功(201) / 已领取(409 Already claimed) → 解析订阅页 → 全部关闭
//   * 201：领取成功，GOG 可能在过程中勾选了某项订阅，立即反向关闭；
//   * 409 Already claimed：本次未触发新订阅，但脚本兜底复检，确保历史遗留的"被勾上"项也被一并关掉；
//   * 401：未登录或登录已过期，跳过关闭（无鉴权无法操作）；
//   * 404 Giveaway has ended：当前没有可领取的游戏，跳过关闭。
return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
        url: 'https://www.gog.com/giveaway/claim',
        method: 'POST',
        timeout: 10000,
        onload: (xhr) => {
            let res = {};
            try { res = JSON.parse(xhr.responseText); } catch (e) {}
            if (xhr.status === 201) {
                GM_log('领取成功，关闭所有营销订阅');
                disableAllNewsletterSubscriptions();
                resolve('Claim success');
            } else if (xhr.status === 409 && res.message === 'Already claimed') {
                GM_log('已经领过了，复检并关闭所有营销订阅');
                disableAllNewsletterSubscriptions();
                reject('Repeat Claim');
            } else if (xhr.status === 401) {
                GM_log('尚未登陆或登录已过期');
                reject('Login timeout');
            } else if (xhr.status === 404 && res.message === 'Giveaway has ended') {
                GM_log('当前还没有可以领取的游戏（未触发订阅，跳过关闭）');
                reject('Giveaway has ended');
            } else {
                GM_log('领取失败，状态: ' + xhr.status);
                reject('Claim failed:' + res);
            }
        },
        onerror: (e) => {
            GM_log('领取请求异常: ' + (e && e.error ? e.error : e));
            reject('Claim error');
        }
    });
});