// ==UserScript==
// @name         自动领取GOG限免 + 网络退订营销（设置接口·单文件）
// @namespace    https://bbs.tampermonkey.net.cn/
// @version      2.3.0
// @author       Elm Forest (modified) + WorkBuddy
// @description  自动领取GOG限免游戏，并通过设置页接口直接关闭“通过值得信赖的合作伙伴的服务接收营销信息”（不打开页面、不点勾选框）
// @icon         https://www.gog.com/favicon.ico
// @grant        GM_log
// @grant        GM_xmlhttpRequest
// @connect      www.gog.com
// @license      MIT
// @crontab      * * once * *
// @homepage     https://github.com/Elm-Forest/gog-claim
// @supportURL   https://github.com/Elm-Forest/gog-claim/issues
// ==/UserScript==

// 设置页接口：账户级“通过值得信赖的合作伙伴的服务接收营销信息”订阅项（会话 Cookie 鉴权，无需 token）。
// 对应 https://www.gog.com/account/settings/subscriptions 里的该项。
// 显式 set（非翻转）：URL 末尾 /0 = 关闭、/1 = 开启；调 /0 即“保证关、幂等、零翻转风险”。
// 该 UUID 绑定你的账号订阅记录（账户级稳定 ID），可在浏览器 Network 里抓 save_newsletter_subscription/<UUID>/0 取得。
const NEWSLETTER_SUBSCRIPTION_ID = '5353f0f4-3c06-11ee-b0fc-fa163ec9fc5f';

function saveNewsletterSubscriptionOff() {
    GM_xmlhttpRequest({
        url: 'https://www.gog.com/account/save_newsletter_subscription/' + NEWSLETTER_SUBSCRIPTION_ID + '/0',
        method: 'POST',
        timeout: 10000,
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Origin': 'https://www.gog.com',
            'Referer': 'https://www.gog.com/account/settings/subscriptions'
        },
        onload: (xhr) => {
            GM_log('[退订] save_newsletter_subscription/0 返回: ' + xhr.status + ' ' + String(xhr.responseText).slice(0, 120));
        },
        onerror: (e) => {
            GM_log('[退订] 请求失败: ' + (e && e.error ? e.error : e));
        }
    });
}

// 主流程：领取限免，领取成功（201）后撤销营销订阅，避免 GOG 把营销勾选重新打开。
return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
        url: 'https://www.gog.com/giveaway/claim',
        method: 'POST',
        timeout: 10000,
        onload: (xhr) => {
            let res = {};
            try { res = JSON.parse(xhr.responseText); } catch (e) {}
            if (xhr.status === 201) {
                GM_log('领取成功，撤销营销订阅');
                saveNewsletterSubscriptionOff();
                resolve('Claim success');
            } else if (xhr.status === 409 && res.message === 'Already claimed') {
                GM_log('已经领过了（未触发新订阅，跳过退订）');
                reject('Repeat Claim');
            } else if (xhr.status === 401) {
                GM_log('尚未登陆或登录已过期');
                reject('Login timeout');
            } else if (xhr.status === 404 && res.message === 'Giveaway has ended') {
                GM_log('当前还没有可以领取的游戏（未触发订阅，跳过退订）');
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
